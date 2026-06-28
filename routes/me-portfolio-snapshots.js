const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const snapshotRoutes = require("./portfolio-snapshots");

router.get("/", requireAuth, async (req, res) => {
  req.query.user_id = String(req.authUser.id);
  return snapshotRoutes.handleGetSnapshots(req, res);
});

router.post("/capture", requireAuth, async (req, res) => {
  req.query.user_id = String(req.authUser.id);
  return snapshotRoutes.handleCaptureSnapshot(req, res);
});

module.exports = router;
