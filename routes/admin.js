const router = require("express").Router();
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAdmin, signUserToken } = require("../middleware/auth");
const portfolioRoutes = require("./portfolio");
const refreshRoutes = require("./refresh-prices");

const ADMIN_VERSION = "admin-v3.3-login-multi-user";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function validatePassword(password, required = true) {
  const text = String(password || "");
  if (!text && !required) return null;
  if (text.length < 8) throw new Error("Passwort muss mindestens 8 Zeichen haben.");
  return text;
}

function publicAdminUser(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role || "user",
    is_active: user.is_active !== false,
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
    last_login_at: user.last_login_at || null
  };
}

function optionalNumber(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Bitte nur gültige Zahlen verwenden.");
  if (n < 0) throw new Error("Negative Werte sind nicht erlaubt.");
  return n;
}

function optionalText(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase().trim();
  if (["true", "1", "yes", "ja"].includes(normalized)) return true;
  if (["false", "0", "no", "nein"].includes(normalized)) return false;
  throw new Error("Ungültiger Ja/Nein-Wert.");
}

function normalizeEnum(value, allowed, fallback, fieldName) {
  const normalized = optionalText(value, fallback);
  if (!allowed.includes(normalized)) throw new Error(`${fieldName} muss einer dieser Werte sein: ${allowed.join(", ")}`);
  return normalized;
}

function parseProvider(value) {
  const parsed = optionalText(value);
  if (parsed === undefined || parsed === null || parsed === "manual" || parsed === "") return null;
  if (!["finnhub", "coingecko", "twelvedata"].includes(parsed)) {
    throw new Error("Datenquelle ist ungültig.");
  }
  return parsed;
}

