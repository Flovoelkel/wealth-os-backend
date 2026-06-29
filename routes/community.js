const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const {
  GAME_VERSION,
  cleanText,
  parseJsonArray,
  publicProfileRow,
  buildGameStateForUser,
  ensurePublicSettings,
  buildPublicPortfolio,
  safeError
} = require("./game-helpers");

function boolOrNull(value) {
  if (value === undefined) return null;
  return value === true || value === "true" || value === 1 || value === "1";
}

router.get("/players", async (req, res) => {
  try {
    const q = cleanText(req.query.q, "", 100).toLowerCase();
    const sort = cleanText(req.query.sort, "wealth", 40);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const params = [limit];
    let where = "WHERE u.is_active IS DISTINCT FROM false AND gp.public_profile_enabled = true";

    if (q) {
      params.push(`%${q}%`);
      where += ` AND (lower(COALESCE(gp.alias,'')) LIKE $${params.length} OR lower(COALESCE(u.display_name,'')) LIKE $${params.length})`;
    }

    const order = sort === "league"
      ? "gp.league_key ASC, COALESCE(gp.market_wealth,0) DESC"
      : sort === "wins"
        ? "COALESCE(gp.wins,0) DESC, COALESCE(gp.market_wealth,0) DESC"
        : "COALESCE(gp.market_wealth,0) DESC, COALESCE(gp.weighted_wealth,0) DESC";

    const result = await db.query(
      `
      SELECT gp.*, u.display_name
      FROM game_profiles gp
      JOIN portfolio_users u ON u.id = gp.user_id
      ${where}
      ORDER BY ${order}
      LIMIT $1
      `,
      params
    );

    res.json({ ok: true, community_version: GAME_VERSION, players: result.rows.map(publicProfileRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Community konnte nicht geladen werden." });
  }
});

router.get("/players/:userId", async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return safeError(res, 400, "Ungültige Nutzer-ID.");

    const result = await db.query(
      `
      SELECT gp.*, u.display_name
      FROM game_profiles gp
      JOIN portfolio_users u ON u.id = gp.user_id
      WHERE gp.user_id = $1 AND u.is_active IS DISTINCT FROM false AND gp.public_profile_enabled = true
      LIMIT 1
      `,
      [userId]
    );

    if (!result.rows.length) return safeError(res, 404, "Profil wurde nicht gefunden oder ist nicht öffentlich.");
    res.json({ ok: true, player: publicProfileRow(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Profil konnte nicht geladen werden." });
  }
});

router.get("/players/:userId/portfolio", async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return safeError(res, 400, "Ungültige Nutzer-ID.");
    const portfolio = await buildPublicPortfolio(userId);
    res.json({ ok: true, portfolio });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ ok: false, error: status === 403 ? err.message : "Öffentliches Portfolio konnte nicht geladen werden." });
  }
});

router.post("/me/settings", requireAuth, async (req, res) => {
  try {
    await buildGameStateForUser(req.authUser);
    await ensurePublicSettings(req.authUser.id);

    const publicEnabled = boolOrNull(req.body.public_enabled);
    const allowMessages = boolOrNull(req.body.allow_messages);
    const showExactValues = boolOrNull(req.body.show_exact_values);
    const displayNameMode = cleanText(req.body.display_name_mode, null, 40);
    const assetVisibilityMode = cleanText(req.body.asset_visibility_mode, null, 40);
    const hiddenAssetIds = req.body.hidden_asset_ids !== undefined ? parseJsonArray(req.body.hidden_asset_ids).map(Number).filter(Number.isFinite) : null;
    const interests = req.body.interests !== undefined ? parseJsonArray(req.body.interests).slice(0, 20) : null;

    if (displayNameMode && !["alias", "real"].includes(displayNameMode)) return safeError(res, 400, "Anzeige-Name-Modus ist ungültig.");
    if (assetVisibilityMode && !["categories", "all", "custom"].includes(assetVisibilityMode)) return safeError(res, 400, "Portfolio-Sichtbarkeit ist ungültig.");

    const result = await db.query(
      `
      UPDATE public_portfolio_settings
      SET public_enabled = COALESCE($2, public_enabled),
          allow_messages = COALESCE($3, allow_messages),
          show_exact_values = COALESCE($4, show_exact_values),
          display_name_mode = COALESCE($5, display_name_mode),
          asset_visibility_mode = COALESCE($6, asset_visibility_mode),
          hidden_asset_ids = COALESCE($7::jsonb, hidden_asset_ids),
          interests = COALESCE($8::jsonb, interests),
          updated_at = NOW()
      WHERE user_id = $1
      RETURNING *
      `,
      [
        req.authUser.id,
        publicEnabled,
        allowMessages,
        showExactValues,
        displayNameMode,
        assetVisibilityMode,
        hiddenAssetIds === null ? null : JSON.stringify(hiddenAssetIds),
        interests === null ? null : JSON.stringify(interests)
      ]
    );

    await db.query(
      `
      UPDATE game_profiles
      SET public_profile_enabled = COALESCE($2, public_profile_enabled),
          public_portfolio_enabled = COALESCE($3, public_portfolio_enabled),
          message_opt_in = COALESCE($4, message_opt_in),
          interests = COALESCE($5::jsonb, interests),
          updated_at = NOW()
      WHERE user_id = $1
      `,
      [
        req.authUser.id,
        publicEnabled,
        publicEnabled,
        allowMessages,
        interests === null ? null : JSON.stringify(interests)
      ]
    );

    res.json({ ok: true, settings: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Community-Einstellungen konnten nicht gespeichert werden." });
  }
});

router.post("/me/assets/:assetId/visibility", requireAuth, async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isInteger(assetId)) return safeError(res, 400, "Ungültige Asset-ID.");
    const visibility = cleanText(req.body.public_visibility, "private", 40);
    if (!["private", "public", "category_only"].includes(visibility)) return safeError(res, 400, "Sichtbarkeit ist ungültig.");

    const result = await db.query(
      `UPDATE assets SET public_visibility = $3 WHERE user_id = $1 AND id = $2 RETURNING id, public_visibility`,
      [req.authUser.id, assetId, visibility]
    );
    if (!result.rows.length) return safeError(res, 404, "Asset wurde nicht gefunden.");
    res.json({ ok: true, asset: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Asset-Sichtbarkeit konnte nicht gespeichert werden." });
  }
});

module.exports = router;
