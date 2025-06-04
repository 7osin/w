const express = require('express');
const path = require('path');
const app = express();

// إعداد مجلد الملفات العامة
app.use('/public', express.static(path.join(__dirname, 'public')));

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});