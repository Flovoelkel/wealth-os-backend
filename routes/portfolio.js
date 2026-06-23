const router = require("express").Router();
const db = require("../db");

router.get("/", async (req, res) => {
  const userId = req.query.user_id;

  const result = await db.query(
    "SELECT * FROM assets WHERE user_id = $1",
    [userId]
  );

  res.json(result.rows);
});

module.exports = router;
