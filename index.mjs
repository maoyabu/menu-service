import express from 'express';
import mongoose from 'mongoose';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import Menu from './models/menu.js';
import User from './models/users.js';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import flash from 'connect-flash';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import expressLayouts from 'express-ejs-layouts';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.use(expressLayouts);
app.set('layout', 'layouts/boilerplate');

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

passport.use(new LocalStrategy(User.authenticate()));
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

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(authRoutes);

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