const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const {
  GAME_VERSION,
  GAME_CLASSES,
  LEAGUES,
  cleanText,
  parseJsonArray,
  parseJsonObject,
  toNumber,
  round,
  buildGameStateForUser,
  recomputeAllGameProfiles,
  publicProfileRow,
  ensureGameProfile,
  ensurePublicSettings,
  safeError
} = require("./game-helpers");

const ALLOWED_THEMES = ["classic", "midnight", "sand", "sage", "carbon", "bloom", "racing", "royal", "ocean", "mahogany"];
const ALLOWED_GAME_MODES = ["npc", "global", "league", "community"];
const ALLOWED_GAME_CLASSES = GAME_CLASSES.map((item) => item.key);

function normalizeEnum(value, allowed, fallback) {
  const text = cleanText(value, fallback, 80);
  if (!allowed.includes(text)) return fallback;
  return text;
}

function positiveNumber(value, fallback = 0) {
  const n = toNumber(value, fallback);
  if (!Number.isFinite(n) || n < 0) throw new Error("Negative oder ungültige Werte sind nicht erlaubt.");
  return n;
}

function gameClassDetails(gameClass, rawDetails = {}) {
  const details = parseJsonObject(rawDetails);
  const kindByClass = {
    immo_self: "real_estate",
    immo_rent: "real_estate",
    consumer: "manual_asset",
    collector: "manual_asset",
    commodity: "manual_asset",
    business: "business",
    crowdfunding: "crowdfunding_project",
    debt: "debt",
    neutral: "cash",
    productive: "manual_productive"
  };
  return {
    ...details,
    kind: details.kind || kindByClass[gameClass] || "manual_asset",
    game_class: gameClass,
    liquidity_class: gameClass === "neutral" ? "liquid" : (details.liquidity_class || "illiquid")
  };
}

function manualValueFromBody(body) {
  return positiveNumber(body.value ?? body.manual_value ?? body.current_value ?? 0, 0);
}

function isNeutralLiquid(gameClass, body) {
  if (body.is_liquid !== undefined) return body.is_liquid === true;
  return gameClass === "neutral";
}

function normalizeAssetNameKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function findExistingPortfolioAssetByName(userId, name) {
  const key = normalizeAssetNameKey(name);
  if (!key) return null;
  const result = await db.query(
    `
    SELECT *
    FROM assets
    WHERE user_id = $1
      AND mode = 'portfolio'
    ORDER BY id ASC
    `,
    [Number(userId)]
  );
  return (result.rows || []).find((row) => normalizeAssetNameKey(row.name) === key) || null;
}

async function incrementAssetValueForUser(user, existing, amount, fallbackGameClass = "neutral") {
  const id = Number(existing.id);
  const value = positiveNumber(amount, 0);
  if (!id || value <= 0) throw new Error("Betrag muss größer als 0 sein.");

  const currentState = await buildGameStateForUser(user).catch(() => null);
  const scored = (currentState?.scores?.assets || []).find((item) => Number(item.id) === id);
  const currentRealValue = Math.abs(toNumber(scored?.real_value, toNumber(existing.manual_value, 0)));
  const currentQuantity = toNumber(existing.quantity, 0);

  if (["stock", "etf", "crypto"].includes(existing.type) && currentQuantity > 0 && currentRealValue > 0) {
    const eurPerUnit = currentRealValue / currentQuantity;
    const additionalQuantity = eurPerUnit > 0 ? value / eurPerUnit : 0;
    return db.query(
      `
      UPDATE assets
      SET quantity = COALESCE(quantity,0) + $3,
          mode = 'portfolio',
          asset_game_class = COALESCE(asset_game_class, 'productive')
      WHERE id = $1 AND user_id = $2
      RETURNING *
      `,
      [id, user.id, additionalQuantity]
    );
  }

  return db.query(
    `
    UPDATE assets
    SET manual_value = COALESCE(manual_value,0) + $3,
        quantity = COALESCE(NULLIF(quantity,0), 1),
        mode = 'portfolio',
        asset_game_class = COALESCE(asset_game_class, $4),
        is_liquid = CASE WHEN COALESCE(asset_game_class, $4) = 'neutral' THEN true ELSE COALESCE(is_liquid,false) END,
        asset_details = COALESCE(asset_details, '{}'::jsonb) || $5::jsonb
    WHERE id = $1 AND user_id = $2
    RETURNING *
    `,
    [id, user.id, value, fallbackGameClass || existing.asset_game_class || "neutral", JSON.stringify({ last_merged_from_wealthlist_at: new Date().toISOString() })]
  );
}


function currentSeasonKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const day = Math.floor((date.getTime() - start) / 86400000);
  const season = Math.floor(day / 14) + 1;
  return `${year}-S${String(season).padStart(2, "0")}`;
}

async function ensureSeason(seasonKey) {
  await db.query(
    `
    INSERT INTO game_seasons (season_key, starts_at, ends_at, is_active, created_at)
    VALUES ($1, NOW(), NOW() + INTERVAL '14 days', true, NOW())
    ON CONFLICT (season_key) DO NOTHING
    `,
    [seasonKey]
  ).catch(() => {});
}

async function fetchEligibleOpponents(userId, leagueKey, marketWealth, personalGoal, limit, excludeIds = []) {
  const excluded = [Number(userId), ...excludeIds.map(Number).filter(Number.isFinite)];
  const target = Math.max(Number(marketWealth || 0), Number(personalGoal || 0), 1);
  const params = [excluded, leagueKey, Number(marketWealth || 0), target, Math.max(1, Math.min(50, Number(limit || 15)))];
  const result = await db.query(
    `
    SELECT gp.*, u.display_name, pps.allow_messages, pps.asset_visibility_mode,
           (gp.league_key = $2::text) AS same_league,
           ABS(COALESCE(gp.market_wealth,0) - $3::numeric) AS distance_to_me,
           ABS(COALESCE(gp.market_wealth,0) - $4::numeric) AS distance_to_goal
    FROM game_profiles gp
    JOIN portfolio_users u ON u.id = gp.user_id
    LEFT JOIN public_portfolio_settings pps ON pps.user_id = gp.user_id
    WHERE u.is_active IS DISTINCT FROM false
      AND gp.public_profile_enabled = true
      AND gp.user_id <> ALL($1::int[])
    ORDER BY same_league DESC,
             CASE WHEN COALESCE(gp.market_wealth,0) >= $3::numeric THEN 0 ELSE 1 END ASC,
             LEAST(ABS(COALESCE(gp.market_wealth,0) - $3::numeric), ABS(COALESCE(gp.market_wealth,0) - $4::numeric)) ASC,
             COALESCE(gp.market_wealth,0) ASC,
             gp.user_id ASC
    LIMIT $5
    `,
    params
  );
  return result.rows || [];
}

