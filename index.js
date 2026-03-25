const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/deposit', (req, res) => {
    res.sendFile(path.join(__dirname, 'deposit.html'));
});

app.post('/login', (req, res) => {
    console.log("بيانات دخول مستلمة:", req.body);
    res.status(200).json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`السيرفر يعمل الآن على المنفذ ${PORT}`);
});
