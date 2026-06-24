const router = require("express").Router();
const db = require("../db");

const ENGINE_VERSION = "price-engine-v1.6-quantity-target-fx";

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

function normalizeProvider(asset) {
  if (asset.type === "crypto") return "coingecko";
  if (asset.data_provider === "twelvedata") return "twelvedata";
  return "finnhub";
}

function getProviderAndSymbol(asset) {
  if (asset.type === "crypto" && asset.coin_id) {
    return { provider: "coingecko", symbol: asset.coin_id };
  }

  if ((asset.type === "stock" || asset.type === "etf") && (asset.provider_symbol || asset.symbol)) {
    return {
      provider: normalizeProvider(asset),
      symbol: asset.provider_symbol || asset.symbol
    };
  }

  return { provider: null, symbol: null };
}

function getFxRate(asset, fxMap) {
  const currency = String(asset.price_currency || "EUR").toUpperCase();
  if (currency === "EUR") return 1;

  const rate = toNumberOrNull(fxMap.get(`${currency}:EUR`));
  return rate === null ? 1 : rate;
}

function getManualMarket(asset) {
  return {
    price: toNumberOrNull(asset.manual_value),
    price_raw: toNumberOrNull(asset.manual_value),
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

function getCachedMarket(asset, priceMap, fxMap) {
  const manualValue = toNumberOrNull(asset.manual_value);
  const liveEnabled = asset.live_enabled !== false;
  const fxRate = getFxRate(asset, fxMap);

  if (!liveEnabled || asset.type === "manual") {
    return getManualMarket(asset);
  }

  const { provider, symbol } = getProviderAndSymbol(asset);

  if (!provider || !symbol) {
    if (manualValue !== null) return getManualMarket(asset);

    return {
      price: null,
      price_raw: null,
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
        price_raw: manualValue,
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
      price_raw: null,
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

  const priceRaw = toNumberOrNull(cached.price);

  if (cached.source_error || priceRaw === null) {
    if (manualValue !== null) {
      return {
        price: manualValue,
        price_raw: manualValue,
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
      price_raw: null,
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
    price: priceRaw * fxRate,
    price_raw: priceRaw,
    previous_close: toNumberOrNull(cached.previous_close),
    day_change_abs:
      toNumberOrNull(cached.day_change_abs) === null
        ? null
        : toNumberOrNull(cached.day_change_abs) * fxRate,
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
  if (marketDirection === "unknown" || marketDirection === "flat") return "neutral";
  if (mode === "watchlist") return marketDirection === "down" ? "green" : "red";
  return marketDirection === "up" ? "green" : "red";
}

function summarizeAssets(assets) {
  const totalValue = assets.reduce((sum, asset) => sum + (asset.value || 0), 0);
  const totalDayChangeValue = assets.reduce((sum, asset) => sum + (asset.day_change_value || 0), 0);

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
  const price = market.price;

  let value = null;
  let dayChangeValue = null;
  let valuationMethod = "quantity_times_price";

  if (quantity > 0 && price !== null) {
    valuationMethod = "quantity_times_price";
    value = price * quantity;

    if (market.day_change_abs !== null && market.day_change_abs !== undefined) {
      dayChangeValue = market.day_change_abs * quantity;
    } else if (market.day_change_percent !== null && market.day_change_percent !== undefined) {
      dayChangeValue = value * (market.day_change_percent / 100);
    }
  } else if (manualValue !== null) {
    valuationMethod = "manual_position_value";
    value = manualValue;

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

  return { value, dayChangeValue, valuationMethod };
}

function getCacheAgeSeconds(fetchedAt) {
  if (!fetchedAt) return null;
  const fetchedTime = new Date(fetchedAt).getTime();
  if (!Number.isFinite(fetchedTime)) return null;
  return Math.max(0, Math.round((Date.now() - fetchedTime) / 1000));
}

function enrichAsset(asset, priceMap, fxMap, forcedMode = null, syntheticOverrides = null) {
  const quantity = quantityToNumber(asset.quantity);
  const mode = forcedMode || (asset.mode === "watchlist" ? "watchlist" : "portfolio");
  const market = getCachedMarket(asset, priceMap, fxMap);
  const valueResult = calculateValueAndChange(asset, market, quantity);

  const roundedDayChangeValue = round(valueResult.dayChangeValue, 2);
  const roundedDayChangePercent = round(market.day_change_percent, 4);
  const marketDirection = getMarketDirection(roundedDayChangeValue, roundedDayChangePercent);

  const provider = getProviderAndSymbol(asset).provider;
  const providerSymbol = getProviderAndSymbol(asset).symbol;

  return {
    id: syntheticOverrides?.id || asset.id,
    user_id: asset.user_id,
    mode,
    name: syntheticOverrides?.name || asset.name,
    type: asset.type,
    symbol: asset.symbol,
    provider_symbol: providerSymbol,
    data_provider: provider,
    coin_id: asset.coin_id,
    quantity,
    manual_value: asset.manual_value === null ? null : toNumberOrNull(asset.manual_value),
    target_value: asset.target_value === null ? null : toNumberOrNull(asset.target_value),
    price_currency: asset.price_currency || "EUR",
    live_enabled: asset.live_enabled !== false,
    is_synthetic: Boolean(syntheticOverrides),
    base_asset_id: syntheticOverrides?.base_asset_id || null,

    price: round(market.price, 4),
    price_raw: round(market.price_raw, 4),
    value: syntheticOverrides?.value !== undefined ? round(syntheticOverrides.value, 2) : round(valueResult.value, 2),
    day_change_abs: round(market.day_change_abs, 4),
    day_change_percent: roundedDayChangePercent,
    day_change_value:
      syntheticOverrides?.day_change_value !== undefined
        ? round(syntheticOverrides.day_change_value, 2)
        : roundedDayChangeValue,

    market_direction: marketDirection,
    display_color: getDisplayColor(mode, marketDirection),
    valuation_method: syntheticOverrides?.valuation_method || valueResult.valuationMethod,

    source: market.source,
    source_error: market.source_error || null,
    used_manual_fallback: market.used_manual_fallback || false,
    last_updated_at: market.last_updated_at || null,
    fetched_at: market.fetched_at || null,
    cache_age_seconds: getCacheAgeSeconds(market.fetched_at)
  };
}

async function buildPortfolioResponse(userIdInput = 1) {
  const userId = Number(userIdInput || 1);

  const assetsResult = await db.query(
    "SELECT * FROM assets WHERE user_id = $1 ORDER BY id ASC",
    [userId]
  );

  const pricesResult = await db.query("SELECT * FROM market_prices");
  const fxResult = await db.query("SELECT * FROM fx_rates");

  const priceMap = new Map();
  for (const row of pricesResult.rows) {
    priceMap.set(getMarketKey(row.provider, row.symbol), row);
  }

  const fxMap = new Map();
  for (const row of fxResult.rows) {
    fxMap.set(`${row.base}:${row.quote}`, row.rate);
  }
  fxMap.set("EUR:EUR", 1);

  const enrichedAssets = assetsResult.rows.map((asset) => enrichAsset(asset, priceMap, fxMap));

  const portfolioAssets = enrichedAssets.filter((asset) => asset.mode === "portfolio");
  const originalWatchlistAssets = enrichedAssets.filter((asset) => asset.mode === "watchlist");

  const targetGapAssets = [];

  for (const asset of portfolioAssets) {
    const targetValue = toNumberOrNull(asset.target_value);
    const currentValue = toNumberOrNull(asset.value);

    if (targetValue !== null && currentValue !== null && targetValue > currentValue) {
      const gapValue = targetValue - currentValue;
      const dayChangeValue =
        asset.day_change_percent !== null && asset.day_change_percent !== undefined
          ? gapValue * (asset.day_change_percent / 100)
          : 0;

      const syntheticAsset = {
        ...asset,
        id: `gap-${asset.id}`,
        mode: "watchlist",
        name: `${asset.name} Ziel-Lücke`,
        value: round(gapValue, 2),
        day_change_value: round(dayChangeValue, 2),
        valuation_method: "target_gap",
        is_synthetic: true,
        base_asset_id: asset.id,
        manual_value: null,
        quantity: 0
      };

      syntheticAsset.market_direction = getMarketDirection(
        syntheticAsset.day_change_value,
        syntheticAsset.day_change_percent
      );
      syntheticAsset.display_color = getDisplayColor("watchlist", syntheticAsset.market_direction);

      targetGapAssets.push(syntheticAsset);
    }
  }

  const watchlistAssets = [...originalWatchlistAssets, ...targetGapAssets];

  const portfolio = summarizeAssets(portfolioAssets);
  const watchlist = summarizeAssets(watchlistAssets);

  return {
    engine_version: ENGINE_VERSION,
    user_id: Number(userId),
    currency: "EUR",
    total_value: portfolio.total_value,
    total_day_change_value: portfolio.total_day_change_value,
    total_day_change_percent: portfolio.total_day_change_percent,
    portfolio,
    watchlist,
    target_gaps: {
      count: targetGapAssets.length,
      total_value: round(targetGapAssets.reduce((sum, asset) => sum + (asset.value || 0), 0), 2)
    }
  };
}

router.get("/", async (req, res) => {
  try {
    const payload = await buildPortfolioResponse(req.query.user_id || 1);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Portfolio engine error",
      details: err.message
    });
  }
});

module.exports = router;
module.exports.buildPortfolioResponse = buildPortfolioResponse;