async function getSeasonOpponentsForUser(userId, state, options = {}) {
  const limit = Math.max(1, Math.min(15, Number(options.limit || 15)));
  const seasonKey = currentSeasonKey();
  await ensureSeason(seasonKey);

  if (options.refresh === true) {
    await db.query("DELETE FROM game_rivalries WHERE user_id = $1 AND season_key = $2", [userId, seasonKey]).catch(() => {});
  }

  const existing = await db.query(
    `
    SELECT gr.opponent_user_id, gr.slot_rank, gp.*, u.display_name, pps.allow_messages, pps.asset_visibility_mode,
           (gp.league_key = $3::text) AS same_league
    FROM game_rivalries gr
    JOIN game_profiles gp ON gp.user_id = gr.opponent_user_id
    JOIN portfolio_users u ON u.id = gp.user_id
    LEFT JOIN public_portfolio_settings pps ON pps.user_id = gp.user_id
    WHERE gr.user_id = $1
      AND gr.season_key = $2
      AND COALESCE(gr.expires_at, NOW() + INTERVAL '1 minute') > NOW()
      AND u.is_active IS DISTINCT FROM false
      AND gp.public_profile_enabled = true
    ORDER BY gr.slot_rank ASC
    LIMIT $4
    `,
    [userId, seasonKey, state.scores.league.key, limit]
  ).catch(() => ({ rows: [] }));

  const validRows = existing.rows || [];
  const missing = limit - validRows.length;
  let newRows = [];
  if (missing > 0) {
    const personalGoal = Number(state.profile?.goal_value || state.profile?.target_wealth || state.profile?.goal || 0);
    const existingIds = validRows.map((row) => row.opponent_user_id || row.user_id);
    newRows = await fetchEligibleOpponents(userId, state.scores.league.key, state.scores.market_wealth, personalGoal, missing, existingIds);
    let slot = validRows.length + 1;
    for (const row of newRows) {
      await db.query(
        `
        INSERT INTO game_rivalries (season_key, user_id, opponent_user_id, slot_rank, source, created_at, expires_at)
        VALUES ($1,$2,$3,$4,'season_matchmaking',NOW(),NOW() + INTERVAL '14 days')
        ON CONFLICT (season_key, user_id, opponent_user_id) DO UPDATE
        SET slot_rank = EXCLUDED.slot_rank,
            expires_at = EXCLUDED.expires_at
        `,
        [seasonKey, userId, row.user_id, slot]
      ).catch(() => {});
      row.slot_rank = slot;
      slot += 1;
    }
  }

  return { season_key: seasonKey, rows: [...validRows, ...newRows].slice(0, limit) };
}

async function postToBrevo(user, state) {
  const apiKey = process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY;
  const listId = process.env.BREVO_WEEKLY_UPDATES_LIST_ID || process.env.BREVO_LIST_ID;
  if (!apiKey || !listId || typeof fetch !== "function") {
    return { attempted: false, ok: false, reason: "BREVO_API_KEY oder BREVO_LIST_ID fehlt." };
  }
  const attrs = {
    VORNAME: String(user.display_name || "").split(" ")[0] || user.display_name || "",
    WL_ANLASS: "Wochenupdates aktiviert",
    WL_REALES_VERMOEGEN: state.scores.real_wealth,
    WL_VERMOGEN: state.scores.weighted_wealth,
    WL_MARKTVERMOEGEN: state.scores.market_wealth,
    WL_AKTIVER_SPIELWERT: state.scores.market_wealth,
    WL_LEVEL: state.profile.level || 1,
    WL_SIEGE: state.profile.wins || 0,
    WL_ASSET_LIST: (state.scores.assets || []).slice(0, 20).map((a) => `${a.name}: ${a.real_value}`).join(" | "),
    WL_DASHBOARD_URL: process.env.WEALTHLIST_DASHBOARD_URL || "https://fvoelkel.com/portfolio-dashboard/"
  };
  const payload = { email: user.email, attributes: attrs, listIds: [Number(listId)], updateEnabled: true };
  const response = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify(payload)
  });
  return { attempted: true, ok: response.ok, status: response.status, payload };
}

async function userOwnsAsset(userId, assetId) {
  const result = await db.query("SELECT * FROM assets WHERE id = $1 AND user_id = $2", [Number(assetId), Number(userId)]);
  return result.rows[0] || null;
}

router.get("/meta", async (req, res) => {
  res.json({ ok: true, game_version: GAME_VERSION, asset_classes: GAME_CLASSES, leagues: LEAGUES });
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const state = await buildGameStateForUser(req.authUser);
    res.json({ ok: true, ...state });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Spielprofil konnte nicht geladen werden." });
  }
});

