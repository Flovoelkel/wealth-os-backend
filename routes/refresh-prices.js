const router = require("express").Router();
const axios = require("axios");
const db = require("../db");

const REFRESH_VERSION = "price-refresh-v1.6.1-provider-throttle";
const FINNHUB_MIN_INTERVAL_MS = 1200;
const TWELVE_DATA_MIN_INTERVAL_MS = 8500;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProvider(provider, type) {
  const normalizedProvider = provider ? String(provider).toLowerCase() : null;

  if (type === "crypto" || normalizedProvider === "coingecko") {
    return "coingecko";
  }

  if (normalizedProvider === "twelvedata") {
    return "twelvedata";
  }

  return "finnhub";
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
      params: { symbol, token },
      timeout: 10000
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
    const providerMessage =
      err.response?.data?.message ||
      err.response?.data?.status ||
      err.response?.data?.code ||
      null;

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source_error: status
        ? `Request failed with status code ${status}${providerMessage ? `: ${providerMessage}` : ""}`
        : err.message,
      last_updated_at: null
    };
  }
}

async function fetchTwelveDataQuote(symbol, micCode, exchange) {
  const apikey = process.env.TWELVE_DATA_API_KEY;

  if (!apikey) {
    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source_error: "Missing TWELVE_DATA_API_KEY",
      last_updated_at: null
    };
  }

  try {
    const params = { symbol, apikey };

    if (micCode) {
      params.mic_code = micCode;
    }

    if (exchange) {
      params.exchange = exchange;
    }

    const response = await axios.get("https://api.twelvedata.com/quote", {
      params,
      timeout: 10000
    });

    const data = response.data || {};

    if (data.status === "error" || data.code || data.message === "**symbol** not found") {
      return {
        price: null,
        previous_close: null,
        day_change_abs: null,
        day_change_percent: null,
        source_error: data.message || `Twelve Data error for symbol ${symbol}`,
        last_updated_at: null
      };
    }

    const price =
      toNumberOrNull(data.price) ??
      toNumberOrNull(data.close) ??
      toNumberOrNull(data.previous_close);

    if (price === null || price === 0) {
      return {
        price: null,
        previous_close: toNumberOrNull(data.previous_close),
        day_change_abs: toNumberOrNull(data.change),
        day_change_percent: toNumberOrNull(data.percent_change),
        source_error: `No valid quote returned for symbol ${symbol}`,
        last_updated_at: data.timestamp || null
      };
    }

    return {
      price,
      previous_close: toNumberOrNull(data.previous_close),
      day_change_abs: toNumberOrNull(data.change),
      day_change_percent: toNumberOrNull(data.percent_change),
      source_error: null,
      last_updated_at: data.timestamp || null
    };
  } catch (err) {
    const status = err.response?.status || null;
    const providerMessage =
      err.response?.data?.message ||
      err.response?.data?.status ||
      err.response?.data?.code ||
      null;

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source_error: status
        ? `Request failed with status code ${status}${providerMessage ? `: ${providerMessage}` : ""}`
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

    const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: {
        ids: coinId,
        vs_currencies: "usd",
        include_24hr_change: "true",
        include_last_updated_at: "true"
      },
      headers,
      timeout: 10000
    });

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
    const providerMessage =
      err.response?.data?.message ||
      err.response?.data?.status ||
      err.response?.data?.code ||
      null;

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source_error: status
        ? `Request failed with status code ${status}${providerMessage ? `: ${providerMessage}` : ""}`
        : err.message,
      last_updated_at: null
    };
  }
}

