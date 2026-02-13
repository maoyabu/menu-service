import express from 'express';
import mongoose from 'mongoose';
import User from '../models/users.js';
import Menu from '../models/menu.js';
import Mymenu from '../models/mymenu.js';
import WeeklyMenuPlan from '../models/weeklyMenuPlan.js';
import Group from '../models/groups.js';
import Notification from '../models/notification.js';
import SearchLog from '../models/searchLog.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import FoodGuideline from '../models/foodGuideline.js';
import MenuDo from '../models/menuDo.js';
import { renderTemplate, sendMail } from '../utils/mailer.js';
import { shouldSendTemplate } from '../utils/mailSettings.js';
import Stock from '../models/stock.js';
import MyEquipment from '../models/myEquipment.js';
import Task from '../models/task.js';
import Notice from '../models/notice.js';
import PackingEvent from '../models/packingEvent.js';
import ShoppingListState from '../models/shoppingListState.js';
import { monthToSeason, normalizeSeasonList } from '../utils/season.js';
import { isLoggedIn } from '../middleware.js';
import ExcelJS from 'exceljs';
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

const DEFAULT_GUIDELINE_TOTALS = {
  '乳類': 200,
  'チーズ': 10,
  '卵類': 80,
  '肉類': 120,
  '魚介類': 120,
  '豆類': 100,
  '野菜類': 310,
  'いも及びでん粉類': 100,
  'きのこ類': 30,
  '果実類': 200,
  '穀物': 500,
  '藻類': 10,
  '加工食品': 0,
  'その他': 0
};
const FOOD_CLASSIFICATIONS = Object.keys(DEFAULT_GUIDELINE_TOTALS);

const WEEK_MENU_SETTINGS_DEFAULTS = {
  breakfastMenus: ['モーニング'],
  breakfastRatios: {
    japanese: 3,
    western: 4,
    chinese: 0,
    other: 0
  },
  lunchMenus: [
    'カレーライス',
    '丼',
    'パスタ',
    'うどん',
    '焼きそば',
    'そうめん',
    'そば',
    'ちゃんぽん',
    'ラーメン',
    'ハンバーガー',
    'サンドイッチ',
    '定食'
  ],
  lunchRatios: {
    japanese: 2,
    western: 3,
    chinese: 2,
    other: 0
  },
  dinnerMenus: [],
  dinnerRatios: {
    japanese: 3,
    western: 2,
    chinese: 2,
    other: 0
  },
  dinnerArrangeCount: 1,
  breakfastFilterEnabled: true,
  lunchFilterEnabled: true,
  dinnerFilterEnabled: true
};

const normalizeBreakfastRatios = (raw = {}) => {
  const keys = ['japanese', 'western', 'chinese', 'other'];
  const sanitized = keys.reduce((acc, key) => {
    const value = Number(raw?.[key]);
    acc[key] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    return acc;
  }, {});
  const sum = keys.reduce((acc, key) => acc + sanitized[key], 0);
  if (sum <= 0) {
    return { ...WEEK_MENU_SETTINGS_DEFAULTS.breakfastRatios };
  }
  if (sum === 7) return sanitized;

  const scaled = keys.map((key) => {
    const rawValue = sanitized[key];
    const scaledValue = (rawValue / sum) * 7;
    return { key, rawValue, scaledValue };
  });
  const floored = {};
  let total = 0;
  scaled.forEach(({ key, scaledValue }) => {
    const value = Math.floor(scaledValue);
    floored[key] = value;
    total += value;
  });
  let remainder = 7 - total;
  if (remainder > 0) {
    const byFraction = scaled
      .map(({ key, scaledValue }) => ({ key, fraction: scaledValue - Math.floor(scaledValue) }))
      .sort((a, b) => b.fraction - a.fraction);
    for (let i = 0; i < remainder; i += 1) {
      const target = byFraction[i % byFraction.length];
      floored[target.key] += 1;
    }
  }
  return floored;
};

const normalizeLunchRatios = (raw = {}) => {
  const keys = ['japanese', 'western', 'chinese', 'other'];
  const sanitized = keys.reduce((acc, key) => {
    const value = Number(raw?.[key]);
    acc[key] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    return acc;
  }, {});
  const sum = keys.reduce((acc, key) => acc + sanitized[key], 0);
  if (sum <= 0) {
    return { ...WEEK_MENU_SETTINGS_DEFAULTS.lunchRatios };
  }
  if (sum === 7) return sanitized;

  const scaled = keys.map((key) => {
    const rawValue = sanitized[key];
    const scaledValue = (rawValue / sum) * 7;
    return { key, rawValue, scaledValue };
  });
  const floored = {};
  let total = 0;
  scaled.forEach(({ key, scaledValue }) => {
    const value = Math.floor(scaledValue);
    floored[key] = value;
    total += value;
  });
  let remainder = 7 - total;
  if (remainder > 0) {
    const byFraction = scaled
      .map(({ key, scaledValue }) => ({ key, fraction: scaledValue - Math.floor(scaledValue) }))
      .sort((a, b) => b.fraction - a.fraction);
    for (let i = 0; i < remainder; i += 1) {
      const target = byFraction[i % byFraction.length];
      floored[target.key] += 1;
    }
  }
  return floored;
};

const normalizeWeekMenuSettings = (raw = {}) => {
  const toArray = (value) => (Array.isArray(value) ? value : (value ? [value] : []))
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  return {
    breakfastMenus: toArray(raw.breakfastMenus).length ? toArray(raw.breakfastMenus) : WEEK_MENU_SETTINGS_DEFAULTS.breakfastMenus.slice(),
    breakfastRatios: normalizeBreakfastRatios(raw.breakfastRatios || {}),
    lunchMenus: toArray(raw.lunchMenus).length ? toArray(raw.lunchMenus) : WEEK_MENU_SETTINGS_DEFAULTS.lunchMenus.slice(),
    lunchRatios: normalizeLunchRatios(raw.lunchRatios || {}),
    dinnerMenus: toArray(raw.dinnerMenus).length ? toArray(raw.dinnerMenus) : WEEK_MENU_SETTINGS_DEFAULTS.dinnerMenus.slice(),
    dinnerRatios: normalizeLunchRatios(raw.dinnerRatios || {}),
    dinnerArrangeCount: Number.isFinite(Number(raw.dinnerArrangeCount))
      ? Math.max(0, Math.min(7, Math.floor(Number(raw.dinnerArrangeCount))))
      : WEEK_MENU_SETTINGS_DEFAULTS.dinnerArrangeCount,
    breakfastFilterEnabled: raw.breakfastFilterEnabled !== false,
    lunchFilterEnabled: raw.lunchFilterEnabled !== false,
    dinnerFilterEnabled: raw.dinnerFilterEnabled !== false
  };
};

const normalizeSexForGuideline = (value) => {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw === '男' || raw === '男性') return '男';
  if (raw === '女' || raw === '女性') return '女';
  if (raw.includes('男')) return '男';
  if (raw.includes('女')) return '女';
  const lower = raw.toLowerCase();
  if (lower.startsWith('m')) return '男';
  if (lower.startsWith('f')) return '女';
  return '';
};

const calculateAgeFromISO = (iso) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const monthDiff = today.getMonth() - date.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < date.getDate())) {
    age -= 1;
  }
  return age;
};

const buildGuidelineIndex = (rows = []) => {
  const index = new Map();
  rows.forEach((row) => {
    const cls = (row.classification || '').trim();
    if (!cls) return;
    const sex = normalizeSexForGuideline(row.sex || '');
    const key = `${cls}|${sex}`;
    if (!index.has(key)) index.set(key, []);
    const startAge = Number(row.ageStart);
    const endAge = (row.ageEnd === null || typeof row.ageEnd === 'undefined') ? null : Number(row.ageEnd);
    if (!Number.isFinite(startAge) || (endAge !== null && !Number.isFinite(endAge))) return;
    index.get(key).push({
      startAge,
      endAge,
      required: Number(row.requiredGrams) || 0
    });
  });
  index.forEach((list) => {
    list.sort((a, b) => {
      if (a.startAge !== b.startAge) return a.startAge - b.startAge;
      const aEnd = a.endAge === null ? Infinity : a.endAge;
      const bEnd = b.endAge === null ? Infinity : b.endAge;
      return aEnd - bEnd;
    });
  });
  return index;
};

const pickGuidelineEntry = (entries = [], age) => {
  if (!entries.length || typeof age !== 'number' || Number.isNaN(age)) return null;
  const hits = entries.filter((row) => age >= row.startAge && (row.endAge === null || age <= row.endAge));
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const aRange = (a.endAge === null ? Infinity : a.endAge) - a.startAge;
    const bRange = (b.endAge === null ? Infinity : b.endAge) - b.startAge;
    if (aRange !== bRange) return aRange - bRange;
    return a.startAge - b.startAge;
  });
  return hits[0];
};

const findGuidelineAmount = (age, sexCode, classification, index) => {
  if (typeof age !== 'number' || Number.isNaN(age)) return 0;
  const cls = (classification || '').trim();
  if (!cls) return 0;
  const sex = normalizeSexForGuideline(sexCode);
  if (sex) {
    const entry = pickGuidelineEntry(index.get(`${cls}|${sex}`) || [], age);
    if (entry) return entry.required;
  }
  const neutral = pickGuidelineEntry(index.get(`${cls}|`) || [], age);
  if (neutral) return neutral.required;
  if (!sex) {
    const merged = [
      ...(index.get(`${cls}|男`) || []),
      ...(index.get(`${cls}|女`) || [])
    ];
    const entry = pickGuidelineEntry(merged, age);
    if (entry) return entry.required;
  }
  return 0;
};

const aggregateGuidelineTotals = async (members = []) => {
  const sums = {};
  FOOD_CLASSIFICATIONS.forEach((cls) => { sums[cls] = 0; });
  const perUserTotals = {};
  if (!Array.isArray(members) || !members.length) {
    return { totals: { ...DEFAULT_GUIDELINE_TOTALS }, perUserTotals, memberCount: 0, source: 'default' };
  }
  const rows = await FoodGuideline.find().lean();
  if (!rows.length) {
    return { totals: { ...DEFAULT_GUIDELINE_TOTALS }, perUserTotals, memberCount: members.length, source: 'default' };
  }
  const index = buildGuidelineIndex(rows);
  const seen = new Set();
  let counted = 0;
  members.forEach((member) => {
    if (!member) return;
    const id = member.id ? String(member.id) : '';
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    const age = calculateAgeFromISO(member.birthDateISO || member.birthDate);
    if (typeof age !== 'number' || Number.isNaN(age)) return;
    const userTotals = {};
    FOOD_CLASSIFICATIONS.forEach((cls) => {
      userTotals[cls] = findGuidelineAmount(age, member.sex, cls, index);
    });
    if (id) perUserTotals[id] = userTotals;
    counted += 1;
    FOOD_CLASSIFICATIONS.forEach((cls) => {
      sums[cls] += userTotals[cls];
    });
  });
  if (!counted) {
    return { totals: { ...DEFAULT_GUIDELINE_TOTALS }, perUserTotals, memberCount: 0, source: 'default' };
  }
  const averages = {};
  FOOD_CLASSIFICATIONS.forEach((cls) => {
    averages[cls] = sums[cls] / counted;
  });
  return { totals: averages, perUserTotals, memberCount: counted, source: 'db' };
};

const toISODateString = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
};

const hydrateGroupUsers = async (users = []) => {
  if (!Array.isArray(users) || !users.length) return [];
  const idsNeedingLookup = Array.from(new Set(
    users.filter((u) => u && (!u.sex || !u.birthDateISO) && u.id).map((u) => String(u.id))
  ));
  if (!idsNeedingLookup.length) return users;
  const docs = await User.find({ _id: { $in: idsNeedingLookup } })
    .select('sex birth_date displayname username email')
    .lean();
  const map = new Map(docs.map((doc) => [String(doc._id), doc]));
  return users.map((user) => {
    if (!user || !user.id) return user;
    const doc = map.get(String(user.id));
    if (!doc) return user;
    return {
      ...user,
      sex: user.sex || doc.sex || '',
      birthDateISO: user.birthDateISO || toISODateString(doc.birth_date)
    };
  });
};

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

const SERVICE_CHOICES = new Set(['plan', 'stock', 'packing']);

const normalizeServiceChoice = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return SERVICE_CHOICES.has(normalized) ? normalized : '';
};

const getServiceRedirect = (service) => {
  if (service === 'stock') return '/users/stock-top';
  if (service === 'packing') return '/users/packing';
  return '/users/my-top';
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
    successMessage = (user) => `ようこそ、${user.username || user.email}さん！`,
    onAuthenticated = null
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

    if (typeof onAuthenticated === 'function') {
      await onAuthenticated(authenticatedUser, req);
    }

    req.flash('success', successMessage(authenticatedUser));
    const redirectTo = typeof successRedirect === 'function'
      ? successRedirect(req, authenticatedUser)
      : successRedirect;
    return res.redirect(redirectTo);
  } catch (err) {
    console.error('ログイン処理失敗:', err);
    return next(err);
  }
};

const WEEKDAY_JA = ['月', '火', '水', '木', '金', '土', '日'];
const WEEKDAY_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const CATEGORY_CONFIG = {
  breakfastMain: {
    kinds: ['主菜', '副菜', '汁物', '主食', '主食・ごはん', '主食・パン', '主食・麺', 'デザート', 'ドリンク', 'モーニングプレート'],
    label: '朝食',
    mealType: 'モーニング'
  },
  lunchMain: {
    kinds: ['主菜', '副菜', '汁物', '主食', '主食・ごはん', '主食・パン', '主食・麺', 'デザート', 'ドリンク'],
    label: 'メインディッシュ',
    mealType: 'ランチ'
  },
  dinnerStaple: {
    kinds: ['主食', '主食・ごはん', '主食・パン', '主食・麺', 'デザート', 'ドリンク'],
    label: '主食',
    mealType: 'ディナー'
  },
  dinnerMain: {
    kinds: ['主菜', 'デザート', 'ドリンク'],
    label: 'メイン',
    mealType: 'ディナー'
  },
  dinnerSide: {
    kinds: ['副菜', 'デザート', 'ドリンク'],
    label: '副菜',
    mealType: 'ディナー'
  },
  dinnerSoup: {
    kinds: ['汁物', 'デザート', 'ドリンク'],
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
      'デザート',
      'ドリンク'
    ],
    label: 'ディナー追加',
    mealType: 'ディナー'
  }
};

const CATEGORY_TO_SLOT_TYPE = {
  breakfastMain: 'breakfast-main',
  lunchMain: 'lunch-main',
  dinnerStaple: 'dinner-staple',
  dinnerMain: 'dinner-main',
  dinnerSide: 'dinner-side',
  dinnerSoup: 'dinner-soup',
  dinnerFlexible: 'dinner-flex'
};

const SLOT_TYPE_DETAILS = Object.freeze({
  'breakfast-main': { meal: 'breakfast', key: 'main', categoryKey: 'breakfastMain' },
  'lunch-main': { meal: 'lunch', key: 'main', categoryKey: 'lunchMain' },
  'dinner-staple': { meal: 'dinner', key: 'staple', categoryKey: 'dinnerStaple' },
  'dinner-main': { meal: 'dinner', key: 'main', categoryKey: 'dinnerMain' },
  'dinner-side': { meal: 'dinner', key: 'side', categoryKey: 'dinnerSide' },
  'dinner-soup': { meal: 'dinner', key: 'soup', categoryKey: 'dinnerSoup' },
  'dinner-flex': { meal: 'dinner', key: 'extras', categoryKey: 'dinnerFlexible' }
});

const formatIngredientItems = (items = []) => (items || []).map((item) => ({
  id: item?.name?._id ? item.name._id.toString() : null,
  name: item?.name?.ingredient || '',
  classification: item?.name?.classification || '',
  amount: typeof item?.amount === 'number' && !Number.isNaN(item.amount) ? item.amount : null,
  unit: item?.unit || (Array.isArray(item?.name?.unit) ? item.name.unit[0] : '') || ''
}));

const formatSeasoningItems = (items = []) => (items || []).map((item) => ({
  id: item?.name?._id ? item.name._id.toString() : null,
  name: item?.name?.seasoning || '',
  classification: item?.name?.classification || '',
  amount: typeof item?.amount === 'number' && !Number.isNaN(item.amount) ? item.amount : null,
  unit: item?.unit || (Array.isArray(item?.name?.unit) ? item.name.unit[0] : '') || ''
}));

const formatSetMenuDocument = (doc) => {
  if (!doc || !doc._id) return null;
  return {
    id: doc._id.toString(),
    name: doc.name || '',
    yomi: doc.yomi || '',
    kind: doc.kind || '',
    cook: doc.cook || '',
    people: doc.people,
    material: !!doc.material,
    url: doc.url || (`/users/menu/${doc._id.toString()}`),
    imageUrl: doc.imageUrl || '',
    menu: doc.menu || '',
    junle: doc.junle || '',
    time: doc.time,
    makeAhead: !!doc.makeAhead,
    basicMenu: !!doc.basicMenu,
    season: normalizeSeasonList(doc.season || []),
    menuType: doc.menuType || 'single',
    setType: doc.setType || '',
    ingredients: formatIngredientItems(doc.ingredients || []),
    seasoning: formatSeasoningItems(doc.seasoning || [])
  };
};

const formatMenuDocument = (doc) => {
  const id = doc._id.toString();
  const isSet = doc.menuType === 'set';
  return {
    id,
    name: doc.name,
    yomi: doc.yomi || '',
    kind: doc.kind,
    cook: doc.cook,
    people: doc.people,
    material: !!doc.material,
    url: isSet ? '' : (doc.url || (`/users/menu/${id}`)),
    imageUrl: doc.imageUrl || '',
    menu: doc.menu,
    junle: doc.junle,
    time: doc.time,
    makeAhead: !!doc.makeAhead,
    basicMenu: !!doc.basicMenu,
    season: normalizeSeasonList(doc.season || []),
    menuType: doc.menuType || 'single',
    setType: doc.setType || '',
    setMenus: (doc.setMenus || []).map(formatSetMenuDocument).filter(Boolean),
    ingredients: formatIngredientItems(doc.ingredients || []),
    seasoning: formatSeasoningItems(doc.seasoning || [])
  };
};

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

const toJstDate = (date = new Date()) => {
  const offsetMinutes = 9 * 60;
  const currentOffset = date.getTimezoneOffset();
  return new Date(date.getTime() + (offsetMinutes + currentOffset) * 60 * 1000);
};

const userLabel = (user) => (user?.displayname || user?.username || user?.email || '').toString();

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

const selectRandomMenu = (menus) => {
  if (!menus?.length) return null;
  const index = Math.floor(Math.random() * menus.length);
  return menus[index] || null;
};

