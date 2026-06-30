const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { buildGameStateForUser } = require("./game-helpers");

const ME_ASSETS_VERSION = "me-assets-v3.4.6-autosave-dashboard-ux";


const ALLOWED_GAME_CLASSES = ["productive", "neutral", "commodity", "collector", "immo_self", "immo_rent", "consumer", "business", "crowdfunding", "debt"];
const ALLOWED_PUBLIC_VISIBILITY = ["private", "public", "category", "categories"];

function normalizeGameClass(value, type, assetDetails) {
  const explicit = optionalText(value);
  if (explicit) {
    if (!ALLOWED_GAME_CLASSES.includes(explicit)) throw new Error("Bitte wähle eine gültige Vermögensklasse aus.");
    return explicit;
  }

  const details = assetDetails || {};
  const kind = details.kind || details.asset_kind;
  const realEstate = details.real_estate || {};
  const vehicle = details.vehicle || {};

  if (["stock", "etf", "crypto"].includes(type)) return "productive";
  if (kind === "real_estate" || details.real_estate) {
    const usage = String(realEstate.usage || details.usage || "").toLowerCase();
    const rent = Number(realEstate.monthly_rent_income || 0);
    return usage.includes("rent") || usage.includes("vermietet") || rent > 0 ? "immo_rent" : "immo_self";
  }
  if (kind === "vehicle" || details.vehicle) {
    const collector = vehicle.is_collector === true || details.is_collector === true || String(vehicle.category || "").toLowerCase().includes("collector");
    return collector ? "collector" : "consumer";
  }
  if (kind === "business") return "business";
  if (kind === "crowdfunding_project") return "crowdfunding";
  if (kind === "debt") return "debt";
  return "neutral";
}

function normalizePublicVisibility(value) {
  const parsed = optionalText(value, "private");
  if (!ALLOWED_PUBLIC_VISIBILITY.includes(parsed)) throw new Error("Bitte wähle eine gültige Sichtbarkeit aus.");
  return parsed === "categories" ? "category" : parsed;
}

function optionalNumber(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Bitte gib eine gültige Zahl ein.");
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
  throw new Error("Bitte wähle Ja oder Nein.");
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
  throw new Error("Die Zusatzdaten konnten nicht verarbeitet werden.");
}

function normalizeEnum(value, allowed, fallback, fieldName) {
  const normalized = optionalText(value, fallback);
  if (!allowed.includes(normalized)) throw new Error("Bitte wähle einen gültigen Wert aus.");
  return normalized;
}

function parseProvider(value) {
  const parsed = optionalText(value);
  if (parsed === undefined || parsed === null || parsed === "manual") return null;
  if (!["finnhub", "coingecko", "twelvedata"].includes(parsed)) {
    throw new Error("Bitte wähle eine gültige Datenquelle aus.");
  }
  return parsed;
}



