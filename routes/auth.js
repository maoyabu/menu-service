import express from 'express';
import mongoose from 'mongoose';
import User from '../models/users.js';
import Menu from '../models/menu.js';
import Mymenu from '../models/mymenu.js';
import WeeklyMenuPlan from '../models/weeklyMenuPlan.js';
import Group from '../models/groups.js';
import { isLoggedIn } from '../middleware.js';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
// ===== Password Reset (Forgot / Reset) =====
import crypto from 'crypto';
import path from 'path';
import ejs from 'ejs';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';


dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const __dirname = path.resolve();

const router = express.Router();

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user) {
      return done(null, false, { message: 'メールアドレスまたはパスワードが違います。' });
    }

    // 退会済みチェック
    if (user.unsubscribe_date) {
      return done(null, false, { message: 'このアカウントは退会済みです。' });
    }

    const isValid = await new Promise((resolve) => {
      user.authenticate(password, (_err, thisUser, passwordError) => {
        resolve(!passwordError && !!thisUser);
      });
    });

    if (!isValid) {
      return done(null, false, { message: 'メールアドレスまたはパスワードが違います。' });
    }

    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === 'on' || normalized === '1';
};

const parseOptionalDate = (value) => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
};

const authenticateWithIdentifier = async (req, res, next, options = {}) => {
  const {
    successRedirect = '/users/my-top',
    failureRedirect = '/login',
    successMessage = (user) => `ようこそ、${user.username || user.email}さん！`
  } = options;

  const identifier = (req.body.identifier || '').trim();
  const password = req.body.password || '';

  if (!identifier || !password) {
    req.flash('error', 'メールアドレス（またはユーザー名）とパスワードを入力してください');
    return res.redirect(failureRedirect);
  }

  try {
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }]
    });

    if (!user) {
      req.flash('error', 'ユーザー名またはメールアドレスが無効です');
      console.error('ユーザーが見つかりません:', identifier);
      return res.redirect(failureRedirect);
    }
    // 退会済みチェック（カスタム認証経由でも拒否）
    if (user.unsubscribe_date) {
      req.flash('error', 'このアカウントは退会済みです。');
      return res.redirect(failureRedirect);
    }

    const authenticatedUser = await new Promise((resolve, reject) => {
      user.authenticate(password, (err, thisUser, passwordError) => {
        if (err) {
          return reject(err);
        }
        if (passwordError || !thisUser) {
          return resolve(null);
        }
        resolve(thisUser);
      });
    });

    if (!authenticatedUser) {
      req.flash('error', 'パスワードが間違っています');
      return res.redirect(failureRedirect);
    }

    await new Promise((resolve, reject) => {
      req.logIn(authenticatedUser, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });

    req.flash('success', successMessage(authenticatedUser));
    return res.redirect(successRedirect);
  } catch (err) {
    console.error('ログイン処理失敗:', err);
    return next(err);
  }
};

const WEEKDAY_JA = ['月', '火', '水', '木', '金', '土', '日'];
const WEEKDAY_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const CATEGORY_CONFIG = {
  lunchMain: {
    kinds: ['主菜', '副菜', '汁物', '主食', '主食・ごはん', '主食・パン', '主食・麺', 'デザート'],
    label: 'メインディッシュ',
    mealType: 'ランチ'
  },
  dinnerStaple: {
    kinds: ['主食', '主食・ごはん', '主食・パン', '主食・麺', 'デザート'],
    label: '主食',
    mealType: 'ディナー'
  },
  dinnerMain: {
    kinds: ['主菜', 'デザート'],
    label: 'メイン',
    mealType: 'ディナー'
  },
  dinnerSide: {
    kinds: ['副菜', 'デザート'],
    label: '副菜',
    mealType: 'ディナー'
  },
  dinnerSoup: {
    kinds: ['汁物', 'デザート'],
    label: '汁物',
    mealType: 'ディナー'
  },
  dinnerFlexible: {
    kinds: [
      '主菜',
      '副菜',
      '汁物',
      '主食',
      '主食・ごはん',
      '主食・パン',
      '主食・麺',
      'デザート'
    ],
    label: 'ディナー追加',
    mealType: 'ディナー'
  }
};

const CATEGORY_TO_SLOT_TYPE = {
  lunchMain: 'lunch-main',
  dinnerStaple: 'dinner-staple',
  dinnerMain: 'dinner-main',
  dinnerSide: 'dinner-side',
  dinnerSoup: 'dinner-soup',
  dinnerFlexible: 'dinner-flex'
};

const SLOT_TYPE_DETAILS = Object.freeze({
  'lunch-main': { meal: 'lunch', key: 'main', categoryKey: 'lunchMain' },
  'dinner-staple': { meal: 'dinner', key: 'staple', categoryKey: 'dinnerStaple' },
  'dinner-main': { meal: 'dinner', key: 'main', categoryKey: 'dinnerMain' },
  'dinner-side': { meal: 'dinner', key: 'side', categoryKey: 'dinnerSide' },
  'dinner-soup': { meal: 'dinner', key: 'soup', categoryKey: 'dinnerSoup' },
  'dinner-flex': { meal: 'dinner', key: 'extras', categoryKey: 'dinnerFlexible' }
});

const formatMenuDocument = (doc) => ({
  id: doc._id.toString(),
  name: doc.name,
  kind: doc.kind,
  cook: doc.cook,
  people: doc.people,
  material: !!doc.material,
  url: doc.url,
  imageUrl: doc.imageUrl || '',
  menu: doc.menu,
  junle: doc.junle,
  time: doc.time,
  ingredients: (doc.ingredients || []).map((item) => ({
    id: item?.name?._id ? item.name._id.toString() : null,
    name: item?.name?.ingredient || '',
    amount: typeof item?.amount === 'number' && !Number.isNaN(item.amount) ? item.amount : null,
    unit: item?.unit || (Array.isArray(item?.name?.unit) ? item.name.unit[0] : '') || ''
  })),
  seasoning: (doc.seasoning || []).map((item) => ({
    id: item?.name?._id ? item.name._id.toString() : null,
    name: item?.name?.seasoning || '',
    amount: typeof item?.amount === 'number' && !Number.isNaN(item.amount) ? item.amount : null,
    unit: item?.unit || (Array.isArray(item?.name?.unit) ? item.name.unit[0] : '') || ''
  }))
});

const startOfDay = (value) => {
  let date;
  if (value instanceof Date) {
    date = new Date(value);
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    date = new Date(y, (m || 1) - 1, d || 1);
  } else {
    date = new Date(value);
  }
  date.setHours(0, 0, 0, 0);
  return date;
};

