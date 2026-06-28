const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const refreshPricesRoutes = require("./refresh-prices");

router.get("/", requireAuth, async (req, res) => {
  req.query.user_id = String(req.authUser.id);
  return refreshPricesRoutes.handleRefreshPrices(req, res);
});

module.exports = router;
