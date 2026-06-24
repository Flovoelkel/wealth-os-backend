const router = require("express").Router();
const db = require("../db");

const UPDATE_VERSION = "asset-update-v1.8-mode-move";

function requireAdminToken(req, res, next) {
  const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({ error: "ADMIN_DASHBOARD_TOKEN is not configured" });
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

function optionalNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value: ${value}`);
  return n;
}

function optionalText(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function optionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase().trim();
  if (["true", "1", "yes", "ja"].includes(normalized)) return true;
  if (["false", "0", "no", "nein"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function optionalEnum(value, allowed, fieldName) {
  const parsed = optionalText(value);
  if (parsed === undefined || parsed === null) return parsed;
  if (!allowed.includes(parsed)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
  }
  return parsed;
}

function parseProvider(value) {
  const parsed = optionalText(value);
  if (parsed === undefined || parsed === null || parsed === "manual") return null;
  if (!["finnhub", "coingecko", "twelvedata"].includes(parsed)) {
    throw new Error("data_provider must be finnhub, coingecko, twelvedata or empty/manual");
  }
  return parsed;
}

router.post("/", requireAdminToken, async (req, res) => {
  try {
    const id = Number(req.body.id);
    const userId = Number(req.body.user_id || 1);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id is required" });
    }

    const allowed = {
      name: optionalText,
      mode: (v) => optionalEnum(v, ["portfolio", "watchlist"], "mode"),
      type: (v) => optionalEnum(v, ["stock", "etf", "crypto", "manual"], "type"),
      quantity: optionalNumber,
      manual_value: optionalNumber,
      target_value: optionalNumber,
      price_currency: (v) => {
        const parsed = optionalText(v);
        return parsed === undefined || parsed === null ? parsed : String(parsed).toUpperCase();
      },
      symbol: optionalText,
      provider_symbol: optionalText,
      coin_id: optionalText,
      data_provider: parseProvider,
      live_enabled: optionalBoolean,
      provider_mic_code: optionalText,
      provider_exchange: optionalText,
      notes_internal: optionalText
    };

    const fields = [];
    const values = [];

    for (const [field, parser] of Object.entries(allowed)) {
      if (req.body[field] !== undefined) {
        values.push(parser(req.body[field]));
        fields.push(`${field} = $${values.length}`);
      }
    }

    if (!fields.length) {
      return res.status(400).json({ error: "No update fields provided" });
    }

    values.push(userId);
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

    if (!result.rows.length) {
      return res.status(404).json({ error: "Asset not found" });
    }

    res.json({
      update_version: UPDATE_VERSION,
      ok: true,
      asset: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({
      error: "Asset update failed",
      details: err.message
    });
  }
});

module.exports = router;