const startOfWeek = (value) => {
  const date = startOfDay(value);
  const day = date.getDay(); // 0 (Sun) ... 6 (Sat)
  const offset = (day + 6) % 7; // convert Sunday->6, Monday->0
  date.setDate(date.getDate() - offset);
  return date;
};

const addDays = (value, days) => {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
};

const getWeekDatesFromStart = (weekStart) => {
  const start = startOfWeek(weekStart);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
};

const getNextWeekStart = () => addDays(startOfWeek(new Date()), 7);

const getNextWeekDates = () => getWeekDatesFromStart(getNextWeekStart());

const formatDisplayDate = (date) => {
  const month = String(date.getMonth() + 1);
  const day = String(date.getDate());
  return `${month}/${day}`;
};

const selectRandomMenu = (menus) => {
  if (!menus?.length) return null;
  const index = Math.floor(Math.random() * menus.length);
  return menus[index] || null;
};

const aggregateSummary = (plan, menuLookup, field) => {
  const accumulator = new Map();

  const accumulate = (item) => {
    if (!item?.name) return;
    const unit = item.unit || '';
    const key = `${item.name}__${unit}`;

    const current = accumulator.get(key) || {
      name: item.name,
      amount: 0,
      unit,
      missingAmount: false
    };

    if (typeof item.amount === 'number' && !Number.isNaN(item.amount)) {
      current.amount += item.amount;
    } else {
      current.missingAmount = true;
    }

    accumulator.set(key, current);
  };

  plan.forEach((day) => {
    const slots = [
      ...(Array.isArray(day?.lunchSlots) ? day.lunchSlots : []),
      day?.dinner?.staple,
      day?.dinner?.main,
      day?.dinner?.side,
      day?.dinner?.soup,
      ...(Array.isArray(day?.dinnerExtras) ? day.dinnerExtras : [])
    ];

    slots.forEach((slot) => {
      if (!slot || slot.dineOut) return;
      const menu = menuLookup[slot.menuId];
      if (!menu) return;

      (menu[field] || []).forEach(accumulate);
    });
  });

  return Array.from(accumulator.values())
    .map((entry) => ({
      name: entry.name,
      unit: entry.unit,
      amount:
        typeof entry.amount === 'number' && !Number.isNaN(entry.amount)
          ? Math.round(entry.amount * 100) / 100
          : null,
      missingAmount: entry.missingAmount
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
};

const normalizeId = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value._id) return String(value._id);
  return '';
};

const calculateGroupSize = (groups, groupId) => {
  if (!groupId) return 1;
  const target = groups.find((group) => normalizeId(group._id) === String(groupId));
  if (!target) return 1;
  const ids = new Set();
  const ownerId = normalizeId(target.createdBy);
  if (ownerId) ids.add(ownerId);
  if (Array.isArray(target.members)) {
    target.members.forEach((member) => {
      const id = normalizeId(member);
      if (id) ids.add(id);
    });
  }
  return ids.size || 1;
};

const buildWeekPlanPayload = (menusByCategory, options = {}) => {
  const { startDate } = options;
  const menuLookup = {};
  Object.values(menusByCategory).forEach((menus) => {
    menus.forEach((menu) => {
      menuLookup[menu.id] = menu;
    });
  });

  const weekStartDate = startDate ? startOfWeek(startDate) : getNextWeekStart();
  const weekDates = getWeekDatesFromStart(weekStartDate);

  const plan = weekDates.map((date, index) => {
    const createSlot = (categoryKey) => {
      const options = menusByCategory[categoryKey] || [];
      const menu = selectRandomMenu(options);
      if (!menu) return null;
      return {
        menuId: menu.id,
        categoryKey,
        favorite: false,
        dineOut: false
      };
    };

    return {
      index,
      dayLabel: WEEKDAY_JA[index],
      dayLabelEn: WEEKDAY_EN[index],
      dateISO: date.toISOString(),
      lunchSlots: [createSlot('lunchMain')].filter(Boolean),
      dinner: {
        staple: createSlot('dinnerStaple'),
        main: createSlot('dinnerMain'),
        side: createSlot('dinnerSide'),
        soup: createSlot('dinnerSoup')
      },
      dinnerExtras: []
    };
  });

  const ingredientSummary = aggregateSummary(plan, menuLookup, 'ingredients');
  const seasoningSummary = aggregateSummary(plan, menuLookup, 'seasoning');

  return {
    plan,
    menuLookup,
    weekDates: weekDates.map((date, index) => ({
      label: WEEKDAY_JA[index],
      labelEn: WEEKDAY_EN[index],
      dateISO: date.toISOString(),
      display: formatDisplayDate(date)
    })),
    weekRangeLabel: `${formatDisplayDate(weekDates[0])}〜${formatDisplayDate(weekDates[6])}`,
    weekStartISO: weekStartDate.toISOString(),
    ingredientSummary,
    seasoningSummary
  };
};

// 管理者用ログイン画面の表示
router.get('/login', (req, res) => {
  res.render('auth/login');
});

// ユーザー用ログイン画面の表示
router.get('/user/login', (req, res) => {
  const [registrationAlert] = req.flash('registrationAlert');
  res.render('auth/userLogin', { registrationAlert: registrationAlert || null });
});

// 管理者ログイン処理（メールアドレスまたはユーザー名で認証・手動検証）
router.post('/login', (req, res, next) =>
  authenticateWithIdentifier(req, res, next, {
    successRedirect: '/admin/admin-top',
    failureRedirect: '/login',
  })
);

// ユーザーログイン処理
router.post('/user/login', (req, res, next) =>
  authenticateWithIdentifier(req, res, next, {
    failureRedirect: '/user/login',
    successRedirect: '/users/my-top',
  })
);

// 新規会員登録
router.post('/user/register', async (req, res, next) => {
  const {
    displayname,
    username,
    email,
    password,
    confirmPassword,
    birth_date,
    sex,
    blood,
    rh,
    termsAgree
  } = req.body;

  const trimmedUsername = (username || '').trim();
  const trimmedEmail = (email || '').trim().toLowerCase();
  const trimmedDisplayName = displayname ? displayname.trim() : undefined;

  const redirectToForm = () => res.redirect('/user/login');

  if (!trimmedUsername) {
    req.flash('registrationAlert', 'ユーザー名を入力してください');
    return redirectToForm();
  }

  if (!trimmedEmail) {
    req.flash('registrationAlert', 'メールアドレスを入力してください');
    return redirectToForm();
  }

  if (!password) {
    req.flash('registrationAlert', 'パスワードを入力してください');
    return redirectToForm();
  }

  if (password !== confirmPassword) {
    req.flash('registrationAlert', 'パスワードが一致しません');
    return redirectToForm();
  }

  if (!normalizeBoolean(termsAgree)) {
    req.flash('registrationAlert', '利用規約とプライバシーポリシーに同意してください');
    return redirectToForm();
  }

  try {
    const existingUser = await User.findOne({
      $or: [{ email: trimmedEmail }, { username: trimmedUsername }]
    });

    if (existingUser) {
      let message = '既に登録済みのアカウントが存在します。';
      if (existingUser.email === trimmedEmail) {
        message = 'このメールアドレスは既に登録されています。';
      } else if (existingUser.username === trimmedUsername) {
        message = 'このユーザー名は既に使用されています。';
      }
      req.flash('registrationAlert', message);
      return redirectToForm();
    }

  let services = {
    allaboutme: normalizeBoolean(req.body?.services?.allaboutme),
    finance: normalizeBoolean(req.body?.services?.finance),
    assets: normalizeBoolean(req.body?.services?.assets),
    menu: normalizeBoolean(req.body?.services?.menu)
  };

  const pendingInvite = req.session && req.session.pendingInvite;
  if (pendingInvite && pendingInvite.menuOnly) {
    // 招待経由の新規登録は Menu のみ利用可に強制
    services = { allaboutme: false, finance: false, assets: false, menu: true };
  }

    const birthDate = parseOptionalDate(birth_date);

    const newUser = new User({
      username: trimmedUsername,
      email: trimmedEmail,
      displayname: trimmedDisplayName,
      birth_date: birthDate,
      sex: sex || undefined,
      blood: blood || undefined,
      rh: rh || undefined,
      services
    });

    const registeredUser = await User.register(newUser, password);

    await new Promise((resolve, reject) => {
      req.logIn(registeredUser, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });

    // (B) 招待グループへの参加 + サービス制限（Menu のみ）
    try {
      // 1) セッションの pendingInvite を優先
      let inviteGroupId = (req.session && req.session.pendingInvite && req.session.pendingInvite.groupId) ? String(req.session.pendingInvite.groupId) : '';

      // 2) セッションが無ければ、メールアドレスが招待リストに含まれるグループを検索して補完
      if (!inviteGroupId) {
        const emailLower = (registeredUser.email || '').toLowerCase();
        if (emailLower) {
          const invitedGroup = await Group.findOne({ invitedUsers: emailLower }).lean();
          if (invitedGroup) {
            inviteGroupId = String(invitedGroup._id);
          }
        }
      }

      if (inviteGroupId) {
        const group = await Group.findById(inviteGroupId);
        if (group) {
          // メンバー追加（未参加なら）
          const isMember = (group.members || []).some((m) => String(m) === String(registeredUser._id));
          if (!isMember) {
            group.members = group.members || [];
            group.members.push(registeredUser._id);
          }
          // 招待メールリストから除外（一致メールを抜く）
          const _email = (registeredUser.email || '').toLowerCase();
          if (_email) {
            group.invitedUsers = (group.invitedUsers || []).filter((addr) => String(addr).toLowerCase() !== _email);
          }
          await group.save();

          // ユーザー側にも反映（Menu のみ有効 + defaultGroup 設定）
          await User.findByIdAndUpdate(
            registeredUser._id,
            {
              $addToSet: { groups: group._id },
              $set: {
                services: { allaboutme: false, finance: false, assets: false, menu: true },
                defaultGroup: group._id,
              }
            }
          );

          // セッションのアクティブグループも更新
          req.session.activeGroupId = group._id.toString();
        }
      }
    } catch (e) {
      console.error('invite attach error:', e);
    } finally {
      if (req.session) delete req.session.pendingInvite;
    }

    req.flash('success', '会員登録が完了しました。ログインしました。');
    return res.redirect('/users/my-top');
  } catch (err) {
    console.error('会員登録処理失敗:', err);

    if (err.name === 'UserExistsError' || err.code === 11000) {
      req.flash('registrationAlert', '既に登録済みのアカウントが存在します。');
      return redirectToForm();
    }

    return next(err);
  }
});

// ログアウト処理
router.post('/logout', (req, res, next) => {
  req.logout(function(err) {
    if (err) { return next(err); }
    req.session.destroy(() => {
      res.redirect('/user/login'); // ログアウト後にログインページへリダイレクト
    });
  });
});

//weekMenu.ejsを開く
router.get('/users/week-menu', isLoggedIn, async (req, res, next) => {
  try {
    const kindSet = new Set();
    Object.values(CATEGORY_CONFIG).forEach((config) => {
      (config.kinds || []).forEach((kind) => {
        if (kind) kindSet.add(kind);
      });
    });
    const menusByKind = {};

    await Promise.all(
      Array.from(kindSet).map(async (kind) => {
        const docs = await Menu.find({ kind })
          .populate({ path: 'ingredients.name', select: 'ingredient unit' })
          .populate({ path: 'seasoning.name', select: 'seasoning unit' })
          .lean();
        menusByKind[kind] = docs.map(formatMenuDocument);
      })
    );

    const combineMenusByKinds = (kinds) => {
      const combined = new Map();
      (kinds || []).forEach((kind) => {
        (menusByKind[kind] || []).forEach((menu) => {
          if (menu.material) return;
          if (!combined.has(menu.id)) {
            combined.set(menu.id, menu);
          }
        });
      });
      return Array.from(combined.values());
    };

    const menusByCategory = Object.entries(CATEGORY_CONFIG).reduce((acc, [key, config]) => {
      acc[key] = combineMenusByKinds(config.kinds);
      return acc;
    }, {});

    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const requestedGroupId = req.query.group ? String(req.query.group) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';

    let currentGroupId = requestedGroupId || defaultGroupId || fallbackGroupId || '';
    if (currentGroupId && !userGroups.some((group) => group._id.toString() === currentGroupId)) {
      currentGroupId = fallbackGroupId || '';
    }

    const planIdParam = req.query.plan && mongoose.Types.ObjectId.isValid(req.query.plan)
      ? req.query.plan
      : '';

    const weekStartParam = typeof req.query.weekStart === 'string' ? req.query.weekStart : '';
    let requestedWeekStart = null;
    if (weekStartParam) {
      const parsed = startOfDay(weekStartParam);
      if (!Number.isNaN(parsed.getTime())) {
        requestedWeekStart = startOfWeek(parsed);
      }
    }

    const today = startOfDay(new Date());
    const todayWeekStart = startOfWeek(today);

    let targetWeekStart = requestedWeekStart || getNextWeekStart();
    let baseWeekDates = getWeekDatesFromStart(targetWeekStart);
    let weekRangeLabel = `${formatDisplayDate(baseWeekDates[0])}〜${formatDisplayDate(baseWeekDates[6])}`;

    let existingPlan = null;
    let existingPlanId = '';

    if (planIdParam) {
      const plan = await WeeklyMenuPlan.findById(planIdParam).lean();
      if (plan) {
        const planGroupId = plan.group.toString();
        const canAccess = userGroups.some((group) => group._id.toString() === planGroupId);
        if (canAccess && (!currentGroupId || planGroupId === currentGroupId)) {
          existingPlan = plan;
          existingPlanId = plan._id.toString();
          targetWeekStart = startOfWeek(plan.weekStart);
          baseWeekDates = getWeekDatesFromStart(targetWeekStart);
          weekRangeLabel = `${formatDisplayDate(baseWeekDates[0])}〜${formatDisplayDate(baseWeekDates[6])}`;
          if (!currentGroupId) {
            currentGroupId = planGroupId;
          }
        }
      }
    }

    if (!existingPlan && currentGroupId) {
      existingPlan = await WeeklyMenuPlan.findOne({
        group: currentGroupId,
        weekStart: targetWeekStart
      }).lean();
      if (existingPlan) {
        existingPlanId = existingPlan._id.toString();
        targetWeekStart = startOfWeek(existingPlan.weekStart);
        baseWeekDates = getWeekDatesFromStart(targetWeekStart);
        weekRangeLabel = `${formatDisplayDate(baseWeekDates[0])}〜${formatDisplayDate(baseWeekDates[6])}`;
      }
    }

    let groupSize = 1;
    let groupDocPopulated = null;
    if (currentGroupId) {
      groupDocPopulated = await Group.findById(currentGroupId)
        .populate({ path: 'createdBy', select: '_id displayname username email' })
        .populate({ path: 'members', select: '_id displayname username email' })
        .lean();

      if (groupDocPopulated) {
        const ids = new Set();
        if (groupDocPopulated.createdBy && groupDocPopulated.createdBy._id) {
          ids.add(String(groupDocPopulated.createdBy._id));
        }
        (groupDocPopulated.members || []).filter(Boolean).forEach((m) => {
          if (m && m._id) ids.add(String(m._id));
        });
        groupSize = ids.size || 1;
      }
    }

    let plan = [];
    let menuLookup = {};
    let ingredientSummary = [];
    let seasoningSummary = [];
    let weekDatesForView = [];

    if (existingPlan) {
      const basePlan = baseWeekDates.map((date, index) => ({
        index,
        dayLabel: WEEKDAY_JA[index],
        dayLabelEn: WEEKDAY_EN[index],
        dateISO: date.toISOString(),
        lunchSlots: [],
        dinner: { staple: null, main: null, side: null, soup: null },
        dinnerExtras: []
      }));

      menuLookup = {};
      Object.values(menusByCategory).forEach((list) => {
        list.forEach((menu) => {
          menuLookup[menu.id] = menu;
        });
      });

      const menuIdSet = new Set();
      (existingPlan.dayPlans || []).forEach((dayPlan) => {
        (dayPlan.slots || []).forEach((slot) => {
          if (slot?.menu) {
            menuIdSet.add(slot.menu.toString());
          }
        });
      });

      if (menuIdSet.size) {
        const menuDocs = await Menu.find({ _id: { $in: Array.from(menuIdSet) } })
          .populate({ path: 'ingredients.name', select: 'ingredient unit' })
          .populate({ path: 'seasoning.name', select: 'seasoning unit' })
          .lean();

        menuDocs.forEach((doc) => {
          const formatted = formatMenuDocument(doc);
          menuLookup[formatted.id] = formatted;
        });
      }

      (existingPlan.dayPlans || []).forEach((dayPlan) => {
        const target = basePlan[dayPlan.dayIndex];
        if (!target) return;

        if (dayPlan.date) {
          const iso = new Date(dayPlan.date).toISOString();
          target.dateISO = iso;
        }

        (dayPlan.slots || []).forEach((slot) => {
          const map = SLOT_TYPE_DETAILS[slot?.slotType];
          if (!map) return;

          const slotData = {
            menuId: slot.menu.toString(),
            categoryKey: map.categoryKey,
            dineOut: !!slot.dineOut,
            favorite: !!slot.favorite,
            locked: !!slot.locked
          };

          if (map.meal === 'lunch') {
            target.lunchSlots = target.lunchSlots || [];
            target.lunchSlots.push(slotData);
          } else if (map.key === 'extras') {
            target.dinnerExtras = target.dinnerExtras || [];
            target.dinnerExtras.push(slotData);
          } else {
            // If same dinner category already exists, append to dinnerExtras instead of overwriting
            if (!target.dinner[map.key]) {
              target.dinner[map.key] = slotData;
            } else {
              target.dinnerExtras = target.dinnerExtras || [];
              target.dinnerExtras.push(slotData);
            }
          }
        });
      });

      plan = basePlan;
      ingredientSummary = aggregateSummary(plan, menuLookup, 'ingredients');
      seasoningSummary = aggregateSummary(plan, menuLookup, 'seasoning');
      weekDatesForView = baseWeekDates.map((date, index) => ({
        label: WEEKDAY_JA[index],
        labelEn: WEEKDAY_EN[index],
        dateISO: date.toISOString(),
        display: formatDisplayDate(date)
      }));
    } else {
      const generated = buildWeekPlanPayload(menusByCategory, { startDate: targetWeekStart });
      plan = generated.plan;
      menuLookup = generated.menuLookup;
      ingredientSummary = generated.ingredientSummary;
      seasoningSummary = generated.seasoningSummary;
      weekDatesForView = generated.weekDates;
      weekRangeLabel = generated.weekRangeLabel;
      targetWeekStart = startOfWeek(new Date(generated.weekStartISO));
      baseWeekDates = weekDatesForView.map((entry) => new Date(entry.dateISO));

      if (targetWeekStart.getTime() < todayWeekStart.getTime()) {
        const ensureSlot = (slot, categoryKey) => ({
          menuId: null,
          categoryKey,
          favorite: false,
          dineOut: false,
          locked: false,
          ...(slot && { ...slot, menuId: null, favorite: false, dineOut: false, locked: false })
        });

        plan = plan.map((day) => ({
          ...day,
          lunchSlots: Array.isArray(day?.lunchSlots)
            ? day.lunchSlots.map((slot) => ensureSlot(slot, slot?.categoryKey || 'lunchMain'))
            : [],
          dinner: {
            staple: ensureSlot(day?.dinner?.staple, 'dinnerStaple'),
            main: ensureSlot(day?.dinner?.main, 'dinnerMain'),
            side: ensureSlot(day?.dinner?.side, 'dinnerSide'),
            soup: ensureSlot(day?.dinner?.soup, 'dinnerSoup')
          },
          dinnerExtras: Array.isArray(day?.dinnerExtras)
            ? day.dinnerExtras.map((slot) => ensureSlot(slot, slot?.categoryKey || 'dinnerFlexible'))
            : []
        }));
        ingredientSummary = [];
        seasoningSummary = [];
      }
    }

    let currentGroupName = '';
    let currentGroupMembers = [];

    if (currentGroupId) {
      if (groupDocPopulated) {
        // Prefer populated document: only existing users are present; nulls are filtered out
        currentGroupName = groupDocPopulated.group_name || '';
        const members = [];
        const owner = groupDocPopulated.createdBy || null;
        if (owner && owner._id) {
          members.push(owner.displayname || owner.username || owner.email || '');
        }
        (groupDocPopulated.members || []).filter(Boolean).forEach((member) => {
          if (!owner || String(member._id) !== String(owner._id)) {
            members.push(member.displayname || member.username || member.email || '');
          }
        });
        currentGroupMembers = members;
      } else {
        // Fallback: use res.locals.userGroups (filter to truthy/populated entries only)
        const targetGroup = userGroups.find((g) => String(g._id) === String(currentGroupId));
        if (targetGroup) {
          currentGroupName = targetGroup.group_name || '';
          const members = [];
          const owner = targetGroup.createdBy;
          if (owner && (owner.displayname || owner.username || owner.email)) {
            members.push(owner.displayname || owner.username || owner.email || '');
          }
          (targetGroup.members || []).filter(Boolean).forEach((member) => {
            const memberId = member._id || member;
            if (owner && String(memberId) === String(owner._id || owner)) return;
            const name = member.displayname || member.username || member.email || '';
            if (name) members.push(name);
          });
          currentGroupMembers = members;
        }
      }
    }

    // グループ名・メンバー名の計算が終わったあと
    // console.log('currentGroupName:', currentGroupName);
    // console.log('currentGroupMembers:', currentGroupMembers);

	const weekStartISO = targetWeekStart.toISOString();
    // MyMenu ids for current user+group to color hearts
    let myMenuIds = [];
    if (currentGroupId) {
      try {
        const mymenus = await Mymenu.find({ user: req.user._id, group: currentGroupId }).select('menu').lean();
        myMenuIds = (mymenus || []).map((m) => (m.menu ? m.menu.toString() : '')).filter(Boolean);
      } catch (e) {
        myMenuIds = [];
      }
    }
    const weekMenuView = (targetWeekStart.getTime() === todayWeekStart.getTime()) ? 'current' : 'next';

	const viewTemplate = 'users/weekMenu2';
	res.render(viewTemplate, {
    categoryConfig: CATEGORY_CONFIG,
    menusByCategory,
    menuLookup,
    plan,
    weekDates: weekDatesForView,
    weekRangeLabel,
    ingredientSummary,
    seasoningSummary,
    currentGroupId,
    groupSize,
    existingPlanId,
    weekStartISO,
    isHistoricalWeek: targetWeekStart.getTime() < todayWeekStart.getTime(),
    todayISO: today.toISOString(),
    // ここから追加
    currentGroupName,
    currentGroupMembers,

    myMenuIds,
    weekMenuView
	});
  
  } catch (err) {
    console.error('週次メニュー生成エラー:', err);
    return next(err);
  }
});

// weekMenu2 direct entry (redirects to week-menu with view=2)
router.get('/users/week-menu2', isLoggedIn, (req, res) => {
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  const q = new URLSearchParams(url.search);
  q.set('view', '2');
  res.redirect('/users/week-menu' + (q.toString() ? ('?' + q.toString()) : ''));
});

router.post('/users/week-menu', isLoggedIn, async (req, res) => {
  try {
    const {
      groupId,
      weekStart,
      weekEnd,
      dayPlans,
      title,
      description
    } = req.body || {};

    if (!groupId || !weekStart || !Array.isArray(dayPlans) || dayPlans.length === 0) {
      return res.status(400).json({ error: '必要な情報が不足しています。' });
    }

    if (!mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ error: 'グループIDが不正です。' });
    }

    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const belongsToGroup = userGroups.some((group) => group._id.toString() === String(groupId));
    if (!belongsToGroup) {
      return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    }

    const parsedWeekStart = new Date(weekStart);
    if (Number.isNaN(parsedWeekStart.getTime())) {
      return res.status(400).json({ error: '週の開始日が不正です。' });
    }
    parsedWeekStart.setHours(0, 0, 0, 0);

    let parsedWeekEnd = weekEnd ? new Date(weekEnd) : null;
    if (parsedWeekEnd && Number.isNaN(parsedWeekEnd.getTime())) {
      return res.status(400).json({ error: '週の終了日が不正です。' });
    }
    if (!parsedWeekEnd) {
      parsedWeekEnd = new Date(parsedWeekStart);
      parsedWeekEnd.setDate(parsedWeekEnd.getDate() + 6);
    }
    parsedWeekEnd.setHours(0, 0, 0, 0);

    const parsedDayPlans = dayPlans
      .map((plan) => {
        if (
          typeof plan?.dayIndex !== 'number' ||
          plan.dayIndex < 0 ||
          plan.dayIndex > 6 ||
          !plan?.mealType
        ) {
          return null;
        }

        const date = plan.dateISO ? new Date(plan.dateISO) : (plan.date ? new Date(plan.date) : null);
        if (!date || Number.isNaN(date.getTime())) {
          return null;
        }
        date.setHours(0, 0, 0, 0);

        const mealType = plan.mealType === 'dinner' ? 'dinner' : 'lunch';
        const slots = (plan.slots || [])
          .map((slot) => {
            const slotType = CATEGORY_TO_SLOT_TYPE[slot?.categoryKey] || slot?.slotType;
            if (!slotType || !mongoose.Types.ObjectId.isValid(slot?.menuId)) {
              return null;
            }
            return {
              slotType,
              menu: slot.menuId,
              dineOut: !!slot.dineOut,
              favorite: !!slot.favorite,
              locked: !!slot.locked
            };
          })
          .filter(Boolean);

        if (!slots.length) {
          return null;
        }

        return {
          dayIndex: plan.dayIndex,
          date,
          mealType,
          slots
        };
      })
      .filter(Boolean);

    if (!parsedDayPlans.length) {
      return res.status(400).json({ error: '保存するメニューがありません。' });
    }

    const planId = req.body?.planId && mongoose.Types.ObjectId.isValid(req.body.planId)
      ? req.body.planId
      : '';

    const updatePayload = {
      weekStart: parsedWeekStart,
      weekEnd: parsedWeekEnd,
      title: title || '',
      description: description || '',
      dayPlans: parsedDayPlans
    };

    const updateOptions = { new: true, runValidators: true, timestamps: true };
    let weeklyPlan = null;
    let statusCode = 200;

    if (planId) {
      weeklyPlan = await WeeklyMenuPlan.findOneAndUpdate(
        { _id: planId, group: groupId },
        updatePayload,
        updateOptions
      );
    }

    if (!weeklyPlan) {
      const existingForWeek = await WeeklyMenuPlan.findOne({
        group: groupId,
        weekStart: parsedWeekStart
      });

      if (existingForWeek) {
        weeklyPlan = await WeeklyMenuPlan.findOneAndUpdate(
          { _id: existingForWeek._id },
          updatePayload,
          updateOptions
        );
      } else {
        weeklyPlan = await WeeklyMenuPlan.create({
          group: groupId,
          createdBy: req.user._id,
          weekStart: parsedWeekStart,
          weekEnd: parsedWeekEnd,
          title: title || '',
          description: description || '',
          dayPlans: parsedDayPlans
        });
        statusCode = 201;
      }
    }

    if (!weeklyPlan) {
      return res.status(500).json({ error: '週次メニューを保存できませんでした。' });
    }

    return res.status(statusCode).json({ success: true, planId: weeklyPlan._id });
  } catch (err) {
    console.error('週次メニュー保存エラー:', err);
    return res.status(500).json({ error: '週次メニューを保存できませんでした。' });
  }
});

