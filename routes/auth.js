import express from 'express';
import passport from 'passport';
import User from '../models/users.js';

const router = express.Router();

// ログイン画面の表示
router.get('/login', (req, res) => {
  res.render('auth/login', { error: req.flash('error') });
});

// ログイン処理（メールアドレスまたはユーザー名で認証・手動検証）
router.post('/login', async (req, res, next) => {
  const { identifier, password } = req.body;
  try {
    // ユーザー名またはメールアドレスで検索
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }]
    });
    if (!user) {
      req.flash('error', 'ユーザー名またはメールアドレスが無効です');
      return res.redirect('/login');
    }
    // パスワード検証 (passport-local-mongoose の authenticate を使用)
    user.authenticate(password, (err, thisUser, passwordError) => {
      if (err) {
        console.error('認証エラー:', err);
        return next(err);
      }
      if (passwordError || !thisUser) {
        req.flash('error', 'パスワードが間違っています');
        return res.redirect('/login');
      }
      // ログイン実行
      req.logIn(thisUser, (err) => {
        if (err) {
          console.error('ログインセッションエラー:', err);
          return next(err);
        }
        console.log('ログイン成功:', thisUser.username);
        return res.redirect('/admin/admin-top');
      });
    });
  } catch (err) {
    console.error('ログイン処理失敗:', err);
    next(err);
  }
});

// ログアウト処理
router.post('/logout', (req, res, next) => {
  req.logout(function(err) {
    if (err) { return next(err); }
    req.session.destroy(() => {
      res.redirect('/login'); // ログアウト後にログインページへリダイレクト
    });
  });
});

export default router;