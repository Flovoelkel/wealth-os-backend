const router = require("express").Router();
const axios = require("axios");

const SEARCH_VERSION = "asset-symbol-search-v1.8";

function requireAdminToken(req, res, next) {
  const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN;
  if (!expectedToken) return res.status(500).json({ error: "ADMIN_DASHBOARD_TOKEN is not configured" });
  const providedToken = req.query.admin_token || req.headers["x-admin-token"] || req.body?.admin_token;
  if (providedToken !== expectedToken) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function normalizeQuery(q) {
  return String(q || "").trim();
}

function looksLikeIsin(query) {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/i.test(query);
}

function looksLikeWkn(query) {
  return /^[A-Z0-9]{6}$/i.test(query) && !looksLikeIsin(query);
}

function mapFinnhubResult(item) {
  return {
    source: "finnhub",
    symbol: item.symbol || null,
    provider_symbol: item.symbol || null,
    description: item.description || null,
    display_symbol: item.displaySymbol || null,
    type: item.type || null,
    score: null,
    currency: "USD",
    suggested_provider: "finnhub"
  };
}

function mapOpenFigiResult(item) {
  return {
    source: "openfigi",
    symbol: item.ticker || null,
    provider_symbol: item.ticker || null,
    description: item.name || item.securityDescription || null,
    display_symbol: item.securityDescription || item.ticker || null,
    exch_code: item.exchCode || null,
    security_type: item.securityType || item.securityType2 || null,
    market_sector: item.marketSector || null,
    figi: item.figi || null,
    currency: null,
    suggested_provider: item.exchCode === "US" ? "finnhub" : "manual"
  };
}

async function searchFinnhub(query) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return { results: [], error: "FINNHUB_API_KEY is not configured" };

  const response = await axios.get("https://finnhub.io/api/v1/search", {
    params: { q: query, token },
    timeout: 10000
  });

  return {
    results: (response.data?.result || []).slice(0, 8).map(mapFinnhubResult),
    error: null
  };
}

async function openFigiRequest(path, payload) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.OPENFIGI_API_KEY) {
    headers["X-OPENFIGI-APIKEY"] = process.env.OPENFIGI_API_KEY;
  }

  const response = await axios.post("https://api.openfigi.com/v3" + path, payload, {
    headers,
    timeout: 10000
  });

  return response.data;
}

async function searchOpenFigi(query) {
  const out = [];
  const errors = [];

  try {
    if (looksLikeWkn(query) || looksLikeIsin(query)) {
      const idType = looksLikeIsin(query) ? "ID_ISIN" : "ID_WERTPAPIER";
      const mapping = await openFigiRequest("/mapping", [{
        idType,
        idValue: query.toUpperCase(),
        marketSecDes: "Equity"
      }]);

      const data = mapping?.[0]?.data || [];
      out.push(...data.slice(0, 8).map(mapOpenFigiResult));
    } else {
      const search = await openFigiRequest("/search", {
        query,
        marketSecDes: "Equity"
      });

      const data = search?.data || [];
      out.push(...data.slice(0, 8).map(mapOpenFigiResult));
    }
  } catch (err) {
    errors.push(err.response?.data?.error || err.response?.data?.message || err.message);
  }

  return { results: out, error: errors[0] || null };
}

router.get("/", requireAdminToken, async (req, res) => {
  const query = normalizeQuery(req.query.q || req.query.query);
  const source = String(req.query.source || "all").toLowerCase();

  if (!query || query.length < 2) {
    return res.status(400).json({ error: "query must have at least 2 characters" });
  }

  const results = [];
  const errors = [];

  if (source === "all" || source === "finnhub") {
    try {
      const finnhub = await searchFinnhub(query);
      results.push(...finnhub.results);
      if (finnhub.error) errors.push({ source: "finnhub", error: finnhub.error });
    } catch (err) {
      errors.push({ source: "finnhub", error: err.response?.data?.error || err.message });
    }
  }

  if (source === "all" || source === "openfigi") {
    const openfigi = await searchOpenFigi(query);
    results.push(...openfigi.results);
    if (openfigi.error) errors.push({ source: "openfigi", error: openfigi.error });
  }

  res.json({
    search_version: SEARCH_VERSION,
    query,
    count: results.length,
    results,
    errors
  });
});

module.exports = router;
