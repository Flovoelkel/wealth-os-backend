const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const ME_ASSETS_VERSION = "me-assets-v3.2-alternative-assets";

function optionalNumber(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value: ${value}`);
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
  throw new Error(`Invalid boolean value: ${value}`);
}

function optionalJson(value, fallback = {}) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  throw new Error("asset_details must be a JSON object");
}

function normalizeEnum(value, allowed, fallback, fieldName) {
  const normalized = optionalText(value, fallback);
  if (!allowed.includes(normalized)) throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
  return normalized;
}

function parseProvider(value) {
  const parsed = optionalText(value);
  if (parsed === undefined || parsed === null || parsed === "manual") return null;
  if (!["finnhub", "coingecko", "twelvedata"].includes(parsed)) {
    throw new Error("data_provider must be finnhub, coingecko, twelvedata or empty/manual");
  }
  return parsed;
}

router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.authUser.id;
    const name = optionalText(req.body.name);
    if (!name) return res.status(400).json({ error: "name is required" });

    const mode = normalizeEnum(req.body.mode, ["portfolio", "watchlist"], "watchlist", "mode");
    const type = normalizeEnum(req.body.type, ["stock", "etf", "crypto", "manual", "vehicle", "real_estate"], "stock", "type");

    let dataProvider = parseProvider(req.body.data_provider);
    let symbol = optionalText(req.body.symbol);
    let providerSymbol = optionalText(req.body.provider_symbol);
    let coinId = optionalText(req.body.coin_id);
    let liveEnabled = optionalBoolean(req.body.live_enabled, Boolean(dataProvider));

    if (type === "manual" || type === "vehicle" || type === "real_estate") {
      dataProvider = null;
      providerSymbol = null;
      coinId = null;
      liveEnabled = false;
    }

    if (!dataProvider) liveEnabled = false;

    if (dataProvider === "finnhub") {
      if (!symbol && !providerSymbol) throw new Error("symbol or provider_symbol is required for Finnhub assets");
      if (!symbol) symbol = providerSymbol;
      if (!providerSymbol) providerSymbol = symbol;
      coinId = null;
    }

    if (dataProvider === "coingecko") {
      if (!coinId && !providerSymbol) throw new Error("coin_id or provider_symbol is required for CoinGecko assets");
      if (!coinId) coinId = providerSymbol;
      if (!providerSymbol) providerSymbol = coinId;
      if (!symbol) symbol = providerSymbol;
    }

    const result = await db.query(
      `
      INSERT INTO assets (
        user_id, mode, name, type, symbol, provider_symbol, data_provider, coin_id,
        quantity, manual_value, target_value, price_currency, live_enabled, notes_internal,
        asset_group, asset_subgroup, asset_class, sector_block, region, abcd_rating, asset_details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
        optionalNumber(req.body.quantity, 0),
        optionalNumber(req.body.manual_value, null),
        optionalNumber(req.body.target_value, null),
        String(optionalText(req.body.price_currency, "EUR") || "EUR").toUpperCase(),
        liveEnabled,
        optionalText(req.body.notes_internal),
        optionalText(req.body.asset_group),
        optionalText(req.body.asset_subgroup),
        optionalText(req.body.asset_class),
        optionalText(req.body.sector_block),
        optionalText(req.body.region),
        optionalText(req.body.abcd_rating),
        JSON.stringify(optionalJson(req.body.asset_details, {}))
      ]
    );

    res.status(201).json({ assets_version: ME_ASSETS_VERSION, ok: true, asset: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Asset create failed", details: err.message });
  }
});

router.post("/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "asset id is required" });

    const allowed = {
      name: optionalText,
      mode: (v) => normalizeEnum(v, ["portfolio", "watchlist"], "watchlist", "mode"),
      type: (v) => normalizeEnum(v, ["stock", "etf", "crypto", "manual", "vehicle", "real_estate"], "stock", "type"),
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
      abcd_rating: optionalText,
      asset_details: (v) => JSON.stringify(optionalJson(v, {}))
    };

    const fields = [];
    const values = [];

    for (const [field, parser] of Object.entries(allowed)) {
      if (req.body[field] !== undefined) {
        values.push(parser(req.body[field]));
        fields.push(`${field} = $${values.length}`);
      }
    }

    if (!fields.length) return res.status(400).json({ error: "No update fields provided" });

    values.push(req.authUser.id);
    values.push(id);

    const result = await db.query(
      `
      UPDATE assets
      SET ${fields.join(", ")}
      WHERE user_id = $${values.length - 1}
        AND id = $${values.length}
      RETURNING *
      `,
      values
    );

    if (!result.rows.length) return res.status(404).json({ error: "Asset not found" });
    res.json({ assets_version: ME_ASSETS_VERSION, ok: true, asset: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Asset update failed", details: err.message });
  }
});

module.exports = router;
