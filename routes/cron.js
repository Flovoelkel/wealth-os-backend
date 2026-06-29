const router = require("express").Router();
const db = require("../db");
const refreshRoutes = require("./refresh-prices");
const { recomputeAllGameProfiles, safeError } = require("./game-helpers");

function requireCronToken(req, res, next) {
  const expected = process.env.CRON_SECRET || process.env.ADMIN_DASHBOARD_TOKEN;
  if (!expected) return res.status(500).json({ ok: false, error: "CRON_SECRET ist nicht konfiguriert." });
  const provided = req.headers["x-cron-token"] || req.query.cron_token || req.body?.cron_token;
  if (provided !== expected) return res.status(401).json({ ok: false, error: "Cron nicht autorisiert." });
  next();
}

async function callRefreshForUser(userId, provider, limit, staleMinutes, fx) {
  return new Promise((resolve) => {
    const req = {
      query: {
        user_id: String(userId),
        provider,
        limit: String(limit || 10),
        stale_minutes: String(staleMinutes ?? 60),
        fx: fx === false ? "false" : "true"
      }
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); }
    };
    refreshRoutes.handleRefreshPrices(req, res);
  });
}

router.post("/refresh-prices", requireCronToken, async (req, res) => {
  try {
    const provider = req.body.provider || req.query.provider || null;
    const limitPerUser = Math.max(1, Math.min(50, Number(req.body.limit_per_user || req.query.limit_per_user || 10)));
    const staleMinutes = Math.max(0, Number(req.body.stale_minutes || req.query.stale_minutes || 60));
    const maxUsers = Math.max(1, Math.min(200, Number(req.body.max_users || req.query.max_users || 50)));
    const fx = req.body.fx !== false && req.query.fx !== "false";

    const users = await db.query(
      `
      SELECT DISTINCT u.id
      FROM portfolio_users u
      JOIN assets a ON a.user_id = u.id
      WHERE u.is_active IS DISTINCT FROM false
        AND a.live_enabled = true
      ORDER BY u.id ASC
      LIMIT $1
      `,
      [maxUsers]
    );

    const results = [];
    for (const user of users.rows) {
      const result = await callRefreshForUser(user.id, provider, limitPerUser, staleMinutes, fx);
      results.push({ user_id: user.id, status: result.status, processed: result.payload?.processed || 0, error: result.payload?.error || null });
    }

    res.json({ ok: true, processed_users: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Preisaktualisierung konnte nicht ausgeführt werden." });
  }
});

router.post("/recompute-game-scores", requireCronToken, async (req, res) => {
  try {
    const results = await recomputeAllGameProfiles(req.body.limit || req.query.limit || 500);
    res.json({ ok: true, processed: results.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Spielwerte konnten nicht neu berechnet werden." });
  }
});

router.post("/daily", requireCronToken, async (req, res) => {
  try {
    const refresh = await new Promise((resolve) => {
      const fakeReq = { ...req, body: { ...req.body, max_users: req.body.max_users || 50, limit_per_user: req.body.limit_per_user || 10 } };
      const fakeRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, payload }); } };
      router.handle({ ...fakeReq, method: "POST", url: "/refresh-prices" }, fakeRes, () => resolve({ status: 500, payload: { error: "Cron routing failed" } }));
    });
    const scores = await recomputeAllGameProfiles(req.body.limit || 500);
    res.json({ ok: true, refresh: refresh.payload, score_recompute: { processed: scores.length, results: scores } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Daily Cron konnte nicht ausgeführt werden." });
  }
});

router.get("/health", requireCronToken, async (req, res) => {
  res.json({ ok: true, cron_version: "v3.4-game-community-foundation" });
});

module.exports = router;
