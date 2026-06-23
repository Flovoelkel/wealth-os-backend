const router = require("express").Router();
const axios = require("axios");
const db = require("../db");

const REFRESH_VERSION = "price-refresh-v1.4";
const FINNHUB_MIN_INTERVAL_MS = 1200;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFinnhubQuote(symbol) {
  const token = process.env.FINNHUB_API_KEY;

  if (!token) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source_error: "Missing FINNHUB_API_KEY",
      last_updated_at: null
    };
  }

  try {
    const response = await axios.get("https://finnhub.io/api/v1/quote", {
      params: {
        symbol,
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
        source_error: `No valid quote returned for symbol ${symbol}`,
        last_updated_at: data.t || null
      };
    }

    return {
      price,
      previous_close: toNumberOrNull(data.pc),
      day_change_abs: toNumberOrNull(data.d),
      day_change_percent: toNumberOrNull(data.dp),
      source_error: null,
      last_updated_at: data.t || null
    };
  } catch (err) {
    const status = err.response?.status || null;

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source_error: status
        ? `Request failed with status code ${status}`
        : err.message,
      last_updated_at: null
    };
  }
}

async function fetchCoinGeckoPrice(coinId) {
  try {
    const headers = {};

    if (process.env.COINGECKO_API_KEY) {
      headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
    }

    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: coinId,
          vs_currencies: "usd",
          include_24hr_change: "true",
          include_last_updated_at: "true"
        },
        headers,
        timeout: 8000
      }
    );

    const data = response.data?.[coinId];

    if (!data || data.usd === undefined) {
      return {
        price: null,
        previous_close: null,
        day_change_abs: null,
        day_change_percent: null,
        source_error: `No price returned for coin_id ${coinId}`,
        last_updated_at: null
      };
    }

    return {
      price: toNumberOrNull(data.usd),
      previous_close: null,
      day_change_abs: null,
      day_change_percent: toNumberOrNull(data.usd_24h_change),
      source_error: null,
      last_updated_at: data.last_updated_at || null
    };
  } catch (err) {
    const status = err.response?.status || null;

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source_error: status
        ? `Request failed with status code ${status}`
        : err.message,
      last_updated_at: null
    };
  }
}

async function upsertMarketPrice(provider, symbol, market) {
  await db.query(
    `
    INSERT INTO market_prices (
      provider,
      symbol,
      price,
      previous_close,
      day_change_abs,
      day_change_percent,
      source_error,
      last_updated_at,
      fetched_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (provider, symbol)
    DO UPDATE SET
      price = EXCLUDED.price,
      previous_close = EXCLUDED.previous_close,
      day_change_abs = EXCLUDED.day_change_abs,
      day_change_percent = EXCLUDED.day_change_percent,
      source_error = EXCLUDED.source_error,
      last_updated_at = EXCLUDED.last_updated_at,
      fetched_at = NOW()
    `,
    [
      provider,
      symbol,
      market.price,
      market.previous_close,
      market.day_change_abs,
      market.day_change_percent,
      market.source_error,
      market.last_updated_at
    ]
  );
}

async function getRefreshCandidates(userId, limit, staleMinutes) {
  const result = await db.query(
    `
    WITH candidates AS (
      SELECT DISTINCT
        CASE
          WHEN type = 'crypto' THEN 'coingecko'
          ELSE 'finnhub'
        END AS provider,
        CASE
          WHEN type = 'crypto' THEN coin_id
          ELSE symbol
        END AS symbol
      FROM assets
      WHERE user_id = $1
        AND COALESCE(live_enabled, true) = true
        AND (
          (type = 'crypto' AND coin_id IS NOT NULL AND coin_id <> '')
          OR
          (type = 'stock' AND symbol IS NOT NULL AND symbol <> '')
        )
    )
    SELECT
      c.provider,
      c.symbol,
      mp.fetched_at
    FROM candidates c
    LEFT JOIN market_prices mp
      ON mp.provider = c.provider
      AND mp.symbol = c.symbol
    WHERE mp.fetched_at IS NULL
       OR mp.fetched_at < NOW() - ($3::int * INTERVAL '1 minute')
    ORDER BY mp.fetched_at ASC NULLS FIRST, c.provider ASC, c.symbol ASC
    LIMIT $2
    `,
    [userId, limit, staleMinutes]
  );

  return result.rows;
}

router.get("/", async (req, res) => {
  const startedAt = Date.now();

  try {
    const userId = req.query.user_id || 1;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 25)));
    const staleMinutes = Math.max(0, Number(req.query.stale_minutes || 30));

    const candidates = await getRefreshCandidates(
      userId,
      limit,
      staleMinutes
    );

    const results = [];

    for (const item of candidates) {
      const provider = item.provider;
      const symbol = item.symbol;

      let market;

      if (provider === "finnhub") {
        await sleep(FINNHUB_MIN_INTERVAL_MS);
        market = await fetchFinnhubQuote(symbol);
      } else if (provider === "coingecko") {
        market = await fetchCoinGeckoPrice(symbol);
      } else {
        market = {
          price: null,
          previous_close: null,
          day_change_abs: null,
          day_change_percent: null,
          source_error: `Unsupported provider: ${provider}`,
          last_updated_at: null
        };
      }

      await upsertMarketPrice(provider, symbol, market);

      results.push({
        provider,
        symbol,
        ok: !market.source_error && market.price !== null,
        price: market.price,
        day_change_percent: market.day_change_percent,
        source_error: market.source_error
      });
    }

    res.json({
      refresh_version: REFRESH_VERSION,
      user_id: Number(userId),
      limit,
      stale_minutes: staleMinutes,
      processed: results.length,
      duration_ms: Date.now() - startedAt,
      results
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Refresh prices error",
      details: err.message
    });
  }
});

module.exports = router;