// マイページトップ
router.get('/users/my-top', isLoggedIn, async (req, res, next) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';

    const currentGroupId = defaultGroupId || fallbackGroupId || '';

    const baseWeekDates = getNextWeekDates();
    const weekStartDate = baseWeekDates[0];
    const weekEndDate = baseWeekDates[6];
  const nextWeekRangeLabel = `${formatDisplayDate(weekStartDate)}〜${formatDisplayDate(weekEndDate)}`;

  const today = startOfDay(new Date());
  const initialCalendarMonthISO = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();

  let nextWeekPlan = null;
  if (currentGroupId) {
    const normalizedWeekStart = new Date(weekStartDate);
    normalizedWeekStart.setHours(0, 0, 0, 0);
    nextWeekPlan = await WeeklyMenuPlan.findOne({
      group: currentGroupId,
      weekStart: normalizedWeekStart
    }).select('_id weekStart weekEnd title').lean();
  }

  const currentWeekStart = startOfWeek(today);
  const currentWeekDates = getWeekDatesFromStart(currentWeekStart);
  const categoryLabels = Object.fromEntries(
    Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => [key, cfg.label])
  );

  let currentWeekPlanDoc = null;
  if (currentGroupId) {
    currentWeekPlanDoc = await WeeklyMenuPlan.findOne({
      group: currentGroupId,
      weekStart: currentWeekStart
    }).lean();
  }

  const menuIdSet = new Set();
  if (currentWeekPlanDoc?.dayPlans?.length) {
    currentWeekPlanDoc.dayPlans.forEach((dayPlan) => {
      (dayPlan.slots || []).forEach((slot) => {
        if (slot?.menu) {
          menuIdSet.add(slot.menu.toString());
        }
      });
    });
  }

  let headerImageItems = [];
  let currentWeekMenuLookup = {};
  if (menuIdSet.size) {
    const menuDocs = await Menu.find({ _id: { $in: Array.from(menuIdSet) } })
      .populate({ path: 'ingredients.name', select: 'ingredient unit' })
      .populate({ path: 'seasoning.name', select: 'seasoning unit' })
      .lean();

    currentWeekMenuLookup = menuDocs.reduce((acc, doc) => {
      const formatted = formatMenuDocument(doc);
      acc[formatted.id] = formatted;
      return acc;
    }, {});
    // --- Build header image candidates (name + imageUrl) from Menu, excluding this week's images ---
    const usedImageSet = new Set(
      Object.values(currentWeekMenuLookup || {})
        .map((m) => (m && m.imageUrl ? String(m.imageUrl) : ''))
        .filter(Boolean)
    );

    const candidateImageDocs = await Menu.find({
      imageUrl: { $exists: true, $ne: '' },
      $or: [{ material: { $exists: false } }, { material: { $ne: true } }]
    })
      .select('imageUrl name')
      .lean();

    // unique by imageUrl
    const uniqueByUrl = new Map();
    (candidateImageDocs || []).forEach((d) => {
      const url = d && d.imageUrl ? String(d.imageUrl) : '';
      if (!url) return;
      if (!uniqueByUrl.has(url)) uniqueByUrl.set(url, { imageUrl: url, name: d.name || '' });
    });

    const allItems = Array.from(uniqueByUrl.values()).filter(
      (item) => !usedImageSet.has(item.imageUrl)
    );

    // Fisher–Yates shuffle then take up to 10
    const pickRandom = (arr, n) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a.slice(0, n);
    };

    headerImageItems = pickRandom(allItems, 10);
    // --- end build headerImageItems ---
}

  const initializeWeekOverview = () =>
    currentWeekDates.map((date, index) => ({
      index,
      dateISO: date.toISOString(),
      display: formatDisplayDate(date),
      weekday: WEEKDAY_JA[index],
      isToday: startOfDay(date).getTime() === today.getTime(),
      lunchSlots: [],
      dinner: { staple: null, main: null, side: null, soup: null },
      dinnerExtras: [],
      meals: [],
      ingredientsSummary: [],
      seasoningSummary: [],
      hasPlan: false
    }));

  const weekPlanOverview = initializeWeekOverview();

  const assignSlotToDay = (dayEntry, slotSource) => {
    if (!dayEntry || !slotSource) return;
    const slotType = slotSource.slotType || CATEGORY_TO_SLOT_TYPE[slotSource.categoryKey];
    const map = SLOT_TYPE_DETAILS[slotType];
    if (!map) return;

    let menuId = null;
    if (slotSource.menuId) {
      menuId = String(slotSource.menuId);
    } else if (slotSource.menu) {
      if (typeof slotSource.menu === 'string') {
        menuId = slotSource.menu;
      } else if (slotSource.menu._id) {
        menuId = slotSource.menu._id.toString();
      } else {
        menuId = String(slotSource.menu);
      }
    }

    const slotPayload = {
      categoryKey: map.categoryKey,
      slotType,
      menuId,
      dineOut: !!slotSource.dineOut,
      favorite: !!slotSource.favorite,
      locked: !!slotSource.locked,
      menu: menuId && currentWeekMenuLookup[menuId] ? currentWeekMenuLookup[menuId] : null
    };

    if (map.meal === 'lunch') {
      dayEntry.lunchSlots = dayEntry.lunchSlots || [];
      dayEntry.lunchSlots.push(slotPayload);
    } else if (map.key === 'extras') {
      dayEntry.dinnerExtras = dayEntry.dinnerExtras || [];
      dayEntry.dinnerExtras.push(slotPayload);
    } else {
      // If same dinner category already exists, append to dinnerExtras instead of overwriting
      if (!dayEntry.dinner[map.key]) {
        dayEntry.dinner[map.key] = slotPayload;
      } else {
        dayEntry.dinnerExtras = dayEntry.dinnerExtras || [];
        dayEntry.dinnerExtras.push(slotPayload);
      }
    }
  };

  if (currentWeekPlanDoc?.dayPlans?.length) {
    currentWeekPlanDoc.dayPlans.forEach((dayPlan) => {
      const dayEntry = weekPlanOverview[dayPlan.dayIndex];
      if (!dayEntry) return;
      const planDate = startOfDay(dayPlan.date);
      dayEntry.dateISO = planDate.toISOString();
      (dayPlan.slots || []).forEach((slot) => assignSlotToDay(dayEntry, slot));
    });
  }

  const aggregateItems = (menus, field) => {
    const itemsMap = new Map(); // name -> Map<unit, { amount, missingAmount }>
    menus.forEach((menu) => {
      if (!menu) return;
      (menu[field] || []).forEach((item) => {
        if (!item?.name) return;
        const name = item.name;
        const unit = item.unit || '';
        const unitMap = itemsMap.get(name) || new Map();
        const current = unitMap.get(unit) || {
          amount: 0,
          missingAmount: false
        };
        if (typeof item.amount === 'number' && !Number.isNaN(item.amount)) {
          current.amount += item.amount;
        } else {
          current.missingAmount = true;
        }
        unitMap.set(unit, current);
        itemsMap.set(name, unitMap);
      });
    });

    return Array.from(itemsMap.entries())
      .map(([name, unitMap]) => ({
        name,
        units: Array.from(unitMap.entries())
          .map(([unit, entry]) => ({
            unit,
            amount: entry.missingAmount ? null : Math.round(entry.amount * 100) / 100,
            missingAmount: entry.missingAmount
          }))
          .sort((a, b) => a.unit.localeCompare(b.unit, 'ja'))
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  };

  weekPlanOverview.forEach((day) => {
    const meals = [];

    const lunchSlots = Array.isArray(day.lunchSlots) ? day.lunchSlots.filter(Boolean) : [];
    if (lunchSlots.length) {
      meals.push({
        mealKey: 'lunch',
        label: 'ランチ',
        slots: lunchSlots.map((slot) => ({
          categoryKey: slot.categoryKey,
          categoryLabel: categoryLabels[slot.categoryKey] || '',
          menuId: slot.menuId,
          menu: slot.menu
        }))
      });
    }

    const dinnerBaseSlots = Object.values(day.dinner || {}).filter(Boolean);
    const dinnerExtraSlots = Array.isArray(day.dinnerExtras) ? day.dinnerExtras.filter(Boolean) : [];
    const dinnerSlots = [...dinnerBaseSlots, ...dinnerExtraSlots];
    if (dinnerSlots.length) {
      meals.push({
        mealKey: 'dinner',
        label: 'ディナー',
        slots: dinnerSlots.map((slot) => ({
          categoryKey: slot.categoryKey,
          categoryLabel: categoryLabels[slot.categoryKey] || '',
          menuId: slot.menuId,
          menu: slot.menu
        }))
      });
    }

    day.meals = meals;
    day.hasPlan = meals.some((meal) => meal.slots.some((slot) => !!slot.menu));

    const menusForDay = meals.flatMap((meal) =>
      meal.slots.map((slot) => slot.menu).filter(Boolean)
    );
    day.ingredientsSummary = aggregateItems(menusForDay, 'ingredients');
    day.seasoningSummary = aggregateItems(menusForDay, 'seasoning');
  });

  const todayDay = weekPlanOverview.find((day) => day.isToday) || null;
  const todayWeekdayIndex = today.getDay();
  const todayWeekdayLabel = WEEKDAY_JA[(todayWeekdayIndex + 6) % 7];

  const todayPlan = todayDay
    ? {
        hasPlan: todayDay.hasPlan,
        dateLabel: todayDay.display,
        weekdayLabel: todayDay.weekday,
        meals: todayDay.meals
      }
    : {
        hasPlan: false,
        dateLabel: formatDisplayDate(today),
        weekdayLabel: todayWeekdayLabel,
        meals: []
      };

  const defaultWeekDayIndex = todayDay ? todayDay.index : 0;

  const currentWeekQueryParts = [];
  if (currentGroupId) {
    currentWeekQueryParts.push(`group=${currentGroupId}`);
  }
  currentWeekQueryParts.push(`weekStart=${currentWeekStart.toISOString()}`);
  const currentWeekLink = '/users/week-menu' + (currentWeekQueryParts.length ? `?${currentWeekQueryParts.join('&')}` : '');

  // --- MyMenu stats & previews ---
  const [sharedCount, urlCount, originalCount] = await Promise.all([
    Mymenu.countDocuments({ user: req.user._id, sourceType: 'shared' }),
    Mymenu.countDocuments({ user: req.user._id, sourceType: 'url' }),
    Mymenu.countDocuments({ user: req.user._id, sourceType: 'original' })
  ]);

  const mySharedSamples = await Mymenu.find({ user: req.user._id, sourceType: 'shared' })
    .populate('menu', 'name imageUrl kind')
    .sort({ update_date: -1, entry_date: -1 })
    .limit(4)
    .lean();

  const myOriginalSamples = await Mymenu.find({ user: req.user._id, sourceType: 'original' })
    .populate('menu', 'name imageUrl kind')
    .sort({ update_date: -1, entry_date: -1 })
    .limit(4)
    .lean();

  let groupMemberItems = [];
  if (currentGroupId) {
    groupMemberItems = await Mymenu.find({
      group: currentGroupId,
      user: { $ne: req.user._id }
    })
      .populate('menu', 'name imageUrl kind junle cook')
      .populate('user', 'displayname username')
      .sort({ update_date: -1, entry_date: -1 })
      .limit(10)
      .lean();
  }

  // MyTop 用：自分のマイメニュー 4件、グループメンバーのマイメニュー 2件
  const myOwnMyMenus = await Mymenu.find({ user: req.user._id })
    .populate('menu', 'name imageUrl kind')
    .sort({ update_date: -1, entry_date: -1 })
    .limit(4)
    .lean();

  const groupMemberMyMenus = currentGroupId
    ? await Mymenu.find({ group: currentGroupId, user: { $ne: req.user._id } })
        .populate('menu', 'name imageUrl kind')
        .populate('user', 'displayname username')
        .sort({ update_date: -1, entry_date: -1 })
        .limit(2)
        .lean()
    : [];

  res.render('users/myTop', {
    nextWeekPlan,
    nextWeekRangeLabel,
    currentGroupId,
    todayISO: today.toISOString(),
    initialCalendarMonthISO,
    todayPlan,
    weekPlanOverview,
    defaultWeekDayIndex,
    currentWeekLink,
    headerImageItems,
    // MyMenu cards
    mymenuStats: { sharedCount, urlCount, originalCount },
    mySharedSamples,
    myOriginalSamples,
    groupMemberItems,
    myOwnMyMenus,
    groupMemberMyMenus
  });
  } catch (err) {
    return next(err);
  }
});

