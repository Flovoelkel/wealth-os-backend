const router = require("express").Router();
const db = require("../db");
const portfolioRoutes = require("./portfolio");

const SNAPSHOT_VERSION = "portfolio-snapshots-v3.0-multi-user";

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function requirePublicToken(req, res, next) {
  const expectedToken = process.env.PUBLIC_DASHBOARD_TOKEN;
  if (!expectedToken) return res.status(500).json({ error: "PUBLIC_DASHBOARD_TOKEN is not configured" });
  const providedToken = req.query.token || req.headers["x-dashboard-token"];
  if (providedToken !== expectedToken) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function requireAdminToken(req, res, next) {
  const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN;
  if (!expectedToken) return res.status(500).json({ error: "ADMIN_DASHBOARD_TOKEN is not configured" });
  const providedToken = req.query.admin_token || req.headers["x-admin-token"] || req.body?.admin_token;
  if (providedToken !== expectedToken) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function handleGetSnapshots(req, res) {
  try {
    const userId = Number(req.query.user_id || 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 365), 1), 2000);

    const result = await db.query(
      `
      SELECT
        snapshot_date,
        currency,
        total_value,
        total_day_change_value,
        total_day_change_percent,
        portfolio_value,
        watchlist_value,
        target_gap_value,
        target_gap_count,
        asset_count,
        created_at,
        updated_at
      FROM portfolio_snapshots
      WHERE user_id = $1
      ORDER BY snapshot_date DESC
      LIMIT $2
      `,
      [userId, limit]
    );

    const snapshots = result.rows.reverse();

    res.json({
      snapshot_version: SNAPSHOT_VERSION,
      user_id: userId,
      count: snapshots.length,
      snapshots
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Snapshot history failed", details: err.message });
  }
}

async function captureSnapshotForUser(userId, snapshotDate = todayIsoDate()) {
  const portfolio = await portfolioRoutes.buildPortfolioResponse(userId);
  const assetCount =
    (portfolio.portfolio?.assets?.length || 0) +
    (portfolio.watchlist?.assets?.filter((asset) => !asset.is_synthetic).length || 0);

  const result = await db.query(
    `
    INSERT INTO portfolio_snapshots (
      user_id,
      snapshot_date,
      currency,
      total_value,
      total_day_change_value,
      total_day_change_percent,
      portfolio_value,
      watchlist_value,
      target_gap_value,
      target_gap_count,
      asset_count,
      payload,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (user_id, snapshot_date)
    DO UPDATE SET
      currency = EXCLUDED.currency,
      total_value = EXCLUDED.total_value,
      total_day_change_value = EXCLUDED.total_day_change_value,
      total_day_change_percent = EXCLUDED.total_day_change_percent,
      portfolio_value = EXCLUDED.portfolio_value,
      watchlist_value = EXCLUDED.watchlist_value,
      target_gap_value = EXCLUDED.target_gap_value,
      target_gap_count = EXCLUDED.target_gap_count,
      asset_count = EXCLUDED.asset_count,
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING *
    `,
    [
      userId,
      snapshotDate,
      portfolio.currency || "EUR",
      toNumber(portfolio.total_value),
      toNumber(portfolio.total_day_change_value),
      portfolio.total_day_change_percent,
      toNumber(portfolio.portfolio?.total_value),
      toNumber(portfolio.watchlist?.total_value),
      toNumber(portfolio.target_gaps?.total_value),
      Number(portfolio.target_gaps?.count || 0),
      assetCount,
      portfolio
    ]
  );

  return result.rows[0];
}

async function handleCaptureSnapshot(req, res) {
  try {
    const userId = Number(req.body?.user_id || req.query.user_id || 1);
    const snapshotDate = req.body?.snapshot_date || req.query.snapshot_date || todayIsoDate();
    const snapshot = await captureSnapshotForUser(userId, snapshotDate);

    res.status(201).json({
      snapshot_version: SNAPSHOT_VERSION,
      ok: true,
      snapshot
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Snapshot capture failed", details: err.message });
  }
}

async function handleCaptureAll(req, res) {
  try {
    const snapshotDate = req.body?.snapshot_date || req.query.snapshot_date || todayIsoDate();

    const users = await db.query(
      `
      SELECT id, email
      FROM portfolio_users
      WHERE COALESCE(is_active, true) = true
      ORDER BY id ASC
      `
    );

    const results = [];

    for (const user of users.rows) {
      try {
        const snapshot = await captureSnapshotForUser(Number(user.id), snapshotDate);
        results.push({ user_id: Number(user.id), email: user.email, ok: true, total_value: snapshot.total_value });
      } catch (err) {
        results.push({ user_id: Number(user.id), email: user.email, ok: false, error: err.message });
      }
    }

    res.status(201).json({
      snapshot_version: SNAPSHOT_VERSION,
      ok: results.every((item) => item.ok),
      snapshot_date: snapshotDate,
      processed: results.length,
      results
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Snapshot capture all failed", details: err.message });
  }
}

router.get("/", requirePublicToken, handleGetSnapshots);
router.post("/capture", requireAdminToken, handleCaptureSnapshot);
router.post("/capture-all", requireAdminToken, handleCaptureAll);

module.exports = router;
module.exports.handleGetSnapshots = handleGetSnapshots;
module.exports.handleCaptureSnapshot = handleCaptureSnapshot;
module.exports.handleCaptureAll = handleCaptureAll;
module.exports.captureSnapshotForUser = captureSnapshotForUser;
