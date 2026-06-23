const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const portfolioRoutes = require("./routes/portfolio");
app.use("/api/portfolio", portfolioRoutes);

app.get("/", (req, res) => {
  res.json({ status: "wealth-os online" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
