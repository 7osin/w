import baileys from '@whiskeysockets/baileys'
import P from 'pino'
import express from 'express'
import bodyParser from 'body-parser'
import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { parse } from 'csv-parse/sync'
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys

const app = express()
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())
app.use(express.static('public'));

let sock // متغير الجلسة
let lastQRCode = null
let lastMessages = []

// سجل التقارير في الذاكرة (يمكنك لاحقاً حفظه في ملف أو قاعدة بيانات)
let reportsLog = []

// إعداد multer لرفع الملفات
const upload = multer({ dest: 'uploads/' });
let greetedNumbers = new Set();
let botActive = true; // حالة البوت (تشغيل/إيقاف)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version, isLatest } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' })
  });

  // مستمع الرسائل الواردة
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!messages || !messages[0]) return;
    const msg = messages[0];
    if (!msg.message || !msg.key || msg.key.fromMe) return;

    // استخراج نص الرسالة ورقم المرسل
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderJid = msg.key.remoteJid;

    // معالجة أوامر التحكم
    if (text.trim().toLowerCase() === 'ايقاف') {
      botActive = false;
      await sock.sendMessage(senderJid, { text: 'تم إيقاف البوت.' });
      return;
    }

    if (text.trim().toLowerCase() === 'تشغيل') {
      botActive = true;
      await sock.sendMessage(senderJid, { text: 'تم تشغيل البوت.' });
      return;
    }

    if (text.trim().toLowerCase() === 'رستارت') {
      botActive = true; // إعادة تشغيل البوت
      await sock.sendMessage(senderJid, { text: 'تم إعادة تشغيل البوت.' });
      try {
        await sock.sendMessage(senderJid, { text: '🔄 يتم الآن إعادة تشغيل البوت بالكامل...' });
        exec('powershell.exe -Command "Start-Process node whatsapp-bot.js"', async (error, stdout, stderr) => {
            if (error) {
                console.error('❌ فشل في إعادة تشغيل البوت:', error);
                await sock.sendMessage(senderJid, { text: '❌ حدث خطأ أثناء محاولة إعادة التشغيل.' });
                return;
            }
            await sock.sendMessage(senderJid, { text: '✅ تم إعادة تشغيل البوت بنجاح.' });
            process.exit(0);
        });
    } catch (error) {
        console.error('❌ فشل في إعادة تشغيل البوت:', error);
        await sock.sendMessage(senderJid, { text: '❌ حدث خطأ أثناء محاولة إعادة التشغيل.' });
    }
      return;
    }

    // أمر لإغلاق الاتصال بالكامل
    if (text.trim().toLowerCase() === 'اغلاق') {
      try {
        await sock.sendMessage(senderJid, { text: '🚫 يتم الآن إغلاق الاتصال بالكامل.' });
        await sock.logout(); // تسجيل الخروج من الجلسة
        process.exit(0); // إيقاف العملية بالكامل
      } catch (error) {
        console.error('❌ فشل في إغلاق الاتصال:', error);
        await sock.sendMessage(senderJid, { text: '❌ حدث خطأ أثناء محاولة الإغلاق.' });
      }
      return;
    }

    // إذا كان البوت غير نشط، لا يتم الرد على الرسائل الأخرى
    if (!botActive) {
      await sock.sendMessage(senderJid, { text: 'البوت غير نشط حالياً.' });
      return;
    }

    // معالجة الرسائل الأخرى (مثل "استلامي")
    const triggers = ['استلامي', 'موعدي', 'استلام', 'موعدالاستلام', 'موعد الاستلام'];
    const cleanText = text.trim().replace(/\s/g, '');
    if (triggers.includes(cleanText)) {
      let found = null;
      for (const report of reportsLog) {
        found = report.entries.find(e =>
          e.number.replace(/\D/g, '').endsWith(senderJid.replace(/\D/g, '').slice(-9))
        );
        if (found) break;
      }
      if (found) {
        const reply = `مرحباً ${found.name}\nموعد الاستلام: ${found.time_receive}\nموعد التسليم: ${found.time_return}\nالموقع: ${found.place}`;
        await sock.sendMessage(senderJid, { text: reply });
      } else {
        await sock.sendMessage(senderJid, { text: 'لم يتم العثور على بياناتك في آخر التقارير.' });
      }
    }

    // تحقق من البنق
    if (text.trim().toLowerCase() === 'بنق') {
      const startTime = Date.now();
      await sock.sendMessage(senderJid, { text: '🏓 البنق قيد القياس...' });
      const endTime = Date.now();
      const ping = endTime - startTime;
      await sock.sendMessage(senderJid, { text: `✅ البنق: ${ping}ms\nحالة البوت: ${botActive ? 'نشط' : 'غير نشط'}` });
      return;
    }

    // أمر جديد لجدول المستلمين
    if (text.trim().toLowerCase() === 'جدول المستلمين') {
      if (reportsLog.length === 0) {
        await sock.sendMessage(senderJid, { text: 'لا توجد بيانات مستلمين حالياً.' });
        return;
      }

      let tableMessage = '📋 جدول المستلمين:\n';
      // إضافة تسجيل لمحتوى reportsLog للتحقق من البيانات
console.log('📋 محتوى reportsLog:', reportsLog);

      reportsLog.forEach((report, index) => {
        report.entries.forEach((entry, entryIndex) => {
          tableMessage += `\n${index + 1}-${entryIndex + 1}. الاسم: ${entry.name || 'غير متوفر'}\nوقت الاستلام: ${entry.time_receive || 'غير متوفر'}\nوقت التسليم: ${entry.time_return || 'غير متوفر'}\nالمكان: ${entry.place || 'غير متوفر'}\n`;
        });
      });

      const imagePath = path.join(__dirname, 'public', 'pn39.png');
      await sock.sendMessage(senderJid, {
        text: tableMessage,
        image: { url: imagePath },
        caption: 'جدول المستلمين:'
      });
    }

    // أمر جديد لجدول اللوق
    if (text.trim().toLowerCase() === 'جدول اللوق') {
      try {
        const logFilePath = path.join(__dirname, 'reports-log.json');
        if (!fs.existsSync(logFilePath)) {
          await sock.sendMessage(senderJid, { text: 'لا توجد بيانات في سجل اللوق حالياً.' });
          return;
        }

        const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        console.log('📋 محتوى سجل اللوق:', logData);

        if (!Array.isArray(logData) || logData.length === 0) {
          await sock.sendMessage(senderJid, { text: 'لا توجد بيانات في سجل اللوق حالياً.' });
          return;
        }

        let logMessage = '📋 جدول اللوق:\n';
        logData.forEach((entry, index) => {
          logMessage += `\n${index + 1}. الاسم: ${entry.name || 'غير متوفر'}\nوقت الاستلام: ${entry.time_receive || 'غير متوفر'}\nوقت التسليم: ${entry.time_return || 'غير متوفر'}\nالمكان: ${entry.place || 'غير متوفر'}\n`;
        });

        const imagePath = path.join(__dirname, 'public', 'pn39.png');
        await sock.sendMessage(senderJid, {
          text: logMessage,
          image: { url: imagePath },
          caption: 'جدول اللوق:'
        });
      } catch (error) {
        console.error('❌ خطأ أثناء قراءة سجل اللوق:', error);
        await sock.sendMessage(senderJid, { text: '❌ حدث خطأ أثناء قراءة سجل اللوق.' });
      }
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQRCode = qr;
      const qrcode = await import('qrcode-terminal');
      qrcode.default.generate(qr, { small: true });
      console.log(`🔗 رابط رمز QR: k39-production.up.railway.app/qr`);
    }

    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!')
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

      console.log('⚠️ Connection closed. Reason:', lastDisconnect?.error?.output?.payload || 'Unknown');

      if (statusCode === 440) {
        console.error('❌ Conflict detected. Re-authenticating...');
        fs.rmSync('auth', { recursive: true, force: true }); // حذف بيانات الاعتماد القديمة
        startSock(); // إعادة المصادقة
      } else if (shouldReconnect) {
        console.log('Reconnecting...');
        startSock();
      } else {
        console.error('❌ Logged out. Please re-authenticate manually.');
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

startSock()

// اجعل صفحة التقرير هي الصفحة الرئيسية
app.get('/', (req, res) => {
  res.redirect('/report');
});

// صفحة ويب بسيطة لإرسال الرسائل
app.get('/old', (req, res) => {
  const status = sock && sock.ws.readyState === sock.ws.OPEN ? '✅ متصل' : '❌ غير متصل'
  const qrSection = (!sock || sock.ws.readyState !== sock.ws.OPEN) && lastQRCode
    ? `<div class="alert alert-warning text-center">
        <h5>امسح الباركود للاتصال بواتساب</h5>
        <img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(lastQRCode.trim().replace(/\s+/g, ''))}&size=200x200" />
      </div>`
    : ''

  const messagesHtml = lastMessages.length
    ? `<ul class="list-group mb-3">${lastMessages.map(m =>
        `<li class="list-group-item"><b>إلى:</b> ${m.number} <br><b>الرسالة:</b> ${m.message} <br><small>${m.time}</small></li>`
      ).join('')}</ul>`
    : '<div class="text-muted">لا توجد رسائل مرسلة بعد.</div>'

  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>بوت واتساب للتذكير</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.rtl.min.css" rel="stylesheet">
      <style>
        body { background: #f8f9fa; }
        .container { max-width: 600px; margin-top: 40px; }
      </style>
    </head>
    <body>
      <div class="container shadow rounded bg-white p-4">
        <h2 class="mb-4 text-center">🤖 بوت واتساب للتذكير</h2>
        <div class="mb-3">
          <span class="badge bg-${status.includes('متصل') ? 'success' : 'danger'}">${status}</span>
          <a href="/commands" class="btn btn-sm btn-outline-secondary float-end">الأوامر</a>
        </div>
        ${qrSection}
        <form method="POST" action="/send" class="mb-4">
          <div class="mb-3">
            <label class="form-label">رقم الهاتف (مثال: 9665xxxxxxxx):</label>
            <input type="text" name="number" class="form-control" required>
          </div>
          <div class="mb-3">
            <label class="form-label">الرسالة:</label>
            <textarea name="message" class="form-control" required></textarea>
          </div>
          <button type="submit" class="btn btn-primary w-100">إرسال رسالة</button>
        </form>
        <h5 class="mb-2">📜 آخر الرسائل المرسلة:</h5>
        ${messagesHtml}
        <div class="mt-4 text-center">
          <a href="/status" class="btn btn-outline-info btn-sm">حالة الاتصال</a>
          <a href="/qr" class="btn btn-outline-warning btn-sm">عرض QR</a>
          <a href="/logout" class="btn btn-outline-danger btn-sm">تسجيل الخروج</a>
        </div>
      </div>
    </body>
    </html>
  `)
})

// نقطة استقبال الرسائل مع حفظ السجل والتنبيه
app.post('/send', async (req, res) => {
  let { number, message } = req.body
  try {
    if (!sock || !sock.ws || sock.ws.readyState !== sock.ws.OPEN)
      return res.send('<script>alert("❌ لم يتم الاتصال بعد بـ WhatsApp.");window.history.back();</script>')

    number = String(number).replace(/\D/g, '')
    if (!number.startsWith('966')) number = '966' + number.replace(/^0+/, '')
    if (!number || !message || typeof message !== 'string' || !message.trim())
      return res.send('<script>alert("❌ يجب إدخال رقم ورسالة نصية صحيحة.");window.history.back();</script>')

    const jid = number + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: message })

    lastMessages.unshift({ number, message, time: new Date().toLocaleString('ar-EG') })
    if (lastMessages.length > 10) lastMessages.pop()

    res.send('<script>alert("✅ تم إرسال الرسالة بنجاح.");window.location="/";</script>')
  } catch (error) {
    console.error(error)
    res.send('<script>alert("❌ فشل في إرسال الرسالة.");window.history.back();</script>')
  }
})

// باقي المسارات (qr, status, disconnect, reconnect, auth, logout, health, version, config, commands) كما هي...

// صفحة التقرير اليومي مع إرسال جماعي
app.get('/report', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>فوج 39 الحرس الوطني</title>
  <style>
    body { font-family: 'Tahoma', sans-serif; background-color: #e0e0e0; padding: 20px; margin: 0; }
    .report-container { background: white; max-width: 800px; margin: auto; padding: 20px; border-radius: 12px; box-shadow: 0 0 10px rgba(0,0,0,0.1); position: relative; }
    h2 { text-align: center; margin-bottom: 10px; }
    .flag { position: absolute; top: 10%; left: 50%; transform: translateX(-50%); opacity: 0.1; z-index: -1; }
    .flag img { width: 120px; }
    .background-logo { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: 0.2; z-index: -2; }
    .background-logo img { width: 300px; }
    form, #imageArea { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-bottom: 20px; }
    input, select, button { padding: 8px 12px; font-size: 16px; border: 1px solid #ccc; border-radius: 8px; }
    button { background-color: #2f4f2f; color: white; cursor: pointer; }
    button:hover { background-color: #1e351e; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 10px; text-align: center; border: 1px solid #2f4f2f; }
    th { background-color: #2f4f2f; color: white; }
    td { position: relative; }
    .edit-btn { display: none; position: absolute; top: 5px; left: 5px; font-size: 14px; background-color: #2f4f2f; border: none; color: white; padding: 2px 6px; border-radius: 4px; cursor: pointer; }
    td:hover .edit-btn { display: inline-block; }
    #imageArea { text-align: center; }
    .hidden { display: none; }
    .names { white-space: pre-wrap; word-break: break-word; }
    .report-date { text-align: center; margin-bottom: 15px; font-size: 18px; font-weight: bold; }
    #placeRow { text-align: center; margin-top: 20px; display: block; }
    #placeRow input { padding: 10px; font-size: 18px; border: 2px solid #2f4f2f; border-radius: 10px; background-color: #f4f4f4; width: 80%; max-width: 400px; margin: auto; display: block; }
    #placeRow input:focus { outline: none; border-color: #1e351e; background-color: #e0e0e0; }
    #placeRow label { font-weight: bold; color: #2f4f2f; font-size: 16px; }
    #placeDisplay { text-align: center; font-size: 20px; font-weight: bold; margin-top: 20px; color: #2f4f2f; }
  </style>
</head>
<body>
  <div id="header" style="text-align: center; margin-bottom: 20px;">
    <h1>فوج 39   </h1>
    <img src="pn39.png" alt="شعار الحرس الوطني" style="width: 200px; height: auto;">
    <h2>📄 التقرير اليومي للأستلام 📄</h2>
  </div>
  <div class="report-container" id="capture">
    <div class="flag">
      <img src="pn39.png" alt=" الحرس الوطني">
    </div>
    <div class="background-logo">
      <img src="pn39.png" alt="شعار الحرس الوطني خلفية">
    </div>
    <div id="reportDate" class="report-date">
      <input type="date" id="manualDate" required>
      <select id="manualDay" required>
        <option value="">اختر اليوم</option>
        <option value="الأحد">الأحد</option>
        <option value="الاثنين">الاثنين</option>
        <option value="الثلاثاء">الثلاثاء</option>
        <option value="الأربعاء">الأربعاء</option>
        <option value="الخميس">الخميس</option>
        <option value="الجمعة">الجمعة</option>
        <option value="السبت">السبت</option>
      </select>
    </div>
    <form id="entryForm">
      <input type="text" id="name1" class="name-input" placeholder=" الاسم" required>
      <input type="text" id="number1" class="number-input" placeholder="رقم الجوال" required>
      <input type="text" id="name2" class="name-input hidden" placeholder="الاسم ">
      <input type="text" id="number2" class="number-input hidden" placeholder="رقم الجوال">
      <div>
        <input type="number" id="time_receive" placeholder="وقت الاستلام" required>
        <select id="time_select_receive">
          <option value="ص">ص</option>
          <option value="م">م</option>
        </select>
      </div>
      <div>
        <input type="number" id="time_return" placeholder="وقت التسليم" required>
        <select id="time_select_return">
          <option value="ص">ص</option>
          <option value="م">م</option>
        </select>
      </div>
      <select id="shift">
        <option value="1">استلام 1</option>
        <option value="2">استلام 2 (شخصان)</option>
      </select>
      <button type="submit">➕ إضافة</button>
    </form>
    <table id="reportTable">
      <thead>
        <tr>
          <th>الاسم</th>
          <th>وقت الاستلام</th>
          <th>وقت التسليم</th>
          <th class="phone-col">رقم الجوال</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <div id="placeRow">
      <label for="place"> الموقع</label>
      <input type="text" id="place" placeholder="أدخل موقع الاستلام" required style="text-align: center;">
      <button id="submitPlaceButton" class="hidden">➕ إضافة</button>
    </div>
    <div id="placeDisplay" class="hidden">
      <p> الـمـوقـع: <span id="placeText"></span></p>
    </div>
  </div>
  <div id="imageArea">
    <button onclick="downloadImage()">📷 تحميل التقرير كصورة</button>
    <button onclick="downloadPDF()">💾 تحميل التقرير PDF</button>
  </div>
  <div style="text-align:center;margin:20px;">
    <button id="sendReportBtn" style="background:#198754;color:#fff;padding:10px 30px;border:none;border-radius:8px;font-size:18px;cursor:pointer;">
      حفظ التقرير وإرسال الرسائل
    </button>
    <div style="text-align:center;margin:20px;">
  <a href="/reports-log" class="export-btn" style="background:#198754;color:#fff;padding:10px 30px;border-radius:8px;font-size:18px;text-decoration:none;display:inline-block;">
    📋 عرض سجل التقارير
  </a>
</div>
  </div>
  <!-- زر رسالة جديدة تحت زر الحفظ -->
<div style="text-align:center;margin:20px;">
  <button id="customMsgBtn" class="export-btn" style="background:#0d6efd;">✉️ رسالة جديدة</button>
</div>

<!-- نافذة الرسالة المخصصة (بدون إدخال أرقام) -->
<div id="customMsgModal" style="display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.3);z-index:9999;">
  <div style="background:#fff;max-width:400px;margin:60px auto;padding:25px;border-radius:12px;box-shadow:0 0 10px #888;position:relative;">
    <h3 style="text-align:center;">إرسال رسالة مخصصة لكل الأرقام في الجدول</h3>
    <form id="customMsgForm">
      <label>الرسالة:</label>
      <textarea id="customText" style="width:100%;height:80px;margin-bottom:10px;" required></textarea>
      <button type="submit" class="export-btn" style="background:#198754;">إرسال</button>
      <button type="button" class="export-btn" style="background:#dc3545;" onclick="document.getElementById('customMsgModal').style.display='none'">إغلاق</button>
    </form>
  </div>
</div>
<script>
document.getElementById('customMsgBtn').onclick = function() {
  document.getElementById('customMsgModal').style.display = 'block';
};
document.getElementById('customMsgForm').onsubmit = async function(e) {
  e.preventDefault();
  // جمع كل الأرقام من الجدول مباشرة
  let numbers = Array.from(document.querySelectorAll('#reportTable tbody tr td:nth-child(4)'))
    .map(td => td.innerText.replace("✏️", "").trim())
    .filter(Boolean);
  const message = document.getElementById('customText').value.trim();
  if (!numbers.length || !message) return alert('يجب وجود أرقام في الجدول وكتابة الرسالة');
  const res = await fetch('/send-custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numbers, message })
  });
  const msg = await res.text();
  alert(msg);
  document.getElementById('customMsgModal').style.display='none';
};
</script>
  <script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script>
    const form = document.getElementById("entryForm");
    const tableBody = document.querySelector("#reportTable tbody");
    const placeRow = document.getElementById("placeRow");
    const submitPlaceButton = document.getElementById("submitPlaceButton");
    const placeDisplay = document.getElementById("placeDisplay");
    const placeText = document.getElementById("placeText");

    form.onsubmit = function(e) {
      e.preventDefault();
      const name1 = document.getElementById("name1").value.trim();
      const number1 = document.getElementById("number1").value.trim();
      const name2 = document.getElementById("name2").value.trim();
      const number2 = document.getElementById("number2").value.trim();
      const time_receive = document.getElementById("time_receive").value.trim();
      const time_return = document.getElementById("time_return").value.trim();
      const shift = document.getElementById("shift").value;
      const time_receive_period = document.getElementById("time_select_receive").value;
      const time_return_period = document.getElementById("time_select_return").value;

      if (name1 && number1 && time_receive && time_return) {
        let rows = '';
        rows += \`<tr>
          <td class="editable">\${name1}<button class="edit-btn">✏️</button></td>
          <td class="editable">\${time_receive} \${time_receive_period}<button class="edit-btn">✏️</button></td>
          <td class="editable">\${time_return} \${time_return_period}<button class="edit-btn">✏️</button></td>
                      <td class="editable">\${number1}<button class="edit-btn">✏️</button></td>
        </tr>\`;
        if (shift === "2" && name2 && number2) {
          rows += \`<tr>
            <td class="editable">\${name2}<button class="edit-btn">✏️</button></td>
            <td class="editable">\${time_receive} \${time_receive_period}<button class="edit-btn">✏️</button></td>
            <td class="editable">\${time_return} \${time_return_period}<button class="edit-btn">✏️</button></td>
                        <td class="editable">\${number1}<button class="edit-btn">✏️</button></td>
          </tr>\`
        }
        tableBody.innerHTML += rows;
        form.reset();
        document.getElementById("name2").classList.add("hidden");
        document.getElementById("number2").classList.add("hidden");
        if (!placeRow.classList.contains("hidden")) {
          placeRow.style.display = 'block';
        }
      }
    };

    document.getElementById("shift").addEventListener("change", function() {
      document.getElementById("name2").classList.toggle("hidden", this.value !== "2");
      document.getElementById("number2").classList.toggle("hidden", this.value !== "2");
    });

    function updateManualDate() {
      const manualDate = document.getElementById("manualDate").value;
      const manualDay = document.getElementById("manualDay").value;
      if (manualDate && manualDay) {
        document.getElementById("reportDate").innerHTML = \`اليوم: \${manualDay} – التاريخ: \${manualDate}\`;
      }
    }

    document.getElementById("manualDate").addEventListener("change", updateManualDate);
    document.getElementById("manualDay").addEventListener("change", updateManualDate);

    function toggleVisibility(hidden) {
      document.getElementById("entryForm").classList.toggle("hidden", hidden);
      document.querySelectorAll(".edit-btn").forEach(btn => btn.style.display = hidden ? "none" : "");
      document.getElementById("imageArea").classList.toggle("hidden", hidden);
    }

function downloadImage() {
  hidePhoneColumn(true);
  toggleVisibility(true);
  const today = new Date();
  const formattedDate = today.toISOString().split('T')[0];
  html2canvas(document.getElementById("capture")).then(canvas => {
    const link = document.createElement("a");
        link.download = \`تقرير_فوج_39_\${formattedDate}.png\`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    hidePhoneColumn(false);
    toggleVisibility(false);
  });
}
      

async function downloadPDF() {
  hidePhoneColumn(true);
  toggleVisibility(true);
  const today = new Date();
  const formattedDate = today.toISOString().split('T')[0];
  const canvas = await html2canvas(document.getElementById("capture"));
  const imgData = canvas.toDataURL("image/png");
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();
  const imgProps = pdf.getImageProperties(imgData);
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
  pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(\`تقرير_فوج_39_\${formattedDate}.pdf\`);
  hidePhoneColumn(false);
  toggleVisibility(false);
}


    submitPlaceButton.addEventListener("click", function() {
      const place = document.getElementById("place").value.trim();
      if (place !== "") {
        placeText.textContent = place;
        placeDisplay.classList.remove("hidden");
        placeRow.style.display = 'none';
      }
    });

    document.getElementById("place").addEventListener("input", function() {
      submitPlaceButton.classList.toggle("hidden", this.value.trim() === "");
    });

    document.addEventListener("click", function(e) {
      if (e.target.classList.contains("edit-btn")) {
        const cell = e.target.parentElement;
        const oldContent = cell.childNodes[0].nodeValue.trim();
        const input = document.createElement("input");
        input.type = "text";
        input.value = oldContent.replace(/<br\\s*\\/?\>/g, "\\n");
        input.style.textAlign = "center";
        input.style.width = "100%";
        input.style.fontFamily = "inherit";
        input.style.fontSize = "16px";
        cell.innerHTML = "";
        cell.appendChild(input);
        input.focus();
        input.addEventListener("blur", function() {
          cell.innerHTML = input.value.includes("\\n") ? input.value.split("\\n").map(line => line.trim()).join("<br>") : input.value.trim();
          const editBtn = document.createElement("button");
          editBtn.className = "edit-btn";
          editBtn.textContent = "✏️";
          cell.appendChild(editBtn);
        });
      }
    });

    document.getElementById("sendReportBtn").onclick = async function() {
      const place = document.getElementById("place").value.trim() || document.getElementById("placeText").textContent.trim();
      const rows = Array.from(document.querySelectorAll("#reportTable tbody tr"));
      if (rows.length === 0) {
        alert("يجب إضافة بيانات أولاً!");
        return;
      }

      const progressBar = document.createElement("div");
      progressBar.style.width = "100%";
      progressBar.style.height = "30px";
      progressBar.style.backgroundColor = "#f3f3f3";
      progressBar.style.border = "1px solid #ccc";
      progressBar.style.borderRadius = "5px";
      progressBar.style.marginTop = "10px";
      progressBar.style.position = "relative";

      const progress = document.createElement("div");
      progress.style.height = "100%";
      progress.style.width = "0%";
      progress.style.backgroundColor = "#198754";
      progress.style.borderRadius = "5px";
      progress.style.transition = "width 0.3s";

      const progressText = document.createElement("span");
      progressText.style.position = "absolute";
      progressText.style.top = "50%";
      progressText.style.left = "50%";
      progressText.style.transform = "translate(-50%, -50%)";
      progressText.style.fontSize = "14px";
      progressText.style.color = "#fff";

      progressBar.appendChild(progress);
      progressBar.appendChild(progressText);
      document.getElementById("imageArea").appendChild(progressBar);

      const data = rows.map((row) => {
        const tds = row.querySelectorAll("td");
        return {
          name: tds[0].innerText.replace("✏️", "").trim(),
          time_receive: tds[1].innerText.replace("✏️", "").trim(),
          time_return: tds[2].innerText.replace("✏️", "").trim(),
          number: tds[3].innerText.replace("✏️", "").trim(),
          place
        };
      });

      for (let i = 0; i < data.length; i++) {
        try {
          const res = await fetch('/send-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [data[i]] })
          });
          const msg = await res.text();
          progress.style.width = ((i + 1) / data.length) * 100 + "%";
          progressText.textContent = Math.round(((i + 1) / data.length) * 100) + "%";
        } catch (error) {
          console.error("Error sending data:", error);
        }
      }

      setTimeout(() => {
        progressBar.remove();
      }, 2000);
    };

    function hidePhoneColumn(hide) {
  // إخفاء عنوان العمود
  const ths = document.querySelectorAll('#reportTable thead th');
  if (ths[3]) ths[3].style.display = hide ? 'none' : '';
  // إخفاء كل خلية رقم جوال في الصفوف
  document.querySelectorAll('#reportTable tbody tr').forEach(row => {
    if (row.children[3]) row.children[3].style.display = hide ? 'none' : '';
  }); 
}
  </script>
</body>
</html>
  `)
})

// تحميل السجل من ملف عند بدء التشغيل
const logFilePath = path.join(process.cwd(), 'reports-log.json');
if (fs.existsSync(logFilePath)) {
  try {
    reportsLog = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
  } catch (e) {
    reportsLog = [];
  }
}

// حفظ السجل في ملف
function saveReportsLog() {
  fs.writeFileSync(logFilePath, JSON.stringify(reportsLog, null, 2), 'utf8');
}

// تحديث /send-bulk ليحفظ السجل في ملف
app.post('/send-bulk', async (req, res) => {
  try {
    if (!sock || !sock.ws || sock.ws.readyState !== sock.ws.OPEN)
      return res.status(400).send('❌ لم يتم الاتصال بعد بـ WhatsApp.');

    const { data } = req.body;
    if (!Array.isArray(data) || !data.length)
      return res.status(400).send('❌ لا توجد بيانات لإرسالها.');

    // حفظ التقرير في السجل مع التاريخ والوقت
    reportsLog.unshift({
      date: new Date().toLocaleString('ar-EG'),
      entries: data
    });
    if (reportsLog.length > 30) reportsLog.pop(); // احتفظ بآخر 30 تقرير فقط
    saveReportsLog();

    let success = 0, fail = 0;
    for (const entry of data) {
      try {
        let number = String(entry.number).replace(/\D/g, '');
        if (!number.startsWith('966')) number = '966' + number.replace(/^0+/, '');
        const jid = number + '@s.whatsapp.net';
        const msg = `مرحباً ${entry.name}،\nموعد الاستلام: ${entry.time_receive}\nموعد التسليم: ${entry.time_return}\nالموقع: ${entry.place}`;
        // إرسال رسالة الموعد مباشرة
        await sock.sendMessage(jid, { text: msg });
        success++;

        // جدولة رسالة تنبيه في وقت الاستلام بالضبط
        scheduleReceiveReminder(entry, jid);

      } catch {
        fail++;
      }
    }
    res.send(`✅ تم إرسال الرسائل بنجاح لجميع الأرقام.\nنجاح: ${success} | فشل: ${fail}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('❌ حدث خطأ أثناء إرسال الرسائل.');
  }
});

// دالة جدولة التنبيه في وقت الاستلام
function scheduleReceiveReminder(entry, jid) {
  // توقع أن entry.time_receive مثل: "8 ص" أو "8 م"
  let [hour, period] = entry.time_receive.split(' ');
  hour = parseInt(hour);
  if (isNaN(hour)) return;

  // تحويل لصيغة 24 ساعة
  if (period === 'م' && hour < 12) hour += 12;
  if (period === 'ص' && hour === 12) hour = 0;

  // تحديد التاريخ اليوم (يمكنك تطويرها لاحقاً ليأخذ تاريخ التقرير)
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);

  // إذا الوقت قد مضى اليوم، لا ترسل تنبيه
  if (target < now) return;

  const msUntil = target - now;
  setTimeout(async () => {
    try {
      await sock.sendMessage(jid, { text: `تنبيه: الآن موعد استلامك (${entry.time_receive}) في الموقع: ${entry.place}` });
    } catch (e) { }
  }, msUntil);
}

function schedulePreReminder(entry, jid, minutesBefore = 20) {
  let [hour, period] = entry.time_receive.split(' ');
  hour = parseInt(hour);
  if (isNaN(hour)) return;

  // تحويل لصيغة 24 ساعة
  if (period === 'م' && hour < 12) hour += 12;
  if (period === 'ص' && hour === 12) hour = 0;

  // تحديد التاريخ اليوم
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);

  // تقليل الوقت بـ 20 دقيقة
  target.setMinutes(target.getMinutes() - minutesBefore);

  // إذا الوقت قد مضى اليوم، لا ترسل تنبيه
  if (target < now) return;

  const msUntil = target - now;
  setTimeout(async () => {
    try {
      await sock.sendMessage(jid, { text: `⏰ تنبيه: لديك موعد استلام بعد ${minutesBefore} دقيقة.` });
    } catch (error) {
      console.error('❌ فشل في إرسال التنبيه:', error);
    }
  }, msUntil);
}


// صفحة سجل التقارير مع بحث وحذف وتصدير
app.get('/reports-log', (req, res) => {
  const q = (req.query.q || '').trim();
  let filtered = reportsLog;
  if (q) {
    filtered = reportsLog.filter(r =>
      r.entries.some(e =>
        e.name.includes(q) ||
        e.number.includes(q) ||
        e.place.includes(q) ||
        r.date.includes(q)
      )
    );
  }
  let html = `
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>سجل التقارير</title>
      <style>
        body { font-family: Tahoma, sans-serif; background: #f8f9fa; padding: 30px; }
        .log-container { background: #fff; border-radius: 10px; box-shadow: 0 0 10px #ccc; max-width: 900px; margin: auto; padding: 20px; }
        h2 { text-align: center; }
        .report-block { border: 1px solid #198754; border-radius: 8px; margin-bottom: 20px; padding: 10px 15px; position:relative;}
        .report-date { color: #198754; font-weight: bold; margin-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: center; }
        th { background: #198754; color: #fff; }
        .delete-btn { position:absolute; top:10px; left:10px; background:#dc3545; color:#fff; border:none; border-radius:5px; padding:3px 10px; cursor:pointer;}
        .search-box {margin-bottom:20px;text-align:center;}
        .search-box input{padding:8px 12px;font-size:16px;border-radius:8px;border:1px solid #ccc;}
        .export-btn {background:#198754;color:#fff;padding:8px 18px;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-bottom:15px;}
      </style>
    </head>
    <body>
      <div class="log-container">
        <h2>📋 سجل التقارير المرسلة</h2>
        <div class="search-box">
          <form method="get" action="/reports-log">
            <input type="text" name="q" placeholder="بحث بالاسم أو الرقم أو الموقع أو التاريخ" value="${q}">
            <button type="submit">بحث</button>
            <a href="/reports-log" style="margin-right:10px;">إلغاء</a>
          </form>
        </div>
        <button class="export-btn" onclick="window.location='/reports-log/export-csv'">⬇️ تصدير كـ CSV</button>
        <a href="/reports-log/import-csv" class="export-btn" style="background:#ffc107;color:#222;">⬆️ استعادة من CSV</a>
        <a href="/report" style="display:inline-block;margin-bottom:15px;color:#198754;">⬅️ عودة للتقرير</a>
  `;

  if (filtered.length === 0) {
    html += `<div style="text-align:center;color:#888;">لا يوجد تقارير محفوظة بعد.</div>`;
  } else {
    filtered.forEach((report, idx) => {
      html += `
        <div class="report-block">
          <button class="delete-btn" onclick="if(confirm('تأكيد حذف التقرير؟')){window.location='/reports-log/delete/${reportsLog.length-1-idx}'}">حذف</button>
          <div class="report-date">#${reportsLog.length - idx} - ${report.date}</div>
          <table>
            <thead>
              <tr>
                <th>الاسم</th>
                <th>وقت الاستلام</th>
                <th>وقت التسليم</th>
                  <th>رقم الجوال</th>
                <th>الموقع</th>
              </tr>
            </thead>
            <tbody>
              ${report.entries.map(e => `
  <tr>
    <td>${e.name}</td>
    <td>${e.time_receive}</td>
    <td>${e.time_return}</td>
    <td>${e.number}</td>
    <td>${e.place}</td>
  </tr>
`).join('')}
            </tbody>
          </table>
        </div>
      `;
    });
  }

  html += `</div></body></html>`;
  res.send(html);
});

// حذف تقرير
app.get('/reports-log/delete/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  if (!isNaN(idx) && idx >= 0 && idx < reportsLog.length) {
    reportsLog.splice(idx, 1);
    saveReportsLog();
  }
  res.redirect('/reports-log');
});

// تصدير CSV
app.get('/reports-log/export-csv', (req, res) => {
  let csv = 'التاريخ,الاسم,رقم الجوال,وقت الاستلام,وقت التسليم,الموقع\n';
  reportsLog.forEach(report => {
    report.entries.forEach(e => {
      csv += `"${report.date}","${e.name}","${e.time_receive}","${e.number}","${e.time_return}","${e.place}"\n`;
    });
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reports-log.csv"');
  res.send('\uFEFF' + csv); // \uFEFF لإظهار العربي بشكل صحيح في Excel
});

// صفحة رفع CSV
app.get('/reports-log/import-csv', (req, res) => {
  res.send(`
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>استعادة سجل التقارير من CSV</title>
      <style>
        body { font-family: Tahoma, sans-serif; background: #f8f9fa; padding: 30px; }
        .container { background: #fff; border-radius: 10px; box-shadow: 0 0 10px #ccc; max-width: 500px; margin: auto; padding: 20px; }
        h2 { text-align: center; }
        form { text-align: center; margin-top: 30px; }
        input[type="file"] { margin-bottom: 15px; }
        button { background:#198754;color:#fff;padding:8px 18px;border:none;border-radius:8px;font-size:16px;cursor:pointer; }
        a { display:block; margin-top:20px; color:#198754; text-align:center;}
      </style>
    </head>
    <body>
      <div class="container">
        <h2>استعادة سجل التقارير من ملف CSV</h2>
        <form method="post" action="/reports-log/import-csv" enctype="multipart/form-data">
          <input type="file" name="csvfile" accept=".csv" required><br>
          <button type="submit">رفع واستعادة</button>
        </form>
        <a href="/reports-log">⬅️ عودة لسجل التقارير</a>
      </div>
    </body>
    </html>
  `);
});

// معالجة رفع واستيراد CSV
app.post('/reports-log/import-csv', upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) return res.send('❌ لم يتم رفع أي ملف.');
    const csvData = fs.readFileSync(req.file.path, 'utf8');
    const records = parse(csvData, {
      columns: true,
      skip_empty_lines: true
    });

    // تحويل CSV إلى reportsLog
    // كل صف في CSV يمثل إدخال (entry) في تقرير، مع عمود "التاريخ" لتجميعها
    const grouped = {};
    for (const row of records) {
      const date = row['التاريخ'] || 'غير معروف';
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push({
        name: row['الاسم'] || '',
        number: row['رقم الجوال'] || '',
        time_receive: row['وقت الاستلام'] || '',
        time_return: row['وقت التسليم'] || '',
        place: row['الموقع'] || ''
      });
    }
    // استبدل السجل الحالي بالمرفوع
    reportsLog = Object.entries(grouped).map(([date, entries]) => ({ date, entries }));
    saveReportsLog();

    // حذف الملف المؤقت
    fs.unlinkSync(req.file.path);

    res.send(`<script>alert('✅ تم استعادة السجل بنجاح!');window.location='/reports-log';</script>`);
  } catch (e) {
    console.error(e);
    res.send(`<script>alert('❌ فشل في استعادة السجل من CSV.');window.location='/reports-log';</script>`);
  }
});

app.post('/send-custom', async (req, res) => {
  try {
    if (!sock || !sock.ws || sock.ws.readyState !== sock.ws.OPEN)
      return res.status(400).send('❌ لم يتم الاتصال بعد بـ WhatsApp.');
    const { numbers, message } = req.body;
    if (!Array.isArray(numbers) || !message) return res.status(400).send('❌ بيانات غير صحيحة.');
    let success = 0, fail = 0;
    for (let number of numbers) {
      try {
        number = String(number).replace(/\D/g, '');
        if (!number.startsWith('966')) number = '966' + number.replace(/^0+/, '');
        const jid = number + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        success++;
      } catch {
        fail++;
      }
    }
    res.send(`✅ تم إرسال الرسالة.\nنجاح: ${success} | فشل: ${fail}`);
  } catch (e) {
    res.status(500).send('❌ حدث خطأ أثناء الإرسال.');
  }
});

// صفحة التحميل المخصصة لـ "Dashboard Render"
app.get('/dashboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Dashboard Render</title>
      <style>
        /* شاشة التحميل */
        #loading-screen {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background-color: #282c34;
          color: #61dafb;
          display: flex;
          justify-content: center;
          align-items: center;
          font-size: 24px;
          z-index: 9999;
        }
        .spinner {
          border: 4px solid #f3f3f3;
          border-top: 4px solid #61dafb;
          border-radius: 50%;
          width: 50px;
          height: 50px;
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <!-- شاشة التحميل -->
      <div id="loading-screen">
        <div>
          <div class="spinner"></div>
          <p>جاري تحميل Dashboard Render...</p>
        </div>
      </div>

      <!-- محتوى الموقع -->
      <div id="content" style="display: none;">
        <h1>مرحباً بك في Dashboard Render!</h1>
        <p>هذا هو المحتوى الرئيسي للوحة التحكم.</p>
      </div>

      <script>
        // إخفاء شاشة التحميل بعد تحميل الصفحة
        window.addEventListener('load', () => {
          const loadingScreen = document.getElementById('loading-screen');
          const content = document.getElementById('content');
          loadingScreen.style.display = 'none';
          content.style.display = 'block';
        });
      </script>
    </body>
    </html>
  `);
});

// إعداد مسار رئيسي
app.get('/', (req, res) => {
    res.send('<h1>WhatsApp Bot is Running!</h1>');
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 KaMa www http://localhost:${PORT}`);
})

// مسار لعرض صورة QR
app.get('/qr', (req, res) => {
  if (!lastQRCode) {
    return res.send('<h1>❌ لا يوجد رمز QR متاح حالياً.</h1>');
  }
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(lastQRCode.trim().replace(/\s+/g, ''))}&size=200x200`;
  res.send(`
    <!DOCTYPE html>
    <html lang="ar">
    <head>
      <meta charset="UTF-8">
      <title>عرض رمز QR</title>
    </head>
    <body style="text-align: center; font-family: Arial, sans-serif;">
      <h1>📱 رمز QR للاتصال بواتساب</h1>
      <img src="${qrImageUrl}" alt="رمز QR" style="margin-top: 20px;">
    </body>
    </html>
  `);
});
