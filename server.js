const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ROUTES EINBINDEN
const portfolioRoutes = require("./routes/portfolio");
app.use("/api/portfolio", portfolioRoutes);

// TEST ROUTE
app.get("/", (req, res) => {
  res.json({ status: "wealth-os online" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));

app.get("/debug/env", (req, res) => {
  res.json({
    hasFinnhubKey: Boolean(process.env.FINNHUB_API_KEY),
    hasCoinGeckoKey: Boolean(process.env.COINGECKO_API_KEY)
  });
});
