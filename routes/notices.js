import express from 'express';
import { isLoggedIn } from '../middleware.js';
import Notice from '../models/notice.js';

const router = express.Router();
router.use(isLoggedIn);

router.get('/', async (req, res, next) => {
  try {
    const notices = await Notice.find({})
      .sort({ publishedAt: -1, createdAt: -1 })
      .lean();
    res.render('users/notices', { notices });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const notice = await Notice.findById(req.params.id).lean();
    if (!notice) return res.redirect('/notices');
    res.render('users/noticeDetail', { notice });
  } catch (e) { next(e); }
});

export default router;
