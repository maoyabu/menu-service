import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import Menu from './models/menu.js';
import User from './models/users.js';
import Group from './models/groups.js';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import flash from 'connect-flash';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import expressLayouts from 'express-ejs-layouts';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import mymenuRoutes from './routes/mymenu.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.use(expressLayouts);
app.set('layout', 'layouts/boilerplate');

app.use((req, res, next) => {
  res.locals.isAdminRoute = req.path.startsWith('/admin');
  // Expose current path for nav highlighting
  res.locals.currentPath = req.path || '';
  next();
});

// Trust first proxy (needed for secure cookies on Heroku)
app.set('trust proxy', 1);

await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finance', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

app.use(session({ 
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/finance', collectionName: 'sessions' }),
  cookie: { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  },
}));

app.use(flash());

app.use(passport.initialize());
app.use(passport.session());

app.use(express.static('public'));

// passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  next();
});

// Expose the logged-in user to templates
app.use((req, res, next) => {
  res.locals.user = req.user;
  next();
});

app.use(async (req, res, next) => {
  res.locals.userGroups = [];
  res.locals.userDefaultGroupId = '';
  if (!req.user) {
    return next();
  }

  try {
    const groups = await Group.find({
      $or: [
        { createdBy: req.user._id },
        { members: req.user._id }
      ]
    })
      .sort({ createdAt: 1 })
      .select('group_name createdBy members')
      .lean();

    res.locals.userGroups = groups || [];
    res.locals.userDefaultGroupId = req.user.defaultGroup ? req.user.defaultGroup.toString() : '';
    return next();
  } catch (err) {
    res.locals.userGroups = [];
    res.locals.userDefaultGroupId = req.user.defaultGroup ? req.user.defaultGroup.toString() : '';
    return next(err);
  }
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(authRoutes);
app.use('/settings', settingsRoutes);
app.use('/users/my-menu', mymenuRoutes);

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

//管理画面用のルート
app.use('/admin', adminRoutes);

app.get('/menus', async (req, res) => {
  const menus = await Menu.find({});
  res.render('menus/index', { menus });
});

app.get('/', (req, res) => {
  if (req.isAuthenticated() && req.user?.isAdmin) {
    return res.redirect('/admin-top');
  }
  return res.redirect('/login');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Menu Service running on port ${PORT}`);
});
