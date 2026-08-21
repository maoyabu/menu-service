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
import boardRoutes from './routes/board.js';
import slideshowRoutes from './routes/slideshow.js';
import purchaseReminderRoutes from './routes/purchaseReminder.js';
import noticeRoutes from './routes/notices.js';
import supportRoutes from './routes/support.js';
import apiSettingsRoutes from './routes/apiSettings.js';
import apiAuthRoutes from './routes/apiAuth.js';
import apiMealRoutes from './routes/apiMeal.js';
import Notification from './models/notification.js';
import { renderTemplate, sendMail } from './utils/mailer.js';
import WeeklyAnnouncement from './models/weeklyAnnouncement.js';
import MonthlyStockReminder from './models/monthlyStockReminder.js';
import Stock from './models/stock.js';
import Ingredient from './models/ingredients.js';
import Seasoning from './models/seasonings.js';
import EquipmentInventoryReminder from './models/equipmentInventoryReminder.js';
import MyEquipment from './models/myEquipment.js';
import PurchaseReminderLog from './models/purchaseReminderLog.js';
import WeeklyMenuPlan from './models/weeklyMenuPlan.js';
import DailyMenuAnnouncement from './models/dailyMenuAnnouncement.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const ONE_WEEK_MS = 1000 * 60 * 60 * 24 * 7;

const getAppBaseUrl = () => {
  const configuredUrl = process.env.APP_BASE_URL || process.env.BASE_URL;
  const fallbackUrl = process.env.NODE_ENV === 'production'
    ? 'https://www.7daysplan.jp'
    : `http://192.168.1.138:${process.env.PORT || 3001}`;
  return String(configuredUrl || fallbackUrl).replace(/\/+$/, '');
};

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

