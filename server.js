app.post('/sendMessages', async (req, res) => {
  const { soldiers, location } = req.body;

  if (!sock) return res.status(500).send('لم يتم الاتصال بعد بـ WhatsApp');

  try {
    for (const s of soldiers) {
      const jid = s.phone + '@s.whatsapp.net';
      const msg = `السلام عليكم ${s.name}\nوقت الاستلام: ${s.receiveTime}\nوقت التسليم: ${s.deliverTime}\nمكان التسليم: ${location}`;
      await sock.sendMessage(jid, { text: msg });
    }
    res.send('✅ تم إرسال الرسائل لجميع الأفراد');
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ حدث خطأ أثناء الإرسال');
  }
});
