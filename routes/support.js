import express from 'express';
import Qa from '../models/qa.js';
import PublicInquiry from '../models/publicInquiry.js';
import { sendMail } from '../utils/mailer.js';

const router = express.Router();

// Public FAQ list (JSON)
router.get('/api/support/public/faq', async (req, res) => {
  try {
    const flagRaw = String(req.query.faq_flag || '').trim().toLowerCase();
    let faqFlag = true;
    if (flagRaw) {
      faqFlag = ['true', '1', 'yes'].includes(flagRaw);
    }
    const items = await Qa.find({ faq_flag: faqFlag })
      .select('qa_category qa_question qa_answer url')
      .sort({ update_date: -1 })
      .lean();
    const result = items.map((item) => ({
      _id: String(item._id),
      qa_category: item.qa_category || '',
      qa_question: item.qa_question || '',
      qa_answer: item.qa_answer || '',
      url: item.url || null
    }));
    res.json(result);
  } catch (err) {
    console.error('support faq error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// Public inquiry (JSON)
router.post('/api/support/public/inquiries', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const title = String(req.body?.title || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!email || !title || !message) {
      return res.status(400).json({ error: 'missing_params', message: 'email, title, message は必須です' });
    }
    const created = await PublicInquiry.create({ email, title, message });
    const toEmail = process.env.ADMIN_NOTIFY_EMAIL || 'ma.oyabu@gmail.com';
    const html = `
      <p>お問い合わせが届きました。</p>
      <p><strong>メールアドレス:</strong> ${email}</p>
      <p><strong>タイトル:</strong> ${title}</p>
      <p><strong>内容:</strong><br/>${message.replace(/\\n/g, '<br/>')}</p>
    `;
    await sendMail({
      to: toEmail,
      subject: `[お問い合わせ] ${title}`,
      html
    });
    res.json({ ok: true, id: String(created._id) });
  } catch (err) {
    console.error('support inquiry error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

export default router;