function validateNonNegativeNumbers(obj, path = "") {
  if (!obj || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    const label = path ? `${path}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      validateNonNegativeNumbers(value, label);
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    const numericKeys = [
      "quantity", "manual_value", "target_value", "purchase_price", "current_estimated_value", "current_value",
      "market_value", "current_property_value", "equity_paid", "remaining_debt", "financing_rate_percent",
      "repayment_months", "monthly_payment", "annual_value_growth_percent", "projected_annual_growth_percent",
      "projection_years", "holding_years", "monthly_rent_income", "monthly_operating_costs", "selling_cost_percent"
    ];
    if (!numericKeys.includes(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error("Beträge, Stückzahlen und Prozentwerte dürfen nicht negativ sein.",
    "Bitte wähle eine gültige Vermögensklasse aus.",
    "Bitte wähle eine gültige Sichtbarkeit aus.");
  }
}

function normalizeAlternativePayload(body) {
  const requestedType = optionalText(body.type, "stock");
  const assetDetails = optionalJson(body.asset_details, {});
  const kindFromDetails = assetDetails.kind || assetDetails.asset_kind;
  const kind = ["vehicle", "real_estate"].includes(requestedType)
    ? requestedType
    : (["vehicle", "real_estate"].includes(kindFromDetails) ? kindFromDetails : null);

  if (!kind) {
    return { dbType: requestedType, assetDetails };
  }

  assetDetails.kind = kind;
  return { dbType: "manual", assetDetails };
}

function safeAssetError(res, err, fallbackMessage) {
  console.error(err);

  const userMessages = [
    "Bitte gib eine gültige Zahl ein.",
    "Bitte wähle Ja oder Nein.",
    "Bitte wähle einen gültigen Wert aus.",
    "Bitte wähle eine gültige Datenquelle aus.",
    "Für Finnhub-Werte ist ein Ticker erforderlich.",
    "Für CoinGecko-Werte ist eine Coin ID erforderlich.",
    "Die Zusatzdaten konnten nicht verarbeitet werden.",
    "Beträge, Stückzahlen und Prozentwerte dürfen nicht negativ sein.",
    "Bitte wähle eine gültige Vermögensklasse aus.",
    "Bitte wähle eine gültige Sichtbarkeit aus."
  ];

  if (userMessages.includes(err.message)) {
    return res.status(400).json({ error: err.message });
  }

  return res.status(400).json({
    error: fallbackMessage,
    code: "ASSET_SAVE_FAILED"
  });
}

router.post("/", requireAuth, async (req, res) => {
  try {
    validateNonNegativeNumbers(req.body);

    const userId = req.authUser.id;
    const name = optionalText(req.body.name);
    if (!name) return res.status(400).json({ error: "Bitte gib einen Namen ein." });

    const mode = normalizeEnum(req.body.mode, ["portfolio", "watchlist"], "portfolio", "mode");
    const alternative = normalizeAlternativePayload(req.body);
    const type = normalizeEnum(alternative.dbType, ["stock", "etf", "crypto", "manual"], "stock", "type");
    const gameClass = normalizeGameClass(req.body.asset_game_class || req.body.game_class, type, alternative.assetDetails);
    const publicVisibility = normalizePublicVisibility(req.body.public_visibility);
    const isLiquid = optionalBoolean(req.body.is_liquid, gameClass === "neutral");
    alternative.assetDetails = { ...(alternative.assetDetails || {}), game_class: gameClass };

    let dataProvider = parseProvider(req.body.data_provider);
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

    if (!dataProvider) liveEnabled = false;

    if (dataProvider === "finnhub") {
      if (!symbol && !providerSymbol) throw new Error("Für Finnhub-Werte ist ein Ticker erforderlich.");
      if (!symbol) symbol = providerSymbol;
      if (!providerSymbol) providerSymbol = symbol;
      coinId = null;
    }

    if (dataProvider === "coingecko") {
      if (!coinId && !providerSymbol) throw new Error("Für CoinGecko-Werte ist eine Coin ID erforderlich.");
      if (!coinId) coinId = providerSymbol;
      if (!providerSymbol) providerSymbol = coinId;
      if (!symbol) symbol = providerSymbol;
    }

    const result = await db.query(
      `
      INSERT INTO assets (
        user_id, mode, name, type, symbol, provider_symbol, data_provider, coin_id,
        quantity, manual_value, target_value, price_currency, live_enabled, notes_internal,
        asset_group, asset_subgroup, asset_class, sector_block, region, abcd_rating, asset_details,
        asset_game_class, public_visibility, is_liquid
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
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
        JSON.stringify(alternative.assetDetails || {}),
        gameClass,
        publicVisibility,
        isLiquid
      ]
    );

    const gameState = await buildGameStateForUser(req.authUser).catch(() => null);
    res.status(201).json({ assets_version: ME_ASSETS_VERSION, ok: true, asset: result.rows[0], game_state: gameState });
  } catch (err) {
    return safeAssetError(res, err, "Der Wert konnte nicht gespeichert werden. Bitte prüfe die Eingaben.");
  }
});

router.post("/:id", requireAuth, async (req, res) => {
  try {
    validateNonNegativeNumbers(req.body);

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Ungültige Asset-ID." });

    const allowed = {
      name: optionalText,
      mode: (v) => normalizeEnum(v, ["portfolio", "watchlist"], "portfolio", "mode"),
      type: (v) => {
        const alternative = normalizeAlternativePayload({ ...req.body, type: v });
        req.__normalizedAssetDetails = alternative.assetDetails;
        return normalizeEnum(alternative.dbType, ["stock", "etf", "crypto", "manual"], "stock", "type");
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
      abcd_rating: optionalText,
      asset_details: (v) => JSON.stringify(req.__normalizedAssetDetails || normalizeAlternativePayload(req.body).assetDetails || optionalJson(v, {})),
      asset_game_class: (v) => normalizeGameClass(v, req.body.type || "manual", optionalJson(req.body.asset_details, {})),
      public_visibility: normalizePublicVisibility, // kept for API compatibility; Portfolio-Dashboard v3.4.6 no longer exposes this field
      is_liquid: (v) => optionalBoolean(v, null)
    };

    const fields = [];
    const values = [];

    for (const [field, parser] of Object.entries(allowed)) {
      if (req.body[field] !== undefined) {
        values.push(parser(req.body[field]));
        fields.push(`${field} = $${values.length}`);
      }
    }

    if (req.__normalizedAssetDetails && req.body.asset_details === undefined) {
      values.push(JSON.stringify(req.__normalizedAssetDetails));
      fields.push(`asset_details = $${values.length}`);
    }

    if (!fields.length) return res.status(400).json({ error: "Es wurden keine Änderungen übermittelt." });

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

    if (!result.rows.length) return res.status(404).json({ error: "Der Wert wurde nicht gefunden." });
    const gameState = await buildGameStateForUser(req.authUser).catch(() => null);
    res.json({ assets_version: ME_ASSETS_VERSION, ok: true, asset: result.rows[0], game_state: gameState });
  } catch (err) {
    return safeAssetError(res, err, "Der Wert konnte nicht aktualisiert werden. Bitte prüfe die Eingaben.");
  }
});

module.exports = router;
