const router = require("express").Router();
const axios = require("axios");
const db = require("../db");

const MARKET_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quantityToNumber(value) {
  const n = toNumberOrNull(value);
  return n === null ? 0 : n;
}

function round(value, decimals = 2) {
  const n = toNumberOrNull(value);
  if (n === null) return null;
  return Number(n.toFixed(decimals));
}

function getCacheKey(asset) {
  return `${asset.type}:${asset.coin_id || asset.symbol || asset.id}`;
}

function getCached(asset) {
  const key = getCacheKey(asset);
  const cached = MARKET_CACHE.get(key);

  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  if (age > CACHE_TTL_MS) return null;

  return cached.data;
}

function setCached(asset, data) {
  const key = getCacheKey(asset);

  MARKET_CACHE.set(key, {
    timestamp: Date.now(),
    data
  });
}

async function getCryptoPrice(asset) {
  if (!asset.coin_id) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: "coingecko",
      source_error: "Missing coin_id",
      last_updated_at: null
    };
  }

  const url = "https://api.coingecko.com/api/v3/simple/price";

  const headers = {};

  if (process.env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  }

  const response = await axios.get(url, {
    params: {
      ids: asset.coin_id,
      vs_currencies: "usd",
      include_24hr_change: "true",
      include_last_updated_at: "true"
    },
    headers,
    timeout: 8000
  });

  const data = response.data?.[asset.coin_id];

  if (!data || data.usd === undefined) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: "coingecko",
      source_error: `No price returned for coin_id ${asset.coin_id}`,
      last_updated_at: null
    };
  }

  return {
    price: toNumberOrNull(data.usd),
    previous_close: null,
    day_change_abs: null,
    day_change_percent: toNumberOrNull(data.usd_24h_change),
    source: "coingecko",
    source_error: null,
    last_updated_at: data.last_updated_at || null
  };
}

async function getFinnhubQuote(asset) {
  const token = process.env.FINNHUB_API_KEY;

  if (!token) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: "finnhub",
      source_error: "Missing FINNHUB_API_KEY",
      last_updated_at: null
    };
  }

  if (!asset.symbol) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: "finnhub",
      source_error: "Missing symbol",
      last_updated_at: null
    };
  }

  const url = "https://finnhub.io/api/v1/quote";

  const response = await axios.get(url, {
    params: {
      symbol: asset.symbol,
      token
    },
    timeout: 8000
  });

  const data = response.data || {};
  const price = toNumberOrNull(data.c);

  if (price === null || price === 0) {
    return {
      price: null,
      previous_close: toNumberOrNull(data.pc),
      day_change_abs: toNumberOrNull(data.d),
      day_change_percent: toNumberOrNull(data.dp),
      source: "finnhub",
      source_error: `No valid quote returned for symbol ${asset.symbol}`,
      last_updated_at: data.t || null
    };
  }

  return {
    price,
    previous_close: toNumberOrNull(data.pc),
    day_change_abs: toNumberOrNull(data.d),
    day_change_percent: toNumberOrNull(data.dp),
    source: "finnhub",
    source_error: null,
    last_updated_at: data.t || null
  };
}

async function getManualPrice(asset) {
  return {
    price: toNumberOrNull(asset.manual_value),
    previous_close: null,
    day_change_abs: 0,
    day_change_percent: 0,
    source: "manual",
    source_error: null,
    last_updated_at: null
  };
}

async function getMarketData(asset) {
  const cached = getCached(asset);
  if (cached) return cached;

  try {
    let data;

    if (asset.type === "crypto") {
      data = await getCryptoPrice(asset);
    } else if (asset.type === "stock" || asset.type === "etf") {
      data = await getFinnhubQuote(asset);
    } else if (asset.type === "manual") {
      data = await getManualPrice(asset);
    } else {
      data = {
        price: null,
        previous_close: null,
        day_change_abs: null,
        day_change_percent: null,
        source: null,
        source_error: `Unsupported asset type: ${asset.type}`,
        last_updated_at: null
      };
    }

    if (!data.source_error && data.price !== null) {
      setCached(asset, data);
    }

    return data;
  } catch (err) {
    const status = err.response?.status || null;

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: asset.type === "crypto" ? "coingecko" : "finnhub",
      source_error: status
        ? `Request failed with status code ${status}`
        : err.message,
      last_updated_at: null
    };
  }
}

router.get("/", async (req, res) => {
  try {
    const userId = req.query.user_id || 1;

    const result = await db.query(
      "SELECT * FROM assets WHERE user_id = $1 ORDER BY id ASC",
      [userId]
    );

    const enrichedAssets = await Promise.all(
      result.rows.map(async (asset) => {
        const quantity = quantityToNumber(asset.quantity);
        const market = await getMarketData(asset);

        let price = market.price;
        let source = market.source;
        let sourceError = market.source_error || null;
        
        const manualFallback = toNumberOrNull(asset.manual_value);
        
        if (price === null && manualFallback !== null) {
          price = manualFallback;
          source = "manual_fallback";
          sourceError = market.source_error
            ? `External source failed: ${market.source_error}`
            : null;
        }
        
        const value = price === null ? null : price * quantity;

        let dayChangeValue = null;

        if (
          market.day_change_abs !== null &&
          market.day_change_abs !== undefined
        ) {
          dayChangeValue = market.day_change_abs * quantity;
        } else if (
          value !== null &&
          market.day_change_percent !== null &&
          market.day_change_percent !== undefined
        ) {
          dayChangeValue = value * (market.day_change_percent / 100);
        }

        return {
          id: asset.id,
          user_id: asset.user_id,
          name: asset.name,
          type: asset.type,
          symbol: asset.symbol,
          coin_id: asset.coin_id,
          quantity,
          manual_value:
            asset.manual_value === null
              ? null
              : toNumberOrNull(asset.manual_value),

          price: round(price, 4),
          value: round(value, 2),
          day_change_abs: round(market.day_change_abs, 4),
          day_change_percent: round(market.day_change_percent, 4),
          day_change_value: round(dayChangeValue, 2),

          source,
          source_error: sourceError,
          last_updated_at: market.last_updated_at || null
        };
      })
    );

    const totalValue = enrichedAssets.reduce((sum, asset) => {
      return sum + (asset.value || 0);
    }, 0);

    const totalDayChangeValue = enrichedAssets.reduce((sum, asset) => {
      return sum + (asset.day_change_value || 0);
    }, 0);

    const totalDayChangePercent =
      totalValue > 0 && totalValue - totalDayChangeValue !== 0
        ? (totalDayChangeValue / (totalValue - totalDayChangeValue)) * 100
        : null;

    res.json({
      user_id: Number(userId),
      currency: "USD",
      total_value: round(totalValue, 2),
      total_day_change_value: round(totalDayChangeValue, 2),
      total_day_change_percent: round(totalDayChangePercent, 4),
      assets: enrichedAssets
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Portfolio engine error",
      details: err.message
    });
  }
});

module.exports = router;
