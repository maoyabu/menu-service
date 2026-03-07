import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/users.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

const toUserJSON = (user) => ({
  id: String(user._id),
  username: user.username,
  email: user.email,
  displayname: user.displayname || null,
  isAdmin: Boolean(user.isAdmin)
});

router.post('/login', async (req, res) => {
  try {
    const { username, email, identifier, password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'missing_params', message: 'password は必須です' });
    }

    let user = null;
    const identifierValue = String(identifier || username || email || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (normalizedEmail) {
      user = await User.findOne({ email: normalizedEmail });
    }
    if (!user && identifierValue) {
      if (identifierValue.includes('@')) {
        user = await User.findOne({ email: identifierValue.toLowerCase() });
      }
      if (!user) {
        user = await User.findOne({ username: identifierValue });
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'IDまたはパスワードが違います' });
    }

    if (user.unsubscribe_date) {
      return res.status(403).json({ error: 'unsubscribed', message: '退会済みのためログインできません' });
    }

    const isValid = await new Promise((resolve) => {
      user.authenticate(password, (_err, thisUser, passwordError) => {
        resolve(!passwordError && !!thisUser);
      });
    });

    if (!isValid) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'IDまたはパスワードが違います' });
    }

    const token = jwt.sign({ sub: String(user._id) }, JWT_SECRET, { expiresIn: '14d' });
    return res.json({ token, user: toUserJSON(user) });
  } catch (err) {
    console.error('api auth login error:', err);
    return res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

export default router;
