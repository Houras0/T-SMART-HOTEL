const express = require("express");
const path = require("path");
require("dotenv").config();
const { registerAuthRoutes, verifyEmailTransport } = require("./lib/auth-routes");

const app = express();
const publicDir = path.join(__dirname, "public");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir, { index: false }));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use(express.static(__dirname));
registerAuthRoutes(app);
void verifyEmailTransport()
  .then(() => console.log("✅ Email SMTP connection verified"))
  .catch((error) => console.error("⚠️ Email SMTP verification failed:", {
    code: error?.code,
    responseCode: error?.responseCode,
    command: error?.command,
  }));

app.get(["/api", "/api/"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/deposit", (req, res) => {
  res.sendFile(path.join(__dirname, "deposit.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Ready on port ${PORT}!`);
});