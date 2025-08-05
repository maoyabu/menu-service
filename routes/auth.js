import express from 'express';
import passport from 'passport';
import User from '../models/users.js';

const router = express.Router();

// ログイン画面の表示
router.get('/login', (req, res) => {
  res.render('auth/login', { error: req.flash('error') });
});

// ログイン処理
router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) {
      console.error('認証エラー:', err);
      return next(err);
    }
    if (!user) {
      console.warn('ログイン失敗:', info);
      return res.render('auth/login', { error: info && info.message ? info.message : 'ログインに失敗しました' });
    }
    req.logIn(user, (err) => {
      if (err) {
        console.error('ログインセッションエラー:', err);
        return next(err);
      }
      console.log('ログイン成功:', user.email || user.username);
      return res.redirect('/admin/admin-top');
    });
  })(req, res, next);
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