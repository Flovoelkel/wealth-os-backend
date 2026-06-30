const db = require("../db");
const portfolioRoutes = require("./portfolio");

const GAME_VERSION = "game-community-v3.4.6-test-feedback-autosave-email";

const GAME_CLASSES = [
  { key: "productive", label: "Produktiv", emoji: "📈", multiplier: 1.5, portfolio_label: "Depot / ETF / Aktien / Fonds", is_live_price_supported: true, sort_order: 10 },
  { key: "neutral", label: "Neutral / Liquidität", emoji: "💰", multiplier: 1.0, portfolio_label: "Cash / Tagesgeld / Festgeld", is_live_price_supported: false, sort_order: 20 },
  { key: "commodity", label: "Rohstoffe", emoji: "🪙", multiplier: 1.5, portfolio_label: "Gold / Silber / Rohstoffe", is_live_price_supported: false, sort_order: 30 },
  { key: "collector", label: "Sammlerobjekte", emoji: "🏎️", multiplier: 1.0, portfolio_label: "Kunst / Uhren / Sammlerfahrzeuge", is_live_price_supported: false, sort_order: 40 },
  { key: "immo_self", label: "Immobilie selbstgenutzt", emoji: "🏠", multiplier: 0.8, portfolio_label: "Selbstgenutzte Immobilie", is_live_price_supported: false, sort_order: 50 },
  { key: "immo_rent", label: "Immobilie vermietet", emoji: "🏘️", multiplier: 1.5, portfolio_label: "Vermietete Immobilie", is_live_price_supported: false, sort_order: 60 },
  { key: "consumer", label: "Konsumgut", emoji: "🛍️", multiplier: 0.2, portfolio_label: "Auto / Technik / Konsumgut", is_live_price_supported: false, sort_order: 70 },
  { key: "business", label: "Eigenes Unternehmen", emoji: "🚀", multiplier: 1.5, portfolio_label: "Business / Beteiligung", is_live_price_supported: false, sort_order: 80 },
  { key: "crowdfunding", label: "Crowdfunding", emoji: "🤝", multiplier: 1.0, portfolio_label: "Crowdfunding / Produktbeteiligung", is_live_price_supported: false, sort_order: 90 },
  { key: "debt", label: "Schulden", emoji: "⛔", multiplier: -1.0, portfolio_label: "Kredit / Schulden", is_live_price_supported: false, sort_order: 100 }
];

const CLASS_BY_KEY = new Map(GAME_CLASSES.map((item) => [item.key, item]));

const LEAGUES = [
  { key: "bronze", label: "Bronze", min_value: 0, max_value: 10000, sort_order: 10 },
  { key: "silver", label: "Silber", min_value: 10000, max_value: 50000, sort_order: 20 },
  { key: "gold", label: "Gold", min_value: 50000, max_value: 250000, sort_order: 30 },
  { key: "platinum", label: "Platin", min_value: 250000, max_value: 1000000, sort_order: 40 },
  { key: "diamond", label: "Diamond", min_value: 1000000, max_value: 10000000, sort_order: 50 },
  { key: "deca_millionaire", label: "10 Mio. €+", min_value: 10000000, max_value: 100000000, sort_order: 60 },
  { key: "centi_millionaire", label: "100 Mio. €+", min_value: 100000000, max_value: null, sort_order: 70 }
];

const ACHIEVEMENTS = [
  { key: "first_commodity", title: "Rohstoffsammler", emoji: "🪙", description: "Erster Rohstoff im Portfolio.", test: (scores) => scores.assets.some((a) => a.game_class === "commodity" && a.real_value > 0) },
  { key: "first_gold", title: "Goldstarter", emoji: "🥇", description: "Erstes Gold-/Rohstoff-Asset angelegt.", test: (scores) => scores.assets.some((a) => a.game_class === "commodity" && /gold|silber|rohstoff/i.test(String(a.name || ""))) },
  { key: "gold_1000", title: "1.000 € Gold", emoji: "🏅", description: "Gold-/Rohstoffbestand überschreitet 1.000 €.", test: (scores) => scores.assets.filter((a) => a.game_class === "commodity").reduce((s, a) => s + Math.max(0, Number(a.real_value || 0)), 0) >= 1000 },
  { key: "diversifier_3", title: "Diversifizierer", emoji: "💎", description: "Mindestens 3 Vermögensklassen vorhanden.", test: (scores) => new Set(scores.assets.filter((a) => Math.abs(Number(a.real_value || 0)) > 0).map((a) => a.game_class)).size >= 3 },
  { key: "liquidity_1000", title: "Liquiditätsprofi", emoji: "🏦", description: "Mehr als 1.000 € liquide Assets.", test: (scores) => scores.assets.filter((a) => a.game_class === "neutral").reduce((s, a) => s + Math.max(0, Number(a.real_value || 0)), 0) >= 1000 },
  { key: "first_depot", title: "Depotstarter", emoji: "📈", description: "Erstes Aktien-/ETF-/Fonds-Asset.", test: (scores) => scores.assets.some((a) => a.game_class === "productive" && a.real_value > 0) }
];

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  const n = toNumber(value, null);
  if (n === null) return null;
  return Number(n.toFixed(decimals));
}

