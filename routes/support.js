import express from 'express';
import Qa from '../models/qa.js';
import PublicInquiry from '../models/publicInquiry.js';
import SupportInquiry from '../models/supportInquiry.js';
import { sendMail } from '../utils/mailer.js';

const router = express.Router();

const requireApiUser = (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized', message: 'ログインしてください' });
    return false;
  }
  return true;
};

// Member FAQ list (JSON)
router.get('/api/support', async (req, res) => {
  try {
    if (!requireApiUser(req, res)) return;
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

// Member inquiry list (JSON)
router.get('/api/support/inquiries', async (req, res) => {
  try {
    if (!requireApiUser(req, res)) return;
    const list = await SupportInquiry.find({ user: req.user._id })
      .sort({ update_date: -1 })
      .lean();
    const result = list.map((item) => {
      const messages = (item.messages && item.messages.length)
        ? item.messages
        : (item.message ? [{ content: item.message, isAdmin: false, isRead: true, entry_date: item.entry_date }] : []);
      return {
        _id: String(item._id),
        title: item.title || '',
        status: item.status || 'open',
        closed: !!item.closed,
        entry_date: item.entry_date || null,
        update_date: item.update_date || null,
        messages: messages.map((msg, index) => ({
          _id: String(msg._id || `${item._id}-${index}`),
          content: msg.content || '',
          isAdmin: !!msg.isAdmin,
          isRead: !!msg.isRead,
          entry_date: msg.entry_date || item.entry_date || null
        }))
      };
    });
    res.json(result);
  } catch (err) {
    console.error('support inquiry list error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// Member inquiry create (JSON)
router.post('/api/support/inquiries', async (req, res) => {
  try {
    if (!requireApiUser(req, res)) return;
    const email = String(req.body?.email || req.user?.email || '').trim();
    const title = String(req.body?.title || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!email || !title || !message) {
      return res.status(400).json({ error: 'missing_params', message: 'email, title, message は必須です' });
    }
    const created = await SupportInquiry.create({
      user: req.user._id,
      email,
      title,
      status: 'open',
      closed: false,
      messages: [{ content: message, isAdmin: false, isRead: true }]
    });
    const toEmail = process.env.ADMIN_NOTIFY_EMAIL || 'ma.oyabu@gmail.com';
    const html = `
      <p>会員からお問い合わせが届きました。</p>
      <p><strong>ユーザー:</strong> ${req.user?.displayname || req.user?.username || ''}</p>
      <p><strong>メールアドレス:</strong> ${email}</p>
      <p><strong>タイトル:</strong> ${title}</p>
      <p><strong>内容:</strong><br/>${message.replace(/\\n/g, '<br/>')}</p>
    `;
    await sendMail({
      to: toEmail,
      subject: `[会員お問い合わせ] ${title}`,
      html
    });
    res.json({ ok: true, id: String(created._id) });
  } catch (err) {
    console.error('support inquiry create error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// Member inquiry reply (JSON)
router.post('/api/support/inquiries/:id/reply', async (req, res) => {
  try {
    if (!requireApiUser(req, res)) return;
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'missing_params', message: 'message は必須です' });
    }
    const inquiry = await SupportInquiry.findOne({ _id: req.params.id, user: req.user._id });
    if (!inquiry) return res.status(404).json({ error: 'not_found' });
    if (inquiry.closed) return res.status(400).json({ error: 'closed', message: 'このお問い合わせは完了しています' });
    inquiry.messages.push({ content: message, isAdmin: false, isRead: true });
    inquiry.status = 'open';
    await inquiry.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('support inquiry reply error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// Member inquiry delete (JSON)
router.delete('/api/support/inquiries/:id', async (req, res) => {
  try {
    if (!requireApiUser(req, res)) return;
    const deleted = await SupportInquiry.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!deleted) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('support inquiry delete error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

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