function parseAssetDetails(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function normalizeAssetTypeAndDetails(reqBody) {
  const incomingType = optionalText(reqBody.type, "stock");
  let assetDetails = parseAssetDetails(reqBody.asset_details);
  let technicalType = incomingType;

  if (incomingType === "vehicle" || incomingType === "real_estate") {
    technicalType = "manual";
    assetDetails = { ...assetDetails, kind: incomingType };
  }

  technicalType = normalizeEnum(technicalType, ["stock", "etf", "crypto", "manual"], "stock", "type");
  return { technicalType, assetDetails };
}

function safeError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

router.post("/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!EMAIL_REGEX.test(email) || !password) {
      return safeError(res, 400, "E-Mail und Passwort sind erforderlich.");
    }

    const result = await db.query(
      `
      SELECT id, email, password_hash, display_name, role, is_active, created_at, updated_at, last_login_at
      FROM portfolio_users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    const user = result.rows[0];
    if (!user || !user.password_hash || user.is_active === false) {
      return safeError(res, 401, "Login fehlgeschlagen.");
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return safeError(res, 401, "Login fehlgeschlagen.");

    if (String(user.role || "").toLowerCase() !== "admin") {
      return safeError(res, 403, "Dieser Account hat keine Admin-Berechtigung.");
    }

    await db.query("UPDATE portfolio_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1", [user.id]);
    const token = signUserToken(user);

    res.json({ admin_version: ADMIN_VERSION, ok: true, token, user: publicAdminUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Admin-Login konnte nicht ausgeführt werden." });
  }
});

router.get("/me", requireAdmin, async (req, res) => {
  res.json({ admin_version: ADMIN_VERSION, ok: true, user: publicAdminUser(req.authUser) });
});

router.get("/users", requireAdmin, async (req, res) => {
  try {
    const q = cleanText(req.query.q, "");
    const params = [];
    let where = "";
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where = `WHERE lower(u.email) LIKE $1 OR lower(COALESCE(u.display_name,'')) LIKE $1`;
    }

    const result = await db.query(
      `
      SELECT
        u.id, u.email, u.display_name, u.role, u.is_active, u.created_at, u.updated_at, u.last_login_at,
        COUNT(a.id)::int AS asset_count,
        COUNT(a.id) FILTER (WHERE a.mode = 'portfolio')::int AS portfolio_asset_count,
        COUNT(a.id) FILTER (WHERE a.mode = 'watchlist')::int AS watchlist_asset_count
      FROM portfolio_users u
      LEFT JOIN assets a ON a.user_id = u.id
      ${where}
      GROUP BY u.id
      ORDER BY u.id ASC
      `,
      params
    );

    res.json({ admin_version: ADMIN_VERSION, ok: true, users: result.rows.map(publicAdminUserWithCounts) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Nutzer konnten nicht geladen werden." });
  }
});

function publicAdminUserWithCounts(user) {
  return {
    ...publicAdminUser(user),
    asset_count: Number(user.asset_count || 0),
    portfolio_asset_count: Number(user.portfolio_asset_count || 0),
    watchlist_asset_count: Number(user.watchlist_asset_count || 0)
  };
}

router.post("/users", requireAdmin, async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = validatePassword(req.body?.password, true);
    const displayName = cleanText(req.body?.display_name, email.split("@")[0]);
    const role = normalizeEnum(req.body?.role, ["user", "admin"], "user", "role");
    const isActive = optionalBoolean(req.body?.is_active, true);

    if (!EMAIL_REGEX.test(email)) return safeError(res, 400, "Bitte eine gültige E-Mail-Adresse verwenden.");

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `
      INSERT INTO portfolio_users (email, password_hash, display_name, role, is_active, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, email, display_name, role, is_active, created_at, updated_at, last_login_at
      `,
      [email, passwordHash, displayName, role, isActive]
    );

    res.status(201).json({ admin_version: ADMIN_VERSION, ok: true, user: publicAdminUser(result.rows[0]) });
  } catch (err) {
    const msg = String(err.message || "").toLowerCase().includes("duplicate")
      ? "Diese E-Mail-Adresse existiert bereits."
      : "Nutzer konnte nicht angelegt werden.";
    res.status(400).json({ ok: false, error: msg });
  }
});

router.post("/users/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Nutzer-ID.");

    const fields = [];
    const values = [];

    if (req.body.email !== undefined) {
      const email = cleanEmail(req.body.email);
      if (!EMAIL_REGEX.test(email)) return safeError(res, 400, "Bitte eine gültige E-Mail-Adresse verwenden.");
      values.push(email); fields.push(`email = $${values.length}`);
    }

    if (req.body.display_name !== undefined) {
      values.push(cleanText(req.body.display_name, "")); fields.push(`display_name = $${values.length}`);
    }

    if (req.body.role !== undefined) {
      values.push(normalizeEnum(req.body.role, ["user", "admin"], "user", "role")); fields.push(`role = $${values.length}`);
    }

    if (req.body.is_active !== undefined) {
      values.push(optionalBoolean(req.body.is_active, true)); fields.push(`is_active = $${values.length}`);
    }

    if (req.body.password !== undefined && String(req.body.password || "").trim() !== "") {
      const passwordHash = await bcrypt.hash(validatePassword(req.body.password, true), 12);
      values.push(passwordHash); fields.push(`password_hash = $${values.length}`);
    }

    if (!fields.length) return safeError(res, 400, "Keine Änderungen angegeben.");

    fields.push("updated_at = NOW()");
    values.push(id);

    const result = await db.query(
      `UPDATE portfolio_users SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING id, email, display_name, role, is_active, created_at, updated_at, last_login_at`,
      values
    );

    if (!result.rows.length) return safeError(res, 404, "Nutzer wurde nicht gefunden.");
    res.json({ admin_version: ADMIN_VERSION, ok: true, user: publicAdminUser(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Nutzer konnte nicht gespeichert werden." });
  }
});

router.get("/users/:id/portfolio", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) return safeError(res, 400, "Ungültige Nutzer-ID.");
    const payload = await portfolioRoutes.buildPortfolioResponse(userId);
    res.json({ ...payload, admin_version: ADMIN_VERSION, selected_user_id: userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Portfolio konnte nicht geladen werden." });
  }
});

router.get("/users/:id/refresh-prices", requireAdmin, async (req, res) => {
  req.query.user_id = String(req.params.id);
  return refreshRoutes.handleRefreshPrices(req, res);
});

function buildAssetPayload(reqBody) {
  const { technicalType, assetDetails } = normalizeAssetTypeAndDetails(reqBody);
  let dataProvider = parseProvider(reqBody.data_provider);
  let symbol = optionalText(reqBody.symbol);
  let providerSymbol = optionalText(reqBody.provider_symbol);
  let coinId = optionalText(reqBody.coin_id);
  let liveEnabled = optionalBoolean(reqBody.live_enabled, Boolean(dataProvider));

  if (technicalType === "manual") {
    dataProvider = null;
    providerSymbol = null;
    coinId = null;
    liveEnabled = false;
  }

  if (!dataProvider) liveEnabled = false;

  if (dataProvider === "finnhub") {
    if (!symbol && !providerSymbol) throw new Error("Für Finnhub fehlt Symbol oder Provider-Symbol.");
    if (!symbol) symbol = providerSymbol;
    if (!providerSymbol) providerSymbol = symbol;
    coinId = null;
  }

  if (dataProvider === "coingecko") {
    if (!coinId && !providerSymbol) throw new Error("Für CoinGecko fehlt die CoinGecko-ID.");
    if (!coinId) coinId = providerSymbol;
    if (!providerSymbol) providerSymbol = coinId;
    if (!symbol) symbol = providerSymbol;
  }

  return {
    name: optionalText(reqBody.name),
    mode: normalizeEnum(reqBody.mode, ["portfolio", "watchlist"], "watchlist", "mode"),
    type: technicalType,
    symbol,
    provider_symbol: providerSymbol,
    data_provider: dataProvider,
    coin_id: coinId,
    quantity: optionalNumber(reqBody.quantity, 0),
    manual_value: optionalNumber(reqBody.manual_value, null),
    target_value: optionalNumber(reqBody.target_value, null),
    price_currency: String(optionalText(reqBody.price_currency, "EUR") || "EUR").toUpperCase(),
    live_enabled: liveEnabled,
    notes_internal: optionalText(reqBody.notes_internal),
    asset_group: optionalText(reqBody.asset_group),
    asset_subgroup: optionalText(reqBody.asset_subgroup),
    asset_class: optionalText(reqBody.asset_class),
    sector_block: optionalText(reqBody.sector_block),
    region: optionalText(reqBody.region),
    abcd_rating: optionalText(reqBody.abcd_rating),
    asset_details: assetDetails
  };
}

router.post("/users/:id/assets", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) return safeError(res, 400, "Ungültige Nutzer-ID.");

    const payload = buildAssetPayload(req.body || {});
    if (!payload.name) return safeError(res, 400, "Name fehlt.");

    const result = await db.query(
      `
      INSERT INTO assets (
        user_id, mode, name, type, symbol, provider_symbol, data_provider, coin_id,
        quantity, manual_value, target_value, price_currency, live_enabled, notes_internal,
        asset_group, asset_subgroup, asset_class, sector_block, region, abcd_rating, asset_details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      RETURNING *
      `,
      [
        userId, payload.mode, payload.name, payload.type, payload.symbol, payload.provider_symbol, payload.data_provider, payload.coin_id,
        payload.quantity, payload.manual_value, payload.target_value, payload.price_currency, payload.live_enabled, payload.notes_internal,
        payload.asset_group, payload.asset_subgroup, payload.asset_class, payload.sector_block, payload.region, payload.abcd_rating,
        JSON.stringify(payload.asset_details || {})
      ]
    );

    res.status(201).json({ admin_version: ADMIN_VERSION, ok: true, asset: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Wert konnte nicht angelegt werden. Bitte Eingaben prüfen." });
  }
});

router.post("/users/:userId/assets/:assetId", requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const assetId = Number(req.params.assetId);
    if (!Number.isInteger(userId) || !Number.isInteger(assetId)) return safeError(res, 400, "Ungültige ID.");

    const allowed = {
      name: optionalText,
      mode: (v) => normalizeEnum(v, ["portfolio", "watchlist"], "watchlist", "mode"),
      type: (v) => {
        if (v === "vehicle" || v === "real_estate") return "manual";
        return normalizeEnum(v, ["stock", "etf", "crypto", "manual"], "manual", "type");
      },
      quantity: (v) => optionalNumber(v, null),
      manual_value: (v) => optionalNumber(v, null),
      target_value: (v) => optionalNumber(v, null),
      price_currency: (v) => {
        const parsed = optionalText(v);
        return parsed === undefined || parsed === null ? parsed : String(parsed).toUpperCase();
      },
      symbol: optionalText,
      provider_symbol: optionalText,
      coin_id: optionalText,
      data_provider: parseProvider,
      live_enabled: (v) => optionalBoolean(v, null),
      notes_internal: optionalText,
      asset_group: optionalText,
      asset_subgroup: optionalText,
      asset_class: optionalText,
      sector_block: optionalText,
      region: optionalText,
      abcd_rating: optionalText
    };

    const fields = [];
    const values = [];

    for (const [field, parser] of Object.entries(allowed)) {
      if (req.body[field] !== undefined) {
        values.push(parser(req.body[field]));
        fields.push(`${field} = $${values.length}`);
      }
    }

    if (req.body.asset_details !== undefined) {
      const assetDetails = parseAssetDetails(req.body.asset_details);
      if (req.body.type === "vehicle" || req.body.type === "real_estate") assetDetails.kind = req.body.type;
      values.push(JSON.stringify(assetDetails));
      fields.push(`asset_details = $${values.length}::jsonb`);
    }

    if (!fields.length) return safeError(res, 400, "Keine Änderungen angegeben.");

    values.push(userId);
    values.push(assetId);

    const result = await db.query(
      `UPDATE assets SET ${fields.join(", ")} WHERE user_id = $${values.length - 1} AND id = $${values.length} RETURNING *`,
      values
    );

    if (!result.rows.length) return safeError(res, 404, "Wert wurde nicht gefunden.");
    res.json({ admin_version: ADMIN_VERSION, ok: true, asset: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Wert konnte nicht gespeichert werden. Bitte Eingaben prüfen." });
  }
});

module.exports = router;
