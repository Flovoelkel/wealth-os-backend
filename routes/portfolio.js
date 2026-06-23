const router = require("express").Router();
const db = require("../db");

const ENGINE_VERSION = "price-engine-v1.4-market-price-cache";

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

function getMarketKey(provider, symbol) {
  return `${provider}:${symbol}`;
}

function getManualMarket(asset) {
  return {
    price: toNumberOrNull(asset.manual_value),
    previous_close: null,
    day_change_abs: 0,
    day_change_percent: 0,
    source: "manual",
    source_error: null,
    last_updated_at: null,
    fetched_at: null,
    used_manual_fallback: false
  };
}

function getProviderAndSymbol(asset) {
  if (asset.type === "crypto" && asset.coin_id) {
    return {
      provider: "coingecko",
      symbol: asset.coin_id
    };
  }

  if (asset.type === "stock" && asset.symbol) {
    return {
      provider: "finnhub",
      symbol: asset.symbol
    };
  }

  return {
    provider: null,
    symbol: null
  };
}

function getCachedMarket(asset, priceMap) {
  const manualValue = toNumberOrNull(asset.manual_value);
  const liveEnabled = asset.live_enabled !== false;

  if (!liveEnabled || asset.type === "manual" || asset.type === "etf") {
    return getManualMarket(asset);
  }

  const { provider, symbol } = getProviderAndSymbol(asset);

  if (!provider || !symbol) {
    if (manualValue !== null) {
      return getManualMarket(asset);
    }

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: null,
      source_error: "Missing provider or symbol",
      last_updated_at: null,
      fetched_at: null,
      used_manual_fallback: false
    };
  }

  const cached = priceMap.get(getMarketKey(provider, symbol));

  if (!cached) {
    if (manualValue !== null) {
      return {
        price: manualValue,
        previous_close: null,
        day_change_abs: 0,
        day_change_percent: 0,
        source: "manual_fallback",
        source_error: "No cached market price yet",
        last_updated_at: null,
        fetched_at: null,
        used_manual_fallback: true
      };
    }

    return {
      price: null,
      previous_close: null,
      day_change_abs: null,
      day_change_percent: null,
      source: provider,
      source_error: "No cached market price yet",
      last_updated_at: null,
      fetched_at: null,
      used_manual_fallback: false
    };
  }

  const price = toNumberOrNull(cached.price);

  if (cached.source_error || price === null) {
    if (manualValue !== null) {
      return {
        price: manualValue,
        previous_close: null,
        day_change_abs: 0,
        day_change_percent: 0,
        source: "manual_fallback",
        source_error: cached.source_error || "Cached price is empty",
        last_updated_at: cached.last_updated_at || null,
        fetched_at: cached.fetched_at || null,
        used_manual_fallback: true
      };
    }

    return {
      price: null,
      previous_close: toNumberOrNull(cached.previous_close),
      day_change_abs: toNumberOrNull(cached.day_change_abs),
      day_change_percent: toNumberOrNull(cached.day_change_percent),
      source: provider,
      source_error: cached.source_error || "Cached price is empty",
      last_updated_at: cached.last_updated_at || null,
      fetched_at: cached.fetched_at || null,
      used_manual_fallback: false
    };
  }

  return {
    price,
    previous_close: toNumberOrNull(cached.previous_close),
    day_change_abs: toNumberOrNull(cached.day_change_abs),
    day_change_percent: toNumberOrNull(cached.day_change_percent),
    source: provider,
    source_error: null,
    last_updated_at: cached.last_updated_at || null,
    fetched_at: cached.fetched_at || null,
    used_manual_fallback: false
  };
}

function getMarketDirection(dayChangeValue, dayChangePercent) {
  const value = toNumberOrNull(dayChangeValue);
  const percent = toNumberOrNull(dayChangePercent);
  const signal = value !== null ? value : percent;

  if (signal === null) return "unknown";
  if (signal > 0) return "up";
  if (signal < 0) return "down";
  return "flat";
}

function getDisplayColor(mode, marketDirection) {
  if (marketDirection === "unknown" || marketDirection === "flat") {
    return "neutral";
  }

  if (mode === "watchlist") {
    return marketDirection === "down" ? "green" : "red";
  }

  return marketDirection === "up" ? "green" : "red";
}

function summarizeAssets(assets) {
  const totalValue = assets.reduce((sum, asset) => {
    return sum + (asset.value || 0);
  }, 0);

  const totalDayChangeValue = assets.reduce((sum, asset) => {
    return sum + (asset.day_change_value || 0);
  }, 0);

  const totalDayChangePercent =
    totalValue > 0 && totalValue - totalDayChangeValue !== 0
      ? (totalDayChangeValue / (totalValue - totalDayChangeValue)) * 100
      : null;

  return {
    total_value: round(totalValue, 2),
    total_day_change_value: round(totalDayChangeValue, 2),
    total_day_change_percent: round(totalDayChangePercent, 4),
    assets
  };
}