async function upsertMarketPrice(provider, symbol, market) {
  // Do not overwrite a previously valid price with a transient rate-limit error.
  if (market.source_error && String(market.source_error).includes("429")) {
    const existing = await db.query(
      "SELECT price, source_error FROM market_prices WHERE provider = $1 AND symbol = $2",
      [provider, symbol]
    );

    const existingPrice = existing.rows[0]?.price;
    const existingError = existing.rows[0]?.source_error;

    if (existingPrice !== null && existingPrice !== undefined && !existingError) {
      return;
    }
  }


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

async function upsertFxRate(base, quote, rate) {
  await db.query(
    `
    INSERT INTO fx_rates (base, quote, rate, fetched_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (base, quote)
    DO UPDATE SET
      rate = EXCLUDED.rate,
      fetched_at = NOW()
    `,
    [base, quote, rate]
  );
}

async function refreshFxRates(userId) {
  const result = await db.query(
    `
    SELECT DISTINCT UPPER(COALESCE(price_currency, 'EUR')) AS currency
    FROM assets
    WHERE user_id = $1
      AND COALESCE(price_currency, 'EUR') <> 'EUR'
      AND COALESCE(price_currency, '') <> ''
    ORDER BY currency ASC
    `,
    [userId]
  );

  const refreshed = [];

  for (const row of result.rows) {
    const base = row.currency;
    const fxBase = base === "GBX" ? "GBP" : base;

    try {
      const response = await axios.get(
        `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(fxBase)}/EUR`,
        { timeout: 10000 }
      );

      let rate = toNumberOrNull(response.data?.rate);

      // London-listed quotes are often returned in pence. GBX = GBP pence.
      if (base === "GBX" && rate !== null) {
        rate = rate / 100;
      }

      if (rate !== null) {
        await upsertFxRate(base, "EUR", rate);
        refreshed.push({ base, quote: "EUR", rate, ok: true });
      } else {
        refreshed.push({ base, quote: "EUR", rate: null, ok: false, error: "No FX rate returned" });
      }
    } catch (err) {
      refreshed.push({ base, quote: "EUR", rate: null, ok: false, error: err.message });
    }
  }

  await upsertFxRate("EUR", "EUR", 1);
  return refreshed;
}

async function getRefreshCandidates(userId, limit, staleMinutes, providerFilter) {
  const result = await db.query(
    `
    WITH candidates AS (
      SELECT DISTINCT
        CASE
          WHEN type = 'crypto' THEN 'coingecko'
          ELSE COALESCE(data_provider, 'finnhub')
        END AS provider,
        CASE
          WHEN type = 'crypto' THEN coin_id
          ELSE COALESCE(provider_symbol, symbol)
        END AS symbol,
        provider_mic_code,
        provider_exchange
      FROM assets
      WHERE user_id = $1
        AND COALESCE(live_enabled, true) = true
        AND (
          (type = 'crypto' AND coin_id IS NOT NULL AND coin_id <> '')
          OR
          (type IN ('stock', 'etf') AND COALESCE(provider_symbol, symbol) IS NOT NULL AND COALESCE(provider_symbol, symbol) <> '')
        )
        AND (
          $4::text IS NULL
          OR LOWER(
            CASE
              WHEN type = 'crypto' THEN 'coingecko'
              ELSE COALESCE(data_provider, 'finnhub')
            END
          ) = LOWER($4::text)
        )
    )
    SELECT
      c.provider,
      c.symbol,
      c.provider_mic_code,
      c.provider_exchange,
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
    [userId, limit, staleMinutes, providerFilter || null]
  );

  return result.rows;
}

async function handleRefreshPrices(req, res) {
  const startedAt = Date.now();

  try {
    const userId = req.query.user_id || 1;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
    const staleMinutes = Math.max(0, Number(req.query.stale_minutes || 60));
    const refreshFx = req.query.fx !== "false";
    const providerFilter = req.query.provider ? String(req.query.provider).toLowerCase() : null;

    const fx_results = refreshFx ? await refreshFxRates(userId) : [];
    const candidates = await getRefreshCandidates(userId, limit, staleMinutes, providerFilter);

    const results = [];

    for (const item of candidates) {
      const provider = normalizeProvider(item.provider);
      const symbol = item.symbol;

      let market;

      if (provider === "finnhub") {
        await sleep(FINNHUB_MIN_INTERVAL_MS);
        market = await fetchFinnhubQuote(symbol);
      } else if (provider === "twelvedata") {
        await sleep(TWELVE_DATA_MIN_INTERVAL_MS);
        market = await fetchTwelveDataQuote(
          symbol,
          item.provider_mic_code,
          item.provider_exchange
        );
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
      provider_filter: providerFilter,
      processed: results.length,
      fx_processed: fx_results.length,
      duration_ms: Date.now() - startedAt,
      fx_results,
      results
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Refresh prices error",
      details: err.message
    });
  }
}

router.get("/", handleRefreshPrices);

module.exports = router;
module.exports.handleRefreshPrices = handleRefreshPrices;
