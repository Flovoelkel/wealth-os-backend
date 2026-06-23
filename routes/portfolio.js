const router = require("express").Router();
const db = require("../db");

const axios = require("axios");

// STOCK PRICE (einfacher Placeholder erstmal)
async function getPrice(asset) {

  if (asset.type === "stock") {
    return 150; // später Finnhub
  }

  if (asset.type === "etf") {
    return 80; // später API
  }

  if (asset.type === "crypto") {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${asset.coin_id}&vs_currencies=usd`
    );

    return res.data[asset.coin_id].usd;
  }

  if (asset.type === "manual") {
    return asset.manual_value;
  }

  return 0;
}

router.get("/", async (req, res) => {

  const userId = req.query.user_id;

  const result = await db.query(
    "SELECT * FROM assets WHERE user_id = $1",
    [userId]
  );

  const assets = result.rows;

  const enriched = await Promise.all(
    assets.map(async (a) => {
      const price = await getPrice(a);

      return {
        ...a,
        price,
        value: price * a.quantity
      };
    })
  );

  res.json(enriched);
});

module.exports = router;
