const router = require("express").Router();
const axios = require("axios");
const db = require("../db");

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(decimals));
}

async function getCryptoPrice(asset) {
  if (!asset.coin_id) {
    return {
      price: null,
      day_change_percent: null,
      source: "coingecko",
      source_error: "Missing coin_id"
    };
  }

  const url = "https://api.coingecko.com/api/v3/simple/price";

  const response = await axios.get(url, {
    params: {
      ids: asset.coin_id,
      vs_currencies: "usd",
      include_24hr_change: "true",
      include_last_updated_at: "true"
    },
    timeout: 8000
  });

  const data = response.data?.[asset.coin_id];

  if (!data || data.usd === undefined) {
    return {
      price: null,
      day_change_percent: null,
      source: "coingecko",
      source_error: `No price returned for coin_id ${asset.coin_id}`
    };
  }

  return {
    price: toNumber(data.usd),
    day_change_percent: data.usd_24h_change === null ? null : toNumber(data.usd_24h_change),
    last_updated_at: data.last_updated_at || null,
    source: "coingecko",
    source_error: null
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
      source_error: "Missing FINNHUB_API_KEY"
    };
  }

  if (!asset.symbol) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: "finnhub",
      source_error: "Missing symbol"
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

  if (!data.c || data.c === 0) {
    return {
      price: null,
      previous_close: data.pc ?? null,
      day_change_abs: data.d ?? null,
      day_change_percent: data.dp ?? null,
      source: "finnhub",
      source_error: `No valid quote returned for symbol ${asset.symbol}`
    };
  }

  return {
    price: toNumber(data.c),
    previous_close: data.pc === undefined ? null : toNumber(data.pc),
    day_change_abs: data.d === undefined ? null : toNumber(data.d),
    day_change_percent: data.dp === undefined ? null : toNumber(data.dp),
    source: "finnhub",
    source_error: null
  };
}

async function getManualPrice(asset) {
  return {
    price: toNumber(asset.manual_value),
    previous_close: null,
    day_change_abs: 0,
    day_change_percent: 0,
    source: "manual",
    source_error: null
  };
}

async function getMarketData(asset) {
  try {
    if (asset.type === "crypto") {
      return await getCryptoPrice(asset);
    }

    if (asset.type === "stock" || asset.type === "etf") {
      return await getFinnhubQuote(asset);
    }

    if (asset.type === "manual") {
      return await getManualPrice(asset);
    }

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: null,
      source_error: `Unsupported asset type: ${asset.type}`
    };
  } catch (err) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: null,
      source_error: err.message
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
        const quantity = toNumber(asset.quantity);
        const market = await getMarketData(asset);

        const price = market.price;
        const value = price === null ? null : price * quantity;

        let dayChangeValue = null;

        if (market.day_change_abs !== null && market.day_change_abs !== undefined) {
          dayChangeValue = market.day_change_abs * quantity;
        } else if (value !== null && market.day_change_percent !== null && market.day_change_percent !== undefined) {
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
          manual_value: asset.manual_value === null ? null : toNumber(asset.manual_value),

          price: round(price, 4),
          value: round(value, 2),
          day_change_abs: round(market.day_change_abs, 4),
          day_change_percent: round(market.day_change_percent, 4),
          day_change_value: round(dayChangeValue, 2),

          source: market.source,
          source_error: market.source_error || null,
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
      totalValue > 0 ? (totalDayChangeValue / (totalValue - totalDayChangeValue)) * 100 : null;

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
