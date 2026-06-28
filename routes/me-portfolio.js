const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const portfolioRoutes = require("./portfolio");

router.get("/", requireAuth, async (req, res) => {
  try {
    const payload = await portfolioRoutes.buildPortfolioResponse(req.authUser.id);
    res.json({
      ...payload,
      auth_user: {
        id: req.authUser.id,
        email: req.authUser.email,
        display_name: req.authUser.display_name
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Das Portfolio konnte nicht geladen werden.", code: "PORTFOLIO_LOAD_FAILED" });
  }
});

module.exports = router;
