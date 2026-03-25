const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/deposit', (req, res) => res.sendFile(path.join(__dirname, 'deposit.html')));

app.post('/login', (req, res) => {
    console.log("بيانات دخول جديدة:", req.body);
    res.json({ success: true });
});

app.listen(8080, '0.0.0.0', () => console.log('السيرفر يعمل الآن على منفذ 8080'));
