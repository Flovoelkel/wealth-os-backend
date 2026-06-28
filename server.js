const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "2mb" }));

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const mePortfolioRoutes = require("./routes/me-portfolio");
const meRefreshPricesRoutes = require("./routes/me-refresh-prices");
const mePortfolioSnapshotsRoutes = require("./routes/me-portfolio-snapshots");
const meAssetsRoutes = require("./routes/me-assets");

const portfolioRoutes = require("./routes/portfolio");
const refreshPricesRoutes = require("./routes/refresh-prices");
const assetUpdateRoutes = require("./routes/assets-update");
const assetCreateRoutes = require("./routes/assets-create");
const portfolioSnapshotsRoutes = require("./routes/portfolio-snapshots");
const assetSymbolSearchRoutes = require("./routes/assets-symbol-search");

function requireDashboardToken(req, res, next) {
  const expectedToken = process.env.PUBLIC_DASHBOARD_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({ error: "PUBLIC_DASHBOARD_TOKEN is not configured" });
  }

  const providedToken = req.query.token || req.headers["x-dashboard-token"];

  if (providedToken !== expectedToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// Authenticated user-facing routes. These should be used by fvoelkel.com/portfolio-dashboard.
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/me/portfolio", mePortfolioRoutes);
app.use("/api/me/refresh-prices", meRefreshPricesRoutes);
app.use("/api/me/portfolio-snapshots", mePortfolioSnapshotsRoutes);
app.use("/api/me/assets", meAssetsRoutes);

// Legacy routes remain available for the old one-user public/admin setup and automation compatibility.
app.use("/api/portfolio", requireDashboardToken, portfolioRoutes);
app.use("/api/refresh-prices", requireDashboardToken, refreshPricesRoutes);
app.use("/api/assets/update", assetUpdateRoutes);
app.use("/api/assets/create", assetCreateRoutes);
app.use("/api/portfolio-snapshots", portfolioSnapshotsRoutes);
app.use("/api/assets/search", assetSymbolSearchRoutes);

app.get("/", (req, res) => {
  res.json({ status: "wealth-os online", version: "v3.3-admin-login-multi-user" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