router.get('/users/api/week-plans', isLoggedIn, async (req, res) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';

    let groupId = req.query.group ? String(req.query.group) : '';
    if (groupId && !userGroups.some((group) => group._id.toString() === groupId)) {
      return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    }
    if (!groupId) {
      groupId = defaultGroupId || fallbackGroupId || '';
    }

    const monthParam = typeof req.query.month === 'string' ? req.query.month : '';
    if (!/^\d{4}-\d{2}$/.test(monthParam)) {
      return res.status(400).json({ error: '不正な月が指定されました。' });
    }

    const [yearStr, monthStr] = monthParam.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;

    if (
      Number.isNaN(year) ||
      Number.isNaN(monthIndex) ||
      monthIndex < 0 ||
      monthIndex > 11
    ) {
      return res.status(400).json({ error: '不正な月が指定されました。' });
    }

    if (!groupId) {
      return res.json({
        success: true,
        month: monthParam,
        calendarStart: null,
        calendarEnd: null,
        weeks: [],
        todayWeekStart: startOfWeek(new Date()).toISOString()
      });
    }

    const monthStart = new Date(year, monthIndex, 1);
    const monthEnd = new Date(year, monthIndex + 1, 0);
    const calendarStart = startOfWeek(monthStart);
    const lastWeekStart = startOfWeek(monthEnd);
    const calendarEnd = addDays(lastWeekStart, 6);

    const plans = await WeeklyMenuPlan.find({
      group: groupId,
      weekStart: { $gte: calendarStart, $lte: lastWeekStart }
    })
      .select('_id weekStart title')
      .lean();

    const planMap = new Map();
    plans.forEach((plan) => {
      const key = startOfWeek(plan.weekStart).toISOString();
      planMap.set(key, {
        planId: plan._id.toString(),
        title: plan.title || ''
      });
    });

    const weeks = [];
    let cursor = new Date(calendarStart);
    while (cursor.getTime() <= calendarEnd.getTime()) {
      const weekStartISO = cursor.toISOString();
      const entry = planMap.get(weekStartISO);
      weeks.push({
        weekStart: weekStartISO,
        planId: entry ? entry.planId : null,
        title: entry ? entry.title : ''
      });
      cursor = addDays(cursor, 7);
    }

    return res.json({
      success: true,
      month: monthParam,
      calendarStart: calendarStart.toISOString(),
      calendarEnd: calendarEnd.toISOString(),
      weeks,
      todayWeekStart: startOfWeek(new Date()).toISOString()
    });
  } catch (err) {
    console.error('カレンダーデータ取得エラー:', err);
    return res.status(500).json({ error: 'カレンダーデータを取得できませんでした。' });
  }
});

function buildTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }
  return {
    sendMail: async (opts) => {
      console.log('[DEV] sendMail mocked:', opts);
      return { messageId: 'mocked' };
    },
  };
}

async function sendPasswordResetMail(toEmail, resetUrl, username) {
  const tplPath = path.join(__dirname, 'utils', 'templates', 'passwordReset.ejs');
  const html = await ejs.renderFile(tplPath, { resetUrl, username });
  const from = process.env.MAIL_FROM || 'no-reply@example.com';
  const transporter = buildTransporter();
  await transporter.sendMail({
    from,
    to: toEmail,
    subject: 'パスワード再設定のご案内',
    html,
  });
}

// GET /auth/forgot
router.get('/auth/forgot', (req, res) => {
  res.render('auth/forgot-password');
});

// POST /auth/forgot
router.post('/auth/forgot', async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      req.flash('error', '登録メールアドレスを入力してください');
      return res.redirect('/user/login');
    }

    const user = await User.findOne({ email });
    if (!user) {
      req.flash('error', 'ユーザーの登録がありません。会員登録をしてください。');
      return res.redirect(`/user/register?email=${encodeURIComponent(email)}&menuOnly=0`);
    }

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${baseUrl}/auth/reset/${token}`;
    await sendPasswordResetMail(user.email, resetUrl, user.displayname || user.username || user.email);

    req.flash('success', 'パスワード再設定メールを送信しました');
    res.redirect('/user/login');
  } catch (err) {
    next(err);
  }
});

// GET /auth/reset/:token
router.get('/auth/reset/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    }).lean();

    if (!user) {
      req.flash('error', 'リンクの有効期限が切れているか無効です。もう一度お試しください。');
      return res.redirect('/user/login');
    }

    return res.render('auth/reset-password', { token });
  } catch (err) {
    next(err);
  }
});

// POST /auth/reset/:token
router.post('/auth/reset/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const { newPassword, confirmNewPassword } = req.body;

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      req.flash('error', 'リンクの有効期限が切れているか無効です。もう一度お試しください。');
      return res.redirect('/user/login');
    }
    if (!newPassword || newPassword !== confirmNewPassword) {
      req.flash('error', '新しいパスワードが一致しません');
      return res.redirect(`/auth/reset/${token}`);
    }

    await new Promise((resolve, reject) => {
      user.setPassword(newPassword, (err) => (err ? reject(err) : resolve()));
    });

    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    await new Promise((resolve, reject) => {
      req.logIn(user, (err) => (err ? reject(err) : resolve()));
    });

    if (user.defaultGroup) {
      req.session.activeGroupId = user.defaultGroup.toString();
    }
    const to = user.defaultGroup ? `/users/week-menu?group=${user.defaultGroup.toString()}` : '/users/week-menu';
    req.flash('success', 'パスワードを更新しました。');
    res.redirect(to);
  } catch (err) {
    next(err);
  }
});

router.get('/user/register', (req, res) => {
  const presetEmail = (req.query.email || '').toLowerCase();
  const menuOnly = (req.query.menuOnly === '1') || !!(req.session?.pendingInvite?.menuOnly);
  const [registrationAlert] = req.flash('registrationAlert');

  return res.render('auth/userLogin', {
    presetEmail,
    menuOnly,
    defaultTab: 'register',
    registrationAlert: registrationAlert || null,
  });
});

export default router;