function calculateValueAndChange(asset, market, quantity) {
  const manualValue = toNumberOrNull(asset.manual_value);
  const useManualPositionValue = manualValue !== null && quantity === 0;

  let price = market.price;
  let value = null;
  let dayChangeValue = null;
  let valuationMethod = "quantity_times_price";

  if (useManualPositionValue) {
    valuationMethod = "manual_position_value";
    value = manualValue;

    if (price === null) {
      price = manualValue;
    }

    if (market.day_change_percent !== null && market.day_change_percent !== undefined) {
      dayChangeValue = value * (market.day_change_percent / 100);
    } else if (market.day_change_abs !== null && market.day_change_abs !== undefined && market.price) {
      dayChangeValue = value * (market.day_change_abs / market.price);
    } else {
      dayChangeValue = 0;
    }
  } else {
    value = price === null ? null : price * quantity;

    if (market.day_change_abs !== null && market.day_change_abs !== undefined) {
      dayChangeValue = market.day_change_abs * quantity;
    } else if (
      value !== null &&
      market.day_change_percent !== null &&
      market.day_change_percent !== undefined
    ) {
      dayChangeValue = value * (market.day_change_percent / 100);
    }
  }

  return {
    price,
    value,
    dayChangeValue,
    valuationMethod
  };
}

function getCacheAgeSeconds(fetchedAt) {
  if (!fetchedAt) return null;

  const fetchedTime = new Date(fetchedAt).getTime();

  if (!Number.isFinite(fetchedTime)) return null;

  return Math.max(0, Math.round((Date.now() - fetchedTime) / 1000));
}

router.get("/", async (req, res) => {
  try {
    const userId = req.query.user_id || 1;

    const assetsResult = await db.query(
      "SELECT * FROM assets WHERE user_id = $1 ORDER BY id ASC",
      [userId]
    );

    const pricesResult = await db.query(
      "SELECT * FROM market_prices"
    );

    const priceMap = new Map();

    for (const row of pricesResult.rows) {
      priceMap.set(getMarketKey(row.provider, row.symbol), row);
    }

    const enrichedAssets = assetsResult.rows.map((asset) => {
      const quantity = quantityToNumber(asset.quantity);
      const mode = asset.mode === "watchlist" ? "watchlist" : "portfolio";

      const market = getCachedMarket(asset, priceMap);
      const valueResult = calculateValueAndChange(asset, market, quantity);

      const roundedDayChangeValue = round(valueResult.dayChangeValue, 2);
      const roundedDayChangePercent = round(market.day_change_percent, 4);

      const marketDirection = getMarketDirection(
        roundedDayChangeValue,
        roundedDayChangePercent
      );

      return {
        id: asset.id,
        user_id: asset.user_id,
        mode,
        name: asset.name,
        type: asset.type,
        symbol: asset.symbol,
        coin_id: asset.coin_id,
        quantity,
        manual_value:
          asset.manual_value === null
            ? null
            : toNumberOrNull(asset.manual_value),
        live_enabled: asset.live_enabled !== false,

        price: round(valueResult.price, 4),
        value: round(valueResult.value, 2),
        day_change_abs: round(market.day_change_abs, 4),
        day_change_percent: roundedDayChangePercent,
        day_change_value: roundedDayChangeValue,

        market_direction: marketDirection,
        display_color: getDisplayColor(mode, marketDirection),
        valuation_method: valueResult.valuationMethod,

        source: market.source,
        source_error: market.source_error || null,
        used_manual_fallback: market.used_manual_fallback || false,
        last_updated_at: market.last_updated_at || null,
        fetched_at: market.fetched_at || null,
        cache_age_seconds: getCacheAgeSeconds(market.fetched_at)
      };
    });

    const portfolioAssets = enrichedAssets.filter(
      (asset) => asset.mode === "portfolio"
    );

    const watchlistAssets = enrichedAssets.filter(
      (asset) => asset.mode === "watchlist"
    );

    const portfolio = summarizeAssets(portfolioAssets);
    const watchlist = summarizeAssets(watchlistAssets);

    res.json({
      engine_version: ENGINE_VERSION,
      user_id: Number(userId),
      currency: "EUR",

      total_value: portfolio.total_value,
      total_day_change_value: portfolio.total_day_change_value,
      total_day_change_percent: portfolio.total_day_change_percent,

      portfolio,
      watchlist
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
