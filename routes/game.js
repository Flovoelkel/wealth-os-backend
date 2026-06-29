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
const ALLOWED_GAME_MODES = ["npc", "global", "league"];
const ALLOWED_GAME_CLASSES = GAME_CLASSES.map((item) => item.key);

function normalizeEnum(value, allowed, fallback) {
  const text = cleanText(value, fallback, 80);
  if (!allowed.includes(text)) return fallback;
  return text;
}

function positiveNumber(value, fallback = 0) {
  const n = toNumber(value, fallback);
  if (!Number.isFinite(n) || n < 0) throw new Error("Negative oder ungÃžltige Werte sind nicht erlaubt.");
  return n;
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
            interests = COALESCE($4::jsonb, interests),
            updated_at = NOW()
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
    res.status(201).json({ ok: true, asset: result.rows[0], game_state: state });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Asset konnte nicht gespeichert werden. Bitte Eingaben prÃžfen." });
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
          imported_local_state = $6::jsonb,
          updated_at = NOW()
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
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 15)));
    const leagueKey = req.query.league_key || state.scores.league.key;

    const result = await db.query(
      `
      SELECT gp.*, u.display_name
      FROM game_profiles gp
      JOIN portfolio_users u ON u.id = gp.user_id
      WHERE u.is_active IS DISTINCT FROM false
        AND gp.user_id <> $1
        AND gp.league_key = $2
      ORDER BY ABS(COALESCE(gp.market_wealth,0) - $3) ASC, COALESCE(gp.market_wealth,0) ASC
      LIMIT $4
      `,
      [req.authUser.id, leagueKey, state.scores.market_wealth, limit]
    );

    res.json({
      ok: true,
      league_key: leagueKey,
      opponents: result.rows.map(publicProfileRow),
      fallback_required: result.rows.length < Math.min(3, limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Gegner konnten nicht geladen werden." });
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