router.post("/profile", requireAuth, async (req, res) => {
  try {
    await ensureGameProfile(req.authUser);
    await ensurePublicSettings(req.authUser.id);

    const alias = cleanText(req.body.alias, undefined, 120);
    const avatar = cleanText(req.body.avatar, undefined, 20);
    const gameTheme = req.body.game_theme !== undefined ? normalizeEnum(req.body.game_theme, ALLOWED_THEMES, "classic") : undefined;
    const gameMode = req.body.game_mode !== undefined ? normalizeEnum(req.body.game_mode, ALLOWED_GAME_MODES, "npc") : undefined;
    const messageOptIn = req.body.message_opt_in !== undefined ? req.body.message_opt_in === true : undefined;
    const publicProfileEnabled = req.body.public_profile_enabled !== undefined ? req.body.public_profile_enabled === true : undefined;
    const publicPortfolioEnabled = req.body.public_portfolio_enabled !== undefined ? req.body.public_portfolio_enabled === true : undefined;
    const interests = req.body.interests !== undefined ? parseJsonArray(req.body.interests).slice(0, 20) : undefined;

    const fields = [];
    const values = [];

    const add = (field, value, cast = "") => {
      if (value === undefined) return;
      values.push(value);
      fields.push(`${field} = $${values.length}${cast}`);
    };

    add("alias", alias);
    add("avatar", avatar);
    add("game_theme", gameTheme);
    add("game_mode", gameMode);
    add("message_opt_in", messageOptIn);
    add("public_profile_enabled", publicProfileEnabled);
    add("public_portfolio_enabled", publicPortfolioEnabled);
    add("interests", interests === undefined ? undefined : JSON.stringify(interests), "::jsonb");

    if (fields.length) {
      values.push(req.authUser.id);
      await db.query(`UPDATE game_profiles SET ${fields.join(", ")}, updated_at = NOW() WHERE user_id = $${values.length}`, values);
    }

    if (publicPortfolioEnabled !== undefined || messageOptIn !== undefined || interests !== undefined) {
      await db.query(
        `
        UPDATE public_portfolio_settings
        SET public_enabled = COALESCE($2, public_enabled),
            allow_messages = COALESCE($3, allow_messages),
            interests = COALESCE($4::jsonb, interests)
        WHERE user_id = $1
        `,
        [
          req.authUser.id,
          publicPortfolioEnabled === undefined ? null : publicPortfolioEnabled,
          messageOptIn === undefined ? null : messageOptIn,
          interests === undefined ? null : JSON.stringify(interests)
        ]
      );
    }

    const state = await buildGameStateForUser(req.authUser);
    res.json({ ok: true, ...state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Spielprofil konnte nicht gespeichert werden." });
  }
});

router.post("/event", requireAuth, async (req, res) => {
  try {
    const eventType = cleanText(req.body.event_type, "manual", 80);
    const title = cleanText(req.body.title, "Spielereignis", 240);
    const payload = parseJsonObject(req.body.payload);
    const xpDelta = Math.max(-100000, Math.min(100000, Math.round(toNumber(req.body.xp_delta, 0))));

    const result = await db.query(
      `
      INSERT INTO game_events (user_id, event_type, title, payload, xp_delta, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
      RETURNING *
      `,
      [req.authUser.id, eventType, title, JSON.stringify(payload), xpDelta]
    );

    if (xpDelta !== 0) {
      await db.query(
        `UPDATE game_profiles SET xp = GREATEST(0, COALESCE(xp, 0) + $2), updated_at = NOW() WHERE user_id = $1`,
        [req.authUser.id, xpDelta]
      );
    }

    res.status(201).json({ ok: true, event: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Spielereignis konnte nicht gespeichert werden." });
  }
});

router.post("/assets", requireAuth, async (req, res) => {
  try {
    const name = cleanText(req.body.name, null, 180);
    if (!name) return safeError(res, 400, "Name fehlt.");

    const gameClass = normalizeEnum(req.body.asset_game_class || req.body.game_class, ALLOWED_GAME_CLASSES, "neutral");
    const value = positiveNumber(req.body.value ?? req.body.manual_value, 0);
    const mode = normalizeEnum(req.body.mode, ["portfolio", "watchlist"], "portfolio");
    const targetValue = req.body.target_value === undefined ? null : positiveNumber(req.body.target_value, 0);
    const details = parseJsonObject(req.body.asset_details);
    const isLiquid = gameClass === "neutral" && req.body.is_liquid !== false;

    const kindByClass = {
      immo_self: "real_estate",
      immo_rent: "real_estate",
      consumer: "manual_asset",
      collector: "manual_asset",
      commodity: "manual_asset",
      business: "business",
      crowdfunding: "crowdfunding_project",
      debt: "debt",
      neutral: "cash",
      productive: "manual_productive"
    };

    const assetDetails = {
      ...details,
      kind: details.kind || kindByClass[gameClass] || "manual_asset",
      game_class: gameClass,
      liquidity_class: isLiquid ? "liquid" : (details.liquidity_class || "illiquid")
    };

    if (mode === "portfolio" && value > 0) {
      const existing = await findExistingPortfolioAssetByName(req.authUser.id, name);
      if (existing) {
        const updated = await incrementAssetValueForUser(req.authUser, existing, value, gameClass);
        await db.query(
          `INSERT INTO game_events (user_id, event_type, title, payload, xp_delta, created_at)
           VALUES ($1,'asset_merged',$2,$3::jsonb,0,NOW())`,
          [req.authUser.id, "Asset zusammengeführt: " + (existing.name || name), JSON.stringify({ asset_id: existing.id, amount: value, requested_name: name })]
        ).catch(() => {});
        const state = await buildGameStateForUser(req.authUser);
        return res.status(200).json({ ok: true, merged_existing: true, asset: updated.rows[0], game_state: state });
      }
    }

    const result = await db.query(
      `
      INSERT INTO assets (
        user_id, name, mode, type, quantity, manual_value, target_value, price_currency,
        live_enabled, data_provider, asset_game_class, public_visibility, is_liquid, asset_details
      )
      VALUES ($1,$2,$3,'manual',1,$4,$5,'EUR',false,NULL,$6,'private',$7,$8::jsonb)
      RETURNING *
      `,
      [req.authUser.id, name, mode, value, targetValue, gameClass, isLiquid, JSON.stringify(assetDetails)]
    );

    const state = await buildGameStateForUser(req.authUser);
    res.status(201).json({ ok: true, merged_existing: false, asset: result.rows[0], game_state: state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Asset konnte nicht gespeichert werden. Bitte Eingaben prüfen." });
  }
});

router.post("/assets/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Asset-ID.");
    const existing = await userOwnsAsset(req.authUser.id, id);
    if (!existing) return safeError(res, 404, "Asset wurde nicht gefunden.");

    const name = cleanText(req.body.name, existing.name, 180);
    const gameClass = normalizeEnum(req.body.asset_game_class || req.body.game_class || existing.asset_game_class, ALLOWED_GAME_CLASSES, "neutral");
    const value = req.body.value !== undefined || req.body.manual_value !== undefined || req.body.current_value !== undefined
      ? manualValueFromBody(req.body)
      : toNumber(existing.manual_value, 0);
    const mode = normalizeEnum(req.body.mode || existing.mode, ["portfolio", "watchlist"], "portfolio");
    const targetValue = req.body.target_value === undefined ? existing.target_value : positiveNumber(req.body.target_value, 0);
    const details = gameClassDetails(gameClass, { ...parseJsonObject(existing.asset_details), ...parseJsonObject(req.body.asset_details) });
    const isLiquid = isNeutralLiquid(gameClass, req.body);
    const publicVisibility = normalizeEnum(req.body.public_visibility || existing.public_visibility || "private", ["private", "public", "category", "categories"], "private");

    const result = await db.query(
      `
      UPDATE assets
      SET name = $3,
          mode = $4,
          manual_value = $5,
          target_value = $6,
          asset_game_class = $7,
          public_visibility = $8,
          is_liquid = $9,
          asset_details = $10::jsonb
      WHERE id = $1 AND user_id = $2
      RETURNING *
      `,
      [id, req.authUser.id, name, mode, value, targetValue, gameClass, publicVisibility === "categories" ? "category" : publicVisibility, isLiquid, JSON.stringify(details)]
    );

    const state = await buildGameStateForUser(req.authUser);
    res.json({ ok: true, asset: result.rows[0], game_state: state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Asset konnte nicht aktualisiert werden. Bitte Eingaben prüfen." });
  }
});

router.post("/assets/:id/increment", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Asset-ID.");
    const amount = positiveNumber(req.body.amount ?? req.body.value, 0);
    if (amount <= 0) return safeError(res, 400, "Betrag muss größer als 0 sein.");

    const existing = await userOwnsAsset(req.authUser.id, id);
    if (!existing) return safeError(res, 404, "Asset wurde nicht gefunden.");

    const currentState = await buildGameStateForUser(req.authUser);
    const scored = (currentState.scores?.assets || []).find((item) => Number(item.id) === id);
    const currentRealValue = Math.abs(toNumber(scored?.real_value, toNumber(existing.manual_value, 0)));
    const currentQuantity = toNumber(existing.quantity, 0);

    let updateSql;
    let values;

    if (["stock", "etf", "crypto"].includes(existing.type) && currentQuantity > 0 && currentRealValue > 0) {
      const eurPerUnit = currentRealValue / currentQuantity;
      const additionalQuantity = eurPerUnit > 0 ? amount / eurPerUnit : 0;
      updateSql = `
        UPDATE assets
        SET quantity = COALESCE(quantity,0) + $3,
            mode = 'portfolio',
            asset_game_class = COALESCE(asset_game_class, 'productive')
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `;
      values = [id, req.authUser.id, additionalQuantity];
    } else {
      updateSql = `
        UPDATE assets
        SET manual_value = COALESCE(manual_value,0) + $3,
            quantity = COALESCE(NULLIF(quantity,0), 1),
            mode = 'portfolio',
            asset_game_class = COALESCE(asset_game_class, $4),
            is_liquid = CASE WHEN COALESCE(asset_game_class, $4) = 'neutral' THEN true ELSE COALESCE(is_liquid,false) END
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `;
      values = [id, req.authUser.id, amount, req.body.asset_game_class || existing.asset_game_class || "neutral"];
    }

    const result = await db.query(updateSql, values);
    await db.query(
      `INSERT INTO game_events (user_id, event_type, title, payload, xp_delta, created_at) VALUES ($1,'asset_increment',$2,$3::jsonb,0,NOW())`,
      [req.authUser.id, "Asset erhöht: " + (existing.name || id), JSON.stringify({ asset_id: id, amount })]
    );
    const state = await buildGameStateForUser(req.authUser);
    res.json({ ok: true, asset: result.rows[0], game_state: state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Asset konnte nicht erhöht werden. Bitte Eingaben prüfen." });
  }
});

router.delete("/assets/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Asset-ID.");

    // Datenschutz-/Referenz-sicheres Löschen: nicht hart löschen, sondern sofort aus Portfolio/Spiel entfernen.
    // Dadurch schlagen Löschungen nicht wegen späterer Foreign-Key-Referenzen fehl und verschwinden sofort aus Dashboard und Spiel.
    const result = await db.query(
      `
      UPDATE assets
      SET mode = 'deleted',
          public_visibility = 'private',
          asset_details = COALESCE(asset_details, '{}'::jsonb) || $3::jsonb
      WHERE id = $1 AND user_id = $2 AND mode IS DISTINCT FROM 'deleted'
      RETURNING id, name, mode
      `,
      [id, req.authUser.id, JSON.stringify({ deleted_by: "wealthlist_game", deleted_at: new Date().toISOString() })]
    );
    if (!result.rows.length) return safeError(res, 404, "Asset wurde nicht gefunden oder war bereits gelöscht.");

    await db.query(
      `INSERT INTO game_events (user_id, event_type, title, payload, xp_delta, created_at)
       VALUES ($1,'asset_deleted',$2,$3::jsonb,0,NOW())`,
      [req.authUser.id, "Asset gelöscht: " + (result.rows[0].name || id), JSON.stringify({ asset_id: id })]
    ).catch(() => {});

    const state = await buildGameStateForUser(req.authUser);
    res.json({ ok: true, deleted: result.rows[0], game_state: state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Asset konnte nicht gelöscht werden." });
  }
});

router.post("/import-local", requireAuth, async (req, res) => {
  try {
    const local = parseJsonObject(req.body.local_state || req.body);
    const importAssets = req.body.import_assets === true;
    const assets = Array.isArray(local.assets) ? local.assets.slice(0, 100) : [];

    await ensureGameProfile(req.authUser);
    await db.query(
      `
      UPDATE game_profiles
      SET xp = GREATEST(COALESCE(xp,0), $2),
          level = GREATEST(COALESCE(level,1), $3),
          wins = GREATEST(COALESCE(wins,0), $4),
          streak = GREATEST(COALESCE(streak,0), $5),
          imported_local_state = $6::jsonb
      WHERE user_id = $1
      `,
      [
        req.authUser.id,
        Math.max(0, Math.round(toNumber(local.xp, 0))),
        Math.max(1, Math.round(toNumber(local.lv || local.level, 1))),
        Math.max(0, Math.round(toNumber(local.wins, 0))),
        Math.max(0, Math.round(toNumber(local.streak, 0))),
        JSON.stringify(local)
      ]
    );

    let importedAssets = 0;
    if (importAssets) {
      for (const item of assets) {
        const name = cleanText(item.nm || item.name, null, 180);
        const gameClass = normalizeEnum(item.tp || item.asset_game_class || item.game_class, ALLOWED_GAME_CLASSES, "neutral");
        const value = Math.abs(toNumber(item.currentValue ?? item.realValue ?? item.val ?? item.value, 0));
        if (!name || value <= 0) continue;
        await db.query(
          `
          INSERT INTO assets (user_id, name, mode, type, quantity, manual_value, price_currency, live_enabled, data_provider, asset_game_class, public_visibility, is_liquid, asset_details)
          VALUES ($1,$2,'portfolio','manual',1,$3,'EUR',false,NULL,$4,'private',$5,$6::jsonb)
          `,
          [req.authUser.id, name, value, gameClass, gameClass === "neutral", JSON.stringify({ kind: "wealthlist_import", game_class: gameClass, imported_from_local_game: true })]
        );
        importedAssets += 1;
      }
    }

    const state = await buildGameStateForUser(req.authUser);
    res.json({ ok: true, imported_assets: importedAssets, game_state: state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Lokaler Spielstand konnte nicht importiert werden." });
  }
});

router.get("/leaderboard", requireAuth, async (req, res) => {
  try {
    await buildGameStateForUser(req.authUser);
    const sameLeague = req.query.same_league !== "false";
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const params = [limit];
    let where = "WHERE u.is_active IS DISTINCT FROM false";

    if (sameLeague) {
      const me = await db.query("SELECT league_key FROM game_profiles WHERE user_id = $1", [req.authUser.id]);
      const leagueKey = me.rows[0]?.league_key || "bronze";
      params.push(leagueKey);
      where += ` AND gp.league_key = $${params.length}`;
    }

    const result = await db.query(
      `
      SELECT gp.*, u.display_name
      FROM game_profiles gp
      JOIN portfolio_users u ON u.id = gp.user_id
      ${where}
      ORDER BY COALESCE(gp.market_wealth,0) DESC, COALESCE(gp.weighted_wealth,0) DESC, gp.user_id ASC
      LIMIT $1
      `,
      params
    );

    const rows = result.rows.map((row, index) => ({ rank: index + 1, ...publicProfileRow(row), is_me: Number(row.user_id) === Number(req.authUser.id) }));
    res.json({ ok: true, game_version: GAME_VERSION, same_league: sameLeague, leaderboard: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Rangliste konnte nicht geladen werden." });
  }
});

router.get("/opponents", requireAuth, async (req, res) => {
  try {
    const state = await buildGameStateForUser(req.authUser);
    const limit = Math.max(1, Math.min(15, Number(req.query.limit || 15)));
    const refresh = req.query.refresh === "true" || req.query.rebuild === "true";
    const mode = cleanText(req.query.mode, "season", 40);

    if (mode === "live") {
      const rows = await fetchEligibleOpponents(req.authUser.id, state.scores.league.key, state.scores.market_wealth, Number(state.profile?.goal_value || 0), limit);
      return res.json({
        ok: true,
        game_version: GAME_VERSION,
        mode: "live",
        league_key: state.scores.league.key,
        opponents: rows.map(publicProfileRow),
        fallback_required: rows.length < Math.min(3, limit)
      });
    }

    const rivals = await getSeasonOpponentsForUser(req.authUser.id, state, { limit, refresh });
    res.json({
      ok: true,
      game_version: GAME_VERSION,
      mode: "season",
      season_key: rivals.season_key,
      league_key: state.scores.league.key,
      opponents: rivals.rows.map(publicProfileRow),
      fallback_required: rivals.rows.length < Math.min(3, limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Gegner konnten nicht geladen werden." });
  }
});


router.get("/email-updates/status", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM game_email_preferences WHERE user_id = $1 LIMIT 1`,
      [req.authUser.id]
    ).catch(() => ({ rows: [] }));
    const pref = result.rows[0] || null;
    res.json({ ok: true, weekly_updates_enabled: pref?.weekly_updates_enabled === true, preference: pref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "E-Mail-Status konnte nicht geladen werden." });
  }
});

router.post("/email-updates/enable", requireAuth, async (req, res) => {
  try {
    const state = await buildGameStateForUser(req.authUser);
    let brevo = { attempted: false, ok: false };
    try { brevo = await postToBrevo(req.authUser, state); } catch (err) { brevo = { attempted: true, ok: false, error: err.message }; }

    const payload = { brevo, scores: state.scores, enabled_from: "wealthlist_button" };
    const result = await db.query(
      `
      INSERT INTO game_email_preferences (user_id, weekly_updates_enabled, brevo_subscribed_at, last_brevo_payload, created_at, updated_at)
      VALUES ($1,true,NOW(),$2::jsonb,NOW(),NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET weekly_updates_enabled = true,
          brevo_subscribed_at = NOW(),
          last_brevo_payload = EXCLUDED.last_brevo_payload,
          updated_at = NOW()
      RETURNING *
      `,
      [req.authUser.id, JSON.stringify(payload)]
    );
    await db.query(
      `UPDATE game_profiles SET email_updates_enabled = true, email_updates_enabled_at = COALESCE(email_updates_enabled_at, NOW()), brevo_last_submitted_at = CASE WHEN $2 THEN NOW() ELSE brevo_last_submitted_at END, updated_at = NOW() WHERE user_id = $1`,
      [req.authUser.id, brevo.ok === true]
    ).catch(() => {});
    res.json({ ok: true, weekly_updates_enabled: true, brevo, preference: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Wochenupdates konnten nicht aktiviert werden." });
  }
});

router.post("/email-updates/disable", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `
      INSERT INTO game_email_preferences (user_id, weekly_updates_enabled, brevo_unsubscribed_at, created_at, updated_at)
      VALUES ($1,false,NOW(),NOW(),NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET weekly_updates_enabled = false,
          brevo_unsubscribed_at = NOW(),
          updated_at = NOW()
      RETURNING *
      `,
      [req.authUser.id]
    );
    await db.query(
      `UPDATE game_profiles SET email_updates_enabled = false, email_updates_disabled_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [req.authUser.id]
    ).catch(() => {});
    res.json({ ok: true, weekly_updates_enabled: false, preference: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Wochenupdates konnten nicht deaktiviert werden." });
  }
});

router.post("/recompute", requireAuth, async (req, res) => {
  try {
    const state = await buildGameStateForUser(req.authUser);
    res.json({ ok: true, ...state });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Spielwerte konnten nicht neu berechnet werden." });
  }
});

router.post("/admin/recompute-all", requireAuth, async (req, res) => {
  try {
    if (String(req.authUser.role || "").toLowerCase() !== "admin") return safeError(res, 403, "Admin-Zugriff erforderlich.");
    const results = await recomputeAllGameProfiles(req.body.limit || 500);
    res.json({ ok: true, processed: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Spielwerte konnten nicht neu berechnet werden." });
  }
});

module.exports = router;
