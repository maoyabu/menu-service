export const isAdmin = (req, res, next) => {
  if (req.isAuthenticated() && req.user?.isAdmin) {
    return next();
  }
  req.flash('error', '管理者としてログインしてください');
  return res.redirect('/login');
};

export const isLoggedIn = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  req.flash('error', 'ログインしてください');
  res.redirect('/login');
};