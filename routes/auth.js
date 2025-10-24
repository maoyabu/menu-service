import express from 'express';
import mongoose from 'mongoose';
import User from '../models/users.js';
import Menu from '../models/menu.js';
import WeeklyMenuPlan from '../models/weeklyMenuPlan.js';
import { isLoggedIn } from '../middleware.js';

const router = express.Router();

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
    kinds: ['主菜', '主食', '主食・ごはん', '主食・パン', '主食・麺'],
    label: 'メインディッシュ',
    mealType: 'ランチ'
  },
  dinnerStaple: {
    kinds: ['主食', '主食・ごはん', '主食・パン', '主食・麺'],
    label: '主食',
    mealType: 'ディナー'
  },
  dinnerMain: {
    kinds: ['主菜'],
    label: 'メイン',
    mealType: 'ディナー'
  },
  dinnerSide: {
    kinds: ['副菜'],
    label: '副菜',
    mealType: 'ディナー'
  },
  dinnerSoup: {
    kinds: ['汁物'],
    label: '汁物',
    mealType: 'ディナー'
  }
};

const CATEGORY_TO_SLOT_TYPE = {
  lunchMain: 'lunch-main',
  dinnerStaple: 'dinner-staple',
  dinnerMain: 'dinner-main',
  dinnerSide: 'dinner-side',
  dinnerSoup: 'dinner-soup'
};

const formatMenuDocument = (doc) => ({
  id: doc._id.toString(),
  name: doc.name,
  kind: doc.kind,
  cook: doc.cook,
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

const getNextWeekDates = () => {
  const today = new Date();
  const day = today.getDay();
  const offset = ((8 - day) % 7) || 7;
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offset);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
};

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
      day?.lunch?.main,
      day?.dinner?.staple,
      day?.dinner?.main,
      day?.dinner?.side,
      day?.dinner?.soup
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

const buildWeekPlanPayload = (menusByCategory) => {
  const menuLookup = {};
  Object.values(menusByCategory).forEach((menus) => {
    menus.forEach((menu) => {
      menuLookup[menu.id] = menu;
    });
  });

  const weekDates = getNextWeekDates();

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
      lunch: {
        main: createSlot('lunchMain')
      },
      dinner: {
        staple: createSlot('dinnerStaple'),
        main: createSlot('dinnerMain'),
        side: createSlot('dinnerSide'),
        soup: createSlot('dinnerSoup')
      }
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

    const services = {
      allaboutme: normalizeBoolean(req.body?.services?.allaboutme),
      finance: normalizeBoolean(req.body?.services?.finance),
      assets: normalizeBoolean(req.body?.services?.assets),
      menu: normalizeBoolean(req.body?.services?.menu)
    };

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

    const baseWeekDates = getNextWeekDates();
    const baseWeekRangeLabel = `${formatDisplayDate(baseWeekDates[0])}〜${formatDisplayDate(baseWeekDates[6])}`;

    let existingPlan = null;

    if (planIdParam) {
      const plan = await WeeklyMenuPlan.findById(planIdParam).lean();
      if (plan) {
        const planGroupId = plan.group.toString();
        const canAccess = userGroups.some((group) => group._id.toString() === planGroupId);
        if (canAccess && (!currentGroupId || planGroupId === currentGroupId)) {
          existingPlan = plan;
          if (!currentGroupId) {
            currentGroupId = planGroupId;
          }
        }
      }
    }

    if (!existingPlan && currentGroupId) {
      const normalizedWeekStart = new Date(baseWeekDates[0]);
      normalizedWeekStart.setHours(0, 0, 0, 0);
      existingPlan = await WeeklyMenuPlan.findOne({
        group: currentGroupId,
        weekStart: normalizedWeekStart
      }).lean();
    }

    let plan = [];
    let menuLookup = {};
    let ingredientSummary = [];
    let seasoningSummary = [];
    let weekDatesForView = [];
    let weekRangeLabel = baseWeekRangeLabel;
    let existingPlanId = existingPlan ? existingPlan._id.toString() : '';

    if (existingPlan) {
      const basePlan = baseWeekDates.map((date, index) => ({
        index,
        dayLabel: WEEKDAY_JA[index],
        dayLabelEn: WEEKDAY_EN[index],
        dateISO: date.toISOString(),
        lunch: { main: null },
        dinner: { staple: null, main: null, side: null, soup: null }
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

      const slotTypeMap = {
        'lunch-main': { meal: 'lunch', key: 'main', categoryKey: 'lunchMain' },
        'dinner-staple': { meal: 'dinner', key: 'staple', categoryKey: 'dinnerStaple' },
        'dinner-main': { meal: 'dinner', key: 'main', categoryKey: 'dinnerMain' },
        'dinner-side': { meal: 'dinner', key: 'side', categoryKey: 'dinnerSide' },
        'dinner-soup': { meal: 'dinner', key: 'soup', categoryKey: 'dinnerSoup' }
      };

      (existingPlan.dayPlans || []).forEach((dayPlan) => {
        const target = basePlan[dayPlan.dayIndex];
        if (!target) return;

        if (dayPlan.date) {
          const iso = new Date(dayPlan.date).toISOString();
          target.dateISO = iso;
        }

        (dayPlan.slots || []).forEach((slot) => {
          const map = slotTypeMap[slot?.slotType];
          if (!map) return;

          const slotData = {
            menuId: slot.menu.toString(),
            categoryKey: map.categoryKey,
            dineOut: !!slot.dineOut,
            favorite: !!slot.favorite,
            locked: !!slot.locked
          };

          if (map.meal === 'lunch') {
            target.lunch[map.key] = slotData;
          } else {
            target.dinner[map.key] = slotData;
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
      const generated = buildWeekPlanPayload(menusByCategory);
      plan = generated.plan;
      menuLookup = generated.menuLookup;
      ingredientSummary = generated.ingredientSummary;
      seasoningSummary = generated.seasoningSummary;
      weekDatesForView = generated.weekDates;
      weekRangeLabel = generated.weekRangeLabel;
    }

    res.render('users/weekMenu', {
      categoryConfig: CATEGORY_CONFIG,
      menusByCategory,
      menuLookup,
      plan,
      weekDates: weekDatesForView,
      weekRangeLabel,
      ingredientSummary,
      seasoningSummary,
      currentGroupId,
      existingPlanId
    });
  } catch (err) {
    console.error('週次メニュー生成エラー:', err);
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

    let nextWeekPlan = null;
    if (currentGroupId) {
      const normalizedWeekStart = new Date(weekStartDate);
      normalizedWeekStart.setHours(0, 0, 0, 0);
      nextWeekPlan = await WeeklyMenuPlan.findOne({
        group: currentGroupId,
        weekStart: normalizedWeekStart
      }).select('_id weekStart weekEnd title').lean();
    }

    res.render('users/myTop', {
      nextWeekPlan,
      nextWeekRangeLabel,
      currentGroupId
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