function cleanText(value, fallback = null, maxLength = 500) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parseJsonObject(value) {
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

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function gameClassFromAsset(asset) {
  const details = parseJsonObject(asset.asset_details);
  const explicit = cleanText(asset.asset_game_class || details.game_class || details.asset_game_class, null, 80);
  if (explicit && CLASS_BY_KEY.has(explicit)) return explicit;

  const kind = cleanText(details.kind || details.asset_kind, null, 80);
  const realEstate = parseJsonObject(details.real_estate);
  const vehicle = parseJsonObject(details.vehicle);

  if (kind === "real_estate" || Object.keys(realEstate).length) {
    const usage = cleanText(realEstate.usage || details.usage || details.real_estate_usage, "", 80);
    const rent = toNumber(realEstate.monthly_rent_income || details.monthly_rent_income, 0);
    if (["rent", "rented", "vermietet", "immo_rent"].includes(usage) || rent > 0) return "immo_rent";
    return "immo_self";
  }

  if (kind === "vehicle" || Object.keys(vehicle).length) {
    const collector = vehicle.is_collector === true || details.is_collector === true || String(vehicle.category || "").toLowerCase().includes("collector");
    return collector ? "collector" : "consumer";
  }

  if (kind === "business") return "business";
  if (kind === "crowdfunding_project") return "crowdfunding";
  if (kind === "debt") return "debt";
  if (asset.type === "stock" || asset.type === "etf" || asset.type === "crypto") return "productive";
  return "neutral";
}

function classDefinition(key) {
  return CLASS_BY_KEY.get(key) || CLASS_BY_KEY.get("neutral");
}

function realValueForAsset(asset) {
  const gameClass = gameClassFromAsset(asset);
  const face = Math.abs(toNumber(asset.value, toNumber(asset.manual_value, 0)));
  return gameClass === "debt" ? -face : face;
}

function weightedValueForAsset(asset) {
  const gameClass = gameClassFromAsset(asset);
  const def = classDefinition(gameClass);
  const face = Math.abs(toNumber(asset.value, toNumber(asset.manual_value, 0)));
  if (gameClass === "debt") return -face;
  return face * toNumber(def.multiplier, 1);
}

function eventEffectForClass(activeEvents, gameClass) {
  let effect = 0;
  for (const event of activeEvents || []) {
    const effects = parseJsonObject(event.effects_json || event.effects);
    effect += toNumber(effects[gameClass], 0);
  }
  return effect;
}

function marketValueForAsset(asset, activeEvents = []) {
  const gameClass = gameClassFromAsset(asset);
  const base = weightedValueForAsset(asset);
  if (gameClass === "debt") return base;
  const effect = eventEffectForClass(activeEvents, gameClass);
  return base * (1 + effect);
}

function leagueForScore(scoreInput) {
  const score = Math.max(0, toNumber(scoreInput, 0));
  return LEAGUES.find((league) => score >= league.min_value && (league.max_value === null || score < league.max_value)) || LEAGUES[0];
}

async function getActiveMarketEvents() {
  try {
    const result = await db.query(
      `
      SELECT *
      FROM market_game_events
      WHERE is_active = true
        AND starts_at <= NOW()
        AND expires_at > NOW()
      ORDER BY starts_at DESC
      `
    );
    return result.rows || [];
  } catch (_) {
    return [];
  }
}

function calculateScoresFromAssets(assets, activeEvents = []) {
  const portfolioAssets = (assets || []).filter((asset) => asset && asset.mode === "portfolio" && !asset.is_synthetic);
  const assetScores = portfolioAssets.map((asset) => {
    const gameClass = gameClassFromAsset(asset);
    const def = classDefinition(gameClass);
    const real_value = realValueForAsset(asset);
    const weighted_value = weightedValueForAsset(asset);
    const market_value = marketValueForAsset(asset, activeEvents);
    return {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      game_class: gameClass,
      game_class_label: def.label,
      game_class_portfolio_label: def.portfolio_label,
      game_multiplier: def.multiplier,
      is_liquid: asset.is_liquid === true || gameClass === "neutral",
      real_value: round(real_value, 2),
      weighted_value: round(weighted_value, 2),
      market_value: round(market_value, 2)
    };
  });

  const real_wealth = assetScores.reduce((sum, asset) => sum + toNumber(asset.real_value, 0), 0);
  const weighted_wealth = assetScores.reduce((sum, asset) => sum + toNumber(asset.weighted_value, 0), 0);
  const market_wealth = assetScores.reduce((sum, asset) => sum + toNumber(asset.market_value, 0), 0);
  const league = leagueForScore(market_wealth);

  return {
    real_wealth: round(real_wealth, 2),
    weighted_wealth: round(weighted_wealth, 2),
    market_wealth: round(market_wealth, 2),
    league,
    assets: assetScores
  };
}

async function ensureGameProfile(user) {
  const userId = Number(user.id || user.user_id || user);
  const displayName = cleanText(user.display_name, `Spieler ${userId}`, 120);
  const result = await db.query(
    `
    INSERT INTO game_profiles (user_id, alias, game_theme, game_mode, created_at, updated_at)
    VALUES ($1, $2, 'classic', 'npc', NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET updated_at = game_profiles.updated_at
    RETURNING *
    `,
    [userId, displayName]
  );
  return result.rows[0];
}

async function ensurePublicSettings(userId) {
  const result = await db.query(
    `
    INSERT INTO public_portfolio_settings (user_id, created_at, updated_at)
    VALUES ($1, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET updated_at = public_portfolio_settings.updated_at
    RETURNING *
    `,
    [Number(userId)]
  );
  return result.rows[0];
}

async function awardAchievements(userId, scores) {
  const awarded = [];
  for (const achievement of ACHIEVEMENTS) {
    let ok = false;
    try { ok = achievement.test(scores); } catch (_) { ok = false; }
    if (!ok) continue;
    try {
      const result = await db.query(
        `
        INSERT INTO game_achievements (user_id, achievement_key, title, description, icon, unlocked_at, created_at)
        VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
        ON CONFLICT (user_id, achievement_key) DO NOTHING
        RETURNING *
        `,
        [userId, achievement.key, achievement.title, achievement.description, achievement.emoji]
      );
      if (result.rows[0]) awarded.push(result.rows[0]);
    } catch (_) {
      // Older schemas may not yet have all achievement columns. Do not block autosave.
      try {
        const result = await db.query(
          `INSERT INTO game_achievements (user_id, achievement_key, unlocked_at) VALUES ($1,$2,NOW()) ON CONFLICT (user_id, achievement_key) DO NOTHING RETURNING *`,
          [userId, achievement.key]
        );
        if (result.rows[0]) awarded.push(result.rows[0]);
      } catch (_) {}
    }
  }
  return awarded;
}

async function buildGameStateForUser(user) {
  const userId = Number(user.id || user.user_id || user);
  const profile = await ensureGameProfile(user);
  const publicSettings = await ensurePublicSettings(userId);
  const portfolio = await portfolioRoutes.buildPortfolioResponse(userId);
  const activeEvents = await getActiveMarketEvents();
  const scores = calculateScoresFromAssets(portfolio.portfolio?.assets || [], activeEvents);

  const updated = await db.query(
    `
    UPDATE game_profiles
    SET real_wealth = $2,
        weighted_wealth = $3,
        market_wealth = $4,
        league_key = $5,
        updated_at = NOW()
    WHERE user_id = $1
    RETURNING *
    `,
    [userId, scores.real_wealth, scores.weighted_wealth, scores.market_wealth, scores.league.key]
  );

  const newAchievements = await awardAchievements(userId, scores);

  return {
    game_version: GAME_VERSION,
    profile: updated.rows[0] || profile,
    public_settings: publicSettings,
    scores,
    new_achievements: newAchievements,
    portfolio_summary: {
      total_value: portfolio.total_value,
      total_day_change_value: portfolio.total_day_change_value,
      total_day_change_percent: portfolio.total_day_change_percent,
      portfolio_asset_count: portfolio.portfolio?.assets?.length || 0,
      watchlist_asset_count: portfolio.watchlist?.assets?.length || 0
    },
    active_market_events: activeEvents
  };
}

async function recomputeAllGameProfiles(limit = 500) {
  const users = await db.query(
    `
    SELECT id, email, display_name, role, is_active
    FROM portfolio_users
    WHERE is_active IS DISTINCT FROM false
    ORDER BY id ASC
    LIMIT $1
    `,
    [Math.max(1, Math.min(1000, Number(limit) || 500))]
  );
  const results = [];
  for (const user of users.rows) {
    try {
      const state = await buildGameStateForUser(user);
      results.push({ user_id: user.id, ok: true, market_wealth: state.scores.market_wealth, league_key: state.scores.league.key });
    } catch (err) {
      results.push({ user_id: user.id, ok: false, error: err.message });
    }
  }
  return results;
}

function publicProfileRow(row) {
  const alias = cleanText(row.alias, cleanText(row.display_name, `Spieler ${row.user_id || row.id}`, 120), 120);
  return {
    user_id: row.user_id || row.id,
    alias,
    avatar: row.avatar || null,
    game_theme: row.game_theme || "classic",
    game_mode: row.game_mode || "npc",
    level: Number(row.level || 1),
    xp: Number(row.xp || 0),
    wins: Number(row.wins || 0),
    streak: Number(row.streak || 0),
    real_wealth: round(row.real_wealth, 2),
    weighted_wealth: round(row.weighted_wealth, 2),
    market_wealth: round(row.market_wealth, 2),
    league_key: row.league_key || leagueForScore(row.market_wealth || 0).key,
    league_label: leagueForScore(row.market_wealth || 0).label,
    public_profile_enabled: row.public_profile_enabled === true,
    public_portfolio_enabled: row.public_portfolio_enabled === true,
    message_opt_in: row.message_opt_in === true,
    interests: parseJsonArray(row.interests)
  };
}

function roundToPublicBucket(value) {
  const n = Math.abs(toNumber(value, 0));
  const sign = value < 0 ? -1 : 1;
  let bucket = 1000;
  if (n >= 1000000) bucket = 100000;
  else if (n >= 100000) bucket = 10000;
  else if (n >= 10000) bucket = 5000;
  return sign * Math.round(n / bucket) * bucket;
}

function publicValue(value, settings) {
  return settings.show_exact_values === true ? round(value, 2) : roundToPublicBucket(value);
}

function hiddenIdSet(settings) {
  return new Set(parseJsonArray(settings.hidden_asset_ids).map(String));
}

function assetAllowedByVisibility(asset, settings) {
  const hidden = hiddenIdSet(settings);
  if (hidden.has(String(asset.id))) return false;
  const mode = settings.asset_visibility_mode || "categories";
  if (mode === "custom") return ["public", "category", "category_only"].includes(asset.public_visibility || "private");
  return true;
}

function sanitizePublicAsset(asset, settings) {
  if (!assetAllowedByVisibility(asset, settings)) return null;
  const gameClass = gameClassFromAsset(asset);
  const realValue = realValueForAsset(asset);
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    category_label: classDefinition(gameClass).portfolio_label,
    game_class: gameClass,
    game_class_label: classDefinition(gameClass).label,
    value: publicValue(realValue, settings),
    value_display_mode: settings.show_exact_values === true ? "exact" : "rounded",
    asset_group: asset.asset_group || null,
    asset_class: asset.asset_class || null,
    region: asset.region || null
  };
}

