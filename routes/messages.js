const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { cleanText, buildGameStateForUser, safeError } = require("./game-helpers");

async function canSendMessage(senderId, receiverId) {
  const result = await db.query(
    `
    SELECT
      sp.user_id AS sender_id, sp.league_key AS sender_league,
      rp.user_id AS receiver_id, rp.league_key AS receiver_league, rp.message_opt_in,
      pps.allow_messages
    FROM game_profiles sp
    JOIN game_profiles rp ON rp.user_id = $2
    LEFT JOIN public_portfolio_settings pps ON pps.user_id = rp.user_id
    WHERE sp.user_id = $1
    LIMIT 1
    `,
    [senderId, receiverId]
  );

  const row = result.rows[0];
  if (!row) return { ok: false, error: "Spielprofile fehlen." };
  if (row.message_opt_in !== true && row.allow_messages !== true) return { ok: false, error: "Der Empfänger erlaubt aktuell keine Nachrichten." };
  if (row.sender_league !== row.receiver_league) return { ok: false, error: "Nachrichten sind aktuell nur innerhalb derselben Vermögens-Liga erlaubt." };
  return { ok: true };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const result = await db.query(
      `
      SELECT
        m.*,
        sender.display_name AS sender_display_name,
        receiver.display_name AS receiver_display_name,
        sgp.alias AS sender_alias,
        rgp.alias AS receiver_alias
      FROM player_messages m
      JOIN portfolio_users sender ON sender.id = m.sender_user_id
      JOIN portfolio_users receiver ON receiver.id = m.receiver_user_id
      LEFT JOIN game_profiles sgp ON sgp.user_id = sender.id
      LEFT JOIN game_profiles rgp ON rgp.user_id = receiver.id
      WHERE m.sender_user_id = $1 OR m.receiver_user_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2
      `,
      [req.authUser.id, limit]
    );
    res.json({ ok: true, messages: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Nachrichten konnten nicht geladen werden." });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const receiverId = Number(req.body.receiver_user_id);
    if (!Number.isInteger(receiverId) || receiverId === Number(req.authUser.id)) return safeError(res, 400, "Ungültiger Empfänger.");
    const messageText = cleanText(req.body.message_text, null, 2000);
    if (!messageText) return safeError(res, 400, "Nachricht fehlt.");

    await buildGameStateForUser(req.authUser);
    const receiver = await db.query("SELECT id, display_name, is_active FROM portfolio_users WHERE id = $1 LIMIT 1", [receiverId]);
    if (!receiver.rows.length || receiver.rows[0].is_active === false) return safeError(res, 404, "Empfänger wurde nicht gefunden.");
    await buildGameStateForUser(receiver.rows[0]);

    const allowed = await canSendMessage(req.authUser.id, receiverId);
    if (!allowed.ok) return safeError(res, 403, allowed.error);

    const result = await db.query(
      `
      INSERT INTO player_messages (sender_user_id, receiver_user_id, message_text, status, created_at)
      VALUES ($1, $2, $3, 'sent', NOW())
      RETURNING *
      `,
      [req.authUser.id, receiverId, messageText]
    );

    res.status(201).json({ ok: true, message: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Nachricht konnte nicht gesendet werden." });
  }
});

router.post("/:id/read", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return safeError(res, 400, "Ungültige Nachrichten-ID.");
    const result = await db.query(
      `
      UPDATE player_messages
      SET status = 'read', read_at = NOW()
      WHERE id = $1 AND receiver_user_id = $2
      RETURNING *
      `,
      [id, req.authUser.id]
    );
    if (!result.rows.length) return safeError(res, 404, "Nachricht wurde nicht gefunden.");
    res.json({ ok: true, message: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: "Nachricht konnte nicht aktualisiert werden." });
  }
});

module.exports = router;