const aggregateSummary = (plan, menuLookup, field) => {
  const accumulator = new Map();

  const resolveAggregationMenus = (menu) => {
    if (!menu) return [];
    const list = [];
    if (Array.isArray(menu.ingredients) && menu.ingredients.length) list.push(menu);
    if (Array.isArray(menu.seasoning) && menu.seasoning.length && !list.includes(menu)) list.push(menu);
    if (menu.menuType === 'set' && Array.isArray(menu.setMenus)) {
      menu.setMenus.forEach((m) => { if (m) list.push(m); });
    }
    if (!list.length) list.push(menu);
    return list;
  };

  const accumulate = (item) => {
    if (!item?.name) return;
    const unit = item.unit || '';
    const key = `${item.name}__${unit}`;

    const current = accumulator.get(key) || {
      name: item.name,
      amount: 0,
      unit,
      missingAmount: false,
      classification: item.classification || ''
    };
    if (!current.classification && item.classification) current.classification = item.classification;

    if (typeof item.amount === 'number' && !Number.isNaN(item.amount)) {
      current.amount += item.amount;
    } else {
      current.missingAmount = true;
    }

    accumulator.set(key, current);
  };

  plan.forEach((day) => {
    const slots = [
      ...(Array.isArray(day?.breakfastSlots) ? day.breakfastSlots : []),
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

      resolveAggregationMenus(menu).forEach((targetMenu) => {
        (targetMenu[field] || []).forEach(accumulate);
      });
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
      missingAmount: entry.missingAmount,
      classification: entry.classification || ''
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

const filterSeasonalMenus = (menus, currentSeason) => {
  if (!currentSeason) return menus || [];
  return (menus || []).filter((menu) => {
    const seasons = normalizeSeasonList(menu?.season || []);
    if (!seasons.length) return true;
    return seasons.includes(currentSeason);
  });
};

const menuMatchesKeyword = (menu, keywords = []) => {
  if (!keywords.length) return true;
  const text = `${menu?.name || ''} ${menu?.menu || ''}`;
  return keywords.some((kw) => kw && text.includes(kw));
};

const filterMenusByKeyword = (menus, keywords = [], options = {}) => {
  const { junle = '', kind = '' } = options;
  return (menus || []).filter((menu) => {
    if (junle && menu?.junle !== junle) return false;
    if (kind && menu?.kind !== kind) return false;
    return menuMatchesKeyword(menu, keywords);
  });
};

const sortMenusByPreference = (menus, frequencyMap = {}) =>
  (menus || [])
    .slice()
    .sort((a, b) => {
      const freqA = frequencyMap[a?.id] || 0;
      const freqB = frequencyMap[b?.id] || 0;
      if (freqA !== freqB) return freqB - freqA;
      return Math.random() - 0.5;
    });

const shuffleArray = (arr = []) => {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const buildMyMenuFrequencyMap = (mymenus = []) =>
  (mymenus || []).reduce((acc, entry) => {
    const id = normalizeId(entry?.menu);
    if (!id) return acc;
    const freq = Number(entry?.frequency);
    acc[id] = Number.isFinite(freq) ? freq : 0;
    return acc;
  }, {});

const getMenuText = (menu) => `${menu?.name || ''} ${menu?.menu || ''}`;

const filterBaseMenus = (menus, { excludeKeywords = [] } = {}) =>
  (menus || []).filter((menu) => {
    if (!menu) return false;
    if (menu.material === true) return false;
    const text = getMenuText(menu);
    if (!text) return false;
    if (text.includes('インスタント')) return false;
    if (excludeKeywords.length && menuMatchesKeyword({ name: text }, excludeKeywords)) return false;
    return true;
  });

const BREAKFAST_BUCKETS = [
  { key: 'plate', kind: 'モーニングプレート', keywords: [] },
  { key: 'jp_rice', keywords: ['白米', 'おにぎり', '卵かけご飯'] },
  { key: 'jp_miso', keywords: ['味噌汁'] },
  { key: 'jp_fish', keywords: ['焼き魚', '干物'] },
  { key: 'jp_natto', keywords: ['納豆', 'しらす', 'ふりかけ'] },
  { key: 'jp_tamago', keywords: ['卵焼き'] },
  { key: 'west_bread', keywords: ['食パン', 'サンドイッチ', 'フレンチトースト', 'パンケーキ', 'シリアル', 'トースト', 'ホットドッグ'] },
  { key: 'west_yogurt', keywords: ['ヨーグルト'] },
  { key: 'west_egg', keywords: ['目玉焼き', 'スクランブルエッグ', 'オムレツ'] },
  { key: 'west_soup', keywords: ['スープ'] }
];

const detectBreakfastBucket = (menu) => {
  if (!menu) return '';
  if (menu.kind === 'モーニングプレート') return 'plate';
  const text = getMenuText(menu);
  for (const bucket of BREAKFAST_BUCKETS) {
    if (bucket.key === 'plate') continue;
    if (menuMatchesKeyword({ name: text }, bucket.keywords)) return bucket.key;
  }
  return '';
};

const pickBreakfastByBucket = ({ menus, bucketKey, myMenuFrequency = {}, currentSeason = '', excludeMenuId = '' }) => {
  const baseMenus = filterBaseMenus(menus);
  const seasonal = filterSeasonalMenus(baseMenus, currentSeason);
  const poolBase = seasonal.length ? seasonal : baseMenus;
  const bucket = BREAKFAST_BUCKETS.find((b) => b.key === bucketKey);
  if (!bucket) return null;
  let candidates = [];
  if (bucket.key === 'plate') {
    candidates = poolBase.filter((m) => m && m.kind === 'モーニングプレート');
  } else {
    // 必ずバケット内キーワードで絞り込む
    candidates = filterMenusByKeyword(poolBase, bucket.keywords || []);
    // 卵枠はモーニングプレートを除外
    if (bucket.key === 'west_egg') {
      candidates = candidates.filter((m) => m && m.kind !== 'モーニングプレート');
    }
    if (bucket.key === 'jp_tamago') {
      candidates = candidates.filter((m) => m && m.kind !== 'モーニングプレート');
      // 卵焼き枠は卵焼きキーワードのみで絞る
      candidates = filterMenusByKeyword(candidates, ['卵焼き']);
    }
    if (bucket.key === 'west_soup') {
      candidates = candidates.filter((m) => m.junle === '洋食' || menuMatchesKeyword(m, ['スープ']));
    }
  }
  if (!candidates.length) {
    // バケット内に候補が無い場合は諦めて null（他バケットに逃げない）
    return null;
  }
  const filtered = candidates.filter((m) => m.id !== excludeMenuId);
  const targetPool = filtered.length ? filtered : candidates;
  const sorted = sortMenusByPreference(targetPool, myMenuFrequency);
  return sorted[0] || targetPool[0] || null;
};

const buildBreakfastPlan = (menus, options = {}) => {
  const {
    myMenuFrequency = {},
    currentSeason = '',
    breakfastMenuFilter = [],
    breakfastRatios = {},
    preferredSetMenuIds = new Set()
  } = options;

  const baseMenus = filterBaseMenus(menus);
  const allowList = new Set(
    (breakfastMenuFilter || [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
  );
  let filteredMenus = baseMenus;
  if (allowList.size) {
    filteredMenus = baseMenus.filter((menu) => allowList.has(String(menu?.menu || '').trim()));
  }
  if (!filteredMenus.length) filteredMenus = baseMenus;

  const seasonalMenus = filterSeasonalMenus(filteredMenus, currentSeason);
  const fallbackMenus = seasonalMenus.length ? seasonalMenus : filteredMenus;
  if (!fallbackMenus.length) {
    return Array.from({ length: 7 }, () => []);
  }

  const classify = (menu) => {
    const junle = String(menu?.junle || '').trim();
    if (junle.includes('和')) return 'japanese';
    if (junle.includes('洋')) return 'western';
    if (junle.includes('中')) return 'chinese';
    return 'other';
  };

  const buckets = { japanese: [], western: [], chinese: [], other: [] };
  fallbackMenus.forEach((menu) => {
    buckets[classify(menu)].push(menu);
  });

  const ratio = normalizeBreakfastRatios(breakfastRatios || {});
  const keys = ['japanese', 'western', 'chinese', 'other'];
  const counts = { ...ratio };
  const availableKeys = keys.filter((key) => buckets[key].length);
  if (!availableKeys.length) {
    return Array.from({ length: 7 }, () => []);
  }
  keys.forEach((key) => {
    if (counts[key] > 0 && !buckets[key].length) {
      let remaining = counts[key];
      counts[key] = 0;
      let idx = 0;
      while (remaining > 0) {
        const target = availableKeys[idx % availableKeys.length];
        counts[target] += 1;
        remaining -= 1;
        idx += 1;
      }
    }
  });

  const dayTypes = [];
  keys.forEach((key) => {
    for (let i = 0; i < counts[key]; i += 1) dayTypes.push(key);
  });
  while (dayTypes.length < 7) {
    dayTypes.push(availableKeys[dayTypes.length % availableKeys.length]);
  }
  if (dayTypes.length > 7) dayTypes.length = 7;

  const usedIds = new Set();
  let favoriteQuota = 3;

  const isPreferredSetMenu = (menu) => {
    if (!menu || menu.menuType !== 'set') return false;
    if (!preferredSetMenuIds || !preferredSetMenuIds.has(menu.id)) return false;
    const setType = menu.setType;
    if (Array.isArray(setType)) return setType.includes('morning');
    if (typeof setType === 'string') return setType === 'morning';
    return false;
  };

  const pickMenuFromPool = (pool) => {
    if (!pool.length) return null;
    const allowReuse = usedIds.size >= pool.length;
    const available = allowReuse ? pool : pool.filter((menu) => menu && !usedIds.has(menu.id));
    if (!available.length) return null;

    const preferredSet = available.filter(isPreferredSetMenu);
    if (preferredSet.length) {
      const sorted = sortMenusByPreference(preferredSet, myMenuFrequency);
      const picked = sorted[0] || preferredSet[0] || null;
      if (picked) {
        usedIds.add(picked.id);
        if (myMenuFrequency[picked.id] && favoriteQuota > 0) favoriteQuota -= 1;
      }
      return picked;
    }

    const sorted = sortMenusByPreference(available, myMenuFrequency);
    const pickPreferred = (preferFavorites) =>
      sorted.find((menu) => {
        if (!menu) return false;
        if (!allowReuse && usedIds.has(menu.id)) return false;
        if (!preferFavorites) return true;
        return !!myMenuFrequency[menu.id];
      }) || null;

    let picked = null;
    if (favoriteQuota > 0) {
      picked = pickPreferred(true) || pickPreferred(false);
    } else {
      picked = pickPreferred(false);
    }

    if (picked) {
      usedIds.add(picked.id);
      if (myMenuFrequency[picked.id] && favoriteQuota > 0) favoriteQuota -= 1;
    }
    return picked;
  };

  return shuffleArray(dayTypes).map((type) => {
    const pool = buckets[type].length ? buckets[type] : fallbackMenus;
    const picked = pickMenuFromPool(pool);
    if (!picked) return [];
    return [{
      menuId: picked.id,
      categoryKey: 'breakfastMain',
      favorite: false,
      dineOut: false
    }];
  });
};

const pickBreakfastCandidate = ({
  menus,
  myMenuFrequency = {},
  currentSeason = '',
  breakfastMenuFilter = [],
  preferredSetMenuIds = new Set(),
  excludeMenuId = ''
}) => {
  const baseMenus = filterBaseMenus(menus);
  const allowList = new Set(
    (breakfastMenuFilter || [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
  );
  let filteredMenus = baseMenus;
  if (allowList.size) {
    filteredMenus = baseMenus.filter((menu) => allowList.has(String(menu?.menu || '').trim()));
  }
  if (!filteredMenus.length) filteredMenus = baseMenus;
  const seasonalMenus = filterSeasonalMenus(filteredMenus, currentSeason);
  let pool = seasonalMenus.length ? seasonalMenus : filteredMenus;
  if (excludeMenuId) {
    pool = pool.filter((menu) => menu?.id !== excludeMenuId);
  }
  if (!pool.length) return null;

  const isPreferredSetMenu = (menu) => {
    if (!menu || menu.menuType !== 'set') return false;
    if (!preferredSetMenuIds || !preferredSetMenuIds.has(menu.id)) return false;
    const setType = menu.setType;
    if (Array.isArray(setType)) return setType.includes('morning');
    if (typeof setType === 'string') return setType === 'morning';
    return false;
  };

  const preferredSet = pool.filter(isPreferredSetMenu);
  if (preferredSet.length) {
    const sorted = sortMenusByPreference(preferredSet, myMenuFrequency);
    return sorted[0] || preferredSet[0] || null;
  }

  const sorted = sortMenusByPreference(pool, myMenuFrequency);
  return sorted[0] || pool[0] || null;
};

const buildLunchPlan = (menus, options = {}) => {
  const {
    myMenuFrequency = {},
    currentSeason = '',
    lunchMenuFilter = [],
    lunchRatios = {},
    preferredOriginalMenuIds = new Set()
  } = options;
  const LUNCH_EXCLUDE_KEYWORDS = [
    '食パン', 'サンドイッチ', 'フレンチトースト', 'パンケーキ', 'シリアル', 'トースト', 'ホットドッグ',
    'ヨーグルト',
    '目玉焼き', 'スクランブルエッグ', 'オムレツ',
    'スープ',
    'スープ ',
    '白米', 'おにぎり', '卵かけご飯',
    '味噌汁',
    '焼き魚', '干物',
    '納豆', 'しらす', 'ふりかけ',
    '卵焼き'
  ];
  const baseMenus = filterBaseMenus(menus, { excludeKeywords: LUNCH_EXCLUDE_KEYWORDS });
  const allowList = new Set(
    (lunchMenuFilter || [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
  );
  let filteredMenus = baseMenus;
  if (allowList.size) {
    filteredMenus = baseMenus.filter((menu) => allowList.has(String(menu?.menu || '').trim()));
  }
  if (!filteredMenus.length) filteredMenus = baseMenus;
  const seasonalMenus = filterSeasonalMenus(filteredMenus, currentSeason);
  const fallbackMenus = seasonalMenus.length ? seasonalMenus : filteredMenus;
  const rawAllowedMenus = (menus || []).filter((m) => m && m.material !== true && (!m.kind || ['主食・ごはん', '主食・麺', '主食'].includes(m.kind)));
  const usedIds = new Set();
  const allowedKinds = new Set(['主食・ごはん', '主食・麺', '主食']);
  let favoriteQuota = 5;

  const filtered = (fallbackMenus || []).filter((menu) => {
    if (!menu) return false;
    if (menu.kind && !allowedKinds.has(menu.kind)) return false;
    if (menu.material === true) return false;
    return true;
  });

  const classify = (menu) => {
    const junle = String(menu?.junle || '').trim();
    if (junle.includes('和')) return 'japanese';
    if (junle.includes('洋')) return 'western';
    if (junle.includes('中')) return 'chinese';
    return 'other';
  };

  const ratio = normalizeLunchRatios(lunchRatios || {});
  const keys = ['japanese', 'western', 'chinese', 'other'];
  const buckets = { japanese: [], western: [], chinese: [], other: [] };
  filtered.forEach((menu) => {
    buckets[classify(menu)].push(menu);
  });
  const availableKeys = keys.filter((key) => buckets[key].length);
  if (!availableKeys.length) {
    return Array.from({ length: 7 }, () => []);
  }

  const counts = { ...ratio };
  keys.forEach((key) => {
    if (counts[key] > 0 && !buckets[key].length) {
      let remaining = counts[key];
      counts[key] = 0;
      let idx = 0;
      while (remaining > 0) {
        const target = availableKeys[idx % availableKeys.length];
        counts[target] += 1;
        remaining -= 1;
        idx += 1;
      }
    }
  });

  const dayTypes = [];
  keys.forEach((key) => {
    for (let i = 0; i < counts[key]; i += 1) dayTypes.push(key);
  });
  while (dayTypes.length < 7) {
    dayTypes.push(availableKeys[dayTypes.length % availableKeys.length]);
  }
  if (dayTypes.length > 7) dayTypes.length = 7;

  const isPreferredTeishoku = (menu) => {
    if (!menu || !preferredOriginalMenuIds || !preferredOriginalMenuIds.has(menu.id)) return false;
    const kind = String(menu?.kind || '');
    const text = getMenuText(menu);
    return kind === '定食' || text.includes('定食');
  };

  const pickFromPool = (pool) => {
    if (!pool.length) return null;
    let candidatePool = pool;
    if (candidatePool.length < 3) {
      candidatePool = rawAllowedMenus.length ? rawAllowedMenus : candidatePool;
    }
    if (!candidatePool.length) return null;
    const allowReuse = usedIds.size >= candidatePool.length;
    const available = allowReuse ? candidatePool : candidatePool.filter((m) => m && !usedIds.has(m.id));
    if (!available.length) return null;

    const preferredTeishoku = available.filter(isPreferredTeishoku);
    if (preferredTeishoku.length) {
      const sorted = sortMenusByPreference(preferredTeishoku, myMenuFrequency);
      const picked = sorted[0] || preferredTeishoku[0] || null;
      if (picked) {
        usedIds.add(picked.id);
        if (myMenuFrequency[picked.id] && favoriteQuota > 0) favoriteQuota -= 1;
      }
      return picked;
    }

    const sorted = sortMenusByPreference(available, myMenuFrequency);
    const chunk = sorted.slice(0, Math.min(5, sorted.length));
    const shuffledTop = shuffleArray(chunk);
    const pickFromList = (list, preferFavorites) => {
      const base = (list || []).filter((m) => {
        if (!m) return false;
        if (!allowReuse && usedIds.has(m.id)) return false;
        return true;
      });
      if (!base.length) return null;
      if (preferFavorites) {
        const fav = base.find((m) => !!myMenuFrequency[m.id]);
        if (fav) return fav;
      }
      return base[0] || null;
    };

    let picked = pickFromList(shuffledTop, favoriteQuota > 0);
    if (!picked) {
      const shuffledAll = shuffleArray(sorted);
      picked = pickFromList(shuffledAll, favoriteQuota > 0);
    }
    if (!picked) {
      const shuffledAll = shuffleArray(available);
      picked = pickFromList(shuffledAll, favoriteQuota > 0);
    }
    if (picked) {
      usedIds.add(picked.id);
      if (myMenuFrequency[picked.id] && favoriteQuota > 0) favoriteQuota -= 1;
    }
    return picked;
  };

  return shuffleArray(dayTypes).map((type) => {
    const pool = buckets[type].length ? buckets[type] : filtered;
    const picked = pickFromPool(pool);
    if (!picked) return [];
    return [{
      menuId: picked.id,
      categoryKey: 'lunchMain',
      favorite: false,
      dineOut: false
    }];
  });
};

const pickLunchCandidate = ({ menus, myMenuFrequency = {}, currentSeason = '', excludeMenuId = '' }) => {
  const LUNCH_EXCLUDE_KEYWORDS = [
    '食パン', 'サンドイッチ', 'フレンチトースト', 'パンケーキ', 'シリアル', 'トースト', 'ホットドッグ',
    'ヨーグルト',
    '目玉焼き', 'スクランブルエッグ', 'オムレツ',
    'スープ',
    'スープ ',
    '白米', 'おにぎり', '卵かけご飯',
    '味噌汁',
    '焼き魚', '干物',
    '納豆', 'しらす', 'ふりかけ',
    '卵焼き'
  ];
  const baseMenus = filterBaseMenus(menus, { excludeKeywords: LUNCH_EXCLUDE_KEYWORDS });
  const seasonalMenus = filterSeasonalMenus(baseMenus, currentSeason);
  const fallbackMenus = seasonalMenus.length ? seasonalMenus : baseMenus;
  const allowedKinds = new Set(['主食・ごはん', '主食・麺', '主食']);
  const rawAllowed = (menus || []).filter((m) => m && m.material !== true && (!m.kind || allowedKinds.has(m.kind)));
  const filtered = (fallbackMenus || []).filter((menu) => {
    if (!menu) return false;
    if (menu.kind && !allowedKinds.has(menu.kind)) return false;
    if (menu.material === true) return false;
    if (menu.id === excludeMenuId) return false;
    return true;
  });
  let pool = filtered.length ? filtered : fallbackMenus;
  if (pool.length < 3 && rawAllowed.length) {
    pool = rawAllowed;
  }
  if (!pool.length) return null;
  const sorted = sortMenusByPreference(pool, myMenuFrequency);
  const top = sorted.slice(0, Math.min(5, sorted.length));
  const candidatePool = top.length ? shuffleArray(top) : shuffleArray(sorted);
  return candidatePool[0] || null;
};

const buildDinnerPlan = (menusByCategory, options = {}) => {
  const {
    myMenuFrequency = {},
    currentSeason = '',
    dinnerMenuFilter = [],
    dinnerRatios = {},
    preferredOriginalMenuIds = new Set(),
    arrangeCount = 0,
    weekStartDate = null
  } = options;
  const breakfastKeywords = [
    '食パン', 'サンドイッチ', 'フレンチトースト', 'パンケーキ', 'シリアル', 'トースト', 'ホットドッグ',
    'ヨーグルト',
    '目玉焼き', 'スクランブルエッグ', 'オムレツ',
    'おにぎり', '卵かけご飯',
    '味噌汁',
    '焼き魚', '干物',
    '納豆', 'しらす', 'ふりかけ',
    '卵焼き'
  ];
  const allowList = new Set(
    (dinnerMenuFilter || [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
  );

  const applyDinnerFilter = (list) => {
    if (!allowList.size) return list || [];
    const filtered = (list || []).filter((menu) => allowList.has(String(menu?.menu || '').trim()));
    return filtered.length ? filtered : (list || []);
  };

  const stapleBase = applyDinnerFilter(filterBaseMenus(menusByCategory.dinnerStaple || [], { excludeKeywords: breakfastKeywords }));
  const mainBase = applyDinnerFilter(filterBaseMenus(menusByCategory.dinnerMain || [], { excludeKeywords: breakfastKeywords }));
  const sideBase = applyDinnerFilter(filterBaseMenus(menusByCategory.dinnerSide || [], { excludeKeywords: breakfastKeywords }));
  const soupBase = applyDinnerFilter(filterBaseMenus(menusByCategory.dinnerSoup || [], { excludeKeywords: breakfastKeywords }));

  const seasonalStaples = filterSeasonalMenus(stapleBase, currentSeason);
  const mainArrangeCandidates = mainBase.filter((m) => m?.menuType === 'arrange');
  const mainBaseRegular = mainBase.filter((m) => m?.menuType !== 'arrange');
  const seasonalMains = filterSeasonalMenus(mainBaseRegular, currentSeason);
  const seasonalSides = filterSeasonalMenus(sideBase, currentSeason);
  const seasonalSoups = filterSeasonalMenus(soupBase, currentSeason);

  const excludedKinds = new Set(['ごはんのお供', 'デザート', 'フルーツ', 'ドリンク', 'モーニングプレート']);
  const allowedStapleKinds = new Set(['主食', '主食・ごはん', '主食・麺', '主食・パン']);
  const isWhiteRice = (menu) => /白米/.test(getMenuText(menu));
  const isTakikomi = (menu) => /炊き込みご飯/.test(getMenuText(menu));
  const isPizzaBread = (menu) => (menu?.kind === '主食・パン') && /ピザ/.test(getMenuText(menu));
  const isNabe = (menu) => String(menu?.cook || '').includes('鍋');

  const classify = (menu) => {
    const junle = String(menu?.junle || '').trim();
    if (junle.includes('和')) return 'japanese';
    if (junle.includes('洋')) return 'western';
    if (junle.includes('中')) return 'chinese';
    return 'other';
  };

  const ratio = normalizeLunchRatios(dinnerRatios || {});
  const keys = ['japanese', 'western', 'chinese', 'other'];
  const counts = { ...ratio };

  const dayTypes = [];
  keys.forEach((key) => {
    for (let i = 0; i < counts[key]; i += 1) dayTypes.push(key);
  });
  while (dayTypes.length < 7) dayTypes.push(availableKeys[dayTypes.length % availableKeys.length]);
  if (dayTypes.length > 7) dayTypes.length = 7;
  const shuffledDayTypes = shuffleArray(dayTypes);

  const usedStaples = new Set();
  const usedMains = new Set();
  const usedSides = new Set();
  const usedSoups = new Set();
  let favoriteQuota = 5;
  let takikomiQuota = 0;
  if (weekStartDate instanceof Date && !Number.isNaN(weekStartDate.getTime())) {
    takikomiQuota = weekStartDate.getDate() <= 7 ? 1 : 0;
  }

  const preferMain = (menu) => !!myMenuFrequency[menu?.id];
  const pickFromList = (list, usedSet, preferFavorites = false) => {
    const allowReuse = usedSet.size >= list.length;
    const available = allowReuse ? list : list.filter((m) => m && !usedSet.has(m.id));
    if (!available.length) return null;
    const sorted = sortMenusByPreference(available, myMenuFrequency);
    let picked = null;
    if (preferFavorites && favoriteQuota > 0) {
      picked = sorted.find((m) => preferMain(m)) || null;
    }
    if (!picked) picked = sorted[0] || null;
    if (picked) {
      usedSet.add(picked.id);
      if (preferMain(picked) && favoriteQuota > 0) favoriteQuota -= 1;
    }
    return picked;
  };

  const filterStaples = (list, { requireWhite = false, allowTakikomi = false } = {}) =>
    (list || []).filter((m) => {
      if (!m) return false;
      if (excludedKinds.has(m.kind)) return false;
      if (!allowedStapleKinds.has(m.kind)) return false;
      if (m.kind === '主食・パン' && !isPizzaBread(m)) return false;
      if (requireWhite && !(isWhiteRice(m) || (allowTakikomi && isTakikomi(m)))) return false;
      return true;
    });

  const filterDish = (list, cuisineKey) => {
    const base = (list || []).filter((m) => m && !excludedKinds.has(m.kind));
    if (!cuisineKey || cuisineKey === 'other') return base;
    const targetJunle = cuisineKey === 'japanese' ? '和食' : cuisineKey === 'western' ? '洋食' : '中華';
    const matched = base.filter((m) => String(m?.junle || '').includes(targetJunle));
    return matched.length ? matched : base;
  };

  function classifyKeyToPool(key) {
    const list = seasonalMains.length ? seasonalMains : mainBase;
    return filterDish(list, key);
  }

  const availableKeys = keys.filter((key) => {
    const pool = classifyKeyToPool(key);
    return pool.length;
  });
  if (!availableKeys.length) return Array.from({ length: 7 }, () => ({ staple: null, main: null, side: null, soup: null }));

  keys.forEach((key) => {
    if (counts[key] > 0 && !classifyKeyToPool(key).length) {
      let remaining = counts[key];
      counts[key] = 0;
      let idx = 0;
      while (remaining > 0) {
        const target = availableKeys[idx % availableKeys.length];
        counts[target] += 1;
        remaining -= 1;
        idx += 1;
      }
    }
  });

  const seasonalArrange = filterSeasonalMenus(mainArrangeCandidates, currentSeason);
  const arrangeCandidates = seasonalArrange.length ? seasonalArrange : (mainArrangeCandidates || []);
  const arrangePreferred = arrangeCandidates.filter((m) => preferredOriginalMenuIds?.has(m.id));
  const arrangePool = arrangePreferred.length ? arrangePreferred : arrangeCandidates;

  const arrangeAssignments = new Map();
  const baseAssignments = new Map();

  const dayIndices = [...Array(7).keys()];
  const eligibleArrangeDays = dayIndices.slice(2);
  const arrangeCountSafe = Math.max(
    0,
    Math.min(7, Math.floor(Number(arrangeCount) || 0), eligibleArrangeDays.length, arrangePool.length)
  );

  const arrangeSorted = sortMenusByPreference(arrangePool, myMenuFrequency);
  const mainPoolForBase = (seasonalMains.length ? seasonalMains : mainBaseRegular);
  const baseMenuById = new Map(mainPoolForBase.map((m) => [String(m.id), m]));

  const usedDays = new Set();
  const pickBaseDayForArrange = (arrangeDay) => {
    const candidates = [];
    if (arrangeDay - 1 >= 0) candidates.push(arrangeDay - 1);
    if (arrangeDay - 2 >= 0) candidates.push(arrangeDay - 2);
    for (const day of candidates) {
      if (usedDays.has(day)) continue;
      if (baseAssignments.has(day)) continue;
      if (arrangeAssignments.has(day)) continue;
      return day;
    }
    return null;
  };

  const shuffledEligible = shuffleArray(eligibleArrangeDays);
  for (const arrangeDay of shuffledEligible) {
    if (arrangeAssignments.size >= arrangeCountSafe) break;
    if (usedDays.has(arrangeDay)) continue;
    const type = shuffledDayTypes[arrangeDay];
    const candidates = filterDish(arrangeSorted, type)
      .filter((m) => (arrangeDay >= 5 ? true : !isNabe(m)));
    const candidateList = candidates.length ? candidates : arrangeSorted;
    let picked = null;
    for (const menu of candidateList) {
      if (!menu || arrangeAssignmentsHasMenu(menu.id)) continue;
      if (usedMains.has(menu.id)) continue;
      const baseId = menu?.arrangeBaseMenu ? String(menu.arrangeBaseMenu) : '';
      if (!baseId) continue;
      if (usedMains.has(baseId)) continue;
      const baseMenu = baseMenuById.get(baseId) || null;
      if (!baseMenu) continue;
      if (baseMenu.menuType === 'arrange') continue;
      const baseDay = pickBaseDayForArrange(arrangeDay);
      if (baseDay === null || baseDay === undefined) continue;
      const baseIsWeekend = baseDay >= 5;
      if (!baseIsWeekend && isNabe(baseMenu)) continue;
      picked = { menu, baseMenu, baseDay };
      break;
    }
    if (!picked) continue;
    arrangeAssignments.set(arrangeDay, picked.menu);
    baseAssignments.set(picked.baseDay, picked.baseMenu);
    usedDays.add(arrangeDay);
    usedDays.add(picked.baseDay);
    usedMains.add(picked.menu.id);
    usedMains.add(picked.baseMenu.id);
  }

  function arrangeAssignmentsHasMenu(id) {
    if (!id) return false;
    return Array.from(arrangeAssignments.values()).some((m) => m?.id === id);
  }

  const dinners = shuffledDayTypes.map((type, dayIndex) => {
    const isWeekend = dayIndex >= 5;
    const cuisineKey = type;
    const forceRice = baseAssignments.has(dayIndex) || arrangeAssignments.has(dayIndex);

    const stapleList = (() => {
      const base = seasonalStaples.length ? seasonalStaples : stapleBase;
      if (forceRice || ['japanese', 'western', 'chinese'].includes(cuisineKey)) {
        const allowTakikomi = cuisineKey === 'japanese' && takikomiQuota > 0;
        const white = filterStaples(base, { requireWhite: true, allowTakikomi });
        if (allowTakikomi && white.length) {
          const picked = white.find((m) => isTakikomi(m)) || null;
          if (picked) {
            takikomiQuota -= 1;
            usedStaples.add(picked.id);
            return [picked];
          }
        }
        return white.length ? white : filterStaples(base, { requireWhite: false, allowTakikomi: false });
      }
      return filterStaples(base, { requireWhite: false, allowTakikomi: false });
    })();

    const stapleMenu = pickFromList(stapleList, usedStaples, false);
    const stapleIsRice = stapleMenu && stapleMenu.kind === '主食・ごはん' && (isWhiteRice(stapleMenu) || isTakikomi(stapleMenu));

    const mainMenu = (() => {
      if (!stapleIsRice) return null;
      if (baseAssignments.has(dayIndex)) return baseAssignments.get(dayIndex);
      if (arrangeAssignments.has(dayIndex)) return arrangeAssignments.get(dayIndex);
      const base = seasonalMains.length ? seasonalMains : mainBaseRegular;
      let pool = filterDish(base, cuisineKey);
      if (!isWeekend) {
        pool = pool.filter((m) => !isNabe(m));
      }
      return pickFromList(pool, usedMains, true);
    })();

    const sideMenu = pickFromList(
      filterDish(seasonalSides.length ? seasonalSides : sideBase, cuisineKey),
      usedSides,
      true
    );
    const soupMenu = pickFromList(
      filterDish(seasonalSoups.length ? seasonalSoups : soupBase, cuisineKey),
      usedSoups,
      true
    );

    const slots = {
      staple: stapleMenu ? { menuId: stapleMenu.id, categoryKey: 'dinnerStaple', favorite: false, dineOut: false } : null,
      main: mainMenu ? { menuId: mainMenu.id, categoryKey: 'dinnerMain', favorite: false, dineOut: false } : null,
      side: sideMenu ? { menuId: sideMenu.id, categoryKey: 'dinnerSide', favorite: false, dineOut: false } : null,
      soup: soupMenu ? { menuId: soupMenu.id, categoryKey: 'dinnerSoup', favorite: false, dineOut: false } : null
    };

    if (slots.main) {
      const menu = (seasonalMains.length ? seasonalMains : mainBase).find((m) => m?.id === slots.main.menuId);
      if (menu && isNabe(menu)) {
        if (!isWeekend) {
          slots.main = null;
        } else {
          return { staple: null, main: slots.main, side: null, soup: null };
        }
      }
    }
    return slots;
  });

  return dinners;
};

const pickDinnerCandidate = ({ categoryKey, menusByCategory, myMenuFrequency = {}, currentSeason = '', excludeMenuId = '' }) => {
  const breakfastKeywords = [
    '食パン', 'サンドイッチ', 'フレンチトースト', 'パンケーキ', 'シリアル', 'トースト', 'ホットドッグ',
    'ヨーグルト',
    '目玉焼き', 'スクランブルエッグ', 'オムレツ',
    'おにぎり', '卵かけご飯',
    '味噌汁',
    '焼き魚', '干物',
    '納豆', 'しらす', 'ふりかけ',
    '卵焼き'
  ];
  const excludedKinds = new Set(['ごはんのお供', 'デザート', 'フルーツ', 'ドリンク', 'モーニングプレート']);
  const allowedStapleKinds = new Set(['主食', '主食・ごはん', '主食・麺', '主食・パン']);
  const isPizzaBread = (menu) => (menu?.kind === '主食・パン') && /ピザ/.test(getMenuText(menu));
  const isAllowedStaple = (menu) => {
    if (!menu) return false;
    if (!allowedStapleKinds.has(menu.kind)) return false;
    if (menu.kind === '主食・パン' && !isPizzaBread(menu)) return false;
    return true;
  };

  const baseRaw = (menusByCategory[categoryKey] || []).filter((m) => m && m.material !== true && !excludedKinds.has(m.kind));
  const baseList = filterBaseMenus(baseRaw, { excludeKeywords: breakfastKeywords })
    .filter((m) => !excludedKinds.has(m?.kind));
  const seasonal = filterSeasonalMenus(baseList, currentSeason);
  let pool = seasonal.length ? seasonal : baseList;

  let candidates = pool.filter((m) => m.id !== excludeMenuId);
  if (categoryKey === 'dinnerStaple') {
    candidates = candidates.filter(isAllowedStaple);
    if (!candidates.length) {
      // 季節で枯渇したときに元の主食系候補から復活
      candidates = baseRaw.filter(isAllowedStaple);
    }
  }

  if (!candidates.length) return null;
  const sorted = sortMenusByPreference(candidates, myMenuFrequency);
  return sorted[0] || candidates[0] || null;
};

const buildWeekPlanPayload = (menusByCategory, options = {}) => {
  const {
    startDate,
    myMenuFrequency = {},
    currentSeason = '',
    weekMenuSettings = {},
    preferredSetMenuIds = new Set()
  } = options;
  const normalizedSettings = normalizeWeekMenuSettings(weekMenuSettings || {});
  const menuLookup = {};
  Object.values(menusByCategory).forEach((menus) => {
    menus.forEach((menu) => {
      menuLookup[menu.id] = menu;
    });
  });

  const weekStartDate = startDate ? startOfWeek(startDate) : getNextWeekStart();
  const seasonLabel = currentSeason || monthToSeason(weekStartDate.getMonth() + 1);
  const weekDates = getWeekDatesFromStart(weekStartDate);
  const dinnerPlan = buildDinnerPlan(menusByCategory, {
    myMenuFrequency,
    currentSeason: seasonLabel,
    dinnerMenuFilter: normalizedSettings.dinnerMenus || [],
    dinnerRatios: normalizedSettings.dinnerRatios || {},
    preferredOriginalMenuIds: preferredSetMenuIds,
    arrangeCount: normalizedSettings.dinnerArrangeCount || 0,
    weekStartDate: weekStartDate
  });
  const breakfastPlan = buildBreakfastPlan(menusByCategory.breakfastMain || [], {
    myMenuFrequency,
    currentSeason: seasonLabel,
    breakfastMenuFilter: normalizedSettings.breakfastMenus || [],
    breakfastFilterEnabled: normalizedSettings.breakfastFilterEnabled !== false,
    breakfastRatios: normalizedSettings.breakfastRatios || {},
    preferredSetMenuIds
  });
  const lunchPlan = buildLunchPlan(menusByCategory.lunchMain || [], {
    myMenuFrequency,
    currentSeason: seasonLabel,
    lunchMenuFilter: normalizedSettings.lunchMenus || [],
    lunchRatios: normalizedSettings.lunchRatios || {},
    preferredOriginalMenuIds: preferredSetMenuIds
  });

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
      breakfastSlots: Array.isArray(breakfastPlan[index]) ? breakfastPlan[index] : [],
      lunchSlots: Array.isArray(lunchPlan[index]) ? lunchPlan[index] : [createSlot('lunchMain')].filter(Boolean),
      dinner: Array.isArray(dinnerPlan) && dinnerPlan[index]
        ? {
            staple: dinnerPlan[index].staple,
            main: dinnerPlan[index].main,
            side: dinnerPlan[index].side,
            soup: dinnerPlan[index].soup
          }
        : {
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
  res.render('auth/login', { hideHeader: true });
});

// ユーザー用ログイン画面の表示
router.get('/user/login', (req, res) => {
  const [registrationAlert] = req.flash('registrationAlert');
  res.render('auth/userLogin', {
    registrationAlert: registrationAlert || null,
    hideHeader: true
  });
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
    successRedirect: (request, user) => {
      const choice = normalizeServiceChoice(request.body?.serviceChoice);
      const preferred = choice || user?.preferredService || 'plan';
      return getServiceRedirect(preferred);
    },
    onAuthenticated: async (user, request) => {
      const choice = normalizeServiceChoice(request.body?.serviceChoice);
      if (!choice || user?.preferredService === choice) return;
      await User.updateOne({ _id: user._id }, { $set: { preferredService: choice } });
    }
  })
);

router.get('/users/switch-service', isLoggedIn, async (req, res) => {
  try {
    const choice = normalizeServiceChoice(req.query?.target);
    const preferred = choice || req.user?.preferredService || 'plan';
    if (choice && req.user?.preferredService !== choice) {
      await User.updateOne({ _id: req.user._id }, { $set: { preferredService: choice } });
    }
    return res.redirect(getServiceRedirect(preferred));
  } catch (_) {
    return res.redirect('/users/my-top');
  }
});

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


// 7 DAYS PLAN menu filter settings (user-scoped)
router.get('/users/week-menu/settings', isLoggedIn, async (req, res) => {
  try {
    const rawMenus = await Menu.distinct('menu', { isPrivate: { $ne: true } });
    const menus = (rawMenus || [])
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .filter(Boolean)
      .filter((m, idx, arr) => arr.indexOf(m) === idx)
      .sort((a, b) => a.localeCompare(b, 'ja'));

    const userDoc = await User.findById(req.user._id).select('weekMenuSettings').lean();
    const settings = normalizeWeekMenuSettings(userDoc?.weekMenuSettings || {});
    return res.json({ menus, settings });
  } catch (err) {
    console.error('week menu settings fetch error:', err);
    return res.status(500).json({ error: '設定情報を取得できませんでした。' });
  }
});

router.post('/users/week-menu/settings', isLoggedIn, async (req, res) => {
  try {
    const rawMenus = await Menu.distinct('menu', { isPrivate: { $ne: true } });
    const allowed = new Set(
      (rawMenus || [])
        .map((m) => (typeof m === 'string' ? m.trim() : ''))
        .filter(Boolean)
    );
    const toArray = (value) => (Array.isArray(value) ? value : (value ? [value] : []))
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);

    const breakfastMenus = toArray(req.body?.breakfastMenus).filter((v) => allowed.has(v));
    const lunchMenus = toArray(req.body?.lunchMenus).filter((v) => allowed.has(v));
    const dinnerMenus = toArray(req.body?.dinnerMenus).filter((v) => allowed.has(v));
    const payload = {
      breakfastMenus,
      breakfastRatios: normalizeBreakfastRatios(req.body?.breakfastRatios || {}),
      lunchMenus,
      lunchRatios: normalizeLunchRatios(req.body?.lunchRatios || {}),
      dinnerMenus,
      dinnerRatios: normalizeLunchRatios(req.body?.dinnerRatios || {}),
      dinnerArrangeCount: Number.isFinite(Number(req.body?.dinnerArrangeCount))
        ? Math.max(0, Math.min(7, Math.floor(Number(req.body?.dinnerArrangeCount))))
        : WEEK_MENU_SETTINGS_DEFAULTS.dinnerArrangeCount,
      breakfastFilterEnabled: req.body?.breakfastFilterEnabled !== false && String(req.body?.breakfastFilterEnabled) !== 'false',
      lunchFilterEnabled: req.body?.lunchFilterEnabled !== false && String(req.body?.lunchFilterEnabled) !== 'false',
      dinnerFilterEnabled: req.body?.dinnerFilterEnabled !== false && String(req.body?.dinnerFilterEnabled) !== 'false'
    };

    await User.findByIdAndUpdate(req.user._id, { weekMenuSettings: payload });
    const settings = normalizeWeekMenuSettings(payload);
    return res.json({ ok: true, settings });
  } catch (err) {
    console.error('week menu settings save error:', err);
    return res.status(500).json({ error: '設定を保存できませんでした。' });
  }
});

//weekMenu.ejsを開く
router.get('/users/week-menu', isLoggedIn, async (req, res, next) => {
  try {
    const configKindSet = new Set();
    Object.values(CATEGORY_CONFIG).forEach((config) => {
      (config.kinds || []).forEach((kind) => {
        if (kind) configKindSet.add(kind);
      });
    });

    const rawDistinctKinds = await Menu.distinct('kind', { isPrivate: { $ne: true } });
    const allKinds = (rawDistinctKinds || [])
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean);
    const kindSet = new Set([...configKindSet, ...allKinds]);
    const menusByKind = {};

    await Promise.all(
      Array.from(kindSet).map(async (kind) => {
        const docs = await Menu.find({ kind, isPrivate: { $ne: true } })
          .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
          .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
          .populate({
            path: 'setMenus',
            select: 'name menu kind junle cook imageUrl url time people menuType setType ingredients seasoning',
            populate: [
              { path: 'ingredients.name', select: 'ingredient unit classification' },
              { path: 'seasoning.name', select: 'seasoning unit classification' }
            ]
          })
          .lean();
        menusByKind[kind] = docs.map(formatMenuDocument);
      })
    );

    const combineMenusByKinds = (kinds) => {
      const combined = new Map();
      (kinds || []).forEach((kind) => {
        (menusByKind[kind] || []).forEach((menu) => {
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

    const modalKinds = allKinds.length ? allKinds : Array.from(kindSet);
    const modalMenus = combineMenusByKinds(modalKinds);

    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const activeGroupId = res.locals.selectedGroupId ? String(res.locals.selectedGroupId) : '';
    const requestedGroupId = req.query.group ? String(req.query.group) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';

    let currentGroupId = requestedGroupId || activeGroupId || defaultGroupId || fallbackGroupId || '';
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

    let myMenuDocsForGroup = [];
    if (currentGroupId) {
      try {
        myMenuDocsForGroup = await Mymenu.find({ user: req.user._id, group: currentGroupId })
          .select('menu frequency sourceType')
          .lean();
      } catch (e) {
        myMenuDocsForGroup = [];
      }
    }
    const preferredSetMenuIds = new Set(
      (myMenuDocsForGroup || [])
        .filter((entry) => entry?.sourceType === 'original' && entry?.menu)
        .map((entry) => String(entry.menu))
    );

    let weekMenuSettings = WEEK_MENU_SETTINGS_DEFAULTS;
    try {
      const userSettingsDoc = await User.findById(req.user._id).select('weekMenuSettings').lean();
      weekMenuSettings = normalizeWeekMenuSettings(userSettingsDoc?.weekMenuSettings || {});
    } catch (e) {
      weekMenuSettings = normalizeWeekMenuSettings({});
    }

    let groupSize = 1;
    let groupDocPopulated = null;
    let currentUserIsGroupOwner = false;
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
        breakfastSlots: [],
        lunchSlots: [],
        dinner: { staple: null, main: null, side: null, soup: null },
        dinnerExtras: [],
        dayComment: ''
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
          .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
          .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
          .populate({
            path: 'setMenus',
            select: 'name menu kind junle cook imageUrl url time people menuType setType ingredients seasoning',
            populate: [
              { path: 'ingredients.name', select: 'ingredient unit classification' },
              { path: 'seasoning.name', select: 'seasoning unit classification' }
            ]
          })
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
        // dayComment is stored separately (dayComments)

        (dayPlan.slots || []).forEach((slot) => {
          const map = SLOT_TYPE_DETAILS[slot?.slotType];
          if (!map) return;

          const slotData = {
            menuId: slot.menu.toString(),
            categoryKey: map.categoryKey,
            dineOut: !!slot.dineOut,
            dineOutName: typeof slot.dineOutName === 'string' ? slot.dineOutName : '',
            dineOutUrl: typeof slot.dineOutUrl === 'string' ? slot.dineOutUrl : '',
            favorite: !!slot.favorite,
            locked: !!slot.locked,
            prepExtra: Number.isFinite(Number(slot?.prepExtra)) && Number(slot.prepExtra) > 0
              ? Math.floor(Number(slot.prepExtra))
              : 0
          };

          if (map.meal === 'breakfast') {
            target.breakfastSlots = target.breakfastSlots || [];
            target.breakfastSlots.push(slotData);
          } else if (map.meal === 'lunch') {
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

      if (Array.isArray(existingPlan.dayComments)) {
        existingPlan.dayComments.forEach((entry) => {
          if (!entry || typeof entry.dayIndex !== 'number') return;
          const target = basePlan[entry.dayIndex];
          if (!target) return;
          target.dayComment = typeof entry.comment === 'string' ? entry.comment : '';
        });
      }

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
      const myMenuFrequency = buildMyMenuFrequencyMap(myMenuDocsForGroup);
      const currentSeasonLabel = monthToSeason(new Date().getMonth() + 1);
      const generated = buildWeekPlanPayload(menusByCategory, {
        startDate: targetWeekStart,
        myMenuFrequency,
        currentSeason: currentSeasonLabel,
        weekMenuSettings,
        preferredSetMenuIds
      });
      plan = (generated.plan || []).map((day) => ({
        ...day,
        dayComment: (day && typeof day.dayComment === 'string') ? day.dayComment : ''
      }));
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
          dineOutName: '',
          dineOutUrl: '',
          locked: false,
          prepExtra: 0,
          ...(slot && { ...slot, menuId: null, favorite: false, dineOut: false, dineOutName: '', dineOutUrl: '', locked: false })
        });

        plan = plan.map((day) => ({
          ...day,
          breakfastSlots: Array.isArray(day?.breakfastSlots)
            ? day.breakfastSlots.map((slot) => ensureSlot(slot, slot?.categoryKey || 'breakfastMain'))
            : [],
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
    let currentGroupUsers = [];
    let guidelineTotals = {};

    if (currentGroupId) {
      if (groupDocPopulated) {
        // Prefer populated document: only existing users are present; nulls are filtered out
        currentGroupName = groupDocPopulated.group_name || '';
        const members = [];
        const usersList = [];
        const owner = groupDocPopulated.createdBy || null;
        currentUserIsGroupOwner = owner && String(owner._id) === String(req.user._id);
        if (owner && owner._id) {
          members.push(owner.displayname || owner.username || owner.email || '');
          usersList.push({
            id: String(owner._id),
            name: owner.displayname || owner.username || owner.email || '',
            sex: owner.sex || '',
            birthDateISO: toISODateString(owner.birth_date)
          });
        }
        (groupDocPopulated.members || []).filter(Boolean).forEach((member) => {
          if (!owner || String(member._id) !== String(owner._id)) {
            members.push(member.displayname || member.username || member.email || '');
            usersList.push({
              id: String(member._id),
              name: member.displayname || member.username || member.email || '',
              sex: member.sex || '',
              birthDateISO: toISODateString(member.birth_date)
            });
          }
        });
        currentGroupMembers = members;
        currentGroupUsers = usersList;
      } else {
        // Fallback: use res.locals.userGroups (filter to truthy/populated entries only)
        const targetGroup = userGroups.find((g) => String(g._id) === String(currentGroupId));
        if (targetGroup) {
          currentGroupName = targetGroup.group_name || '';
          const members = [];
          const usersList = [];
          const owner = targetGroup.createdBy;
          if (owner && (owner.displayname || owner.username || owner.email)) {
            members.push(owner.displayname || owner.username || owner.email || '');
            usersList.push({
              id: String(owner._id || owner),
              name: owner.displayname || owner.username || owner.email || '',
              sex: owner.sex || '',
              birthDateISO: toISODateString(owner.birth_date)
            });
          }
          currentUserIsGroupOwner = owner && String(owner._id || owner) === String(req.user._id);
          (targetGroup.members || []).filter(Boolean).forEach((member) => {
            const memberId = member._id || member;
            if (owner && String(memberId) === String(owner._id || owner)) return;
            const name = member.displayname || member.username || member.email || '';
            if (name) members.push(name);
            usersList.push({
              id: String(memberId),
              name,
              sex: member.sex || '',
              birthDateISO: toISODateString(member.birth_date)
            });
          });
          currentGroupMembers = members;
          currentGroupUsers = usersList;
        }
      }
    }

    currentGroupUsers = await hydrateGroupUsers(currentGroupUsers);
    const guidelineData = await aggregateGuidelineTotals(currentGroupUsers);
    guidelineTotals = guidelineData.totals;
    const guidelineByUser = guidelineData.perUserTotals || {};

    // グループ名・メンバー名の計算が終わったあと
    // console.log('currentGroupName:', currentGroupName);
    // console.log('currentGroupMembers:', currentGroupMembers);

	const weekStartISO = targetWeekStart.toISOString();
    // participants map for this plan
    let participantsMap = {};
    if (existingPlan && Array.isArray(existingPlan.participants)) {
      participantsMap = existingPlan.participants.reduce((acc, entry) => {
        if (!entry) return acc;
        const key = `${entry.dayIndex}:${entry.mealType}`;
        const users = Array.isArray(entry.users) ? entry.users.map((u) => String(u)) : [];
        acc[key] = users;
        return acc;
      }, {});
    }
    // MyMenu ids for current user+group to color hearts
    let myMenuIds = [];
    if (currentGroupId) {
      if (Array.isArray(myMenuDocsForGroup) && myMenuDocsForGroup.length) {
        myMenuIds = myMenuDocsForGroup.map((m) => (m.menu ? m.menu.toString() : '')).filter(Boolean);
      } else {
        try {
          const mymenus = await Mymenu.find({ user: req.user._id, group: currentGroupId }).select('menu').lean();
          myMenuIds = (mymenus || []).map((m) => (m.menu ? m.menu.toString() : '')).filter(Boolean);
        } catch (e) {
          myMenuIds = [];
        }
      }
    }
    const weekMenuView = (targetWeekStart.getTime() === todayWeekStart.getTime()) ? 'current' : 'next';
    // expose supplies/menu mode for hamburger highlighting
    const weekMenuMode = (typeof req.query.show === 'string' && req.query.show === 'supplies') ? 'supplies' : 'menu';

    // Fetch current user's DO ("これ食べた") records for this week
    let doRecords = [];
    try {
      if (currentGroupId && Array.isArray(baseWeekDates) && baseWeekDates.length >= 7) {
        const rangeStart = startOfDay(baseWeekDates[0]);
        const rangeEnd = startOfDay(baseWeekDates[6]);
        const docs = await MenuDo.find({
          group: currentGroupId,
          recordedBy: req.user?._id,
          date: { $gte: rangeStart, $lte: rangeEnd }
        }).select('date mealType menu').lean();
        doRecords = (docs || []).map((d) => ({
          dateISO: d.date ? new Date(d.date).toISOString() : '',
          mealType: d.mealType || '',
          menuId: d.menu ? String(d.menu) : ''
        }));
      }
    } catch (e) {
      console.warn('DO records fetch failed:', e?.message || e);
    }

	const viewTemplate = 'users/weekMenu2';
	res.render(viewTemplate, {
    categoryConfig: CATEGORY_CONFIG,
    menusByCategory,
    modalMenus,
    allKinds,
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
    currentGroupUsers,
    guidelineTotals,
    guidelineByUser,
    currentUserId: req.user?._id ? String(req.user._id) : '',
    currentUserIsGroupOwner,
    participantsMap,

    myMenuIds,
    weekMenuView,
    doRecords,
    weekMenuMode,
    weekMenuSettings
	});
  
  } catch (err) {
    console.error('週次メニュー生成エラー:', err);
    return next(err);
  }
});

// Week menu PDF (print-friendly HTML)
router.get('/users/week-menu/pdf', isLoggedIn, async (req, res, next) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const activeGroupId = res.locals.selectedGroupId ? String(res.locals.selectedGroupId) : '';
    const requestedGroupId = req.query.group ? String(req.query.group) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';
    let currentGroupId = requestedGroupId || activeGroupId || defaultGroupId || fallbackGroupId || '';
    if (currentGroupId && !userGroups.some((g) => g._id.toString() === currentGroupId)) {
      currentGroupId = fallbackGroupId || '';
    }

    let guidelineTotals = { ...DEFAULT_GUIDELINE_TOTALS };
    if (currentGroupId) {
      const groupDoc = await Group.findById(currentGroupId)
        .populate({ path: 'createdBy', select: 'displayname username email sex birth_date' })
        .populate({ path: 'members', select: 'displayname username email sex birth_date' })
        .lean();
      if (groupDoc) {
        const usersList = [];
        const owner = groupDoc.createdBy || null;
        if (owner && owner._id) {
          usersList.push({
            id: String(owner._id),
            name: owner.displayname || owner.username || owner.email || '',
            sex: owner.sex || '',
            birthDateISO: toISODateString(owner.birth_date)
          });
        }
        (groupDoc.members || []).filter(Boolean).forEach((member) => {
          if (owner && String(member._id) === String(owner._id)) return;
          usersList.push({
            id: String(member._id),
            name: member.displayname || member.username || member.email || '',
            sex: member.sex || '',
            birthDateISO: toISODateString(member.birth_date)
          });
        });
        const hydratedUsers = await hydrateGroupUsers(usersList);
        const guidelineData = await aggregateGuidelineTotals(hydratedUsers);
        guidelineTotals = guidelineData.totals || guidelineTotals;
      }
    }

    const planIdParam = req.query.plan && mongoose.Types.ObjectId.isValid(req.query.plan)
      ? String(req.query.plan)
      : '';
    const weekStartParam = typeof req.query.weekStart === 'string' ? req.query.weekStart : '';
    const targetWeekStart = weekStartParam ? startOfWeek(weekStartParam) : getNextWeekStart();

    let planDoc = null;
    let participantsMap = {};
    if (planIdParam) {
      const plan = await WeeklyMenuPlan.findById(planIdParam).lean();
      if (plan && (!currentGroupId || String(plan.group) === String(currentGroupId))) {
        planDoc = plan;
        if (!currentGroupId) currentGroupId = String(plan.group);
      }
    }
    if (!planDoc && currentGroupId) {
      planDoc = await WeeklyMenuPlan.findOne({ group: currentGroupId, weekStart: targetWeekStart }).lean();
    }
    if (planDoc) {
      participantsMap = (planDoc.participants || []).reduce((acc, entry) => {
        if (!entry) return acc;
        const key = `${entry.dayIndex}:${entry.mealType}`;
        acc[key] = Array.isArray(entry.users) ? entry.users.map((u) => String(u)) : [];
        return acc;
      }, {});
    }

    let weekStartDate = targetWeekStart;
    let weekDates = getWeekDatesFromStart(weekStartDate);
    let menuLookup = {};
    const dayMeals = Array.from({ length: 7 }, () => ({
      breakfast: [],
      lunch: [],
      dinner: []
    }));
    const summaryMap = new Map();
    const requiredMap = new Map();
    const SEASONING_CAPTURE_CLASSES = new Set(['穀物', '乳類', 'チーズ']);

    const normalizeUnit = (value) => String(value || '').trim().toLowerCase();
    const gramsFallbackByUnit = (unit) => {
      const u = normalizeUnit(unit);
      if (!u) return null;
      if (['g', 'gram', 'grams', 'ｇ', 'グラム'].includes(u)) return 1;
      if (['kg', 'kilogram', '㎏', 'キログラム'].includes(u)) return 1000;
      if (['mg', 'milligram', '㎎', 'ミリグラム'].includes(u)) return 0.001;
      return null;
    };
    const toGrams = (amount, unit, meta) => {
      if (typeof amount !== 'number' || Number.isNaN(amount)) return null;
      const u = normalizeUnit(unit);
      if (!u) return null;
      if (u === 'ml' || u === 'mL' || u === 'cc') return amount; // approximate
      const conversions = Array.isArray(meta?.unitConversions) ? meta.unitConversions : [];
      const hit = conversions.find((c) => String(c?.label || '').trim().toLowerCase() === u);
      if (hit && typeof hit.grams === 'number' && !Number.isNaN(hit.grams)) {
        return amount * hit.grams;
      }
      const per = gramsFallbackByUnit(u);
      return per ? amount * per : null;
    };
    const addSummary = (classification, grams) => {
      if (typeof grams !== 'number' || Number.isNaN(grams)) return;
      const label = (classification && String(classification).trim()) ? String(classification).trim() : 'その他';
      const next = (summaryMap.get(label) || 0) + grams;
      summaryMap.set(label, next);
    };
    const dayCount = 7;
    FOOD_CLASSIFICATIONS.forEach((cls) => {
      const daily = Number(guidelineTotals?.[cls]) || 0;
      requiredMap.set(cls, daily * dayCount);
    });

    const pushMeal = (dayIndex, mealType, entry) => {
      if (!dayMeals[dayIndex]) return;
      if (!dayMeals[dayIndex][mealType]) return;
      dayMeals[dayIndex][mealType].push(entry);
    };

    const defaultPeopleCount = calculateGroupSize(userGroups, currentGroupId);
    const getPeopleCount = (participantsMap, dayIndex, mealType) => {
      const key = `${dayIndex}:${mealType}`;
      if (participantsMap && Object.prototype.hasOwnProperty.call(participantsMap, key)) {
        const list = Array.isArray(participantsMap[key]) ? participantsMap[key] : [];
        return list.length;
      }
      return defaultPeopleCount;
    };
    const addMenuToSummary = (menuDoc, peopleCount, extraCount, type = 'ingredient', metaMap = null) => {
      if (!menuDoc) return;
      const basePeople = Number(menuDoc.people) > 0 ? Number(menuDoc.people) : 1;
      const multiplier = (peopleCount + (extraCount || 0)) > 0 ? ((peopleCount + (extraCount || 0)) / basePeople) : 1;
      if (type === 'ingredient') {
        (menuDoc.ingredients || []).forEach((it) => {
          const meta = it?.name || {};
          const fallback = metaMap && meta?._id ? metaMap.get(String(meta._id)) : null;
          const cls = meta?.classification || fallback?.classification || '';
          const grams = toGrams(Number(it?.amount) * multiplier, it?.unit || '', meta?.unitConversions ? meta : fallback);
          addSummary(cls, grams);
        });
      } else {
        (menuDoc.seasoning || []).forEach((it) => {
          const meta = it?.name || {};
          const fallback = metaMap && meta?._id ? metaMap.get(String(meta._id)) : null;
          const cls = meta?.classification || fallback?.classification || '';
          if (!SEASONING_CAPTURE_CLASSES.has(cls)) return;
          const grams = toGrams(Number(it?.amount) * multiplier, it?.unit || '', meta?.unitConversions ? meta : fallback);
          addSummary(cls, grams);
        });
      }
    };

    if (planDoc) {
      weekStartDate = startOfWeek(planDoc.weekStart);
      weekDates = getWeekDatesFromStart(weekStartDate);
      const ids = new Set();
      (planDoc.dayPlans || []).forEach((dp) => {
        (dp.slots || []).forEach((slot) => {
          if (slot?.menu) ids.add(String(slot.menu));
        });
      });
      if (ids.size) {
        const menus = await Menu.find({ _id: { $in: Array.from(ids) } })
          .populate({ path: 'ingredients.name', select: 'ingredient classification unit unitConversions' })
          .populate({ path: 'seasoning.name', select: 'seasoning classification unit unitConversions' })
          .populate({ path: 'setMenus', select: 'name kind imageUrl menuType' })
          .lean();
        const menuDetailMap = new Map();
        const ingredientIds = new Set();
        const seasoningIds = new Set();
        menus.forEach((m) => {
          menuDetailMap.set(String(m._id), m);
          menuLookup[String(m._id)] = {
            name: m.name || '',
            junle: m.junle || '',
            kind: m.kind || '',
            imageUrl: m.imageUrl || '',
            menuType: m.menuType || 'single',
            setMenus: (m.setMenus || []).map((s) => ({
              name: s?.name || '',
              kind: s?.kind || '',
              imageUrl: s?.imageUrl || '',
              menuType: s?.menuType || 'single'
            }))
          };
          (m.ingredients || []).forEach((it) => {
            const id = it?.name?._id ? String(it.name._id) : '';
            if (id) ingredientIds.add(id);
          });
          (m.seasoning || []).forEach((it) => {
            const id = it?.name?._id ? String(it.name._id) : '';
            if (id) seasoningIds.add(id);
          });
        });
        const ingredientMetaMap = new Map();
        if (ingredientIds.size) {
          const docs = await Ingredient.find({ _id: { $in: Array.from(ingredientIds) } })
            .select('classification unit unitConversions ingredient')
            .lean();
          docs.forEach((d) => ingredientMetaMap.set(String(d._id), d));
        }
        const seasoningMetaMap = new Map();
        if (seasoningIds.size) {
          const docs = await Seasoning.find({ _id: { $in: Array.from(seasoningIds) } })
            .select('classification unit unitConversions seasoning')
            .lean();
          docs.forEach((d) => seasoningMetaMap.set(String(d._id), d));
        }
        // accumulate ingredient/seasoning totals (weekly) by slots
        (planDoc.dayPlans || []).forEach((dp) => {
          const dayIndex = Number(dp.dayIndex);
          const mealType = dp.mealType;
          if (!Number.isFinite(dayIndex) || dayIndex < 0 || dayIndex > 6) return;
          const peopleCount = getPeopleCount(participantsMap, dayIndex, mealType);
          (dp.slots || []).forEach((slot) => {
            if (!slot || slot.dineOut) return;
            const menuDoc = menuDetailMap.get(String(slot.menu));
            if (!menuDoc) return;
            const extraCount = Math.max(0, Number(slot?.prepExtra) || 0);
            addMenuToSummary(menuDoc, peopleCount, extraCount, 'ingredient', ingredientMetaMap);
            addMenuToSummary(menuDoc, peopleCount, extraCount, 'seasoning', seasoningMetaMap);
          });
        });
        // required totals: per person per day * dayCount (already set)
      }
      (planDoc.dayPlans || []).forEach((dp) => {
        const dayIndex = Number(dp.dayIndex);
        const mealType = dp.mealType;
        if (!Number.isFinite(dayIndex) || dayIndex < 0 || dayIndex > 6) return;
        (dp.slots || []).forEach((slot) => {
          if (!slot) return;
          if (slot.dineOut) {
            pushMeal(dayIndex, mealType, {
              name: slot.dineOutName || '外食',
              tag: '外食',
              kind: '外食'
            });
            return;
          }
          const menu = menuLookup[String(slot.menu)] || null;
          if (!menu) return;
          pushMeal(dayIndex, mealType, {
            name: menu.name,
            tag: menu.junle,
            kind: menu.kind || '',
            imageUrl: menu.imageUrl || '',
            menuType: menu.menuType || 'single',
            setMenus: Array.isArray(menu.setMenus) ? menu.setMenus : []
          });
        });
      });
    } else {
      // Generate a temporary plan when no saved plan is available
      const kindSet = new Set();
      Object.values(CATEGORY_CONFIG).forEach((config) => (config.kinds || []).forEach((k) => k && kindSet.add(k)));
      const menusByKind = {};
      await Promise.all(
        Array.from(kindSet).map(async (kind) => {
          const docs = await Menu.find({ kind, isPrivate: { $ne: true } })
            .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
            .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
            .lean();
          menusByKind[kind] = docs.map(formatMenuDocument);
        })
      );
      const combineMenusByKinds = (kinds) => {
        const combined = new Map();
        (kinds || []).forEach((kind) => {
          (menusByKind[kind] || []).forEach((menu) => {
            if (!combined.has(menu.id)) combined.set(menu.id, menu);
          });
        });
        return Array.from(combined.values());
      };
      const menusByCategory = Object.entries(CATEGORY_CONFIG).reduce((acc, [key, config]) => {
        acc[key] = combineMenusByKinds(config.kinds);
        return acc;
      }, {});
      let weekMenuSettings = WEEK_MENU_SETTINGS_DEFAULTS;
      let preferredSetMenuIds = new Set();
      try {
        const userSettingsDoc = await User.findById(req.user._id).select('weekMenuSettings').lean();
        weekMenuSettings = normalizeWeekMenuSettings(userSettingsDoc?.weekMenuSettings || {});
      } catch (e) {
        weekMenuSettings = normalizeWeekMenuSettings({});
      }
      try {
        if (currentGroupId) {
          const mymenus = await Mymenu.find({ user: req.user._id, group: currentGroupId }).select('menu sourceType').lean();
          preferredSetMenuIds = new Set(
            (mymenus || [])
              .filter((entry) => entry?.sourceType === 'original' && entry?.menu)
              .map((entry) => String(entry.menu))
          );
        }
      } catch (e) {
        preferredSetMenuIds = new Set();
      }
      const generated = buildWeekPlanPayload(menusByCategory, {
        startDate: weekStartDate,
        weekMenuSettings,
        preferredSetMenuIds
      });
      const plan = generated.plan || [];
      menuLookup = generated.menuLookup || {};
      const ingredientIds = new Set();
      const seasoningIds = new Set();
      Object.values(menuLookup).forEach((menu) => {
        (menu?.ingredients || []).forEach((it) => {
          if (it?.id) ingredientIds.add(String(it.id));
        });
        (menu?.seasoning || []).forEach((it) => {
          if (it?.id) seasoningIds.add(String(it.id));
        });
      });
      const ingredientMetaMap = new Map();
      if (ingredientIds.size) {
        const docs = await Ingredient.find({ _id: { $in: Array.from(ingredientIds) } })
          .select('classification unit unitConversions')
          .lean();
        docs.forEach((d) => {
          ingredientMetaMap.set(String(d._id), d);
        });
      }
      const seasoningMetaMap = new Map();
      if (seasoningIds.size) {
        const docs = await Seasoning.find({ _id: { $in: Array.from(seasoningIds) } })
          .select('classification unit unitConversions')
          .lean();
        docs.forEach((d) => {
          seasoningMetaMap.set(String(d._id), d);
        });
      }
      plan.forEach((day, index) => {
        const b = Array.isArray(day.breakfastSlots) ? day.breakfastSlots : [];
        const l = Array.isArray(day.lunchSlots) ? day.lunchSlots : [];
        const dinnerBase = day?.dinner && typeof day.dinner === 'object'
          ? ['staple', 'main', 'side', 'soup'].map((k) => day.dinner[k]).filter(Boolean)
          : [];
        const dinnerExtras = Array.isArray(day.dinnerExtras) ? day.dinnerExtras.filter(Boolean) : [];
        const d = [...dinnerBase, ...dinnerExtras];
        b.forEach((slot) => {
          const menu = slot?.menuId ? menuLookup[slot.menuId] : null;
          if (menu) pushMeal(index, 'breakfast', {
            name: menu.name,
            tag: menu.junle || '',
            kind: menu.kind || '',
            imageUrl: menu.imageUrl || '',
            menuType: menu.menuType || 'single',
            setMenus: Array.isArray(menu.setMenus) ? menu.setMenus : []
          });
        });
        l.forEach((slot) => {
          const menu = slot?.menuId ? menuLookup[slot.menuId] : null;
          if (menu) pushMeal(index, 'lunch', {
            name: menu.name,
            tag: menu.junle || '',
            kind: menu.kind || '',
            imageUrl: menu.imageUrl || '',
            menuType: menu.menuType || 'single',
            setMenus: Array.isArray(menu.setMenus) ? menu.setMenus : []
          });
        });
        d.forEach((slot) => {
          const menu = slot?.menuId ? menuLookup[slot.menuId] : null;
          if (menu) pushMeal(index, 'dinner', {
            name: menu.name,
            tag: menu.junle || '',
            kind: menu.kind || '',
            imageUrl: menu.imageUrl || '',
            menuType: menu.menuType || 'single',
            setMenus: Array.isArray(menu.setMenus) ? menu.setMenus : []
          });
        });
      });
      // accumulate ingredient/seasoning totals (weekly) by slots
      const peopleCount = defaultPeopleCount;
      const applySlot = (slot) => {
        if (!slot || slot.dineOut) return;
        const menu = slot?.menuId ? menuLookup[slot.menuId] : null;
        if (!menu) return;
        const extraCount = Math.max(0, Number(slot?.prepExtra) || 0);
        const basePeople = Number(menu.people) > 0 ? Number(menu.people) : 1;
        const multiplier = (peopleCount + extraCount) > 0 ? ((peopleCount + extraCount) / basePeople) : 1;
        (menu.ingredients || []).forEach((it) => {
          const meta = it?.id ? ingredientMetaMap.get(String(it.id)) : null;
          const grams = toGrams(Number(it?.amount) * multiplier, it?.unit || '', meta);
          addSummary(it?.classification || meta?.classification || '', grams);
        });
        (menu.seasoning || []).forEach((it) => {
          const meta = it?.id ? seasoningMetaMap.get(String(it.id)) : null;
          const cls = it?.classification || meta?.classification || '';
          if (!SEASONING_CAPTURE_CLASSES.has(cls)) return;
          const grams = toGrams(Number(it?.amount) * multiplier, it?.unit || '', meta);
          addSummary(cls, grams);
        });
        // required totals are handled per day (not per slot)
      };
      plan.forEach((day) => {
        (Array.isArray(day.breakfastSlots) ? day.breakfastSlots : []).forEach(applySlot);
        (Array.isArray(day.lunchSlots) ? day.lunchSlots : []).forEach(applySlot);
        let dinnerSlots = Array.isArray(day.dinnerSlots) ? day.dinnerSlots : [];
        if (!dinnerSlots.length && day && day.dinner) {
          const base = ['staple', 'main', 'side', 'soup'].map((k) => day.dinner[k]).filter(Boolean);
          const extras = Array.isArray(day.dinnerExtras) ? day.dinnerExtras.filter(Boolean) : [];
          dinnerSlots = [...base, ...extras];
        }
        dinnerSlots.forEach(applySlot);
      });
      // required totals: per person per day * dayCount (already set)
    }

    const titleStart = weekDates[0];
    const titleEnd = weekDates[6];
    const titleLabel = `${titleStart.getFullYear()}年${titleStart.getMonth() + 1}月${titleStart.getDate()}日 〜 ${titleEnd.getFullYear()}年${titleEnd.getMonth() + 1}月${titleEnd.getDate()}日の献立表`;
    const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
    const days = weekDates.map((date, index) => ({
      label: `${date.getMonth() + 1}/${date.getDate()}(${weekdays[index] || ''})`,
      meals: dayMeals[index] || { breakfast: [], lunch: [], dinner: [] }
    }));
    let participantMax = defaultPeopleCount;
    if (planDoc) {
      participantMax = 0;
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        participantMax = Math.max(
          participantMax,
          getPeopleCount(participantsMap, dayIndex, 'breakfast'),
          getPeopleCount(participantsMap, dayIndex, 'lunch'),
          getPeopleCount(participantsMap, dayIndex, 'dinner')
        );
      }
      participantMax = Math.max(1, participantMax || defaultPeopleCount);
    }
    const weeklyMap = new Map();
    summaryMap.forEach((grams, classification) => {
      const label = (classification && String(classification).trim()) ? String(classification).trim() : 'その他';
      const perPerson = Math.round((grams / Math.max(1, participantMax)) * 10) / 10;
      weeklyMap.set(label, perPerson);
    });
    const allClasses = new Set([
      ...FOOD_CLASSIFICATIONS,
      ...Array.from(weeklyMap.keys())
    ]);
    const SUMMARY_ORDER = [
      '乳類',
      'チーズ',
      '卵類',
      '肉類',
      '魚介類',
      '豆類',
      '野菜類',
      'いも及びでん粉類',
      'きのこ類',
      '果実類',
      '穀物',
      '藻類',
      '加工食品',
      'その他'
    ];
    const ordered = SUMMARY_ORDER.filter((label) => allClasses.has(label));
    const extras = Array.from(allClasses).filter((label) => !SUMMARY_ORDER.includes(label));
    const summaryRows = [...ordered, ...extras]
      .map((classification) => {
        const required = requiredMap.has(classification)
          ? Math.round(requiredMap.get(classification) * 10) / 10
          : 0;
        const weekly = weeklyMap.get(classification) || 0;
        const diff = Math.round((weekly - required) * 10) / 10;
        return {
          classification,
          requiredGrams: required,
          weeklyGrams: weekly,
          diffGrams: diff
        };
      })
      .map((row, idx) => ({ ...row, _order: idx }))
      .sort((a, b) => a._order - b._order)
      .map(({ _order, ...row }) => row);

    const baseOrigin = `${req.protocol}://${req.get('host')}`;
    return res.render('users/weekMenuPdf', {
      titleLabel,
      days,
      summaryRows,
      baseOrigin
    });
  } catch (err) {
    console.error('week menu pdf error:', err);
    return next(err);
  }
});

// Proxy external images for PDF rendering (avoids hotlink/CORS issues)
router.get('/users/week-menu/image-proxy', isLoggedIn, async (req, res) => {
  try {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl) return res.status(400).send('missing url');
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      return res.status(400).send('invalid url');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('invalid protocol');
    }
    const host = parsed.hostname || '';
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return res.status(400).send('invalid host');
    }

    const upstream = await fetch(parsed.toString(), { method: 'GET' });
    if (!upstream.ok) {
      return res.status(502).send('upstream error');
    }
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);
  } catch (err) {
    console.error('week menu image proxy error:', err);
    return res.status(500).send('proxy error');
  }
});

// Week menu ingredient/seasoning detail (Excel)
router.get('/users/week-menu/ingredients.xlsx', isLoggedIn, async (req, res, next) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const activeGroupId = res.locals.selectedGroupId ? String(res.locals.selectedGroupId) : '';
    const requestedGroupId = req.query.group ? String(req.query.group) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';
    let currentGroupId = requestedGroupId || activeGroupId || defaultGroupId || fallbackGroupId || '';
    if (currentGroupId && !userGroups.some((g) => g._id.toString() === currentGroupId)) {
      currentGroupId = fallbackGroupId || '';
    }

    const planIdParam = req.query.plan && mongoose.Types.ObjectId.isValid(req.query.plan)
      ? String(req.query.plan)
      : '';
    const weekStartParam = typeof req.query.weekStart === 'string' ? req.query.weekStart : '';
    const targetWeekStart = weekStartParam ? startOfWeek(weekStartParam) : getNextWeekStart();

    let planDoc = null;
    if (planIdParam) {
      const plan = await WeeklyMenuPlan.findById(planIdParam).lean();
      if (plan && (!currentGroupId || String(plan.group) === String(currentGroupId))) {
        planDoc = plan;
        if (!currentGroupId) currentGroupId = String(plan.group);
      }
    }
    if (!planDoc && currentGroupId) {
      planDoc = await WeeklyMenuPlan.findOne({ group: currentGroupId, weekStart: targetWeekStart }).lean();
    }

    let weekStartDate = targetWeekStart;
    let weekDates = getWeekDatesFromStart(weekStartDate);
    let plan = [];
    let menuLookup = {};
    let participantsMap = {};
    if (planDoc) {
      weekStartDate = startOfWeek(planDoc.weekStart);
      weekDates = getWeekDatesFromStart(weekStartDate);
      participantsMap = (planDoc.participants || []).reduce((acc, entry) => {
        if (!entry) return acc;
        const key = `${entry.dayIndex}:${entry.mealType}`;
        acc[key] = Array.isArray(entry.users) ? entry.users.map((u) => String(u)) : [];
        return acc;
      }, {});
      const basePlan = weekDates.map((date, index) => ({
        index,
        dateISO: date.toISOString(),
        breakfastSlots: [],
        lunchSlots: [],
        dinner: { staple: null, main: null, side: null, soup: null },
        dinnerExtras: []
      }));
      const ids = new Set();
      (planDoc.dayPlans || []).forEach((dp) => (dp.slots || []).forEach((s) => s?.menu && ids.add(String(s.menu))));
      if (ids.size) {
        const docs = await Menu.find({ _id: { $in: Array.from(ids) } })
          .populate({ path: 'ingredients.name', select: 'ingredient classification unit unitConversions' })
          .populate({ path: 'seasoning.name', select: 'seasoning classification unit unitConversions' })
          .lean();
        docs.forEach((d) => {
          const f = formatMenuDocument(d);
          menuLookup[f.id] = f;
        });
      }
      (planDoc.dayPlans || []).forEach((dp) => {
        const target = basePlan[dp.dayIndex]; if (!target) return;
        (dp.slots || []).forEach((slot) => {
          const map = SLOT_TYPE_DETAILS[slot?.slotType]; if (!map) return;
          const data = { menuId: slot.menu.toString(), categoryKey: map.categoryKey, dineOut: !!slot.dineOut, prepExtra: Number(slot?.prepExtra) || 0 };
          if (map.meal === 'breakfast') target.breakfastSlots.push(data);
          else if (map.meal === 'lunch') target.lunchSlots.push(data);
          else if (map.key === 'extras') target.dinnerExtras.push(data);
          else if (!target.dinner[map.key]) target.dinner[map.key] = data;
          else target.dinnerExtras.push(data);
        });
      });
      plan = basePlan;
    } else {
      const kindSet = new Set();
      Object.values(CATEGORY_CONFIG).forEach((config) => (config.kinds || []).forEach((k) => k && kindSet.add(k)));
      const menusByKind = {};
      await Promise.all(
        Array.from(kindSet).map(async (kind) => {
          const docs = await Menu.find({ kind, isPrivate: { $ne: true } })
            .populate({ path: 'ingredients.name', select: 'ingredient unit classification unitConversions' })
            .populate({ path: 'seasoning.name', select: 'seasoning unit classification unitConversions' })
            .lean();
          menusByKind[kind] = docs.map(formatMenuDocument);
        })
      );
      const combineMenusByKinds = (kinds) => {
        const combined = new Map();
        (kinds || []).forEach((kind) => {
          (menusByKind[kind] || []).forEach((menu) => { if (!combined.has(menu.id)) combined.set(menu.id, menu); });
        });
        return Array.from(combined.values());
      };
      const menusByCategory = Object.entries(CATEGORY_CONFIG).reduce((acc, [key, config]) => {
        acc[key] = combineMenusByKinds(config.kinds);
        return acc;
      }, {});
      let weekMenuSettings = WEEK_MENU_SETTINGS_DEFAULTS;
      let preferredSetMenuIds = new Set();
      try {
        const userSettingsDoc = await User.findById(req.user._id).select('weekMenuSettings').lean();
        weekMenuSettings = normalizeWeekMenuSettings(userSettingsDoc?.weekMenuSettings || {});
      } catch (e) {
        weekMenuSettings = normalizeWeekMenuSettings({});
      }
      try {
        if (currentGroupId) {
          const mymenus = await Mymenu.find({ user: req.user._id, group: currentGroupId }).select('menu sourceType').lean();
          preferredSetMenuIds = new Set(
            (mymenus || [])
              .filter((entry) => entry?.sourceType === 'original' && entry?.menu)
              .map((entry) => String(entry.menu))
          );
        }
      } catch (e) {
        preferredSetMenuIds = new Set();
      }
      const generated = buildWeekPlanPayload(menusByCategory, {
        startDate: weekStartDate,
        weekMenuSettings,
        preferredSetMenuIds
      });
      plan = generated.plan || [];
      menuLookup = generated.menuLookup || {};
    }

    const ingredientMetaMap = new Map();
    const seasoningMetaMap = new Map();
    const ingredientIds = new Set();
    const seasoningIds = new Set();
    Object.values(menuLookup).forEach((menu) => {
      (menu?.ingredients || []).forEach((it) => {
        if (it?.id) ingredientIds.add(String(it.id));
      });
      (menu?.seasoning || []).forEach((it) => {
        if (it?.id) seasoningIds.add(String(it.id));
      });
    });
    if (ingredientIds.size) {
      const docs = await Ingredient.find({ _id: { $in: Array.from(ingredientIds) } })
        .select('classification unit unitConversions ingredient')
        .lean();
      docs.forEach((d) => ingredientMetaMap.set(String(d._id), d));
    }
    if (seasoningIds.size) {
      const docs = await Seasoning.find({ _id: { $in: Array.from(seasoningIds) } })
        .select('classification unit unitConversions seasoning')
        .lean();
      docs.forEach((d) => seasoningMetaMap.set(String(d._id), d));
    }

    const defaultPeopleCount = calculateGroupSize(userGroups, currentGroupId);
    const getPeopleCount = (dayIndex, mealType) => {
      const key = `${dayIndex}:${mealType}`;
      if (participantsMap && Object.prototype.hasOwnProperty.call(participantsMap, key)) {
        const list = Array.isArray(participantsMap[key]) ? participantsMap[key] : [];
        return list.length;
      }
      return defaultPeopleCount;
    };
    const normalizeUnit = (value) => String(value || '').trim().toLowerCase();
    const gramsFallbackByUnit = (unit) => {
      const u = normalizeUnit(unit);
      if (!u) return null;
      if (['g', 'gram', 'grams', 'ｇ', 'グラム'].includes(u)) return 1;
      if (['kg', 'kilogram', '㎏', 'キログラム'].includes(u)) return 1000;
      if (['mg', 'milligram', '㎎', 'ミリグラム'].includes(u)) return 0.001;
      return null;
    };
    const toGrams = (amount, unit, meta) => {
      if (typeof amount !== 'number' || Number.isNaN(amount)) return null;
      const u = normalizeUnit(unit);
      if (!u) return null;
      if (u === 'ml' || u === 'mL' || u === 'cc') return amount;
      const conversions = Array.isArray(meta?.unitConversions) ? meta.unitConversions : [];
      const hit = conversions.find((c) => String(c?.label || '').trim().toLowerCase() === u);
      if (hit && typeof hit.grams === 'number' && !Number.isNaN(hit.grams)) return amount * hit.grams;
      const per = gramsFallbackByUnit(u);
      return per ? amount * per : null;
    };

    const rows = [];
    const round1 = (val) => {
      const num = typeof val === 'number' ? val : NaN;
      if (!Number.isFinite(num)) return null;
      return Math.round(num * 10) / 10;
    };
    const format1 = (val) => {
      const num = round1(val);
      return num === null ? '' : num.toFixed(1);
    };
    const pushEntries = (dayIndex, mealType, slot) => {
      if (!slot || slot.dineOut) return;
      const menu = slot?.menuId ? menuLookup[slot.menuId] : null;
      if (!menu) return;
      const mealLabel = mealType === 'breakfast' ? '朝食' : (mealType === 'lunch' ? '昼食' : '夕食');
      const peopleCount = getPeopleCount(dayIndex, mealType);
      const peopleSafe = Math.max(1, peopleCount);
      const extra = Math.max(0, Number(slot?.prepExtra) || 0);
      const basePeople = Number(menu.people) > 0 ? Number(menu.people) : 1;
      const totalMultiplier = (peopleCount + extra) > 0 ? ((peopleCount + extra) / basePeople) : 1;
      const perPersonMultiplier = (peopleCount + extra) > 0 ? ((peopleCount + extra) / (basePeople * peopleSafe)) : (1 / peopleSafe);
      const date = weekDates[dayIndex];
      const dateLabel = `${date.getMonth() + 1}/${date.getDate()}`;
      (menu.ingredients || []).forEach((it) => {
        const amount = Number(it?.amount);
        if (!Number.isFinite(amount)) return;
        const scaledPerPerson = amount * perPersonMultiplier;
        const unit = it?.unit || '';
        const meta = it?.id ? ingredientMetaMap.get(String(it.id)) : null;
        const grams = toGrams(scaledPerPerson, unit, meta || it);
        const cls = it?.classification || meta?.classification || '';
        const qtyText = `${format1(scaledPerPerson)}${unit || ''}`;
        const gramText = grams === null ? '' : format1(grams);
        rows.push([dateLabel, '食材', mealLabel, cls, it?.name || '', qtyText, gramText ]);
      });
      (menu.seasoning || []).forEach((it) => {
        const amount = Number(it?.amount);
        if (!Number.isFinite(amount)) return;
        const scaledPerPerson = amount * perPersonMultiplier;
        const unit = it?.unit || '';
        const meta = it?.id ? seasoningMetaMap.get(String(it.id)) : null;
        const grams = toGrams(scaledPerPerson, unit, meta || it);
        const cls = it?.classification || meta?.classification || '';
        const qtyText = `${format1(scaledPerPerson)}${unit || ''}`;
        const gramText = grams === null ? '' : format1(grams);
        rows.push([dateLabel, '調味料', mealLabel, cls, it?.name || '', qtyText, gramText ]);
      });
    };

    plan.forEach((day, idx) => {
      (Array.isArray(day.breakfastSlots) ? day.breakfastSlots : []).forEach((slot) => pushEntries(idx, 'breakfast', slot));
      (Array.isArray(day.lunchSlots) ? day.lunchSlots : []).forEach((slot) => {
        const key = slot?.categoryKey === 'breakfastMain' ? 'breakfast' : 'lunch';
        pushEntries(idx, key, slot);
      });
      let dinnerSlots = Array.isArray(day.dinnerSlots) ? day.dinnerSlots : [];
      if (!dinnerSlots.length && day?.dinner) {
        const base = ['staple','main','side','soup'].map((k) => day.dinner[k]).filter(Boolean);
        const extras = Array.isArray(day.dinnerExtras) ? day.dinnerExtras.filter(Boolean) : [];
        dinnerSlots = [...base, ...extras];
      }
      dinnerSlots.forEach((slot) => pushEntries(idx, 'dinner', slot));
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('週の食材・調味料明細');
    const header = ['日付', '区分', '食事', '食材分類', '名称', '数量', 'g換算'];
    sheet.addRow(header);
    rows
      .sort((a, b) => {
        const d = String(a[0]).localeCompare(String(b[0]), 'ja');
        if (d !== 0) return d;
        const t = String(a[1]).localeCompare(String(b[1]), 'ja');
        if (t !== 0) return t;
        return String(a[4]).localeCompare(String(b[4]), 'ja');
      })
      .forEach((r) => sheet.addRow(r));
    sheet.autoFilter = { from: 'A1', to: 'G1' };
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E6F4EA' } };
      cell.alignment = { vertical: 'middle' };
    });
    sheet.columns = [
      { width: 8 },
      { width: 8 },
      { width: 8 },
      { width: 16 },
      { width: 24 },
      { width: 14 },
      { width: 10 }
    ];

    const filename = `week-ingredients-${weekStartDate.toISOString().slice(0,10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('week menu excel error:', err);
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

// Active group selection (session-scoped)
router.post('/users/active-group', isLoggedIn, async (req, res) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId : '';
    if (!groupId) {
      if (req.session) req.session.activeGroupId = '';
      return res.json({ ok: true });
    }
    const belongs = userGroups.some((g) => g._id.toString() === String(groupId));
    if (!belongs) return res.status(403).json({ error: 'グループにアクセスできません。' });
    if (req.session) req.session.activeGroupId = String(groupId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('active group save error:', err);
    return res.status(500).json({ error: 'アクティブグループの保存に失敗しました。' });
  }
});

// Shopping list state (shared within group)
router.get('/users/shopping-list/api/state', isLoggedIn, async (req, res) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const activeGroupId = res.locals.selectedGroupId ? String(res.locals.selectedGroupId) : '';
    const requestedGroupId = typeof req.query.group === 'string' ? req.query.group : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';
    let currentGroupId = requestedGroupId || activeGroupId || defaultGroupId || fallbackGroupId || '';
    if (currentGroupId && !userGroups.some((g) => g._id.toString() === currentGroupId)) {
      currentGroupId = fallbackGroupId || '';
    }
    if (!currentGroupId) return res.json({ state: {}, updatedAt: null });

    const weekStartParam = typeof req.query.weekStart === 'string' ? req.query.weekStart : '';
    const targetWeekStart = startOfWeek(weekStartParam || new Date());
    const doc = await ShoppingListState.findOne({ group: currentGroupId, weekStart: targetWeekStart }).lean();
    const rawState = doc?.state || {};
    const rawDates = doc?.dates || {};
    const state = rawState instanceof Map ? Object.fromEntries(rawState.entries()) : rawState;
    const dates = rawDates instanceof Map ? Object.fromEntries(rawDates.entries()) : rawDates;
    return res.json({ state: state || {}, dates: dates || {}, updatedAt: doc?.updatedAt || null });
  } catch (err) {
    console.error('shopping list state load error:', err);
    return res.status(500).json({ error: 'お買い物リストの取得に失敗しました。' });
  }
});

router.post('/users/shopping-list/api/state', isLoggedIn, async (req, res) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const activeGroupId = res.locals.selectedGroupId ? String(res.locals.selectedGroupId) : '';
    const requestedGroupId = typeof req.body?.groupId === 'string' ? req.body.groupId : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';
    let currentGroupId = requestedGroupId || activeGroupId || defaultGroupId || fallbackGroupId || '';
    if (currentGroupId && !userGroups.some((g) => g._id.toString() === currentGroupId)) {
      currentGroupId = fallbackGroupId || '';
    }
    if (!currentGroupId) return res.status(400).json({ error: 'グループが見つかりません。' });

    const weekStartParam = typeof req.body?.weekStart === 'string' ? req.body.weekStart : '';
    const targetWeekStart = startOfWeek(weekStartParam || new Date());
    const rawState = (req.body && typeof req.body.state === 'object') ? req.body.state : {};
    const entries = Object.entries(rawState || {});
    if (entries.length > 5000) {
      return res.status(413).json({ error: '状態が大きすぎます。' });
    }
    const sanitizedState = {};
    entries.forEach(([key, value]) => {
      if (typeof key !== 'string' || !key) return;
      if (key.length > 200) return;
      sanitizedState[key] = !!value;
    });

    const rawDates = (req.body && typeof req.body.dates === 'object') ? req.body.dates : {};
    const dateEntries = Object.entries(rawDates || {});
    if (dateEntries.length > 5000) {
      return res.status(413).json({ error: '状態が大きすぎます。' });
    }
    const sanitizedDates = {};
    dateEntries.forEach(([key, value]) => {
      if (typeof key !== 'string' || !key) return;
      if (key.length > 200) return;
      if (typeof value !== 'string' || value.length > 40) return;
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) return;
      sanitizedDates[key] = new Date(parsed).toISOString();
    });

    await ShoppingListState.findOneAndUpdate(
      { group: currentGroupId, weekStart: targetWeekStart },
      { $set: { state: sanitizedState, dates: sanitizedDates, updatedBy: req.user?._id || null } },
      { upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('shopping list state save error:', err);
    return res.status(500).json({ error: 'お買い物リストの保存に失敗しました。' });
  }
});

// Shopping list (next week by default): aggregate ingredients/seasonings and split by MyStock
router.get('/users/shopping-list', isLoggedIn, async (req, res, next) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const activeGroupId = res.locals.selectedGroupId ? String(res.locals.selectedGroupId) : '';
    const requestedGroupId = req.query.group ? String(req.query.group) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';
    let currentGroupId = requestedGroupId || activeGroupId || defaultGroupId || fallbackGroupId || '';
    if (currentGroupId && !userGroups.some((g)=> g._id.toString() === currentGroupId)) currentGroupId = fallbackGroupId || '';

    // Decide target week (next week by default)
    const weekStartParam = typeof req.query.weekStart === 'string' ? req.query.weekStart : '';
    let targetWeekStart = weekStartParam ? startOfWeek(weekStartParam) : getNextWeekStart();
    let baseWeekDates = getWeekDatesFromStart(targetWeekStart);

    // Build menus by category (for lookup/aggregation)
    const kindSet = new Set();
    Object.values(CATEGORY_CONFIG).forEach((config) => (config.kinds||[]).forEach((k)=> k && kindSet.add(k)));
    const menusByKind = {};
    await Promise.all(Array.from(kindSet).map(async (kind) => {
      const docs = await Menu.find({ kind, isPrivate: { $ne: true } })
        .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
        .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
        .populate({
          path: 'setMenus',
          select: 'name menu kind junle cook imageUrl url time people menuType setType ingredients seasoning',
          populate: [
            { path: 'ingredients.name', select: 'ingredient unit classification' },
            { path: 'seasoning.name', select: 'seasoning unit classification' }
          ]
        })
        .lean();
      menusByKind[kind] = docs.map(formatMenuDocument);
    }));
    const combineMenusByKinds = (kinds) => {
      const combined = new Map();
      (kinds||[]).forEach((kind)=>{
        (menusByKind[kind]||[]).forEach((menu)=>{ if(!combined.has(menu.id)) combined.set(menu.id, menu); });
      });
      return Array.from(combined.values());
    };
    const menusByCategory = Object.entries(CATEGORY_CONFIG).reduce((acc, [key, config])=>{ acc[key] = combineMenusByKinds(config.kinds); return acc; }, {});

    // Find existing plan for the target week if any
    let existingPlan = null;
    if (currentGroupId) {
      existingPlan = await WeeklyMenuPlan.findOne({ group: currentGroupId, weekStart: targetWeekStart }).lean();
    }
    let myMenuFrequency = {};
    let preferredSetMenuIds = new Set();
    if (currentGroupId) {
      try {
        const mymenus = await Mymenu.find({ user: req.user._id, group: currentGroupId }).select('menu frequency sourceType').lean();
        myMenuFrequency = buildMyMenuFrequencyMap(mymenus);
        preferredSetMenuIds = new Set(
          (mymenus || [])
            .filter((entry) => entry?.sourceType === 'original' && entry?.menu)
            .map((entry) => String(entry.menu))
        );
      } catch (e) {
        myMenuFrequency = {};
        preferredSetMenuIds = new Set();
      }
    }
    let weekMenuSettings = WEEK_MENU_SETTINGS_DEFAULTS;
    try {
      const userSettingsDoc = await User.findById(req.user._id).select('weekMenuSettings').lean();
      weekMenuSettings = normalizeWeekMenuSettings(userSettingsDoc?.weekMenuSettings || {});
    } catch (e) {
      weekMenuSettings = normalizeWeekMenuSettings({});
    }
    const currentSeasonLabel = monthToSeason(new Date().getMonth() + 1);
    let plan = [];
    let menuLookup = {};
    if (existingPlan) {
      const basePlan = baseWeekDates.map((date, index) => ({
        index,
        dateISO: date.toISOString(),
        breakfastSlots: [],
        lunchSlots: [],
        dinner: { staple: null, main: null, side: null, soup: null },
        dinnerExtras: []
      }));
      menuLookup = {};
      Object.values(menusByCategory).forEach((list)=> list.forEach((m)=> { menuLookup[m.id] = m; }));
      const ids = new Set();
      (existingPlan.dayPlans||[]).forEach((dp)=> (dp.slots||[]).forEach((s)=> s?.menu && ids.add(s.menu.toString())));
      if (ids.size) {
        const docs = await Menu.find({ _id: { $in: Array.from(ids) } })
          .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
          .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
          .populate({
            path: 'setMenus',
            select: 'name menu kind junle cook imageUrl url time people menuType setType ingredients seasoning',
            populate: [
              { path: 'ingredients.name', select: 'ingredient unit classification' },
              { path: 'seasoning.name', select: 'seasoning unit classification' }
            ]
          })
          .lean();
        docs.forEach((d)=>{ const f=formatMenuDocument(d); menuLookup[f.id]=f; });
      }
      (existingPlan.dayPlans||[]).forEach((dp)=>{
        const target = basePlan[dp.dayIndex]; if(!target) return;
        (dp.slots||[]).forEach((slot)=>{
          const map = SLOT_TYPE_DETAILS[slot?.slotType]; if(!map) return;
          const data = { menuId: slot.menu.toString(), categoryKey: map.categoryKey, dineOut: !!slot.dineOut, prepExtra: Number(slot?.prepExtra)||0 };
          if (map.meal === 'breakfast') {
            target.breakfastSlots.push(data);
          } else if (map.meal === 'lunch') {
            target.lunchSlots.push(data);
          }
          else if (map.key === 'extras') { target.dinnerExtras.push(data); }
          else if (!target.dinner[map.key]) { target.dinner[map.key] = data; } else { target.dinnerExtras.push(data); }
        });
      });
      plan = basePlan;
    } else {
      const generated = buildWeekPlanPayload(menusByCategory, {
        startDate: targetWeekStart,
        myMenuFrequency,
        currentSeason: currentSeasonLabel,
        weekMenuSettings,
        preferredSetMenuIds
      });
      plan = generated.plan; menuLookup = generated.menuLookup; baseWeekDates = generated.weekDates.map(w=> new Date(w.dateISO));
      targetWeekStart = startOfWeek(new Date(generated.weekStartISO));
    }

    // Aggregate
    const ingredients = aggregateSummary(plan, menuLookup, 'ingredients');
    const seasonings = aggregateSummary(plan, menuLookup, 'seasoning');

    // Load my stock names to split
    const stocks = await Stock.find({ group: currentGroupId, user: req.user._id }).lean();
    const ingIds = stocks.filter(s=> s.type==='ingredient').map(s=> s.item);
    const seaIds = stocks.filter(s=> s.type==='seasoning').map(s=> s.item);
    const [ings, seas] = await Promise.all([
      Ingredient.find({ _id: { $in: ingIds } }).select('ingredient').lean(),
      Seasoning.find({ _id: { $in: seaIds } }).select('seasoning').lean()
    ]);
    const ingNameSet = new Set(ings.map(x=> x.ingredient).filter(Boolean));
    const seaNameSet = new Set(seas.map(x=> x.seasoning).filter(Boolean));

    const topItems = [];
    const bottomStockItems = [];
    const toEntry = (x, type)=> ({
      type,
      name: x.name,
      unit: x.unit,
      amount: x.amount,
      missingAmount: x.missingAmount,
      classification: x.classification || ''
    });
    ingredients.forEach((x)=> (ingNameSet.has(x.name) ? bottomStockItems : topItems).push(toEntry(x, 'ingredient')));
    seasonings.forEach((x)=> (seaNameSet.has(x.name) ? bottomStockItems : topItems).push(toEntry(x, 'seasoning')));

    const weekRangeLabel = `${formatDisplayDate(baseWeekDates[0])}〜${formatDisplayDate(baseWeekDates[6])}`;
    const weekStartISO = targetWeekStart.toISOString();
    return res.render('users/shoppingList', {
      weekRangeLabel,
      weekStartISO,
      groupId: currentGroupId,
      topItems,
      bottomStockItems
    });
  } catch (err) { return next(err); }
});

// Menu recipe detail (for original or any menu without external URL)
router.get('/users/menu/:id', isLoggedIn, async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      req.flash('error', 'メニューが見つかりません');
      return res.redirect('/users/my-top');
    }
    const menu = await Menu.findById(id)
      .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
      .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
      .lean();
    if (!menu) {
      req.flash('error', 'メニューが見つかりません');
      return res.redirect('/users/my-top');
    }
    // Derive instruction/comment display
    let instructionText = String(menu.instructionText || '');
    let commentText = String(menu.comment || '');
    if (!instructionText && commentText) {
      const raw = commentText;
      const parts = raw.split(/\n{2,}/);
      if (parts.length > 1) {
        instructionText = (parts.shift() || '').trim();
        commentText = parts.join('\n\n').trim();
      } else {
        instructionText = raw;
        commentText = '';
      }
    }
    return res.render('users/menuRecipe', { menu, instructionText, commentText });
  } catch (err) {
    return next(err);
  }
});

router.post('/users/week-menu', isLoggedIn, async (req, res) => {
  try {
    const {
      groupId,
      weekStart,
      weekEnd,
      dayPlans,
      dayComments,
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

        const mealType = plan.mealType === 'dinner'
          ? 'dinner'
          : plan.mealType === 'breakfast'
            ? 'breakfast'
            : plan.mealType === 'lunch'
              ? 'lunch'
              : '';
        if (!mealType) {
          return null;
        }
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
              dineOutName: typeof slot.dineOutName === 'string' ? slot.dineOutName : '',
              dineOutUrl: typeof slot.dineOutUrl === 'string' ? slot.dineOutUrl : '',
              favorite: !!slot.favorite,
              locked: !!slot.locked,
              prepExtra: Number.isFinite(Number(slot.prepExtra)) && Number(slot.prepExtra) > 0
                ? Math.floor(Number(slot.prepExtra))
                : 0
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

    const parsedDayComments = Array.isArray(dayComments)
      ? dayComments
          .map((entry) => {
            if (!entry || typeof entry.dayIndex !== 'number' || entry.dayIndex < 0 || entry.dayIndex > 6) return null;
            const date = entry.dateISO ? new Date(entry.dateISO) : (entry.date ? new Date(entry.date) : null);
            if (date && Number.isNaN(date.getTime())) return null;
            if (date) date.setHours(0, 0, 0, 0);
            return {
              dayIndex: entry.dayIndex,
              date: date || undefined,
              comment: typeof entry.comment === 'string' ? entry.comment.trim() : ''
            };
          })
          .filter(Boolean)
      : [];

    const planId = req.body?.planId && mongoose.Types.ObjectId.isValid(req.body.planId)
      ? req.body.planId
      : '';

    const updatePayload = {
      weekStart: parsedWeekStart,
      weekEnd: parsedWeekEnd,
      title: title || '',
      description: description || '',
      dayPlans: parsedDayPlans,
      dayComments: parsedDayComments
    };

    const updateOptions = { new: true, runValidators: true, timestamps: true };
    let weeklyPlan = null;
    let statusCode = 200;

    // --- diff for notifications (menu added) ---
    const prevPlanDoc = planId
      ? await WeeklyMenuPlan.findOne({ _id: planId, group: groupId }).lean()
      : await WeeklyMenuPlan.findOne({ group: groupId, weekStart: parsedWeekStart }).lean();

    const slotKey = (dp, s) => `${dp.dayIndex}:${s.slotType}`;
    const toMap = (doc) => {
      const map = new Map();
      if (!doc) return map;
      (doc.dayPlans || []).forEach((dp) => {
        (dp.slots || []).forEach((s) => { map.set(`${dp.dayIndex}:${s.slotType}`, String(s.menu || '')); });
      });
      return map;
    };
    const prevMap = toMap(prevPlanDoc);
    const nextMap = (() => { const m=new Map(); parsedDayPlans.forEach((dp)=>{ (dp.slots||[]).forEach((s)=>{ m.set(slotKey(dp,s), String(s.menu)); }); }); return m; })();

    const addedItems = [];
    parsedDayPlans.forEach((dp) => {
      (dp.slots || []).forEach((s) => {
        const k = slotKey(dp, s);
        const after = nextMap.get(k) || '';
        // 新規追加のみ: 以前にそのスロット自体が存在していなかった場合に限定
        if (after && !prevMap.has(k)) {
          addedItems.push({ dayIndex: dp.dayIndex, mealType: dp.mealType, slotType: s.slotType, menuId: String(s.menu) });
        }
      });
    });

    if (planId) {
      weeklyPlan = await WeeklyMenuPlan.findOneAndUpdate(
        { _id: planId, group: groupId },
        { $set: updatePayload },
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
          { $set: updatePayload },
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

    // ---- notify group members about menu additions ----
    if (addedItems.length) {
      try {
        const group = await Group.findById(groupId)
          .populate({ path: 'createdBy', select: 'email displayname username isMail' })
          .populate({ path: 'members', select: 'email displayname username isMail' })
          .lean();
        const rawUsers = [];
        if (group?.createdBy) rawUsers.push(group.createdBy);
        if (Array.isArray(group?.members)) rawUsers.push(...group.members);
        const recipients = rawUsers
          .filter(u => u && String(u._id) !== String(req.user._id))
          .filter(u => !!u.email && (u.isMail === undefined || u.isMail === true))
          .map(u => ({ id: String(u._id), email: String(u.email).trim().toLowerCase() }))
          .filter((u, idx, arr) => idx === arr.findIndex(v => v.email === u.email));

        if (recipients.length) {
          // build items with labels
          const menuIds = Array.from(new Set(addedItems.map(a => a.menuId)));
          const menus = await Menu.find({ _id: { $in: menuIds } }).select('name imageUrl').lean();
          const menuInfoMap = new Map(menus.map(m => [String(m._id), { name: m.name || '', imageUrl: m.imageUrl || '' }]));
          const today = new Date();
          const today00 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
          const actorName = req.user.displayname || req.user.username || req.user.email;
      const mealLabel = (mt) => (mt === 'dinner' ? 'ディナー' : (mt === 'breakfast' ? '朝食' : 'ランチ'));

          // group all added items into immediate/batch
          const immediateItems = [];
          const scheduledByRecipient = new Map();

          addedItems.forEach((a) => {
            const targetDate = new Date(parsedWeekStart); targetDate.setDate(targetDate.getDate() + a.dayIndex); targetDate.setHours(0,0,0,0);
            const diffDays = Math.round((targetDate.getTime() - today00.getTime()) / (24*60*60*1000));
            const dateLabel = `${targetDate.getMonth()+1}月${targetDate.getDate()}日`;
            const info = menuInfoMap.get(a.menuId) || { name: '', imageUrl: '' };
            const entry = { dateLabel, mealLabel: mealLabel(a.mealType), menuName: info.name, imageUrl: info.imageUrl };
            if (diffDays <= 1) {
              immediateItems.push(entry);
            } else {
              recipients.forEach((r) => {
                const key = String(r.id);
                const arr = scheduledByRecipient.get(key) || [];
                arr.push({ date: targetDate, mealType: a.mealType, name: entry.menuName, imageUrl: entry.imageUrl });
                scheduledByRecipient.set(key, arr);
              });
            }
          });

          // immediate: one mail to all recipients with aggregated items
          if (immediateItems.length && await shouldSendTemplate('planMenuAdded')) {
            const subject = '7 DAYS PLAN 【これ食べたい！】';
            const html = await renderTemplate('planMenuAdded', { actorName, items: immediateItems });
            const to = recipients.map(r => r.email);
            if (to.length) await sendMail({ to, subject, html });
          }

          // scheduled: queue per recipient for next day 08:00
          if (scheduledByRecipient.size) {
            const schedAt = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 8, 0, 0);
            for (const [rid, items] of scheduledByRecipient.entries()) {
              await Notification.findOneAndUpdate(
                { group: groupId, recipient: rid, actor: req.user._id, type: 'planMenuAdded', scheduledAt: schedAt },
                { $setOnInsert: { group: groupId, recipient: rid, actor: req.user._id, type: 'planMenuAdded', scheduledAt: schedAt }, $push: { items: { $each: items } } },
                { upsert: true }
              );
            }
          }
        }
      } catch (e) {
        console.error('plan menu added notify error:', e);
      }
    }

    return res.status(statusCode).json({ success: true, planId: weeklyPlan._id });
  } catch (err) {
    console.error('週次メニュー保存エラー:', err);
    return res.status(500).json({ error: '週次メニューを保存できませんでした。' });
  }
});

// 週次メニューを再提案（指定週を一括再生成）
router.post('/users/week-menu/regenerate', isLoggedIn, async (req, res) => {
  try {
    const { groupId, weekStart } = req.body || {};
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ error: 'グループIDが不正です。' });
    }
    if (!weekStart) {
      return res.status(400).json({ error: '週の開始日が指定されていません。' });
    }

    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    if (!userGroups.some((g) => g._id.toString() === String(groupId))) {
      return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    }

    const baseWeekStart = startOfWeek(new Date(weekStart));
    if (Number.isNaN(baseWeekStart.getTime())) {
      return res.status(400).json({ error: '週の開始日が不正です。' });
    }
    const weekEnd = addDays(baseWeekStart, 6);

    // Build menus by category (public only)
    const kindSet = new Set();
    Object.values(CATEGORY_CONFIG).forEach((config) => (config.kinds || []).forEach((k) => k && kindSet.add(k)));
    const menusByKind = {};
    await Promise.all(
      Array.from(kindSet).map(async (kind) => {
        const docs = await Menu.find({ kind, isPrivate: { $ne: true } })
          .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
          .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
          .populate({
            path: 'setMenus',
            select: 'name menu kind junle cook imageUrl url time people menuType setType ingredients seasoning',
            populate: [
              { path: 'ingredients.name', select: 'ingredient unit classification' },
              { path: 'seasoning.name', select: 'seasoning unit classification' }
            ]
          })
          .lean();
        menusByKind[kind] = docs.map(formatMenuDocument);
      })
    );
    const combineMenusByKinds = (kinds) => {
      const combined = new Map();
      (kinds || []).forEach((kind) => {
        (menusByKind[kind] || []).forEach((menu) => {
          if (!combined.has(menu.id)) combined.set(menu.id, menu);
        });
      });
      return Array.from(combined.values());
    };
    const menusByCategory = Object.entries(CATEGORY_CONFIG).reduce((acc, [key, config]) => {
      acc[key] = combineMenusByKinds(config.kinds);
      return acc;
    }, {});

    // MyMenu frequency for prioritization
    let myMenuFrequency = {};
    let preferredSetMenuIds = new Set();
    try {
      const mymenus = await Mymenu.find({ user: req.user._id, group: groupId }).select('menu frequency sourceType').lean();
      myMenuFrequency = buildMyMenuFrequencyMap(mymenus);
      preferredSetMenuIds = new Set(
        (mymenus || [])
          .filter((entry) => entry?.sourceType === 'original' && entry?.menu)
          .map((entry) => String(entry.menu))
      );
    } catch (e) {
      myMenuFrequency = {};
      preferredSetMenuIds = new Set();
    }

    const currentSeasonLabel = monthToSeason(baseWeekStart.getMonth() + 1);
    let weekMenuSettings = WEEK_MENU_SETTINGS_DEFAULTS;
    try {
      const userSettingsDoc = await User.findById(req.user._id).select('weekMenuSettings').lean();
      weekMenuSettings = normalizeWeekMenuSettings(userSettingsDoc?.weekMenuSettings || {});
    } catch (e) {
      weekMenuSettings = normalizeWeekMenuSettings({});
    }
    const generated = buildWeekPlanPayload(menusByCategory, {
      startDate: baseWeekStart,
      myMenuFrequency,
      currentSeason: currentSeasonLabel,
      weekMenuSettings,
      preferredSetMenuIds
    });

    const slotToDoc = (slot) => {
      const slotType = CATEGORY_TO_SLOT_TYPE[slot?.categoryKey] || slot?.slotType;
      if (!slotType || !mongoose.Types.ObjectId.isValid(slot?.menuId)) return null;
      return {
        slotType,
        menu: slot.menuId,
        dineOut: !!slot.dineOut,
        dineOutName: '',
        dineOutUrl: '',
        favorite: !!slot.favorite,
        locked: !!slot.locked,
        prepExtra: Number.isFinite(Number(slot?.prepExtra)) && Number(slot.prepExtra) > 0
          ? Math.floor(Number(slot.prepExtra))
          : 0
      };
    };

    const dayPlans = (generated.plan || []).flatMap((day, dayIndex) => {
      const date = new Date(baseWeekStart);
      date.setDate(date.getDate() + dayIndex);
      date.setHours(0, 0, 0, 0);
      const entries = [];
      const breakfastSlots = (day.breakfastSlots || []).map(slotToDoc).filter(Boolean);
      if (breakfastSlots.length) {
        entries.push({ dayIndex, date, mealType: 'breakfast', slots: breakfastSlots });
      }
      const lunchSlots = (day.lunchSlots || []).map(slotToDoc).filter(Boolean);
      if (lunchSlots.length) {
        entries.push({ dayIndex, date, mealType: 'lunch', slots: lunchSlots });
      }
      const dinnerSlots = [
        slotToDoc(day?.dinner?.staple),
        slotToDoc(day?.dinner?.main),
        slotToDoc(day?.dinner?.side),
        slotToDoc(day?.dinner?.soup),
        ...(Array.isArray(day?.dinnerExtras) ? day.dinnerExtras.map(slotToDoc) : [])
      ].filter(Boolean);
      if (dinnerSlots.length) {
        entries.push({ dayIndex, date, mealType: 'dinner', slots: dinnerSlots });
      }
      return entries;
    });

    if (!dayPlans.length) {
      return res.status(400).json({ error: '再提案できるメニューが見つかりませんでした。' });
    }

    const updatePayload = {
      weekStart: baseWeekStart,
      weekEnd,
      title: '',
      description: '',
      dayPlans
    };

    const updated = await WeeklyMenuPlan.findOneAndUpdate(
      { group: groupId, weekStart: baseWeekStart },
      { $set: updatePayload },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, planId: updated?._id });
  } catch (err) {
    console.error('週次メニュー再提案エラー:', err);
    return res.status(500).json({ error: '週次メニューを再提案できませんでした。' });
  }
});

// 個別スロットの再提案（朝/昼/夜のルールを踏襲）
router.post('/users/week-menu/shuffle-slot', isLoggedIn, async (req, res) => {
  try {
    const { groupId, weekStart, dayIndex, mealType, categoryKey, currentMenuId } = req.body || {};
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ error: 'グループIDが不正です。' });
    }
    const di = Number(dayIndex);
    if (!Number.isInteger(di) || di < 0 || di > 6) {
      return res.status(400).json({ error: 'dayIndex が不正です。' });
    }
    const meal = (typeof mealType === 'string' && mealType) ? mealType : '';
    if (!['breakfast', 'lunch', 'dinner'].includes(meal)) {
      return res.status(400).json({ error: 'mealType が不正です。' });
    }

    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    if (!userGroups.some((g) => g._id.toString() === String(groupId))) {
      return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    }

    const baseWeekStart = startOfWeek(weekStart || new Date());
    if (Number.isNaN(baseWeekStart.getTime())) {
      return res.status(400).json({ error: '週の開始日が不正です。' });
    }

    // Build menus by category (public only)
    const kindSet = new Set();
    Object.values(CATEGORY_CONFIG).forEach((config) => (config.kinds || []).forEach((k) => k && kindSet.add(k)));
    const menusByKind = {};
    await Promise.all(
      Array.from(kindSet).map(async (kind) => {
        const docs = await Menu.find({ kind, isPrivate: { $ne: true } })
          .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
          .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
          .populate({
            path: 'setMenus',
            select: 'name menu kind junle cook imageUrl url time people menuType setType ingredients seasoning',
            populate: [
              { path: 'ingredients.name', select: 'ingredient unit classification' },
              { path: 'seasoning.name', select: 'seasoning unit classification' }
            ]
          })
          .lean();
        menusByKind[kind] = docs.map(formatMenuDocument);
      })
    );
    const combineMenusByKinds = (kinds) => {
      const combined = new Map();
      (kinds || []).forEach((k) => {
        (menusByKind[k] || []).forEach((m) => { if (!combined.has(m.id)) combined.set(m.id, m); });
      });
      return Array.from(combined.values());
    };
    const menusByCategory = Object.entries(CATEGORY_CONFIG).reduce((acc, [key, config]) => {
      acc[key] = combineMenusByKinds(config.kinds);
      return acc;
    }, {});

    // MyMenu frequency for prioritization
    let myMenuFrequency = {};
    let preferredSetMenuIds = new Set();
    try {
      const mymenus = await Mymenu.find({ user: req.user._id, group: groupId }).select('menu frequency sourceType').lean();
      myMenuFrequency = buildMyMenuFrequencyMap(mymenus);
      preferredSetMenuIds = new Set(
        (mymenus || [])
          .filter((entry) => entry?.sourceType === 'original' && entry?.menu)
          .map((entry) => String(entry.menu))
      );
    } catch (_) {
      myMenuFrequency = {};
      preferredSetMenuIds = new Set();
    }

    const currentSeasonLabel = monthToSeason(baseWeekStart.getMonth() + 1);
    let weekMenuSettings = WEEK_MENU_SETTINGS_DEFAULTS;
    try {
      const userSettingsDoc = await User.findById(req.user._id).select('weekMenuSettings').lean();
      weekMenuSettings = normalizeWeekMenuSettings(userSettingsDoc?.weekMenuSettings || {});
    } catch (e) {
      weekMenuSettings = normalizeWeekMenuSettings({});
    }
    const generated = buildWeekPlanPayload(menusByCategory, {
      startDate: baseWeekStart,
      myMenuFrequency,
      currentSeason: currentSeasonLabel,
      weekMenuSettings,
      preferredSetMenuIds
    });

    const menuLookup = generated.menuLookup || {};
    const plan = generated.plan || [];
    const dayPlan = plan[di];
    if (!dayPlan) return res.status(404).json({ error: '対象日のプランが見つかりません。' });

    const pickSlotFromDay = () => {
      if (meal === 'breakfast') {
        const currentMenu =
          (menusByCategory.breakfastMain || []).find((m) => m.id === currentMenuId) || null;
        const nextMenu = pickBreakfastCandidate({
          menus: menusByCategory.breakfastMain || [],
          myMenuFrequency,
          currentSeason: currentSeasonLabel,
          breakfastMenuFilter: weekMenuSettings?.breakfastMenus || [],
          breakfastFilterEnabled: weekMenuSettings?.breakfastFilterEnabled !== false,
          preferredSetMenuIds,
          excludeMenuId: currentMenuId || ''
        });
        if (!nextMenu) {
          // 候補が無ければ元のメニューを維持
          return currentMenu
            ? {
                menuId: currentMenu.id,
                categoryKey: 'breakfastMain',
                favorite: false,
                dineOut: false,
                menu: currentMenu
              }
            : null;
        }
        return {
          menuId: nextMenu.id,
          categoryKey: 'breakfastMain',
          favorite: false,
          dineOut: false,
          menu: nextMenu
        };
      }
      if (meal === 'lunch') {
        const slot = (dayPlan.lunchSlots || []).find(Boolean);
        return slot ? { ...slot, menu: menuLookup[slot.menuId] || null } : null;
      }
      // dinner
      const candidates = [
        dayPlan.dinner?.staple,
        dayPlan.dinner?.main,
        dayPlan.dinner?.side,
        dayPlan.dinner?.soup,
        ...(Array.isArray(dayPlan.dinnerExtras) ? dayPlan.dinnerExtras : [])
      ].filter(Boolean);
      let slot = null;
      if (categoryKey) {
        slot = candidates.find((s) => s.categoryKey === categoryKey) || null;
      }
      if (!slot) slot = candidates[0] || null;
      return slot ? { ...slot, menu: menuLookup[slot.menuId] || null } : null;
    };

    const slot = pickSlotFromDay();
    if (!slot) return res.status(404).json({ error: '再提案できるメニューが見つかりませんでした。' });

    return res.json({ success: true, slot });
  } catch (err) {
    console.error('shuffle-slot error:', err);
    return res.status(500).json({ error: '再提案に失敗しました。' });
  }
});

// 参加メンバーの切り替えAPI（自分のみ追加/削除）
router.post('/users/week-menu/participants', isLoggedIn, async (req, res) => {
  try {
    const { planId, dayIndex, mealType, participate, reason } = req.body || {};
    if (!planId || !mongoose.Types.ObjectId.isValid(planId)) {
      return res.status(400).json({ error: 'planId が不正です。' });
    }
    const di = Number(dayIndex);
    if (!Number.isInteger(di) || di < 0 || di > 6) {
      return res.status(400).json({ error: 'dayIndex が不正です。' });
    }
    const meal = mealType === 'dinner'
      ? 'dinner'
      : mealType === 'breakfast'
        ? 'breakfast'
        : mealType === 'lunch'
          ? 'lunch'
          : '';
    if (!meal) {
      return res.status(400).json({ error: 'mealType が不正です。' });
    }
    const userId = req.user._id;

    const planDoc = await WeeklyMenuPlan.findById(planId).populate('group').exec();
    if (!planDoc) return res.status(404).json({ error: '対象の週次メニューが見つかりません。' });

    const groupId = planDoc.group?._id || planDoc.group;
    if (!groupId) return res.status(404).json({ error: '対象のグループが見つかりません。' });
    if (!planDoc.createdBy) {
      planDoc.createdBy = planDoc.group?.createdBy || req.user?._id || undefined;
    }

    // 権限: 対象グループのメンバー（または作成者）であること
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const belongs = groups.some((g) => String(g._id) === String(groupId));
    if (!belongs) return res.status(403).json({ error: '権限がありません。' });

    // 該当エントリを取得/作成
    const keyMatch = (p) => p && p.dayIndex === di && p.mealType === meal;
    let entry = (planDoc.participants || []).find(keyMatch);
    let wasNew = false;
    if (!entry) {
      entry = { dayIndex: di, mealType: meal, users: [] };
      planDoc.participants.push(entry);
      wasNew = true;
    }

    const wantParticipate = !!participate;
    // 新規作成、または既存だが未初期化（空配列）の場合は「全員参加」で初期化
    if (wasNew || !Array.isArray(entry.users) || entry.users.length === 0) {
      const g = planDoc.group;
      const allIds = [];
      if (g && g.createdBy) allIds.push(g.createdBy);
      if (g && Array.isArray(g.members)) allIds.push(...g.members);
      // ユニーク化
      const uniq = Array.from(new Set(allIds.map((x) => String(x))));
      entry.users = uniq;
    }
    const idx = entry.users.findIndex((u) => String(u) === String(userId));
    if (wantParticipate) {
      if (idx === -1) entry.users.push(userId);
    } else {
      if (idx !== -1) entry.users.splice(idx, 1);
    }

    // 参加しない理由（任意）を保存
    if (!wantParticipate && typeof reason === 'string' && reason.trim()) {
      planDoc.participantReasons = Array.isArray(planDoc.participantReasons) ? planDoc.participantReasons : [];
      planDoc.participantReasons.push({
        dayIndex: di,
        mealType: meal,
        user: userId,
        reason: reason.trim(),
        createdAt: new Date()
      });
    }

    await planDoc.save();

    // ---- メール通知ロジック ----
    try {
      const targetGroupId = planDoc.group?._id || planDoc.group || groupId;
      if (!targetGroupId) throw new Error('group missing');
      // 送信対象はグループ作成者 + メンバーをフル取得してから抽出（メール可の全員、自分除外）
      const groupFull = await Group.findById(targetGroupId)
        .populate({ path: 'createdBy', select: 'email displayname username isMail' })
        .populate({ path: 'members', select: 'email displayname username isMail' })
        .lean();
      const rawUsers = [];
      if (groupFull?.createdBy) rawUsers.push(groupFull.createdBy);
      if (Array.isArray(groupFull?.members)) rawUsers.push(...groupFull.members);
      // 逆引き（User 側の groups にこの groupId を持つユーザーも対象）
      const userSideMembers = await User.find({ groups: targetGroupId })
        .select('email displayname username isMail')
        .lean();
      rawUsers.push(...(userSideMembers || []));
      const toList = rawUsers
        .filter(u => u && String(u._id) !== String(userId))
        .filter(u => !!u.email && (u.isMail === undefined || u.isMail === true))
        .map(u => ({ id: String(u._id), email: String(u.email).trim().toLowerCase() }))
        .filter((u, idx, arr) => idx === arr.findIndex(v => v.email === u.email));
      const baseDate = new Date(planDoc.weekStart); baseDate.setHours(0,0,0,0);
      const targetDate = new Date(baseDate); targetDate.setDate(baseDate.getDate() + di); targetDate.setHours(0,0,0,0);
      const today = new Date(); const today00 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diffDays = Math.round((targetDate.getTime() - today00.getTime()) / (24*60*60*1000));
      const actorName = req.user.displayname || req.user.username || req.user.email;
      const dateLabel = `${targetDate.getMonth() + 1}月${targetDate.getDate()}日`;
      const mealLabel = meal === 'dinner' ? 'ディナー' : meal === 'breakfast' ? '朝食' : 'ランチ';

      const scheduleFor = (immediate) => {
        if (immediate) return new Date();
        return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 8, 0, 0);
      };

      if (toList.length) {
        if (!wantParticipate) {
          const immediate = diffDays <= 1;
          if (immediate) {
            if (await shouldSendTemplate('notEating')) {
              const html = await renderTemplate('notEating', { actorName, items: [{ dateLabel, mealLabel, reason: (typeof reason === 'string' ? reason.trim() : '') }] });
              const subject = `${actorName}からの連絡`;
              const to = toList.map((r) => r.email);
              if (to.length) await sendMail({ to, subject, html });
            }
          } else {
            const scheduledAt = scheduleFor(false);
            for (const r of toList) {
              await Notification.findOneAndUpdate(
                { group: targetGroupId, recipient: r.id, actor: req.user._id, type: 'notEating', scheduledAt },
                { $setOnInsert: { group: targetGroupId, recipient: r.id, actor: req.user._id, type: 'notEating', scheduledAt }, $push: { items: { date: targetDate, mealType: meal, reason: (typeof reason === 'string' ? reason.trim() : '') } } },
                { upsert: true }
              );
            }
          }
        } else {
          if (await shouldSendTemplate('eatingAgain')) {
            const html = await renderTemplate('eatingAgain', { actorName, items: [{ dateLabel, mealLabel }] });
            const subject = `${actorName}からの連絡`;
            const to = toList.map((r) => r.email);
            if (to.length) await sendMail({ to, subject, html });
          }
        }
      }
    } catch (mailErr) { console.error('notify mail error:', mailErr); }

    const users = entry.users.map((u) => String(u));
    return res.json({ success: true, key: `${di}:${meal}`, users });
  } catch (err) {
    console.error('参加者更新エラー:', err);
    return res.status(500).json({ error: '参加者を更新できませんでした。' });
  }
});

// 管理者専用: 参加者を全員に戻す
router.post('/users/week-menu/participants/reset', isLoggedIn, async (req, res) => {
  try {
    const { planId, dayIndex, mealType } = req.body || {};
    if (!planId || !mongoose.Types.ObjectId.isValid(planId)) {
      return res.status(400).json({ error: 'planId が不正です。' });
    }
    const di = Number(dayIndex);
    if (!Number.isInteger(di) || di < 0 || di > 6) {
      return res.status(400).json({ error: 'dayIndex が不正です。' });
    }
    const meal = mealType === 'dinner'
      ? 'dinner'
      : mealType === 'breakfast'
        ? 'breakfast'
        : mealType === 'lunch'
          ? 'lunch'
          : '';
    if (!meal) {
      return res.status(400).json({ error: 'mealType が不正です。' });
    }

    const planDoc = await WeeklyMenuPlan.findById(planId).populate('group').exec();
    if (!planDoc) return res.status(404).json({ error: '対象の週次メニューが見つかりません。' });

    // グループ管理者のみ許可
    const group = planDoc.group;
    if (!planDoc.createdBy) {
      planDoc.createdBy = group?.createdBy || req.user?._id || undefined;
    }
    const isOwner = group && String(group.createdBy) === String(req.user._id);
    if (!isOwner) return res.status(403).json({ error: '管理者のみ実行可能です。' });

    const keyMatch = (p) => p && p.dayIndex === di && p.mealType === meal;
    let entry = (planDoc.participants || []).find(keyMatch);
    if (!entry) {
      entry = { dayIndex: di, mealType: meal, users: [] };
      planDoc.participants.push(entry);
    }

    const allIds = [];
    if (group && group.createdBy) allIds.push(group.createdBy);
    if (group && Array.isArray(group.members)) allIds.push(...group.members);
    entry.users = Array.from(new Set(allIds.map((x) => String(x))));

    await planDoc.save();
    return res.json({ success: true, key: `${di}:${meal}`, users: entry.users });
  } catch (err) {
    console.error('参加者全員復元エラー:', err);
    return res.status(500).json({ error: '参加者を復元できませんでした。' });
  }
});

// マイページトップ
router.get('/users/my-top', isLoggedIn, async (req, res, next) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';

    const currentGroupId = defaultGroupId || fallbackGroupId || '';

    // Next week (来週)
    const baseWeekDates = getNextWeekDates();
    const weekStartDate = baseWeekDates[0];
    const weekEndDate = baseWeekDates[6];
    const nextWeekRangeLabel = `${formatDisplayDate(weekStartDate)}〜${formatDisplayDate(weekEndDate)}`;

    // Week after next (再来週)
  const afterNextWeekStart = addDays(startOfWeek(new Date()), 14);
  const afterNextWeekDates = getWeekDatesFromStart(afterNextWeekStart);
  const afterNextWeekStartISO = afterNextWeekStart.toISOString();
  const afterNextWeekRangeLabel = `${formatDisplayDate(afterNextWeekDates[0])}〜${formatDisplayDate(afterNextWeekDates[6])}`;

  const now = new Date();
  const nowJst = toJstDate(now);
  const today = startOfDay(nowJst);
  const initialCalendarMonthISO = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
  const groupConfig = currentGroupId
    ? await Group.findById(currentGroupId).select('group_name stockInventory equipmentInventory members createdBy').lean()
    : null;
  const groupMembersDoc = currentGroupId
    ? await Group.findById(currentGroupId).select('createdBy members').populate('createdBy members', 'displayname username email').lean()
    : null;
  const memberLabelMap = (()=> {
    if (!groupMembersDoc) return new Map();
    const map = new Map();
    const pushUser = (u) => {
      if (!u) return;
      const id = u._id?.toString?.() || (typeof u === 'string' ? u : '');
      if (!id || map.has(id)) return;
      map.set(id, userLabel(u));
    };
    pushUser(groupMembersDoc.createdBy);
    (groupMembersDoc.members || []).forEach(pushUser);
    return map;
  })();
  const groupMembers = (()=> {
    if (!groupConfig) return [];
    const ids = new Set();
    if (groupConfig.createdBy) ids.add(groupConfig.createdBy.toString());
    (groupConfig.members || []).forEach((m)=> { if (m) ids.add(m.toString()); });
    return Array.from(ids).filter(Boolean);
  })();

  const ensureInventoryTask = async ({ groupId, title, startAt, dueAt, source }) => {
    if (!groupId || !title) return;
    const existing = await Task.findOne({ group: groupId, source, title }).lean();
    if (existing) return;
    await Task.create({
      group: groupId,
      title,
      category: '棚卸し',
      createdBy: req.user._id,
      assignees: groupMembers,
      startAt,
      dueAt,
      status: 'not_started',
      source,
      note: '棚卸しに基づくタスク'
    });
  };

  const buildStockNotice = async () => {
    if (!currentGroupId) return null;
    const cfg = groupConfig?.stockInventory || {};
    const enabled = cfg.enabled !== false;
    if (!enabled) return null;
    const sendHour = typeof cfg.sendHour === 'number' ? cfg.sendHour : 8;
    const y = today.getFullYear();
    const m = today.getMonth();
    let scheduledDay = null;
    if ((cfg.mode || 'monthlyDay') === 'monthlyDay') {
      const d = Math.max(1, Math.min(31, Number(cfg.day) || 28));
      const last = new Date(y, m + 1, 0).getDate();
      scheduledDay = Math.min(d, last);
    } else {
      const nth = Math.max(1, Math.min(5, Number(cfg.nth) || 4));
      const weekday = Math.max(0, Math.min(6, Number(cfg.weekday) || 0));
      const first = new Date(y, m, 1);
      const firstWeekday = first.getDay();
      const day1 = 1 + ((7 + weekday - firstWeekday) % 7);
      const candidate = day1 + (nth - 1) * 7;
      const last = new Date(y, m + 1, 0).getDate();
      scheduledDay = Math.min(candidate, last);
    }
    const scheduledAtJst = new Date(Date.UTC(y, m, scheduledDay, sendHour));
    const scheduledAt = new Date(scheduledAtJst.getTime() - (9 * 60 * 60 * 1000)); // convert JST to UTC Date
    if (now < scheduledAt) return null;
    await ensureInventoryTask({
      groupId: currentGroupId,
      title: `${scheduledAt.getFullYear()}年${scheduledAt.getMonth()+1}月のストックの棚卸し`,
      startAt: scheduledAt,
      dueAt: new Date(scheduledAt.getFullYear(), scheduledAt.getMonth(), scheduledAt.getDate() + ((cfg.windowDays || 7) - 1)),
      source: 'stock'
    });
    return {
      title: 'ストック棚卸し',
      message: '今月の棚卸しリストを確認してください。',
      actionHref: '/users/my-stock/checklist',
      scheduledAt,
      dateLabel: `実施日: ${formatDisplayDate(scheduledAt)}`
    };
  };

  const buildEquipmentNotice = async () => {
    if (!currentGroupId) return null;
    const cfg = groupConfig?.equipmentInventory || {};
    const enabled = cfg.enabled !== false;
    if (!enabled) return null;
    const cadence = cfg.cadence || 'monthly';
    const cycleStartJst = toJstDate(getEquipmentCycleStart(cadence));
    cycleStartJst.setHours(0, 0, 0, 0);
    const cycleStart = new Date(cycleStartJst.getTime() - (9 * 60 * 60 * 1000));
    if (now < cycleStart) return null;
    const cycleLabel = (() => {
      if (cadence === 'quarter') return '今四半期';
      if (cadence === 'half') return today.getMonth() < 6 ? '上期' : '下期';
      return '今月';
    })();
    const titleMonthLabel = `${cycleStart.getFullYear()}年${cycleStart.getMonth()+1}月`;
    await ensureInventoryTask({
      groupId: currentGroupId,
      title: `${titleMonthLabel}の備品の棚卸し`,
      startAt: cycleStart,
      dueAt: new Date(cycleStart.getFullYear(), cycleStart.getMonth(), cycleStart.getDate() + 6),
      source: 'equipment'
    });
    return {
      title: '備品棚卸し',
      message: `${cycleLabel}の棚卸しを開始してください。`,
      actionHref: '/users/my-equipment/inventory',
      scheduledAt: cycleStart,
      dateLabel: `開始日: ${formatDisplayDate(cycleStart)}`
    };
  };

  const [stockInventoryNotice, equipmentInventoryNotice] = await Promise.all([
    buildStockNotice(),
    buildEquipmentNotice()
  ]);

  let nextWeekPlan = null;
  let afterNextWeekPlan = null;
  if (currentGroupId) {
    const normalizedWeekStart = new Date(weekStartDate);
    normalizedWeekStart.setHours(0, 0, 0, 0);
    nextWeekPlan = await WeeklyMenuPlan.findOne({
      group: currentGroupId,
      weekStart: normalizedWeekStart
    }).select('_id weekStart weekEnd title').lean();

    const normalizedAfterNextStart = new Date(afterNextWeekStart);
    normalizedAfterNextStart.setHours(0, 0, 0, 0);
    afterNextWeekPlan = await WeeklyMenuPlan.findOne({
      group: currentGroupId,
      weekStart: normalizedAfterNextStart
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
      .populate({ path: 'ingredients.name', select: 'ingredient unit classification' })
      .populate({ path: 'seasoning.name', select: 'seasoning unit classification' })
      .populate({
        path: 'setMenus',
        select: 'name menu kind junle cook imageUrl url time people menuType setType ingredients seasoning',
        populate: [
          { path: 'ingredients.name', select: 'ingredient unit classification' },
          { path: 'seasoning.name', select: 'seasoning unit classification' }
        ]
      })
      .lean();

    currentWeekMenuLookup = menuDocs.reduce((acc, doc) => {
      const formatted = formatMenuDocument(doc);
      acc[formatted.id] = formatted;
      return acc;
    }, {});
  }

  // --- Build header image candidates (name + imageUrl) from Menu, excluding this week's images ---
  const usedImageSet = new Set(
    Object.values(currentWeekMenuLookup || {})
      .flatMap((m) => {
        const urls = [];
        if (m && m.imageUrl) urls.push(String(m.imageUrl));
        if (m && m.menuType === 'set' && Array.isArray(m.setMenus)) {
          m.setMenus.forEach((sm) => {
            if (sm && sm.imageUrl) urls.push(String(sm.imageUrl));
          });
        }
        return urls;
      })
      .filter(Boolean)
  );

  const candidateImageDocs = await Menu.find({
    imageUrl: { $exists: true, $ne: '' },
    $and: [
      {
        $or: [
          { kind: '主菜' },
          { kind: { $regex: '主菜' } },
          { kind: { $regex: '主食' } }
        ]
      },
      { $or: [{ material: { $exists: false } }, { material: { $ne: true } }] }
    ]
  })
    .select('imageUrl name junle kind')
    .lean();

  // unique by imageUrl
  const uniqueByUrl = new Map();
  (candidateImageDocs || []).forEach((d) => {
    const url = d && d.imageUrl ? String(d.imageUrl) : '';
    if (!url) return;
    if (!uniqueByUrl.has(url)) {
      uniqueByUrl.set(url, {
        imageUrl: url,
        name: d.name || '',
        junle: d.junle || '',
        kind: d.kind || ''
      });
    }
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

  const initializeWeekOverview = () =>
    currentWeekDates.map((date, index) => ({
      index,
      dateISO: date.toISOString(),
      display: formatDisplayDate(date),
      weekday: WEEKDAY_JA[index],
      isToday: startOfDay(date).getTime() === today.getTime(),
      breakfastSlots: [],
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
          dineOutName: typeof slotSource.dineOutName === 'string' ? slotSource.dineOutName : '',
          dineOutUrl: typeof slotSource.dineOutUrl === 'string' ? slotSource.dineOutUrl : '',
          favorite: !!slotSource.favorite,
          locked: !!slotSource.locked,
          menu: menuId && currentWeekMenuLookup[menuId] ? currentWeekMenuLookup[menuId] : null
        };

    if (map.meal === 'breakfast') {
      dayEntry.breakfastSlots = dayEntry.breakfastSlots || [];
      dayEntry.breakfastSlots.push(slotPayload);
    } else if (map.meal === 'lunch') {
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
    const resolveAggregationMenus = (menu) => {
      if (!menu) return [];
      const list = [];
      if (Array.isArray(menu.ingredients) && menu.ingredients.length) list.push(menu);
      if (Array.isArray(menu.seasoning) && menu.seasoning.length && !list.includes(menu)) list.push(menu);
      if (menu.menuType === 'set' && Array.isArray(menu.setMenus)) {
        menu.setMenus.forEach((m) => { if (m) list.push(m); });
      }
      if (!list.length) list.push(menu);
      return list;
    };
    menus.forEach((menu) => {
      resolveAggregationMenus(menu).forEach((targetMenu) => {
        if (!targetMenu) return;
        (targetMenu[field] || []).forEach((item) => {
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

    const breakfastSlots = Array.isArray(day.breakfastSlots) ? day.breakfastSlots.filter(Boolean) : [];
    if (breakfastSlots.length) {
      meals.push({
        mealKey: 'breakfast',
        label: '朝食',
        slots: breakfastSlots.map((slot) => ({
          categoryKey: slot.categoryKey,
          categoryLabel: categoryLabels[slot.categoryKey] || '',
          menuId: slot.menuId,
          menu: slot.menu
        }))
      });
    }

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
      .populate({
        path: 'menu',
        select: 'name imageUrl kind junle cook menuType setMenus',
        populate: { path: 'setMenus', select: 'imageUrl' }
      })
      .populate('user', 'displayname username')
      .sort({ update_date: -1, entry_date: -1 })
      .limit(10)
      .lean();
  }

  // MyTop 用：自分のマイメニュー 4件、グループメンバーのマイメニュー 2件
  const myOwnMyMenus = await Mymenu.find({ user: req.user._id })
    .populate({
      path: 'menu',
      select: 'name imageUrl kind menuType setMenus',
      populate: { path: 'setMenus', select: 'imageUrl' }
    })
    .sort({ update_date: -1, entry_date: -1 })
    .limit(4)
    .lean();

  const groupMemberMyMenus = currentGroupId
    ? await Mymenu.find({ group: currentGroupId, user: { $ne: req.user._id } })
        .populate({
          path: 'menu',
          select: 'name imageUrl kind menuType setMenus',
          populate: { path: 'setMenus', select: 'imageUrl' }
        })
        .populate('user', 'displayname username')
        .sort({ update_date: -1, entry_date: -1 })
        .limit(2)
        .lean()
    : [];

  // MyStock counts (ingredient / seasoning) for current user + group
  let mystockCounts = { ingredient: 0, seasoning: 0 };
  if (currentGroupId) {
    try {
      const agg = await Stock.aggregate([
        { $match: { group: new mongoose.Types.ObjectId(String(currentGroupId)), user: req.user._id } },
        { $group: { _id: '$type', count: { $sum: 1 } } }
      ]);
      (agg||[]).forEach(row=>{ if(row._id==='ingredient') mystockCounts.ingredient=row.count; if(row._id==='seasoning') mystockCounts.seasoning=row.count; });
    } catch(_){ /* ignore */ }
  }

  // MyStock inventory status summary
  let myStockInventorySummary = { currentLabel: '', statusLabel: '未完了', nextLabel: '' };
  if (currentGroupId) {
    try {
      const cfg = groupConfig?.stockInventory || {};
      if (cfg.enabled !== false) {
        const sendHour = typeof cfg.sendHour === 'number' ? cfg.sendHour : 8;
        const getScheduledAtUTC = (year, month) => {
          let scheduledDay = null;
          if ((cfg.mode || 'monthlyDay') === 'monthlyDay') {
            const d = Math.max(1, Math.min(31, Number(cfg.day) || 28));
            const last = new Date(year, month + 1, 0).getDate();
            scheduledDay = Math.min(d, last);
          } else {
            const nth = Math.max(1, Math.min(5, Number(cfg.nth) || 4));
            const weekday = Math.max(0, Math.min(6, Number(cfg.weekday) || 0));
            const first = new Date(year, month, 1);
            const firstWeekday = first.getDay();
            const day1 = 1 + ((7 + weekday - firstWeekday) % 7);
            const candidate = day1 + (nth - 1) * 7;
            const last = new Date(year, month + 1, 0).getDate();
            scheduledDay = Math.min(candidate, last);
          }
          const scheduledAtJst = new Date(Date.UTC(year, month, scheduledDay, sendHour));
          return new Date(scheduledAtJst.getTime() - (9 * 60 * 60 * 1000));
        };

        const nowJst = toJstDate(new Date());
        const currentAt = getScheduledAtUTC(nowJst.getFullYear(), nowJst.getMonth());
        const currentLabel = `${currentAt.getFullYear()}年${currentAt.getMonth() + 1}月`;
        const taskTitle = `${currentLabel}のストックの棚卸し`;
        const currentTask = await Task.findOne({
          group: currentGroupId,
          source: 'stock',
          title: taskTitle
        }).select('status').lean();
        const statusLabel = currentTask && currentTask.status === 'completed' ? '完了' : '未完了';

        const nextMonthDate = new Date(nowJst.getFullYear(), nowJst.getMonth() + 1, 1);
        const nextAt = getScheduledAtUTC(nextMonthDate.getFullYear(), nextMonthDate.getMonth());
        const nextLabel = `${nextAt.getFullYear()}年${nextAt.getMonth() + 1}月`;

        myStockInventorySummary = { currentLabel, statusLabel, nextLabel };
      }
    } catch (_){ /* ignore */ }
  }

  // MyEquipment summary for current group
  let myEquipmentSummary = { count: 0, currentLabel: '', statusLabel: '未完了', nextLabel: '' };
  if (currentGroupId) {
    try {
      myEquipmentSummary.count = await MyEquipment.countDocuments({ group: currentGroupId });
      const cadence = groupConfig?.equipmentInventory?.cadence || 'monthly';
      const cycleStartJst = toJstDate(getEquipmentCycleStart(cadence));
      cycleStartJst.setHours(0, 0, 0, 0);
      const cycleStart = new Date(cycleStartJst.getTime() - (9 * 60 * 60 * 1000));
      const currentLabel = `${cycleStart.getFullYear()}年${cycleStart.getMonth() + 1}月`;
      const taskTitle = `${currentLabel}の備品の棚卸し`;
      const currentTask = await Task.findOne({
        group: currentGroupId,
        source: 'equipment',
        title: taskTitle
      }).select('status').lean();
      const statusLabel = currentTask && currentTask.status === 'completed' ? '完了' : '未完了';
      const nextCycleStart = new Date(cycleStartJst);
      if (cadence === 'quarter') {
        nextCycleStart.setMonth(nextCycleStart.getMonth() + 3);
      } else if (cadence === 'half') {
        nextCycleStart.setMonth(nextCycleStart.getMonth() + 6);
      } else {
        nextCycleStart.setMonth(nextCycleStart.getMonth() + 1);
      }
      const nextLabel = `${nextCycleStart.getFullYear()}年${nextCycleStart.getMonth() + 1}月`;
      myEquipmentSummary = { count: myEquipmentSummary.count, currentLabel, statusLabel, nextLabel };
    } catch (_){ /* ignore */ }
  }

  // 人気キーワード（直近7日）
  const popularKeywords = await (async () => {
    const since = new Date(); since.setDate(since.getDate() - 7);
    const rows = await SearchLog.aggregate([
      { $match: { type: 'keyword', createdAt: { $gte: since } } },
      { $group: { _id: '$term', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);
    return rows.map(r => ({ term: r._id, count: r.count })).filter(r => r.term);
  })();

  // 人気ジャンル（直近7日、WeeklyMenuPlanに含まれるメニューのジャンル集計）
  const popularGenres = await (async () => {
    const since = new Date(); since.setDate(since.getDate() - 7);
    const plans = await WeeklyMenuPlan.find({ updatedAt: { $gte: since } })
      .select('dayPlans')
      .lean();
    const menuIds = [];
    (plans || []).forEach((p) => {
      (p.dayPlans || []).forEach((dp) => {
        (dp.slots || []).forEach((s) => { if (s.menu) menuIds.push(s.menu); });
      });
    });
    if (!menuIds.length) return [];
    const menus = await Menu.find({ _id: { $in: menuIds } }).select('junle').lean();
    const counts = new Map();
    menus.forEach((m) => {
      const j = m.junle || '';
      if (!j) return;
      counts.set(j, (counts.get(j) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
  })();

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const recentNotices = await Notice.find({ publishedAt: { $gte: threeDaysAgo } })
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(5)
    .lean();

  let myTodoTasks = [];
  let otherMemberTaskCount = 0;
  if (currentGroupId) {
    const currentUserId = req.user?._id;
    const formatTaskDate = (date) => {
      const d = toJstDate(new Date(date));
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    };
    try {
      const tasksRaw = await Task.find({
        group: currentGroupId,
        status: { $ne: 'completed' },
        assignees: currentUserId
      })
        .select('title dueAt status')
        .lean();
      myTodoTasks = (tasksRaw || []).map((task) => ({
        id: String(task._id),
        title: task.title || '',
        dueAt: task.dueAt || null,
        dueLabel: task.dueAt ? formatTaskDate(task.dueAt) : ''
      }))
        .sort((a, b) => {
          const ta = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
          const tb = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
          return ta - tb;
        });

      otherMemberTaskCount = await Task.countDocuments({
        group: currentGroupId,
        status: { $ne: 'completed' },
        assignees: { $exists: true, $ne: [], $nin: [currentUserId] }
      });
    } catch (_) { /* ignore */ }
  }

  let packingEvents = [];
  if (currentGroupId) {
    const rawEvents = await PackingEvent.find({ group: currentGroupId, completed: { $ne: true } })
      .select('name startAt participants')
      .lean();
    const currentUserId = req.user?._id?.toString?.() || '';
    const formatEventDate = (date) => {
      if (!date) return '';
      const d = toJstDate(new Date(date));
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    };
    packingEvents = (rawEvents || []).map((ev) => {
      const participants = (ev.participants || []).map((id) => id.toString());
      const participantNames = participants
        .map((id) => memberLabelMap.get(id) || '')
        .filter(Boolean);
      return {
        id: String(ev._id),
        name: ev.name || '',
        startAt: ev.startAt || null,
        startLabel: ev.startAt ? formatEventDate(ev.startAt) : '',
        participants: participantNames,
        isParticipant: currentUserId ? participants.includes(currentUserId) : false
      };
    }).sort((a, b) => {
      if (a.isParticipant !== b.isParticipant) return a.isParticipant ? -1 : 1;
      const ta = a.startAt ? new Date(a.startAt).getTime() : Number.POSITIVE_INFINITY;
      const tb = b.startAt ? new Date(b.startAt).getTime() : Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return (a.name || '').localeCompare(b.name || '', 'ja');
    });
  }

  res.render('users/myTop', {
    pageTitle: '7 DAYS PLAN',
    nextWeekPlan,
    nextWeekRangeLabel,
    // Week after next
    afterNextWeekPlan,
    afterNextWeekStartISO,
    afterNextWeekRangeLabel,
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
    groupMemberMyMenus,
    mystockCounts,
    myStockInventorySummary,
    myEquipmentSummary,
    popularKeywords,
    popularGenres,
    stockInventoryNotice,
    recentNotices,
    equipmentInventoryNotice,
    packingEvents,
    myTodoTasks,
    otherMemberTaskCount
  });
  } catch (err) {
    return next(err);
  }
});

// ストック管理トップ
router.get('/users/stock-top', isLoggedIn, async (req, res, next) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const fallbackGroupId = userGroups.length ? userGroups[0]._id.toString() : '';
    const currentGroupId = defaultGroupId || fallbackGroupId || '';
    const groupConfig = currentGroupId
      ? await Group.findById(currentGroupId).select('group_name stockInventory equipmentInventory members createdBy').lean()
      : null;
    const currentGroupName = groupConfig?.group_name || '';

    let mystockCounts = { ingredient: 0, seasoning: 0 };
    if (currentGroupId) {
      try {
        const agg = await Stock.aggregate([
          { $match: { group: new mongoose.Types.ObjectId(String(currentGroupId)), user: req.user._id } },
          { $group: { _id: '$type', count: { $sum: 1 } } }
        ]);
        (agg || []).forEach((row)=> {
          if (row._id === 'ingredient') mystockCounts.ingredient = row.count;
          if (row._id === 'seasoning') mystockCounts.seasoning = row.count;
        });
      } catch (_) { /* ignore */ }
    }

    let myStockInventorySummary = { currentLabel: '', statusLabel: '未完了', nextLabel: '' };
    if (currentGroupId) {
      try {
        const cfg = groupConfig?.stockInventory || {};
        if (cfg.enabled !== false) {
          const sendHour = typeof cfg.sendHour === 'number' ? cfg.sendHour : 8;
          const getScheduledAtUTC = (year, month) => {
            let scheduledDay = null;
            if ((cfg.mode || 'monthlyDay') === 'monthlyDay') {
              const d = Math.max(1, Math.min(31, Number(cfg.day) || 28));
              const last = new Date(year, month + 1, 0).getDate();
              scheduledDay = Math.min(d, last);
            } else {
              const nth = Math.max(1, Math.min(5, Number(cfg.nth) || 4));
              const weekday = Math.max(0, Math.min(6, Number(cfg.weekday) || 0));
              const first = new Date(year, month, 1);
              const firstWeekday = first.getDay();
              const day1 = 1 + ((7 + weekday - firstWeekday) % 7);
              const candidate = day1 + (nth - 1) * 7;
              const last = new Date(year, month + 1, 0).getDate();
              scheduledDay = Math.min(candidate, last);
            }
            const scheduledAtJst = new Date(Date.UTC(year, month, scheduledDay, sendHour));
            return new Date(scheduledAtJst.getTime() - (9 * 60 * 60 * 1000));
          };

          const nowJst = toJstDate(new Date());
          const currentAt = getScheduledAtUTC(nowJst.getFullYear(), nowJst.getMonth());
          const currentLabel = `${currentAt.getFullYear()}年${currentAt.getMonth() + 1}月`;
          const taskTitle = `${currentLabel}のストックの棚卸し`;
          const currentTask = await Task.findOne({
            group: currentGroupId,
            source: 'stock',
            title: taskTitle
          }).select('status').lean();
          const statusLabel = currentTask && currentTask.status === 'completed' ? '完了' : '未完了';

          const nextMonthDate = new Date(nowJst.getFullYear(), nowJst.getMonth() + 1, 1);
          const nextAt = getScheduledAtUTC(nextMonthDate.getFullYear(), nextMonthDate.getMonth());
          const nextLabel = `${nextAt.getFullYear()}年${nextAt.getMonth() + 1}月`;

          myStockInventorySummary = { currentLabel, statusLabel, nextLabel };
        }
      } catch (_) { /* ignore */ }
    }

    let myEquipmentSummary = { count: 0, currentLabel: '', statusLabel: '未完了', nextLabel: '' };
    if (currentGroupId) {
      try {
        myEquipmentSummary.count = await MyEquipment.countDocuments({ group: currentGroupId });
        const cadence = groupConfig?.equipmentInventory?.cadence || 'monthly';
        const cycleStartJst = toJstDate(getEquipmentCycleStart(cadence));
        cycleStartJst.setHours(0, 0, 0, 0);
        const cycleStart = new Date(cycleStartJst.getTime() - (9 * 60 * 60 * 1000));
        const currentLabel = `${cycleStart.getFullYear()}年${cycleStart.getMonth() + 1}月`;
        const taskTitle = `${currentLabel}の備品の棚卸し`;
        const currentTask = await Task.findOne({
          group: currentGroupId,
          source: 'equipment',
          title: taskTitle
        }).select('status').lean();
        const statusLabel = currentTask && currentTask.status === 'completed' ? '完了' : '未完了';
        const nextCycleStart = new Date(cycleStartJst);
        if (cadence === 'quarter') {
          nextCycleStart.setMonth(nextCycleStart.getMonth() + 3);
        } else if (cadence === 'half') {
          nextCycleStart.setMonth(nextCycleStart.getMonth() + 6);
        } else {
          nextCycleStart.setMonth(nextCycleStart.getMonth() + 1);
        }
        const nextLabel = `${nextCycleStart.getFullYear()}年${nextCycleStart.getMonth() + 1}月`;
        myEquipmentSummary = { count: myEquipmentSummary.count, currentLabel, statusLabel, nextLabel };
      } catch (_) { /* ignore */ }
    }

    let myTodoTasks = [];
    let otherMemberTaskCount = 0;
    if (currentGroupId) {
      const currentUserId = req.user?._id;
      const formatTaskDate = (date) => {
        const d = toJstDate(new Date(date));
        return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
      };
      try {
        const tasksRaw = await Task.find({
          group: currentGroupId,
          status: { $ne: 'completed' },
          assignees: currentUserId
        })
          .select('title dueAt status')
          .lean();
        myTodoTasks = (tasksRaw || []).map((task) => ({
          id: String(task._id),
          title: task.title || '',
          dueAt: task.dueAt || null,
          dueLabel: task.dueAt ? formatTaskDate(task.dueAt) : ''
        }))
          .sort((a, b) => {
            const ta = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
            const tb = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
            return ta - tb;
          })
          .slice(0, 5);

        otherMemberTaskCount = await Task.countDocuments({
          group: currentGroupId,
          status: { $ne: 'completed' },
          assignees: { $exists: true, $ne: [], $nin: [currentUserId] }
        });
      } catch (_) { /* ignore */ }
    }

    res.render('users/stockTop', {
      pageTitle: 'ストック管理トップ',
      currentGroupName,
      mystockCounts,
      myStockInventorySummary,
      myEquipmentSummary,
      myTodoTasks,
      otherMemberTaskCount
    });
  } catch (err) {
    return next(err);
  }
});

// 旬の食材一覧（今月/季節）
router.get('/users/seasonal-ingredients', isLoggedIn, async (req, res, next) => {
  try {
    const { keyword = '', classification = '', season = '', month = '' } = req.query;
    const keywordText = String(keyword || '').trim();
    const classificationFilter = String(classification || '').trim();
    const hasSeasonParam = Object.prototype.hasOwnProperty.call(req.query, 'season');
    const hasMonthParam = Object.prototype.hasOwnProperty.call(req.query, 'month');

    const escapeRegex = (text) => {
      if (!text) return null;
      return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    };
    const normalizeMonthLabel = (value) => {
      const raw = String(value || '').trim().replace(/月$/, '');
      const num = Number(raw);
      if (Number.isFinite(num) && num >= 1 && num <= 12) return `${num}月`;
      return '';
    };
    const monthToSeason = (m) => {
      if (m >= 3 && m <= 5) return '春';
      if (m >= 6 && m <= 9) return '夏';
      if (m >= 10 && m <= 11) return '秋';
      return '冬';
    };
    const normalizeSeason = (value) => {
      const raw = String(value || '').trim();
      return ['春', '夏', '秋', '冬'].includes(raw) ? raw : '';
    };
    const normalizeSeasonList = (val) =>
      (Array.isArray(val) ? val : [])
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .filter((s) => s.toLowerCase() !== 'all');
    const normalizeMonthList = (val) =>
      (Array.isArray(val) ? val : [])
        .map((m) => normalizeMonthLabel(m) || '')
        .filter(Boolean)
        .filter((m) => m.toLowerCase() !== 'all');

    const now = new Date();
    const currentMonthNumber = now.getMonth() + 1;
    const currentMonthLabel = `${currentMonthNumber}月`;
    const selectedSeason = hasSeasonParam ? normalizeSeason(season) : '';
    // デフォルトは今月で絞り込む。monthパラメータが空で渡された場合は未選択扱い。
    const selectedMonth = hasMonthParam ? normalizeMonthLabel(month) : currentMonthLabel;

    const keywordRx = escapeRegex(keywordText);
    const filters = [];
    if (keywordRx) {
      filters.push({ $or: [{ ingredient: keywordRx }, { yomi: keywordRx }, { classification: keywordRx }] });
    }
    if (classificationFilter) {
      filters.push({ classification: classificationFilter });
    }
    const query = filters.length ? { $and: filters } : {};

    const ingredients = await Ingredient.find(query)
      .select('ingredient classification yomi energy water protein lipid carbohydrate wikiUrl imageUrl season month')
      .lean();

    const monthActive = !!selectedMonth;

    const monthlyList = ingredients.filter((ing) => {
      const months = normalizeMonthList(ing.month);
      if (!months.length) return false;
      return selectedMonth ? months.includes(selectedMonth) : true;
    });

    const targetIds = new Set(monthlyList.map((ing) => String(ing._id)));
    const menuUsage = {};
    // g換算用に食材の単位変換マスタを取得
    const ingredientConversions = new Map();
    if (targetIds.size) {
      const ingMeta = await Ingredient.find({ _id: { $in: Array.from(targetIds) } })
        .select('unitConversions')
        .lean();
      (ingMeta || []).forEach((ing) => {
        const convMap = new Map();
        (ing.unitConversions || []).forEach((c) => {
          if (!c || typeof c.label !== 'string') return;
          if (typeof c.grams !== 'number') return;
          convMap.set(c.label, c.grams);
        });
        ingredientConversions.set(String(ing._id), convMap);
      });
    }

    const toGrams = (amount, unit, ingId) => {
      const val = Number(amount);
      if (!Number.isFinite(val)) return null;
      const u = (unit || '').trim();
      if (!u) return null;
      if (u === 'g' || u === 'グラム' || u.toLowerCase() === 'gram') return val;
      const conv = ingredientConversions.get(String(ingId));
      if (conv && conv.has(u)) {
        const per = conv.get(u);
        if (Number.isFinite(per)) return Math.round(val * per * 100) / 100;
      }
      return null;
    };

    if (targetIds.size) {
      const menuDocs = await Menu.find({ 'ingredients.name': { $in: Array.from(targetIds) } })
        .select('name ingredients url share')
        .lean();
      const mymenus = await Mymenu.find({ menu: { $in: menuDocs.map((m) => m._id) } })
        .select('menu sourceType')
        .lean();
      const sourceTypePriority = { original: 3, url: 2, shared: 1, '': 0 };
      const sourceTypeMap = new Map();
      (mymenus || []).forEach((m) => {
        const id = m.menu?.toString?.() || '';
        const type = m.sourceType || '';
        if (!id) return;
        const existing = sourceTypeMap.get(id) || '';
        if ((sourceTypePriority[type] || 0) >= (sourceTypePriority[existing] || 0)) {
          sourceTypeMap.set(id, type);
        }
      });

      menuDocs.forEach((menu) => {
        (menu.ingredients || []).forEach((ingRef) => {
          const id = ingRef?.name?.toString?.() || '';
          if (!id || !targetIds.has(id)) return;
          const arr = menuUsage[id] || (menuUsage[id] = []);
          const menuId = String(menu._id);
          if (arr.some((m) => m.id === menuId)) return;
          let sourceType = sourceTypeMap.get(menuId) || '';
          if (!sourceType) {
            sourceType = 'shared';
          }
          const grams = toGrams(ingRef?.amount, ingRef?.unit, id);
          arr.push({
            id: menuId,
            name: menu.name || '',
            url: menu.url || '',
            sourceType,
            share: menu.share === true,
            amount: typeof ingRef?.amount === 'number' ? ingRef.amount : null,
            amountGrams: grams
          });
        });
      });

      // Sort each ingredient's menu list by descending usage amount (missing amounts last)
      Object.keys(menuUsage).forEach((ingId) => {
        menuUsage[ingId].sort((a, b) => {
          const aAmt = typeof a.amountGrams === 'number'
            ? a.amountGrams
            : (typeof a.amount === 'number' ? a.amount : -1);
          const bAmt = typeof b.amountGrams === 'number'
            ? b.amountGrams
            : (typeof b.amount === 'number' ? b.amount : -1);
          return bAmt - aAmt;
        });
      });
    }

    const classifications = (await Ingredient.distinct('classification')).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
    const seasonOptions = ['春', '夏', '秋', '冬'];
    const monthOptions = Array.from({ length: 12 }, (_, idx) => `${idx + 1}月`);
    const seo = { title: '旬の食材リスト' };

    return res.render('users/seasonalIngredients', {
      keyword: keywordText,
      classification: classificationFilter,
      selectedSeason,
      selectedMonth,
      currentMonthLabel,
      currentSeason: monthToSeason(currentMonthNumber),
      monthlyList,
      seasonOptions,
      monthOptions,
      classifications,
      menuUsage,
      seo
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
// 自分の過去理由を取得（グループ単位、最新順）
router.get('/users/week-menu/participant-reasons', isLoggedIn, async (req, res) => {
  try {
    const groupId = String(req.query.group || '');
    if (!groupId || !mongoose.Types.ObjectId.isValid(groupId)) {
      return res.status(400).json({ error: 'group が不正です。' });
    }
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const belongs = groups.some((g) => String(g._id) === String(groupId));
    if (!belongs) return res.status(403).json({ error: '権限がありません。' });

    const docs = await WeeklyMenuPlan.find({ group: groupId, 'participantReasons.user': req.user._id })
      .select('participantReasons')
      .sort({ createdAt: -1 })
      .lean();

    const list = [];
    (docs || []).forEach((d) => {
      (d.participantReasons || []).forEach((r) => {
        if (String(r.user) === String(req.user._id) && r.reason) {
          list.push({ reason: r.reason, createdAt: r.createdAt || d.updatedAt || d.createdAt });
        }
      });
    });

    // ユニーク化 + 最新順
    const seen = new Set();
    const uniq = [];
    list
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .forEach((x) => {
        const key = x.reason.trim();
        if (!key || seen.has(key)) return;
        seen.add(key);
        uniq.push(key);
      });

    return res.json({ success: true, reasons: uniq.slice(0, 20) });
  } catch (err) {
    console.error('過去理由取得エラー:', err);
    return res.status(500).json({ error: '理由を取得できませんでした。' });
  }
});

// 記録: 「これ食べた」（DO）
router.post('/users/week-menu/do', isLoggedIn, async (req, res) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const body = req.body || {};
    const groupId = String(body.groupId || body.group || '').trim();
    const planId = String(body.planId || '').trim();
    const dayIndex = Number(body.dayIndex);
    const mealType = String(body.mealType || '').trim();
    const menuId = String(body.menuId || '').trim();
    const dateISO = String(body.dateISO || '').trim();

    if (!groupId || !userGroups.some((g) => String(g._id) === groupId)) {
      return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    }
    if (!(mealType === 'breakfast' || mealType === 'lunch' || mealType === 'dinner')) {
      return res.status(400).json({ error: '不正な食事区分です。' });
    }
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
      return res.status(400).json({ error: '不正な日付インデックスです。' });
    }
    if (!mongoose.Types.ObjectId.isValid(menuId)) {
      return res.status(400).json({ error: '不正なメニューIDです。' });
    }
    const date = dateISO ? new Date(dateISO) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return res.status(400).json({ error: '不正な日付です。' });
    }

    // 未来日は不可
    const today = startOfDay(new Date());
    const target = startOfDay(date);
    if (target.getTime() > today.getTime()) {
      return res.status(400).json({ error: '未来日の記録はできません。' });
    }

    // 既存の重複を避ける
    try {
      await MenuDo.create({
        group: groupId,
        plan: mongoose.Types.ObjectId.isValid(planId) ? planId : undefined,
        date: target,
        dayIndex,
        mealType,
        menu: menuId,
        recordedBy: req.user._id
      });
      return res.json({ success: true, recorded: true });
    } catch (err) {
      // 重複（ユニーク制約）なら成功として扱う
      if (err && err.code === 11000) {
        return res.json({ success: true, recorded: false, duplicate: true });
      }
      throw err;
    }
  } catch (err) {
    console.error('DO記録エラー:', err);
    return res.status(500).json({ error: '記録に失敗しました。' });
  }
});

// 記録取消: 「これ食べた」を取り消す
router.delete('/users/week-menu/do', isLoggedIn, async (req, res) => {
  try {
    const userGroups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const body = req.body || {};
    const groupId = String(body.groupId || body.group || '').trim();
    const dayIndex = Number(body.dayIndex);
    const mealType = String(body.mealType || '').trim();
    const menuId = String(body.menuId || '').trim();
    const dateISO = String(body.dateISO || '').trim();

    if (!groupId || !userGroups.some((g) => String(g._id) === groupId)) {
      return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    }
    if (!(mealType === 'breakfast' || mealType === 'lunch' || mealType === 'dinner')) {
      return res.status(400).json({ error: '不正な食事区分です。' });
    }
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
      return res.status(400).json({ error: '不正な日付インデックスです。' });
    }
    if (!mongoose.Types.ObjectId.isValid(menuId)) {
      return res.status(400).json({ error: '不正なメニューIDです。' });
    }
    const date = dateISO ? new Date(dateISO) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return res.status(400).json({ error: '不正な日付です。' });
    }

    const target = new Date(date);
    target.setHours(0,0,0,0);

    const result = await MenuDo.findOneAndDelete({
      group: groupId,
      date: target,
      mealType,
      menu: menuId,
      recordedBy: req.user._id
    });

    return res.json({ success: true, removed: !!result });
  } catch (err) {
    console.error('DO取消エラー:', err);
    return res.status(500).json({ error: '取消に失敗しました。' });
  }
});