async function buildPublicPortfolio(userId) {
  const settings = await ensurePublicSettings(userId);
  if (settings.public_enabled !== true) {
    const error = new Error("Dieses Portfolio ist nicht öffentlich.");
    error.status = 403;
    throw error;
  }

  const portfolio = await portfolioRoutes.buildPortfolioResponse(userId);
  const mode = settings.asset_visibility_mode || "categories";
  const publicSourceAssets = (portfolio.portfolio?.assets || [])
    .filter((asset) => !asset.is_synthetic)
    .filter((asset) => assetAllowedByVisibility(asset, settings));

  const categories = new Map();
  for (const asset of publicSourceAssets) {
    const gameClass = gameClassFromAsset(asset);
    const def = classDefinition(gameClass);
    const current = categories.get(gameClass) || { game_class: gameClass, label: def.portfolio_label, value: 0, count: 0 };
    current.value += realValueForAsset(asset);
    current.count += 1;
    categories.set(gameClass, current);
  }

  return {
    user_id: Number(userId),
    visibility: {
      public_enabled: settings.public_enabled === true,
      asset_visibility_mode: mode,
      show_exact_values: settings.show_exact_values === true
    },
    total_value: publicValue(publicSourceAssets.reduce((sum, asset) => sum + realValueForAsset(asset), 0), settings),
    categories: Array.from(categories.values()).map((item) => ({ ...item, value: publicValue(item.value, settings) })),
    assets: mode === "categories" ? [] : publicSourceAssets.map((asset) => sanitizePublicAsset(asset, settings)).filter(Boolean)
  };
}

function safeError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

module.exports = {
  GAME_VERSION,
  GAME_CLASSES,
  LEAGUES,
  ACHIEVEMENTS,
  classDefinition,
  cleanText,
  parseJsonObject,
  parseJsonArray,
  toNumber,
  round,
  gameClassFromAsset,
  leagueForScore,
  calculateScoresFromAssets,
  ensureGameProfile,
  ensurePublicSettings,
  buildGameStateForUser,
  recomputeAllGameProfiles,
  publicProfileRow,
  buildPublicPortfolio,
  safeError
};
