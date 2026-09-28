const express = require("express");
const path = require("path");
const { registerAuthRoutes } = require("../../lib/auth-routes");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
registerAuthRoutes(app);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/deposit", (req, res) => {
  res.sendFile(path.join(__dirname, "deposit.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`الموقع يعمل الآن بنجاح على المنفذ ${PORT}!`);
});