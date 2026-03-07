import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/users.js';
import Group from '../models/groups.js';
import MenuDo from '../models/menuDo.js';
import WeeklyMenuPlan from '../models/weeklyMenuPlan.js';
import MenuApiConfig from '../models/menu_api_config.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const TIME_ZONE = 'Asia/Tokyo';

const formatDateKey = (date) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
};

const getDateRangeJST = (dateString) => {
  if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const start = new Date(`${dateString}T00:00:00+09:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
};

const groupMealsTemplate = () => ({
  breakfast: [],
  lunch: [],
  dinner: []
});

const normalizeMealType = (value) => {
  if (value === 'breakfast' || value === 'lunch' || value === 'dinner') return value;
  return 'dinner';
};

const buildMenuItem = ({
  id,
  mealType,
  name,
  imageUrl,
  url,
  tags,
  source
}) => ({
  id,
  mealType,
  name: name || '',
  imageUrl: imageUrl || '',
  url: url || '',
  tags: tags || [],
  source
});

const parseTags = (menu) => {
  if (!menu) return [];
  const tags = [];
  if (menu.junle) tags.push(menu.junle);
  if (menu.kind) tags.push(menu.kind);
  if (menu.menu) tags.push(menu.menu);
  return tags;
};

const authenticateToken = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    console.log('[apiMeal] missing auth header');
    return res.status(401).json({ error: 'unauthorized', message: '認証が必要です' });
  }
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    const user = await User.findById(payload.sub).select('username email isAdmin').lean();
    if (!user) {
      console.log('[apiMeal] token user not found', { sub: payload.sub });
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.apiUser = user;
    return next();
  } catch (err) {
    console.log('[apiMeal] token invalid', { message: err?.message || '' });
    return res.status(401).json({ error: 'unauthorized', message: '認証に失敗しました' });
  }
};



router.post('/login', async (req, res) => {
  try {
    const { username, email, identifier, password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'missing_params', message: 'password は必須です' });
    }

    let user = null;
    const identifierValue = String(identifier || username || email || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (normalizedEmail) {
      user = await User.findOne({ email: normalizedEmail });
    }
    if (!user && identifierValue) {
      if (identifierValue.includes('@')) {
        user = await User.findOne({ email: identifierValue.toLowerCase() });
      }
      if (!user) {
        user = await User.findOne({ username: identifierValue });
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'IDまたはパスワードが違います' });
    }

    if (user.unsubscribe_date) {
      return res.status(403).json({ error: 'unsubscribed', message: '退会済みのためログインできません' });
    }

    const isValid = await new Promise((resolve) => {
      user.authenticate(password, (_err, thisUser, passwordError) => {
        resolve(!passwordError && !!thisUser);
      });
    });

    if (!isValid) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'IDまたはパスワードが違います' });
    }

    const token = jwt.sign({ sub: String(user._id) }, JWT_SECRET, { expiresIn: '14d' });
    return res.json({
      token,
      user: {
        id: String(user._id),
        username: user.username,
        email: user.email,
        displayname: user.displayname || null,
        isAdmin: Boolean(user.isAdmin)
      }
    });
  } catch (err) {
    console.error('api meal login error:', err);
    return res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

router.get('/config', async (_req, res) => {
  try {
    const config = await MenuApiConfig.findOne({}).sort({ updatedAt: -1 }).lean();
    return res.json({ url: config?.url || '' });
  } catch (err) {
    return res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

router.post('/config', authenticateToken, async (req, res) => {
  try {
    if (!req.apiUser?.isAdmin) {
      return res.status(403).json({ error: 'forbidden', message: '管理者のみ変更できます' });
    }
    const url = String(req.body?.url || '').trim();
    if (!url) {
      return res.status(400).json({ error: 'invalid_url', message: 'url を指定してください' });
    }
    const updated = await MenuApiConfig.findOneAndUpdate(
      {},
      { $set: { url, updatedBy: req.apiUser._id, updatedAt: new Date() } },
      { upsert: true, new: true }
    ).lean();
    return res.json({ url: updated?.url || url });
  } catch (err) {
    return res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

router.get('/day', authenticateToken, async (req, res) => {
  try {
    const dateString = String(req.query.date || '').trim();
    const range = getDateRangeJST(dateString);
    if (!range) {
      return res.status(400).json({ error: 'invalid_date', message: 'date は YYYY-MM-DD 形式で指定してください' });
    }

    const todayKey = formatDateKey(new Date());
    const isFuture = dateString > todayKey;

    const groups = await Group.find({
      $or: [
        { createdBy: req.apiUser._id },
        { members: req.apiUser._id }
      ]
    })
      .select('group_name')
      .lean();

    const groupIds = groups.map((g) => g._id);
    const groupNameMap = new Map(groups.map((g) => [String(g._id), g.group_name || 'Group']));

    const grouped = new Map();
    const ensureGroup = (groupId) => {
      const key = String(groupId);
      if (!grouped.has(key)) {
        grouped.set(key, {
          group: {
            _id: key,
            name: groupNameMap.get(key) || 'Group'
          },
          meals: groupMealsTemplate()
        });
      }
      return grouped.get(key);
    };

    if (!isFuture) {
      const records = await MenuDo.find({
        group: { $in: groupIds },
        date: { $gte: range.start, $lt: range.end }
      })
        .populate('menu', 'name imageUrl url junle kind menu')
        .populate('group', 'group_name')
        .lean();

      for (const record of records) {
        const mealType = normalizeMealType(record.mealType);
        const groupId = record.group?._id || record.group;
        const container = ensureGroup(groupId);
        if (record.group?.group_name) {
          container.group.name = record.group.group_name;
        }
        const menu = record.menu;
        const item = buildMenuItem({
          id: String(record._id),
          mealType,
          name: menu?.name || '',
          imageUrl: menu?.imageUrl || '',
          url: menu?.url || '',
          tags: parseTags(menu),
          source: 'eaten'
        });
        container.meals[mealType].push(item);
      }
    } else {
      const plans = await WeeklyMenuPlan.find({
        group: { $in: groupIds },
        weekStart: { $lte: range.start },
        weekEnd: { $gte: range.start }
      })
        .populate('group', 'group_name')
        .populate('dayPlans.slots.menu', 'name imageUrl url junle kind menu')
        .lean();

      for (const plan of plans) {
        const groupId = plan.group?._id || plan.group;
        const container = ensureGroup(groupId);
        if (plan.group?.group_name) {
          container.group.name = plan.group.group_name;
        }
        const dayPlans = (plan.dayPlans || []).filter((dp) => dp.date && dp.date >= range.start && dp.date < range.end);
        for (const dayPlan of dayPlans) {
          const mealType = normalizeMealType(dayPlan.mealType);
          for (const slot of dayPlan.slots || []) {
            if (slot.dineOut) {
              const item = buildMenuItem({
                id: `${plan._id}-${dayPlan.dayIndex}-${mealType}-${slot.slotType}`,
                mealType,
                name: slot.dineOutName || '外食',
                imageUrl: '',
                url: slot.dineOutUrl || '',
                tags: [],
                source: 'planned'
              });
              container.meals[mealType].push(item);
            } else if (slot.menu) {
              const menu = slot.menu;
              const item = buildMenuItem({
                id: `${plan._id}-${dayPlan.dayIndex}-${mealType}-${menu._id}`,
                mealType,
                name: menu.name || '',
                imageUrl: menu.imageUrl || '',
                url: menu.url || '',
                tags: parseTags(menu),
                source: 'planned'
              });
              container.meals[mealType].push(item);
            }
          }
        }
      }
    }

    const groupsPayload = Array.from(grouped.values()).map((entry) => {
      const meals = entry.meals;
      const sortByName = (a, b) => (a.name || '').localeCompare(b.name || '');
      meals.breakfast.sort(sortByName);
      meals.lunch.sort(sortByName);
      meals.dinner.sort(sortByName);
      return entry;
    });

    return res.json({
      date: dateString,
      isFuture,
      groups: groupsPayload
    });
  } catch (err) {
    console.error('api meal error:', err);
    return res.status(500).json({ error: 'failed', message: err?.message || '' });
  }
});

export default router;