await mongoose.connect(process.env.MONGODB_URI || 'mongodb://192.168.1.230:27017/finance', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

app.use(session({ 
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI || 'mongodb://192.168.1.230:27017/finance', collectionName: 'sessions' }),
  cookie: { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === 'production',
    maxAge: ONE_WEEK_MS
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
  res.locals.selectedGroupId = '';
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
    const requestedGroupId = typeof req.query?.group === 'string' ? String(req.query.group) : '';
    const hasRequested = !!requestedGroupId && (res.locals.userGroups || []).some((g) => String(g._id) === requestedGroupId);
    const activeGroupId = req.session?.activeGroupId ? String(req.session.activeGroupId) : '';
    const hasActive = !!activeGroupId && (res.locals.userGroups || []).some((g) => String(g._id) === activeGroupId);
    res.locals.selectedGroupId = hasRequested ? requestedGroupId : (hasActive ? activeGroupId : '');
    if (hasRequested && req.session) req.session.activeGroupId = requestedGroupId;
    if (activeGroupId && !hasActive) req.session.activeGroupId = '';
    return next();
  } catch (err) {
    res.locals.userGroups = [];
    res.locals.userDefaultGroupId = req.user.defaultGroup ? req.user.defaultGroup.toString() : '';
    res.locals.selectedGroupId = '';
    return next(err);
  }
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(authRoutes);
app.use('/settings', settingsRoutes);
app.use('/users/my-menu', mymenuRoutes);
// Alias route for menu list
app.get('/users/menu-list', (req, res) => {
  return res.redirect('/users/my-menu/shared-register' + (req.url.indexOf('?') === 0 ? req.url : ''));
});
app.use('/users/my-stock', mystockRoutes);
app.use('/users/my-equipment', myequipmentRoutes);
app.use('/users/purchase-reminder', purchaseReminderRoutes);
app.use('/users/packing', packingRoutes);
app.use('/users/board', boardRoutes);
app.use(supportRoutes);
app.use('/api/settings', apiSettingsRoutes);
app.use('/api/auth', apiAuthRoutes);
app.use('/api/meal', apiMealRoutes);
app.use('/slideshow', slideshowRoutes);
app.use('/notices', noticeRoutes);

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

  // Daily menu mail: each user can choose the delivery hour in 7 DAYS PLAN settings.
  const logDailyMenuSkipOnce = () => {};
  const tickDailyMenu = async () => {
    const timeZone = process.env.APP_TIME_ZONE || 'Asia/Tokyo';
    const logPrefix = '[daily-menu-mail]';
    const dateParts = (date) => Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
    );
    const toDateKey = (date) => {
      const parts = dateParts(date);
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const absoluteUrl = (value, baseUrl) => {
      if (!value) return '';
      try { return new URL(value, baseUrl).toString(); } catch (_) { return ''; }
    };

    try {
      const now = new Date();
      const nowParts = dateParts(now);
      const dateKey = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
      const currentTime = `${nowParts.hour}:${nowParts.minute}`;

      const users = await User.find({
        isMail: { $ne: false },
        email: { $exists: true, $ne: '' },
        $or: [
          { 'weekMenuSettings.dailyMenuMailEnabled': true },
          { 'weekMenuSettings.dailyMenuMailEnabled': { $exists: false } }
        ]
      }).select('_id email displayname username groups defaultGroup weekMenuSettings.dailyMenuMailTime').lean();

      const dueUsers = users.filter((user) => {
        const configuredTime = user.weekMenuSettings?.dailyMenuMailTime;
        const deliveryTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(configuredTime || ''))
          ? configuredTime
          : '06:00';
        return deliveryTime <= currentTime;
      });

      if (!dueUsers.length) return;
      const baseUrl = getAppBaseUrl();
      const broadStart = new Date(now.getTime() - (36 * 60 * 60 * 1000));
      const broadEnd = new Date(now.getTime() + (36 * 60 * 60 * 1000));

      for (const user of dueUsers) {
        // Membership is stored on both User and Group. Include both sides so older
        // records with only the User reference still receive their group menu mail.
        const userGroupIds = Array.from(new Set([
          ...(Array.isArray(user.groups) ? user.groups : []),
          user.defaultGroup
        ].filter(Boolean).map(String)));
        const groups = await Group.find({
          $or: [
            { createdBy: user._id },
            { members: user._id },
            ...(userGroupIds.length ? [{ _id: { $in: userGroupIds } }] : [])
          ]
        }).select('_id group_name').lean();
        if (!groups.length) {
          logDailyMenuSkipOnce({ reason: 'no-group', dateKey, groupId: '-', recipientId: user._id });
          continue;
        }

        for (const group of groups) {
          let reserved = null;
          try {
            const plans = await WeeklyMenuPlan.find({
              group: group._id,
              'dayPlans.date': { $gte: broadStart, $lte: broadEnd }
            })
              .populate({
                path: 'dayPlans.slots.menu',
                select: 'name imageUrl menuType setMenus',
                populate: { path: 'setMenus', select: 'name imageUrl' }
              })
              .sort({ updatedAt: -1 })
              .lean();

            const plan = plans.find((candidate) => (candidate.dayPlans || []).some((dayPlan) =>
              dayPlan?.date && toDateKey(new Date(dayPlan.date)) === dateKey && Array.isArray(dayPlan.slots) && dayPlan.slots.length
            ));
            if (!plan) {
              logDailyMenuSkipOnce({ reason: 'no-plan', dateKey, groupId: group._id, recipientId: user._id });
              continue;
            }

            const todayPlans = (plan.dayPlans || []).filter((dayPlan) =>
              dayPlan?.date && toDateKey(new Date(dayPlan.date)) === dateKey && Array.isArray(dayPlan.slots) && dayPlan.slots.length
            );

            const mealDefinitions = [
              { type: 'breakfast', label: '朝食' },
              { type: 'lunch', label: '昼食' },
              { type: 'dinner', label: '夕食' }
            ];
            const meals = mealDefinitions.map(({ type, label }) => ({
              label,
              items: todayPlans
                .filter((dayPlan) => dayPlan.mealType === type)
                .flatMap((dayPlan) => dayPlan.slots || [])
                .map((slot) => {
                  const menu = slot?.menu;
                  if (!menu) return null;
                  const fallbackImage = Array.isArray(menu.setMenus)
                    ? menu.setMenus.find((item) => item?.imageUrl)?.imageUrl
                    : '';
                  return {
                    name: slot.dineOut && slot.dineOutName ? slot.dineOutName : menu.name,
                    imageUrl: absoluteUrl(menu.imageUrl || fallbackImage, baseUrl)
                  };
                })
                .filter((item) => item?.name)
            })).filter((meal) => meal.items.length);
            if (!meals.length) {
              logDailyMenuSkipOnce({ reason: 'no-menu', dateKey, groupId: group._id, recipientId: user._id, planId: plan._id });
              continue;
            }

            try {
              reserved = await DailyMenuAnnouncement.create({
                group: group._id,
                recipient: user._id,
                dateKey,
                sentAt: now
              });
            } catch (err) {
              if (err?.code === 11000) {
                logDailyMenuSkipOnce({ reason: 'already-sent', dateKey, groupId: group._id, recipientId: user._id, planId: plan._id });
                continue;
              }
              throw err;
            }

            const recipientName = user.displayname || user.username || user.email;
            const dateLabel = `${Number(nowParts.month)}/${Number(nowParts.day)}日`;
            const weekStartKey = toDateKey(new Date(plan.weekStart));
            const linkUrl = `${baseUrl}/users/week-menu?public=1&group=${encodeURIComponent(String(group._id))}&weekStart=${encodeURIComponent(weekStartKey)}&date=${encodeURIComponent(dateKey)}`;
            const html = await renderTemplate('dailyMenu', {
              recipientName,
              groupName: group.group_name || '',
              dateLabel,
              meals,
              linkUrl
            });
            await sendMail({
              to: user.email,
              subject: `${dateLabel}の予定メニュー - ${group.group_name || '7 DAYS PLAN'}`,
              html
            });
          } catch (err) {
            if (reserved?._id) {
              await DailyMenuAnnouncement.deleteOne({ _id: reserved._id }).catch(() => {});
            }
            console.error(`${logPrefix} failed date=${dateKey} group=${group?._id} recipient=${user?._id}`, err);
          }
        }
      }
    } catch (err) {
      console.error(`${logPrefix} scheduler-failed`, err);
    }
  };
  tickDailyMenu();
  setInterval(tickDailyMenu, 60 * 1000);

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
      const baseUrl = getAppBaseUrl();

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
      const baseUrl = getAppBaseUrl();
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
      const baseUrl = getAppBaseUrl();
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

  // Equipment inventory reminder (cadence-based: monthly / quarter / half)
  const getEquipmentCycleStart = (cadence = 'monthly') => {
    const now = new Date();
    if (cadence === 'quarter') {
      const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      return new Date(now.getFullYear(), quarterStartMonth, 1);
    }
    if (cadence === 'half') {
      const halfStartMonth = now.getMonth() < 6 ? 0 : 6;
      return new Date(now.getFullYear(), halfStartMonth, 1);
    }
    return new Date(now.getFullYear(), now.getMonth(), 1);
  };

  const tickEquipmentInventory = async () => {
    try {
      const now = new Date();
      const baseUrl = getAppBaseUrl();
      const linkUrl = `${baseUrl}/users/my-equipment/inventory`;
      const sendHour = 8;

      const groups = await Group.find({}).select('_id group_name createdBy members equipmentInventory').lean();
      for (const g of groups) {
        try {
          const cfg = g.equipmentInventory || {};
          const enabled = cfg.enabled !== false;
          if (!enabled) continue;
          const cadence = cfg.cadence || 'monthly';
          const cycleStart = getEquipmentCycleStart(cadence);
          cycleStart.setHours(0, 0, 0, 0);

          // send on the first day of the cycle, after sendHour
          const isToday = now.getFullYear() === cycleStart.getFullYear()
            && now.getMonth() === cycleStart.getMonth()
            && now.getDate() === cycleStart.getDate();
          const afterHour = now.getHours() > sendHour || (now.getHours() === sendHour && now.getMinutes() >= 0);
          if (!isToday || !afterHour) continue;

          const exists = await EquipmentInventoryReminder.findOne({ group: g._id, cycleStart }).lean();
          if (exists) continue;

          // if already inventoried for this cycle, record and skip sending
          const alreadyDone = await MyEquipment.exists({ group: g._id, lastInventoryAt: { $gte: cycleStart } });
          if (alreadyDone) {
            await EquipmentInventoryReminder.create({ group: g._id, cycleStart, cadence, sentAt: new Date(), recipients: [] });
            continue;
          }

          const userIds = [];
          if (g.createdBy) userIds.push(g.createdBy);
          if (Array.isArray(g.members)) userIds.push(...g.members);
          const uniqIds = Array.from(new Set(userIds.map((x) => String(x))));
          const users = await User.find({ _id: { $in: uniqIds }, isMail: true }).select('email displayname username').lean();
          const validUsers = users.filter((u) => !!u.email);
          const subject = `7 DAYS PLAN　【${g.group_name || 'グループ'}の備品棚卸し開始のお知らせ】`;
          for (const u of validUsers) {
            const recipientName = u.displayname || u.username || u.email;
            const html = await renderTemplate('equipmentInventoryReminder', {
              groupName: g.group_name || '',
              recipientName,
              linkUrl
            });
            await sendMail({ to: u.email, subject, html });
          }

          await EquipmentInventoryReminder.create({
            group: g._id,
            cycleStart,
            cadence,
            sentAt: new Date(),
            recipients: validUsers.map((u) => u._id)
          });
        } catch (err) {
          console.error('equipment inventory reminder error (group):', g?._id, err);
        }
      }
    } catch (err) {
      console.error('equipment inventory reminder scheduler error:', err);
    }
  };
  setInterval(tickEquipmentInventory, 60 * 1000);

  // Expiry-based purchase reminder (stocks + equipments, 1 month before)
  const tickPurchaseReminder = async () => {
    try {
      const now = new Date();
      const today = new Date(now); today.setHours(0,0,0,0);
      const limit = new Date(today); limit.setDate(limit.getDate() + 31);
      const baseUrl = getAppBaseUrl();
      const linkUrl = `${baseUrl}/users/purchase-reminder`;

      const groups = await Group.find({}).select('_id group_name createdBy members').lean();
      for (const g of groups) {
        try {
          const userIds = [];
          if (g.createdBy) userIds.push(g.createdBy);
          if (Array.isArray(g.members)) userIds.push(...g.members);
          const uniqIds = Array.from(new Set(userIds.map((x) => String(x))));
          const users = await User.find({ _id: { $in: uniqIds }, isMail: true }).select('email displayname username').lean();
          const validUsers = users.filter((u) => !!u.email);
          if (!validUsers.length) continue;

          const [stocksRaw, equipments] = await Promise.all([
            Stock.find({ group: g._id, expiryDate: { $gte: today, $lte: limit } }).lean(),
            MyEquipment.find({ group: g._id, expiryDate: { $gte: today, $lte: limit } }).lean()
          ]);

          if ((!stocksRaw || !stocksRaw.length) && (!equipments || !equipments.length)) continue;

          // avoid duplicate sends per item+expiry
          const ingIds = [];
          const seaIds = [];
          (stocksRaw || []).forEach((s)=> {
            if (s.type === 'ingredient') ingIds.push(s.item);
            if (s.type === 'seasoning') seaIds.push(s.item);
          });
          const [ingredients, seasonings] = await Promise.all([
            ingIds.length ? Ingredient.find({ _id: { $in: ingIds } }).select('ingredient').lean() : [],
            seaIds.length ? Seasoning.find({ _id: { $in: seaIds } }).select('seasoning').lean() : []
          ]);
          const ingMap = new Map((ingredients||[]).map((i)=> [String(i._id), i.ingredient || '']));
          const seaMap = new Map((seasonings||[]).map((i)=> [String(i._id), i.seasoning || '']));

          const stocks = [];
          for (const s of (stocksRaw || [])) {
            const exists = await PurchaseReminderLog.exists({
              group: g._id,
              itemType: 'stock',
              itemId: s._id,
              expiryDate: s.expiryDate
            });
            if (exists) continue;
            stocks.push({
              name: s.type === 'ingredient' ? (ingMap.get(String(s.item)) || '') : (seaMap.get(String(s.item)) || ''),
              expiryLabel: (()=> {
                const d = new Date(s.expiryDate);
                if (Number.isNaN(d.getTime())) return '';
                return `${d.getMonth() + 1}/${d.getDate()}`;
              })(),
              itemId: s._id,
              expiryDate: s.expiryDate
            });
          }

          const equipmentsList = [];
          for (const e of (equipments || [])) {
            const exists = await PurchaseReminderLog.exists({
              group: g._id,
              itemType: 'equipment',
              itemId: e._id,
              expiryDate: e.expiryDate
            });
            if (exists) continue;
            equipmentsList.push({
              name: e.name || '',
              expiryLabel: (()=> {
                const d = new Date(e.expiryDate);
                if (Number.isNaN(d.getTime())) return '';
                return `${d.getMonth() + 1}/${d.getDate()}`;
              })(),
              itemId: e._id,
              expiryDate: e.expiryDate
            });
          }

          if (!stocks.length && !equipmentsList.length) continue;

          const subject = `7 DAYS PLAN　【${g.group_name || 'グループ'} そろそろ購入リスト】`;
          for (const u of validUsers) {
            const html = await renderTemplate('purchaseReminder', {
              groupName: g.group_name || '',
              stocks,
              equipments: equipmentsList,
              linkUrl
            });
            await sendMail({ to: u.email, subject, html });
          }

          const nowDate = new Date();
          const logs = [
            ...stocks.map((s)=> ({ group: g._id, itemType: 'stock', itemId: s.itemId, expiryDate: s.expiryDate, sentAt: nowDate })),
            ...equipmentsList.map((e)=> ({ group: g._id, itemType: 'equipment', itemId: e.itemId, expiryDate: e.expiryDate, sentAt: nowDate }))
          ];
          if (logs.length) await PurchaseReminderLog.insertMany(logs, { ordered: false }).catch(()=>{});
        } catch (err) {
          console.error('purchase reminder error (group):', g?._id, err);
        }
      }
    } catch (err) {
      console.error('purchase reminder scheduler error:', err);
    }
  };
  setInterval(tickPurchaseReminder, 60 * 1000);
});
