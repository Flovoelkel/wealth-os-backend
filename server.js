const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const portfolioRoutes = require("./routes/portfolio");
const refreshPricesRoutes = require("./routes/refresh-prices");

function requireDashboardToken(req, res, next) {
  const expectedToken = process.env.PUBLIC_DASHBOARD_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({
      error: "PUBLIC_DASHBOARD_TOKEN is not configured"
    });
  }

  const providedToken =
    req.query.token ||
    req.headers["x-dashboard-token"];

  if (providedToken !== expectedToken) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

app.use("/api/portfolio", requireDashboardToken, portfolioRoutes);
app.use("/api/refresh-prices", requireDashboardToken, refreshPricesRoutes);

app.get("/", (req, res) => {
  res.json({ status: "wealth-os online" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
