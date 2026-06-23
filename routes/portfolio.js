const router = require("express").Router();
const db = require("../db");

router.get("/", async (req, res) => {
  const userId = req.query.user_id;

  res.json({
    user_id: userId,
    assets: []
  });
});

module.exports = router;
