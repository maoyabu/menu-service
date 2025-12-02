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
import mystockRoutes from './routes/mystock.js';
import myequipmentRoutes from './routes/myequipment.js';
import packingRoutes from './routes/packing.js';
import slideshowRoutes from './routes/slideshow.js';
import Notification from './models/notification.js';
import { renderTemplate, sendMail } from './utils/mailer.js';
import WeeklyAnnouncement from './models/weeklyAnnouncement.js';
import MonthlyStockReminder from './models/monthlyStockReminder.js';
import Stock from './models/stock.js';


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
app.use('/users/my-stock', mystockRoutes);
app.use('/users/my-equipment', myequipmentRoutes);
app.use('/users/packing', packingRoutes);
app.use('/slideshow', slideshowRoutes);

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
  // Start notification scheduler (simple interval)
  const tick = async () => {
    try {
      const now = new Date();
      const pendings = await Notification.find({ status: 'pending', scheduledAt: { $lte: now } }).limit(50).lean();
      for (const n of pendings) {
        try {
          const recipient = await User.findById(n.recipient).select('email').lean();
          const actor = await User.findById(n.actor).select('displayname username email').lean();
          if (!recipient || !recipient.email) {
            await Notification.updateOne({ _id: n._id }, { $set: { status: 'sent', sentAt: new Date() } });
            continue;
          }
          const actorName = (actor?.displayname || actor?.username || actor?.email || '');
          let subject = `${actorName}からの連絡`;
          let html = '';
          if (n.type === 'myMenuAdded') {
            const group = await Group.findById(n.group).select('group_name').lean();
            const recipientNameUser = await User.findById(n.recipient).select('displayname username email').lean();
            const recipientName = (recipientNameUser?.displayname || recipientNameUser?.username || recipientNameUser?.email || '');
            const items = (n.items || []).map((it) => ({ name: it.name || '' })).filter(it => it.name);
            html = await renderTemplate('myMenuAdded', {
              groupName: group?.group_name || '',
              recipientName,
              actorName,
              items
            });
            subject = `${actorName}さんがマイメニューを追加しました`;
          } else {
            const items = (n.items || []).map((it) => {
              const d = new Date(it.date);
              const mealLabel = it.mealType === 'dinner'
                ? 'ディナー'
                : it.mealType === 'breakfast'
                  ? '朝食'
                  : 'ランチ';
              return { dateLabel: `${d.getMonth()+1}月${d.getDate()}日`, mealLabel, reason: it.reason || '', menuName: it.name || '' };
            });
            if (n.type === 'eatingAgain' || n.type === 'notEating') {
              const tpl = n.type === 'eatingAgain' ? 'eatingAgain' : 'notEating';
              html = await renderTemplate(tpl, { actorName, items });
              subject = `${actorName}からの連絡`;
            } else if (n.type === 'planMenuAdded') {
              html = await renderTemplate('planMenuAdded', { actorName, items: items.map(i => ({ dateLabel: i.dateLabel, mealLabel: i.mealLabel, menuName: i.menuName, imageUrl: i.imageUrl })) });
              subject = '7 DAYS PLAN 【これ食べたい！】';
            } else {
              html = await renderTemplate('notEating', { actorName, items });
            }
          }
          await sendMail({ to: recipient.email, subject, html });
          await Notification.updateOne({ _id: n._id }, { $set: { status: 'sent', sentAt: new Date() } });
        } catch (err) {
          console.error('notification send error:', err);
        }
      }
    } catch (err) {
      console.error('notification scheduler error:', err);
    }
  };
  setInterval(tick, 60 * 1000);

  // Weekly announcement scheduler: every Friday 08:00, announce week after next (Mon start)
  const tickWeekly = async () => {
    try {
      const now = new Date();
      const dow = now.getDay(); // 0=Sun, 5=Fri
      // Only run on Friday after 08:00 local time
      const after8 = now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() >= 0);
      if (dow !== 5 || !after8) return;

      // Compute Monday of current week
      const local00 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const day = (local00.getDay() + 6) % 7; // Mon=0
      const mondayThis = new Date(local00); mondayThis.setDate(mondayThis.getDate() - day);
      // Week after next Monday
      const mondayAfterNext = new Date(mondayThis); mondayAfterNext.setDate(mondayAfterNext.getDate() + 14);
      mondayAfterNext.setHours(0,0,0,0);

      // Range label
      const end = new Date(mondayAfterNext); end.setDate(end.getDate() + 6);
      const fmt = (d) => `${d.getMonth()+1}月${d.getDate()}日`;
      const rangeLabel = `${fmt(mondayAfterNext)}〜${fmt(end)}`;

      // Link base
      const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

      // For each group, send if not yet sent for this weekStart
      const groups = await Group.find({}).select('_id group_name createdBy members').lean();
      for (const g of groups) {
        try {
          const exists = await WeeklyAnnouncement.findOne({ group: g._id, weekStart: mondayAfterNext }).lean();
          if (exists) continue;

          // Recipients: owner + members (email + isMail)
          const userIds = [];
          if (g.createdBy) userIds.push(g.createdBy);
          if (Array.isArray(g.members)) userIds.push(...g.members);
          const uniqIds = Array.from(new Set(userIds.map((x) => String(x))));
          const users = await User.find({ _id: { $in: uniqIds }, isMail: true }).select('email displayname username').lean();
          const validUsers = users.filter(u => !!u.email);
          if (!validUsers.length) {
            await WeeklyAnnouncement.create({ group: g._id, weekStart: mondayAfterNext, sentAt: new Date(), recipients: [] });
            continue;
          }

          // Send per-user personalized
          for (const u of validUsers) {
            const recipientName = u.displayname || u.username || u.email;
            const linkUrl = `${baseUrl}/users/week-menu?group=${encodeURIComponent(String(g._id))}&weekStart=${encodeURIComponent(mondayAfterNext.toISOString())}`;
            const html = await renderTemplate('weeklyPlanReady', {
              groupName: g.group_name || '',
              recipientName,
              rangeLabel,
              linkUrl
            });
            const subject = `再来週の 7 DAYS PLAN を作成しましょう - ${g.group_name || 'グループ'}`;
            await sendMail({ to: u.email, subject, html });
          }

          await WeeklyAnnouncement.create({ group: g._id, weekStart: mondayAfterNext, sentAt: new Date(), recipients: validUsers.map(u => u._id) });
        } catch (err) {
          console.error('weekly announce error (group):', g?._id, err);
        }
      }
    } catch (err) {
      console.error('weekly announce scheduler error:', err);
    }
  };
  setInterval(tickWeekly, 60 * 1000);

  // Monthly stock reminder: per-group schedule (monthly day or nth weekday) at configured hour
  const tickMonthly = async () => {
    try {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const monthStart = new Date(y, m, 1); monthStart.setHours(0,0,0,0);
      const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const linkUrl = `${baseUrl}/users/my-stock`;

      const groups = await Group.find({}).select('_id group_name createdBy members stockInventory').lean();
      for (const g of groups) {
        try {
          // compute scheduled day for this group in this month
          const cfg = g.stockInventory || {};
          const enabled = cfg.enabled !== false;
          if (!enabled) continue;
          const sendHour = (typeof cfg.sendHour === 'number') ? cfg.sendHour : 8;
          const afterHour = now.getHours() > sendHour || (now.getHours() === sendHour && now.getMinutes() >= 0);
          if (!afterHour) continue;

          let scheduledDay = null; // date number 1..31
          if ((cfg.mode || 'monthlyDay') === 'monthlyDay') {
            const d = Math.max(1, Math.min(31, Number(cfg.day) || 28));
            const last = new Date(y, m + 1, 0).getDate();
            scheduledDay = Math.min(d, last);
          } else {
            // nth weekday
            const nth = Math.max(1, Math.min(5, Number(cfg.nth) || 4));
            const weekday = Math.max(0, Math.min(6, Number(cfg.weekday) || 0));
            const first = new Date(y, m, 1);
            const firstWeekday = first.getDay();
            let day1 = 1 + ((7 + weekday - firstWeekday) % 7); // first occurrence
            const candidate = day1 + (nth - 1) * 7;
            const last = new Date(y, m + 1, 0).getDate();
            scheduledDay = Math.min(candidate, last);
          }

          const isToday = now.getDate() === scheduledDay;
          if (!isToday) continue;

          const exists = await MonthlyStockReminder.findOne({ group: g._id, monthStart }).lean();
          if (exists) continue; // already sent for this month

          const userIds = [];
          if (g.createdBy) userIds.push(g.createdBy);
          if (Array.isArray(g.members)) userIds.push(...g.members);
          const uniqIds = Array.from(new Set(userIds.map((x) => String(x))));
          const users = await User.find({ _id: { $in: uniqIds }, isMail: true }).select('email displayname username').lean();
          const validUsers = users.filter(u => !!u.email);
          if (!validUsers.length) {
            await MonthlyStockReminder.create({ group: g._id, monthStart, sentAt: new Date(), recipients: [] });
            continue;
          }

          const subject = `7 DAYS PLAN　【${g.group_name || 'グループ'}のマイストックの定期点検の日が来ました】`;
          for (const u of validUsers) {
            const recipientName = u.displayname || u.username || u.email;
            const html = await renderTemplate('monthlyStockReminder', {
              groupName: g.group_name || '',
              recipientName,
              linkUrl
            });
            await sendMail({ to: u.email, subject, html });
          }

          await MonthlyStockReminder.create({ group: g._id, monthStart, sentAt: new Date(), recipients: validUsers.map(u => u._id) });
        } catch (err) {
          console.error('monthly stock reminder error (group):', g?._id, err);
        }
      }
    } catch (err) {
      console.error('monthly stock reminder scheduler error:', err);
    }
  };
  setInterval(tickMonthly, 60 * 1000);

  // Follow-up alert: if no checklist activity within windowDays after scheduled day
  const tickInventoryFollowUp = async () => {
    try {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const monthStart = new Date(y, m, 1); monthStart.setHours(0,0,0,0);
      const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const linkUrl = `${baseUrl}/users/my-stock/checklist`;

      const groups = await Group.find({}).select('_id group_name createdBy members stockInventory').lean();
      for (const g of groups) {
        try {
          const cfg = g.stockInventory || {};
          const enabled = cfg.enabled !== false;
          if (!enabled) continue;
          const sendHour = (typeof cfg.sendHour === 'number') ? cfg.sendHour : 8;
          const windowDays = (typeof cfg.windowDays === 'number') ? cfg.windowDays : 7;

          // compute scheduled day for this month
          let scheduledDay;
          if ((cfg.mode || 'monthlyDay') === 'monthlyDay') {
            const d = Math.max(1, Math.min(31, Number(cfg.day) || 28));
            const last = new Date(y, m + 1, 0).getDate();
            scheduledDay = Math.min(d, last);
          } else {
            const nth = Math.max(1, Math.min(5, Number(cfg.nth) || 4));
            const weekday = Math.max(0, Math.min(6, Number(cfg.weekday) || 0));
            const first = new Date(y, m, 1);
            const firstWeekday = first.getDay();
            let day1 = 1 + ((7 + weekday - firstWeekday) % 7);
            const candidate = day1 + (nth - 1) * 7;
            const last = new Date(y, m + 1, 0).getDate();
            scheduledDay = Math.min(candidate, last);
          }
          const scheduledAt = new Date(y, m, scheduledDay, sendHour, 0, 0, 0);
          const followUpDate = new Date(scheduledAt.getTime() + windowDays * 24 * 60 * 60 * 1000);

          // only run on the follow-up day, after sendHour
          const isToday = now.getFullYear() === followUpDate.getFullYear() && now.getMonth() === followUpDate.getMonth() && now.getDate() === followUpDate.getDate();
          const afterHour = now.getHours() > sendHour || (now.getHours() === sendHour && now.getMinutes() >= 0);
          if (!isToday || !afterHour) continue;

          // avoid duplicate follow-up for month
          const rec = await MonthlyStockReminder.findOne({ group: g._id, monthStart }).lean();
          if (rec && rec.followUpSentAt) continue;

          // Has there been any checklist activity since scheduledAt?
          const anyChecked = await Stock.exists({ group: g._id, lastCheckedAt: { $gte: scheduledAt } });
          if (anyChecked) {
            // if there was activity, mark followUpSentAt to prevent processing again
            if (!rec) {
              await MonthlyStockReminder.create({ group: g._id, monthStart, sentAt: new Date(0), recipients: [], followUpSentAt: new Date(), followUpRecipients: [] });
            } else {
              await MonthlyStockReminder.updateOne({ _id: rec._id }, { $set: { followUpSentAt: new Date() } });
            }
            continue;
          }

          const userIds = [];
          if (g.createdBy) userIds.push(g.createdBy);
          if (Array.isArray(g.members)) userIds.push(...g.members);
          const uniqIds = Array.from(new Set(userIds.map((x) => String(x))));
          const users = await User.find({ _id: { $in: uniqIds }, isMail: true }).select('email displayname username').lean();
          const validUsers = users.filter(u => !!u.email);
          if (!validUsers.length) {
            if (!rec) {
              await MonthlyStockReminder.create({ group: g._id, monthStart, sentAt: new Date(0), recipients: [], followUpSentAt: new Date(), followUpRecipients: [] });
            } else {
              await MonthlyStockReminder.updateOne({ _id: rec._id }, { $set: { followUpSentAt: new Date(), followUpRecipients: [] } });
            }
            continue;
          }

          const subject = `7 DAYS PLAN　【${g.group_name || 'グループ'}のマイストック点検が未実施です】`;
          for (const u of validUsers) {
            const recipientName = u.displayname || u.username || u.email;
            const html = await renderTemplate('monthlyStockReminderFollowup', {
              groupName: g.group_name || '',
              recipientName,
              linkUrl
            });
            await sendMail({ to: u.email, subject, html });
          }

          if (!rec) {
            await MonthlyStockReminder.create({ group: g._id, monthStart, sentAt: new Date(0), recipients: [], followUpSentAt: new Date(), followUpRecipients: validUsers.map(u=>u._id) });
          } else {
            await MonthlyStockReminder.updateOne({ _id: rec._id }, { $set: { followUpSentAt: new Date(), followUpRecipients: validUsers.map(u=>u._id) } });
          }
        } catch (err) {
          console.error('monthly stock follow-up error (group):', g?._id, err);
        }
      }
    } catch (err) {
      console.error('monthly stock follow-up scheduler error:', err);
    }
  };
  setInterval(tickInventoryFollowUp, 60 * 1000);
});
