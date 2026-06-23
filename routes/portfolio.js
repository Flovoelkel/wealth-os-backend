const router = require("express").Router();
const db = require("../db");

router.get("/", async (req, res) => {
  try {
    const userId = req.query.user_id;

    const result = await db.query(
      "SELECT * FROM assets WHERE user_id = $1",
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
