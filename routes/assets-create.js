const router = require("express").Router();
const db = require("../db");

const CREATE_VERSION = "asset-create-v1.7";

function requireAdminToken(req, res, next) {
  const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({
      error: "ADMIN_DASHBOARD_TOKEN is not configured"
    });
  }

  const providedToken =
    req.query.admin_token ||
    req.headers["x-admin-token"] ||
    req.body?.admin_token;

  if (providedToken !== expectedToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function optionalNumber(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
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
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function normalizeEnum(value, allowed, fallback, fieldName) {
  const normalized = optionalText(value, fallback);
  if (!allowed.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
  }
  return normalized;
}

router.post("/", requireAdminToken, async (req, res) => {
  try {
    const userId = Number(req.body.user_id || 1);

    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: "user_id must be an integer" });
    }

    const name = optionalText(req.body.name);
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const mode = normalizeEnum(
      req.body.mode,
      ["portfolio", "watchlist"],
      "watchlist",
      "mode"
    );

    const type = normalizeEnum(
      req.body.type,
      ["stock", "etf", "crypto", "manual"],
      "stock",
      "type"
    );

    let dataProvider = optionalText(req.body.data_provider);
    if (dataProvider === "manual") dataProvider = null;

    if (dataProvider !== null && !["finnhub", "coingecko", "twelvedata"].includes(dataProvider)) {
      throw new Error("data_provider must be finnhub, coingecko, twelvedata or empty/manual");
    }

    let symbol = optionalText(req.body.symbol);
    let providerSymbol = optionalText(req.body.provider_symbol);
    let coinId = optionalText(req.body.coin_id);
    let liveEnabled = optionalBoolean(req.body.live_enabled, Boolean(dataProvider));

    if (type === "manual") {
      dataProvider = null;
      providerSymbol = null;
      coinId = null;
      liveEnabled = false;
    }

    if (!dataProvider) {
      liveEnabled = false;
    }

    if (dataProvider === "finnhub") {
      if (!symbol && !providerSymbol) {
        throw new Error("symbol or provider_symbol is required for Finnhub assets");
      }
      if (!symbol) symbol = providerSymbol;
      if (!providerSymbol) providerSymbol = symbol;
      coinId = null;
    }

    if (dataProvider === "coingecko") {
      if (!coinId && !providerSymbol) {
        throw new Error("coin_id or provider_symbol is required for CoinGecko assets");
      }
      if (!coinId) coinId = providerSymbol;
      if (!providerSymbol) providerSymbol = coinId;
      if (!symbol) symbol = providerSymbol;
    }

    const quantity = optionalNumber(req.body.quantity, 0);
    const manualValue = optionalNumber(req.body.manual_value, null);
    const targetValue = optionalNumber(req.body.target_value, null);
    const priceCurrency = String(optionalText(req.body.price_currency, "EUR") || "EUR").toUpperCase();
    const notesInternal = optionalText(req.body.notes_internal);

    const result = await db.query(
      `
      INSERT INTO assets (
        user_id,
        mode,
        name,
        type,
        symbol,
        provider_symbol,
        data_provider,
        coin_id,
        quantity,
        manual_value,
        target_value,
        price_currency,
        live_enabled,
        notes_internal
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14
      )
      RETURNING *
      `,
      [
        userId,
        mode,
        name,
        type,
        symbol,
        providerSymbol,
        dataProvider,
        coinId,
        quantity,
        manualValue,
        targetValue,
        priceCurrency,
        liveEnabled,
        notesInternal
      ]
    );

    res.status(201).json({
      create_version: CREATE_VERSION,
      ok: true,
      asset: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({
      error: "Asset create failed",
      details: err.message
    });
  }
});

module.exports = router;
