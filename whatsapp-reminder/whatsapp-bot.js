import baileys from '@whiskeysockets/baileys'
import P from 'pino'
import express from 'express'
import bodyParser from 'body-parser'

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys

const app = express()
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())

let sock
let lastQRCode = null
let lastMessages = []

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version, isLatest } = await fetchLatestBaileysVersion()

  console.log('✅ Using WA version:', version, ', latest:', isLatest)

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' })
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQRCode = qr
      const qrcode = await import('qrcode-terminal')
      qrcode.default.generate(qr, { small: true })
    }

    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!')
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('⚠️ Connection closed. Reconnecting...', shouldReconnect)
      if (shouldReconnect) {
        startSock()
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

startSock()

app.get('/', (req, res) => {
  const status = sock && sock.ws.readyState === sock.ws.OPEN ? '✅ متصل' : '❌ غير متصل'
  const qrSection = (!sock || sock.ws.readyState !== sock.ws.OPEN) && lastQRCode
    ? `<div class="alert alert-warning text-center">
        <h5>امسح الباركود للاتصال بواتساب</h5>
        <img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(lastQRCode)}&size=200x200" />
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

app.listen(3000, () => {
  console.log('🚀 الخادم يعمل على http://localhost:3000')
})