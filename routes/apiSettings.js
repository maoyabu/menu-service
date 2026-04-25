import express from 'express';
import multer from 'multer';
import User from '../models/users.js';
import Group from '../models/groups.js';
import cloudinary from '../utils/cloudinary.js';

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

const requireLoginApi = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthorized', message: 'ログインしてください' });
};

const extractCloudinaryPublicId = (url) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/cloudinary\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const uploadIndex = parts.findIndex((part) => part === 'upload');
    if (uploadIndex === -1) return null;
    const publicParts = parts.slice(uploadIndex + 1);
    if (publicParts.length === 0) return null;
    const last = publicParts[publicParts.length - 1];
    const filename = last.replace(/\.[^/.]+$/, '');
    publicParts[publicParts.length - 1] = filename;
    return publicParts.join('/');
  } catch {
    return null;
  }
};
// GET /api/settings/profile
router.get('/profile', requireLoginApi, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('username displayname email birth_date entry_date update_date avatar blood rh sex isAdmin groups unsubscribe_date')
      .populate({ path: 'groups', select: 'group_name createdBy invitedUsers members' })
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const email = user.email || '';
    const groups = (user.groups || []).map((g) => {
      const isCreator = String(g.createdBy) === String(user._id);
      const isAdmin = isCreator || (g.invitedUsers || []).includes(email);
      return {
        id: String(g._id),
        name: g.group_name || '',
        role: isAdmin ? '管理者' : 'ユーザー'
      };
    });

    res.json({
      user: {
        id: String(user._id),
        username: user.username,
        displayname: user.displayname || '',
        email: user.email || '',
        birth_date: user.birth_date || null,
        entry_date: user.entry_date || null,
        update_date: user.update_date || null,
        avatar: user.avatar || null,
        blood: user.blood || '',
        rh: user.rh || '',
        sex: user.sex || '',
        isAdmin: Boolean(user.isAdmin),
        unsubscribe_date: user.unsubscribe_date || null
      },
      groups
    });
  } catch (err) {
    console.error('api settings profile error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// PUT /api/settings/profile
router.put('/profile', requireLoginApi, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const { displayname, email, birth_date, blood, rh, sex } = req.body || {};
    if (typeof displayname === 'string') user.displayname = displayname;
    if (typeof email === 'string') user.email = email;
    if (typeof blood === 'string') user.blood = blood;
    if (typeof rh === 'string') user.rh = rh;
    if (typeof sex === 'string') user.sex = sex;

    if (birth_date === null || birth_date === '') {
      user.birth_date = null;
    } else if (birth_date) {
      const parsed = new Date(birth_date);
      if (!isNaN(parsed.getTime())) {
        user.birth_date = parsed;
      }
    }

    user.update_date = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('api settings profile save error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// POST /api/settings/profile/avatar
router.post('/profile/avatar', requireLoginApi, upload.single('avatar'), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: '画像ファイルがありません' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'PackingPlan_Profile', resource_type: 'image' },
        (err, uploadResult) => {
          if (err) return reject(err);
          return resolve(uploadResult);
        }
      );
      stream.end(req.file.buffer);
    });

    user.avatar = result?.secure_url || user.avatar;
    user.update_date = new Date();
    await user.save();
    res.json({ ok: true, avatar: user.avatar || null });
  } catch (err) {
    console.error('api settings avatar error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// POST /api/settings/password
router.post('/password', requireLoginApi, async (req, res) => {
  try {
    const { newPassword, confirmPassword } = req.body || {};
    if (!newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'missing_params', message: 'newPassword, confirmPassword は必須です' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'mismatch', message: 'パスワードが一致しません' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'too_short', message: 'パスワードは8文字以上で入力してください' });
    }
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }
    await new Promise((resolve, reject) => {
      user.setPassword(newPassword, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    user.update_date = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('api settings password error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

// POST /api/settings/unsubscribe
router.post('/unsubscribe', requireLoginApi, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }
    const avatarPublicId = extractCloudinaryPublicId(user.avatar);
    if (avatarPublicId) {
      try {
        await cloudinary.uploader.destroy(avatarPublicId);
      } catch (err) {
        console.warn('cloudinary avatar delete failed:', err?.message || err);
      }
    }
    user.unsubscribe_date = new Date();
    if (user.services && typeof user.services === 'object') {
      user.services.menu = false;
    }
    user.update_date = new Date();
    await user.save();

    req.logout(() => {
      req.session?.destroy(() => {
        res.json({ ok: true });
      });
    });
  } catch (err) {
    console.error('api settings unsubscribe error:', err);
    res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

export default router;
