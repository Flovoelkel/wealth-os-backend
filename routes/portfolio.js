const router = require("express").Router();
const db = require("../db");

const ENGINE_VERSION = "price-engine-v3.2-alternative-assets-irr";

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


function parseAssetDetails(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function numberFromDetails(details, keys, fallback = null) {
  for (const key of keys) {
    const value = toNumberOrNull(details?.[key]);
    if (value !== null) return value;
  }
  return fallback;
}

function textFromDetails(details, keys, fallback = null) {
  for (const key of keys) {
    const value = details?.[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return fallback;
}

function calculateMonthlyPayment(principal, annualRatePercent, months) {
  const p = toNumberOrNull(principal);
  const m = Math.max(0, Math.round(toNumberOrNull(months) || 0));
  if (p === null || p <= 0 || m <= 0) return null;

  const annualRate = (toNumberOrNull(annualRatePercent) || 0) / 100;
  const monthlyRate = annualRate / 12;

  if (monthlyRate === 0) return p / m;
  return p * monthlyRate / (1 - Math.pow(1 + monthlyRate, -m));
}

function calculateRemainingBalance(principal, annualRatePercent, monthlyPayment, elapsedMonths) {
  let balance = toNumberOrNull(principal);
  const payment = toNumberOrNull(monthlyPayment);
  const months = Math.max(0, Math.round(toNumberOrNull(elapsedMonths) || 0));

  if (balance === null || balance <= 0) return 0;
  if (payment === null || payment <= 0 || months <= 0) return balance;

  const monthlyRate = ((toNumberOrNull(annualRatePercent) || 0) / 100) / 12;
  const cappedMonths = Math.min(months, 1200);

  for (let i = 0; i < cappedMonths; i++) {
    balance = balance * (1 + monthlyRate) - payment;
    if (balance <= 0) return 0;
  }

  return balance;
}

function calculateIrr(cashFlows) {
  const flows = (cashFlows || []).map(Number).filter((value) => Number.isFinite(value));
  const hasPositive = flows.some((value) => value > 0);
  const hasNegative = flows.some((value) => value < 0);
  if (!flows.length || !hasPositive || !hasNegative) return null;

  function npv(rate) {
    return flows.reduce((sum, cashFlow, index) => sum + cashFlow / Math.pow(1 + rate, index), 0);
  }

  let low = -0.9999;
  let high = 1;
  let lowValue = npv(low);
  let highValue = npv(high);

  // Expand upper bound for unusual high-return scenarios.
  let expansions = 0;
  while (lowValue * highValue > 0 && expansions < 12) {
    high *= 2;
    highValue = npv(high);
    expansions++;
  }

  if (lowValue * highValue > 0) return null;

  for (let i = 0; i < 120; i++) {
    const mid = (low + high) / 2;
    const midValue = npv(mid);
    if (Math.abs(midValue) < 0.000001) return mid;
    if (lowValue * midValue <= 0) {
      high = mid;
      highValue = midValue;
    } else {
      low = mid;
      lowValue = midValue;
    }
  }

  return (low + high) / 2;
}

function buildVehicleMetrics(asset) {
  const assetDetails = parseAssetDetails(asset.asset_details);
  const details = assetDetails.vehicle || assetDetails;

  const currentValue = numberFromDetails(details, ["current_estimated_value", "current_value", "market_value"], toNumberOrNull(asset.manual_value));
  const purchasePrice = numberFromDetails(details, ["purchase_price", "acquisition_cost"]);
  const annualGrowthPercent = numberFromDetails(details, ["annual_value_growth_percent", "projected_annual_growth_percent", "annual_appreciation_percent"], 0);
  const projectionYears = numberFromDetails(details, ["projection_years", "holding_years"], 0);
  const projectedValue =
    currentValue !== null && projectionYears && Number.isFinite(projectionYears)
      ? currentValue * Math.pow(1 + (annualGrowthPercent || 0) / 100, projectionYears)
      : null;

  if (currentValue === null) return null;

  return {
    value: currentValue,
    dayChangeValue: 0,
    valuationMethod: "vehicle_estimated_value",
    computedMetrics: {
      asset_kind: "vehicle",
      purchase_date: textFromDetails(details, ["purchase_date"]),
      purchase_price: round(purchasePrice, 2),
      current_estimated_value: round(currentValue, 2),
      annual_value_growth_percent: round(annualGrowthPercent, 4),
      projection_years: round(projectionYears, 2),
      projected_value: round(projectedValue, 2)
    }
  };
}

function buildRealEstateMetrics(asset) {
  const assetDetails = parseAssetDetails(asset.asset_details);
  const details = assetDetails.real_estate || assetDetails;

  const manualValue = toNumberOrNull(asset.manual_value);
  const currentPropertyValue = numberFromDetails(details, ["current_property_value", "current_value", "market_value", "property_value"], manualValue);
  const equityPaid = numberFromDetails(details, ["equity_paid", "paid_equity", "paid_equity_value"], null);
  const remainingDebt = numberFromDetails(details, ["remaining_debt", "remaining_value_to_pay", "remaining_to_pay", "loan_balance"], 0);
  const purchasePrice = numberFromDetails(details, ["purchase_price", "acquisition_price"], null);
  const annualGrowthPercent = numberFromDetails(details, ["annual_value_growth_percent", "projected_annual_growth_percent", "annual_appreciation_percent"], 0);
  const holdingYears = numberFromDetails(details, ["holding_years", "projection_years"], 10);
  const repaymentMonths = numberFromDetails(details, ["repayment_months", "payoff_months", "amortization_months"], null);
  const financingRatePercent = numberFromDetails(details, ["financing_rate_percent", "interest_rate_percent", "loan_interest_percent"], 0);
  const monthlyPaymentInput = numberFromDetails(details, ["monthly_payment", "monthly_debt_service"], null);
  const monthlyRentIncome = numberFromDetails(details, ["monthly_rent_income", "monthly_income", "rent_income_monthly"], 0);
  const monthlyOperatingCosts = numberFromDetails(details, ["monthly_operating_costs", "monthly_costs", "operating_costs_monthly"], 0);
  const sellingCostPercent = numberFromDetails(details, ["selling_cost_percent", "transaction_cost_percent", "exit_cost_percent"], 0);

  const calculatedMonthlyPayment =
    monthlyPaymentInput !== null
      ? monthlyPaymentInput
      : calculateMonthlyPayment(remainingDebt, financingRatePercent, repaymentMonths);

  const exitMonths = Math.max(1, Math.round((holdingYears || 0) * 12));
  const paymentMonthsForCashflow = repaymentMonths === null ? exitMonths : Math.min(exitMonths, Math.max(0, Math.round(repaymentMonths)));
  const projectedExitValue =
    currentPropertyValue !== null
      ? currentPropertyValue * Math.pow(1 + (annualGrowthPercent || 0) / 100, holdingYears || 0)
      : null;

  const futureDebtBalance = calculateRemainingBalance(
    remainingDebt,
    financingRatePercent,
    calculatedMonthlyPayment,
    exitMonths
  );

  const sellingCosts = projectedExitValue !== null ? projectedExitValue * ((sellingCostPercent || 0) / 100) : null;
  const projectedNetExitProceeds =
    projectedExitValue !== null ? projectedExitValue - (futureDebtBalance || 0) - (sellingCosts || 0) : null;

  const currentEquityValue =
    currentPropertyValue !== null
      ? Math.max(0, currentPropertyValue - (remainingDebt || 0))
      : equityPaid !== null
        ? equityPaid
        : manualValue;

  const initialInvestment = equityPaid !== null && equityPaid > 0
    ? equityPaid
    : purchasePrice !== null && remainingDebt !== null
      ? Math.max(0, purchasePrice - remainingDebt)
      : null;

  let irrMonthly = null;
  let irrAnnualPercent = null;

  if (initialInvestment !== null && initialInvestment > 0 && projectedNetExitProceeds !== null) {
    const monthlyNetCashflow = (monthlyRentIncome || 0) - (monthlyOperatingCosts || 0);
    const flows = [-initialInvestment];

    for (let month = 1; month <= exitMonths; month++) {
      const debtService = month <= paymentMonthsForCashflow ? (calculatedMonthlyPayment || 0) : 0;
      flows.push(monthlyNetCashflow - debtService);
    }

    flows[flows.length - 1] += projectedNetExitProceeds;
    irrMonthly = calculateIrr(flows);
    irrAnnualPercent = irrMonthly === null ? null : (Math.pow(1 + irrMonthly, 12) - 1) * 100;
  }

  if (currentEquityValue === null) return null;

  return {
    value: currentEquityValue,
    dayChangeValue: 0,
    valuationMethod: "real_estate_equity_value",
    computedMetrics: {
      asset_kind: "real_estate",
      purchase_date: textFromDetails(details, ["purchase_date"]),
      purchase_price: round(purchasePrice, 2),
      current_property_value: round(currentPropertyValue, 2),
      equity_paid: round(equityPaid, 2),
      remaining_debt: round(remainingDebt, 2),
      current_equity_value: round(currentEquityValue, 2),
      financing_rate_percent: round(financingRatePercent, 4),
      repayment_months: repaymentMonths === null ? null : Math.round(repaymentMonths),
      calculated_monthly_payment: round(calculatedMonthlyPayment, 2),
      monthly_rent_income: round(monthlyRentIncome, 2),
      monthly_operating_costs: round(monthlyOperatingCosts, 2),
      annual_value_growth_percent: round(annualGrowthPercent, 4),
      holding_years: round(holdingYears, 2),
      projected_exit_value: round(projectedExitValue, 2),
      future_debt_balance: round(futureDebtBalance, 2),
      selling_cost_percent: round(sellingCostPercent, 4),
      projected_net_exit_proceeds: round(projectedNetExitProceeds, 2),
      irr_monthly: irrMonthly === null ? null : round(irrMonthly, 8),
      irr_annual_percent: round(irrAnnualPercent, 4)
    }
  };
}

function calculateAlternativeAssetSnapshot(asset) {
  if (asset.type === "vehicle") return buildVehicleMetrics(asset);
  if (asset.type === "real_estate") return buildRealEstateMetrics(asset);
  return null;
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
  const alternativeSnapshot = calculateAlternativeAssetSnapshot(asset);
  if (alternativeSnapshot) return alternativeSnapshot;

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
  const assetDetails = parseAssetDetails(asset.asset_details);

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

    // Allocation metadata from Excel / assets table.
    asset_group: asset.asset_group || null,
    asset_subgroup: asset.asset_subgroup || null,
    asset_class: asset.asset_class || null,
    sector_block: asset.sector_block || null,
    region: asset.region || null,
    abcd_rating: asset.abcd_rating || null,
    asset_details: assetDetails,
    computed_metrics: valueResult.computedMetrics || null,
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

  const normalizedAssets = enrichedAssets.map((asset) => {
    const hasOwnedQuantity = quantityToNumber(asset.quantity) > 0;

    if (asset.mode === "watchlist" && hasOwnedQuantity) {
      const marketDirection = getMarketDirection(asset.day_change_value, asset.day_change_percent);

      return {
        ...asset,
        mode: "portfolio",
        original_mode: "watchlist",
        promoted_to_portfolio_by_quantity: true,
        display_color: getDisplayColor("portfolio", marketDirection)
      };
    }

    return {
      ...asset,
      original_mode: asset.mode,
      promoted_to_portfolio_by_quantity: false
    };
  });

  const portfolioAssets = normalizedAssets.filter((asset) => asset.mode === "portfolio");
  const originalWatchlistAssets = normalizedAssets.filter((asset) => asset.mode === "watchlist");

  const targetGapAssets = [];

  for (const asset of portfolioAssets) {
    const targetValue = toNumberOrNull(asset.target_value);
    const currentValue = toNumberOrNull(asset.value);

    if (targetValue !== null && currentValue !== null && targetValue > currentValue) {
      const gapValue = targetValue - currentValue;
      const ownedQuantity = quantityToNumber(asset.quantity);
      const unitPrice = toNumberOrNull(asset.price);
      const neededQuantity = unitPrice !== null && unitPrice > 0 ? gapValue / unitPrice : null;
      const targetCompletionPercent = targetValue > 0 ? (currentValue / targetValue) * 100 : null;

      const dayChangeValue =
        asset.day_change_percent !== null && asset.day_change_percent !== undefined
          ? gapValue * (asset.day_change_percent / 100)
          : 0;

      const syntheticAsset = {
        ...asset,
        id: `gap-${asset.id}`,
        mode: "watchlist",
        original_mode: asset.original_mode || asset.mode,
        name: `${asset.name} Nachkauf`,
        value: round(gapValue, 2),
        day_change_value: round(dayChangeValue, 2),
        valuation_method: "target_gap",
        is_synthetic: true,
        base_asset_id: asset.id,
        manual_value: null,
        quantity: 0,

        owned_quantity: round(ownedQuantity, 6),
        owned_value: round(currentValue, 2),
        needed_quantity: round(neededQuantity, 6),
        needed_value: round(gapValue, 2),
        target_gap_quantity: round(neededQuantity, 6),
        target_gap_value: round(gapValue, 2),
        target_completion_percent: round(targetCompletionPercent, 4),
        target_value: round(targetValue, 2)
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
      total_value: round(targetGapAssets.reduce((sum, asset) => sum + (asset.value || 0), 0), 2),
      total_needed_value: round(targetGapAssets.reduce((sum, asset) => sum + (asset.needed_value || 0), 0), 2)
    },
    portfolio_rules: {
      quantity_gt_zero_is_portfolio: true,
      portfolio_assets_with_target_gap_also_appear_in_watchlist: true,
      watchlist_target_gap_fields: [
        "owned_value",
        "owned_quantity",
        "needed_value",
        "needed_quantity",
        "target_value",
        "target_completion_percent"
      ],
      allocation_metadata_fields: [
        "asset_group",
        "asset_subgroup",
        "asset_class",
        "sector_block",
        "region",
        "abcd_rating"
      ],
      alternative_asset_types: ["vehicle", "real_estate"],
      real_estate_calculation_fields: [
        "current_property_value",
        "equity_paid",
        "remaining_debt",
        "current_equity_value",
        "calculated_monthly_payment",
        "projected_net_exit_proceeds",
        "irr_annual_percent"
      ]
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
