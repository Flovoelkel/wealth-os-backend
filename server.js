const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// Portfolio Routes
const portfolioRoutes = require("./routes/portfolio");
app.use("/api/portfolio", portfolioRoutes);

// Health Check
app.get("/", (req, res) => {
  res.json({ status: "wealth-os online" });
});

// Temporary Debug Route
app.get("/debug/env", (req, res) => {
  res.json({
    hasFinnhubKey: Boolean(process.env.FINNHUB_API_KEY),
    hasCoinGeckoKey: Boolean(process.env.COINGECKO_API_KEY)
  });
});

app.get("/debug/coingecko", async (req, res) => {
  try {
    const axios = require("axios");

    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: "bitcoin",
          vs_currencies: "usd",
          include_24hr_change: "true",
          x_cg_demo_api_key: process.env.COINGECKO_API_KEY
        },
        headers: {
          "x-cg-demo-api-key": process.env.COINGECKO_API_KEY
        },
        timeout: 8000
      }
    );

    res.json({
      ok: true,
      data: response.data
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      ok: false,
      status: err.response?.status || null,
      message: err.message,
      data: err.response?.data || null
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
