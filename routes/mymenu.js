import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { isLoggedIn } from '../middleware.js';
import Menu from '../models/menu.js';
import Notification from '../models/notification.js';
import Mymenu from '../models/mymenu.js';
import Group from '../models/groups.js';
import User from '../models/users.js';
import multer from 'multer';
import cloudinary from '../utils/cloudinary.js';
import fs from 'fs/promises';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import SearchLog from '../models/searchLog.js';
import WeeklyMenuPlan from '../models/weeklyMenuPlan.js';
import { renderTemplate, sendMail } from '../utils/mailer.js';
import { monthToSeason, normalizeSeasonList } from '../utils/season.js';

const upload = multer({ dest: 'uploads/' });

const router = express.Router();

// 一般公開URL用トークン生成
function generatePublicToken(len = 24){
  return crypto.randomBytes(Math.ceil(len * 0.75)).toString('base64url').slice(0, len);
}

// 一般公開（ログイン不要）: /users/my-menu/public/:token
router.get('/public/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(404).send('Not found');
    const owned = await Mymenu.findOne({ publicToken: token, share: true, shareScope: 'public' })
      .populate({ path: 'menu', populate: [ { path: 'ingredients.name', select: 'ingredient unit' }, { path: 'seasoning.name', select: 'seasoning unit' } ] })
      .populate('user', 'displayname username')
      .lean();
    if (!owned || !owned.menu) return res.status(404).send('Not found');
    const menu = owned.menu;
    let instructionText = String(menu.instructionText || '');
    let commentText = String(menu.comment || '');
    if (!instructionText && commentText) {
      const raw = commentText; const parts = raw.split(/\n{2,}/);
      if (parts.length > 1){ instructionText = (parts.shift()||'').trim(); commentText = parts.join('\n\n').trim(); }
      else { instructionText = raw; commentText = ''; }
    }
    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const canonical = `${baseUrl}${req.originalUrl}`;
    const title = `${menu.name || ''} | 7 DAYS PLAN オリジナルレシピ`;
    const description = `${menu.kind || ''}${menu.junle ? '・'+menu.junle: ''}${menu.cook ? '・'+menu.cook: ''}のオリジナルレシピ。7 DAYS PLANは「今日何食べる？」のストレスから解放してくれるサービスです。`;
    const seo = { title, description, image: menu.imageUrl || '', canonical, robots: 'index,follow', ogType: 'article' };
    const ownerName = (owned.user?.displayname || owned.user?.username || '') || '';
    return res.render('users/menuRecipe', { menu, instructionText, commentText, isPublic: true, ownerName, seo });
  } catch(e){ return next(e); }
});

// サービスの簡単な案内ページ（一般公開）
router.get('/guide', (req, res) => {
  res.render('users/guide');
});

router.use(isLoggedIn);

// ユーティリティ: 重複無し配列
const unique = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseServing = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 10) / 10;
};
const parseServings = (body = {}) => {
  const values = body.servings && typeof body.servings === 'object' ? body.servings : {};
  return {
    staple: parseServing(values.staple ?? body.serving_staple),
    sideDish: parseServing(values.sideDish ?? body.serving_sideDish),
    mainDish: parseServing(values.mainDish ?? body.serving_mainDish),
    dairy: parseServing(values.dairy ?? body.serving_dairy),
    fruit: parseServing(values.fruit ?? body.serving_fruit)
  };
};
// ユーティリティ: メニューに紐づく食材IDを取得
const pickIngredientIds = (menuDoc) => {
  if (!menuDoc || !Array.isArray(menuDoc.ingredients)) return [];
  return menuDoc.ingredients
    .map((ing) => ing?.name?.toString?.())
    .filter(Boolean);
};

// ユーティリティ: 周辺のユニークリストを作成
async function getFacetLists() {
  const allMenus = await Menu.find().select('kind junle cook menu').lean();
  return {
    kinds: unique(allMenus.map((m) => m.kind)),
    junles: unique(allMenus.map((m) => m.junle)),
    cooks: unique(allMenus.map((m) => m.cook)),
    menuContents: unique(allMenus.map((m) => m.menu))
  };
}

// マイメニューTOP
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user._id;
    // Filters for group members section (prefix g_ to avoid collisions)
    const { g_kind = '', g_junle = '', g_cook = '', g_menuContent = '', g_member = '' } = req.query;

    const [sharedCount, urlCount, originalCount] = await Promise.all([
      Mymenu.countDocuments({ user: userId, sourceType: 'shared' }),
      Mymenu.countDocuments({ user: userId, sourceType: 'url' }),
      Mymenu.countDocuments({ user: userId, sourceType: 'original' })
    ]);

    const mySharedSamples = await Mymenu.find({ user: userId, sourceType: 'shared' })
      .populate({
        path: 'menu',
        select: 'name imageUrl kind menu menuType setMenus',
        populate: { path: 'setMenus', select: 'imageUrl' }
      })
      .sort({ update_date: -1, entry_date: -1 })
      .limit(4)
      .lean();

    const myOriginalSamples = await Mymenu.find({ user: userId, sourceType: 'original' })
      .populate({
        path: 'menu',
        select: 'name imageUrl kind menu menuType setMenus',
        populate: { path: 'setMenus', select: 'imageUrl' }
      })
      .sort({ update_date: -1, entry_date: -1 })
      .limit(4)
      .lean();

    const myUrlSamples = await Mymenu.find({ user: userId, sourceType: 'url' })
      .populate('menu', 'name imageUrl kind menu')
      .sort({ update_date: -1, entry_date: -1 })
      .limit(4)
      .lean();

    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const currentGroup = groups.find((g) => g._id.toString() === defaultGroupId) || groups[0] || null;

    let groupMemberItems = [];
    let groupFacets = { kinds: [], junles: [], cooks: [], menuContents: [], members: [] };
    let groupSelected = { kind: g_kind, junle: g_junle, cook: g_cook, menuContent: g_menuContent, member: g_member };
    if (currentGroup) {
      const rawGroup = await Mymenu.find({
        group: currentGroup._id,
        user: { $ne: userId }
      })
        .populate({
          path: 'menu',
          select: 'name imageUrl kind junle cook menu yomi menuType setMenus',
          populate: { path: 'setMenus', select: 'imageUrl' }
        })
        .populate('user', 'displayname username')
        .sort({ update_date: -1, entry_date: -1 })
        .lean();

      // Build facets from group data only (only existing values selectable)
      const kinds = unique(rawGroup.map((mm) => mm?.menu?.kind).filter(Boolean));
      const junles = unique(rawGroup.map((mm) => mm?.menu?.junle).filter(Boolean));
      const cooks = unique(rawGroup.map((mm) => mm?.menu?.cook).filter(Boolean));
      const menuContents = unique(rawGroup.map((mm) => mm?.menu?.menu).filter(Boolean));
      const memberMap = new Map();
      (rawGroup || []).forEach((mm) => {
        if (!mm?.user) return;
        const id = mm.user._id?.toString?.() || '';
        if (!id) return;
        if (!memberMap.has(id)) {
          const name = mm.user.displayname || mm.user.username || '';
          memberMap.set(id, { id, name });
        }
      });
      groupFacets = { kinds, junles, cooks, menuContents, members: Array.from(memberMap.values()) };

      // Apply filters
      groupMemberItems = (rawGroup || []).filter((mm) => {
        const m = mm.menu || {};
        if (g_kind && m.kind !== g_kind) return false;
        if (g_junle && m.junle !== g_junle) return false;
        if (g_cook && m.cook !== g_cook) return false;
        if (g_menuContent && m.menu !== g_menuContent) return false;
        if (g_member && (mm.user?._id?.toString?.() !== g_member)) return false;
        return true;
      });
    }

    res.render('users/myMenu', {
      mymenuStats: { sharedCount, urlCount, originalCount },
      mySharedSamples,
      myOriginalSamples,
      myUrlSamples,
      groupMemberItems,
      currentGroup,
      groupFacets,
      groupSelected
    });
  } catch (err) { next(err); }
});

// 共有メニューから登録 画面 + 検索
router.get('/shared-register', async (req, res, next) => {
  try {
    const {
      keyword = '',
      kind = '',
      junle = '',
      cook = '',
      menuContent = '',
      fav = 'all',
      seasonal = '',
      seasonalMonth = '',
      originalMenu = '',
      setMenu = '',
      arrangeMenu = ''
    } = req.query;
    const onlySeasonal = ['1', 'true', 'on', 'yes'].includes(String(seasonal).toLowerCase());
    const onlySeasonalByMonth = ['1', 'true', 'on', 'yes'].includes(String(seasonalMonth).toLowerCase());
    const onlyOriginalMenu = ['1', 'true', 'on', 'yes'].includes(String(originalMenu).toLowerCase());
    const onlySetMenu = ['1', 'true', 'on', 'yes'].includes(String(setMenu).toLowerCase());
    const onlyArrangeMenu = ['1', 'true', 'on', 'yes'].includes(String(arrangeMenu).toLowerCase());
    const { kinds, junles, cooks, menuContents } = await getFacetLists();

    // 管理者が登録した共有メニュー（share=true を優先、なければ全件）
    const menuFilter = [];
    if (kind) menuFilter.push({ kind });
    if (junle) menuFilter.push({ junle });
    if (cook) menuFilter.push({ cook });
    if (menuContent) menuFilter.push({ menu: menuContent });
    if (keyword) {
      const rx = new RegExp(escapeRegex(keyword), 'i');
      menuFilter.push({
        $or: [ { name: rx }, { yomi: rx }, { kind: rx }, { junle: rx }, { cook: rx }, { menu: rx } ]
      });
    }
    if (keyword) {
      try {
        await SearchLog.create({
          term: keyword,
          source: 'shared-list',
          type: 'keyword',
          user: req.user?._id || null,
          group: res.locals.userDefaultGroupId || null
        });
      } catch(_) { /* ignore logging errors */ }
    }

    const adminShared = await Menu.find(menuFilter.length ? { $and: [...menuFilter, { isPrivate: { $ne: true } }] } : { isPrivate: { $ne: true } })
      .select('name kind junle cook menu yomi time imageUrl url season menuType setMenus')
      .populate({ path: 'setMenus', select: 'imageUrl' })
      .lean();

    // 会員の共有メニュー（Mymenu.share = true）
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const myId = req.user._id.toString();
    const myGroupIds = new Set(groups.map((g) => g._id.toString()));

    const sharedUserMenus = await Mymenu.find({ share: true })
      .populate({
        path: 'menu',
        select: 'name kind junle cook menu yomi time imageUrl url season menuType setMenus',
        populate: { path: 'setMenus', select: 'imageUrl' }
      })
      .populate('user', 'displayname username email')
      .lean();

    const filteredSharedUserMenus = sharedUserMenus.filter((m) => {
      if (!m?.menu) return false;
      if (m.user && m.user._id && m.user._id.toString() === myId) return false; // 自分の共有は除外
      if (m.shareScope === 'all') return true;
      const g = m.group ? m.group.toString() : '';
      return g && myGroupIds.has(g);
    }).filter((m) => {
      // キーワード・絞り込み
      const x = m.menu || {};
      if (kind && x.kind !== kind) return false;
      if (junle && x.junle !== junle) return false;
      if (cook && x.cook !== cook) return false;
      if (menuContent && x.menu !== menuContent) return false;
      if (keyword) {
        const rx = new RegExp(escapeRegex(keyword), 'i');
        const fields = [x.name, x.yomi, x.kind, x.junle, x.cook, x.menu].filter(Boolean).join(' ');
        return rx.test(fields);
      }
      return true;
    });

    // 自分のマイメニューID一覧（色付き♡判定用）
    const groupId = res.locals.userDefaultGroupId
      || (groups[0]?._id?.toString() ?? '');
    let myMenuIds = [];
    let myOwnTypes = {};
    let myMenuFreq = {};
    if (groupId) {
      const mymenus = await Mymenu.find({ user: req.user._id, group: groupId }).select('menu sourceType frequency').lean();
      myMenuIds = (mymenus || []).map((m) => (m.menu ? m.menu.toString() : '')).filter(Boolean);
      myOwnTypes = (mymenus || []).reduce((acc, m) => { const id = m.menu ? m.menu.toString() : ''; if (id) acc[id] = m.sourceType || ''; return acc; }, {});
      myMenuFreq = (mymenus || []).reduce((acc, m) => { const id = m.menu ? m.menu.toString() : ''; if (id && typeof m.frequency === 'number') acc[id] = m.frequency; return acc; }, {});
    }

    // 自分が作成した（URL/オリジナル）メニューID一覧（編集可）
    const myEditableMenuIds = new Set(
      (await Mymenu.find({ user: req.user._id, sourceType: { $in: ['url', 'original'] } })
        .select('menu sourceType').lean())
      .map((m) => m.menu?.toString()).filter(Boolean)
    );

    // 管理者メニュー + 会員共有メニューを結合（menu._id でユニーク）
    const combinedMap = new Map();
    (adminShared || []).forEach((m) => {
      if (!m || !m._id) return;
      const ingredientIds = pickIngredientIds(m);
      combinedMap.set(m._id.toString(), {
        id: m._id.toString(),
        name: m.name || '',
        menu: m.menu || '',
        kind: m.kind || '',
        junle: m.junle || '',
        cook: m.cook || '',
        time: m.time || '',
        imageUrl: m.imageUrl || '',
        menuType: m.menuType || 'single',
        setImages: Array.isArray(m.setMenus) ? m.setMenus.map((x) => x?.imageUrl).filter(Boolean) : [],
        url: m.url || '',
        by: null,
        sourceType: '',
        canEdit: myEditableMenuIds.has(m._id.toString()),
        ingredientIds,
        season: normalizeSeasonList(m.season)
      });
    });
    (filteredSharedUserMenus || []).forEach((mm) => {
      const m = mm.menu || null;
      if (!m || !m._id) return;
      const id = m._id.toString();
      const byName = (mm.user?.displayname || mm.user?.username || '') || null;
      const ingredientIds = pickIngredientIds(m);
      const existing = combinedMap.get(id);
      if (existing) {
        if (!existing.by && byName) existing.by = byName;
        existing.canEdit = existing.canEdit || myEditableMenuIds.has(id);
        if (!existing.menuType && m.menuType) existing.menuType = m.menuType;
        if (!existing.sourceType && mm.sourceType) existing.sourceType = mm.sourceType;
        if ((!existing.setImages || !existing.setImages.length) && Array.isArray(m.setMenus)) {
          existing.setImages = m.setMenus.map((x) => x?.imageUrl).filter(Boolean);
        }
        if (ingredientIds.length) {
          const merged = new Set([...(existing.ingredientIds || []), ...ingredientIds]);
          existing.ingredientIds = Array.from(merged);
        }
        const seasons = normalizeSeasonList(m.season);
        if (seasons.length) {
          const mergedSeason = new Set([...(existing.season || []), ...seasons]);
          existing.season = Array.from(mergedSeason);
        }
      } else {
        combinedMap.set(id, {
          id,
          name: m.name || '',
          menu: m.menu || '',
          kind: m.kind || '',
          junle: m.junle || '',
          cook: m.cook || '',
          time: m.time || '',
          imageUrl: m.imageUrl || '',
          menuType: m.menuType || 'single',
          setImages: Array.isArray(m.setMenus) ? m.setMenus.map((x) => x?.imageUrl).filter(Boolean) : [],
          url: m.url || '',
          by: byName,
          sourceType: mm.sourceType || '',
          canEdit: myEditableMenuIds.has(id),
          ingredientIds,
          season: normalizeSeasonList(m.season)
        });
      }
    });

    const combinedIds = Array.from(combinedMap.keys());
    if (combinedIds.length) {
      const sourceTypeDocs = await Mymenu.find({
        menu: { $in: combinedIds },
        sourceType: { $in: ['original', 'url'] }
      }).select('menu sourceType').lean();
      const sourceTypeByMenu = {};
      (sourceTypeDocs || []).forEach((doc) => {
        const id = doc?.menu ? String(doc.menu) : '';
        if (!id) return;
        const current = sourceTypeByMenu[id] || '';
        if (doc.sourceType === 'original') {
          sourceTypeByMenu[id] = 'original';
        } else if (!current) {
          sourceTypeByMenu[id] = 'url';
        }
      });
      combinedMap.forEach((item, id) => {
        if (!item) return;
        if (!item.sourceType && sourceTypeByMenu[id]) {
          item.sourceType = sourceTypeByMenu[id];
        }
      });
    }

    let list = Array.from(combinedMap.values());
    const now = new Date();
    const month = now.getMonth() + 1;
    const currentSeason = monthToSeason(month);
    const currentMonthLabel = `${month}月`;

    if (onlySeasonalByMonth) {
      const seasonMatchIds = new Set(
        list
          .filter((it) => normalizeSeasonList(it.season || []).includes(currentSeason))
          .map((it) => String(it.id))
      );
      const allIngredientIds = new Set();
      list.forEach((it) => {
        (it.ingredientIds || []).forEach((id) => allIngredientIds.add(id));
      });
      let seasonalIds = new Set();
      if (allIngredientIds.size > 0) {
        const seasonalIngredients = await Ingredient.find({
          _id: { $in: Array.from(allIngredientIds) },
          month: { $exists: true, $ne: [] }
        }).select('month').lean();
        seasonalIds = new Set(
          (seasonalIngredients || [])
            .filter((ing) => {
              const months = Array.isArray(ing.month) ? ing.month : [];
              // Ignore "all" — only explicit month match
              return !months.includes('all') && months.includes(currentMonthLabel);
            })
            .map((ing) => ing._id.toString())
        );
      }
      list = list.filter((it) => {
        if (seasonMatchIds.has(String(it.id))) return true;
        return (it.ingredientIds || []).some((id) => seasonalIds.has(id));
      });
    } else if (onlySeasonal) {
      const seasonMatchIds = new Set(
        list
          .filter((it) => normalizeSeasonList(it.season || []).includes(currentSeason))
          .map((it) => String(it.id))
      );
      const allIngredientIds = new Set();
      list.forEach((it) => {
        (it.ingredientIds || []).forEach((id) => allIngredientIds.add(id));
      });
      let seasonalIds = new Set();
      if (allIngredientIds.size > 0) {
        const seasonalIngredients = await Ingredient.find({
          _id: { $in: Array.from(allIngredientIds) },
          season: { $exists: true, $ne: [] }
        }).select('season').lean();
        seasonalIds = new Set(
          (seasonalIngredients || [])
            .filter((ing) => {
              const seasons = Array.isArray(ing.season) ? ing.season : [];
              // Exclude "all" and only pick ingredients that explicitly mark the current season
              return !seasons.includes('all') && seasons.includes(currentSeason);
            })
            .map((ing) => ing._id.toString())
        );
      }
      list = list.filter((it) => {
        if (seasonMatchIds.has(String(it.id))) return true;
        return (it.ingredientIds || []).some((id) => seasonalIds.has(id));
      });
    }

    if (onlyOriginalMenu || onlySetMenu || onlyArrangeMenu) {
      list = list.filter((it) => {
        const ownType = (myOwnTypes && myOwnTypes[String(it.id)]) || '';
        const menuType = String(it.menuType || 'single');
        const isOriginal = ownType === 'original' || String(it.sourceType || '') === 'original';
        const isSet = menuType === 'set' || (Array.isArray(it.setImages) && it.setImages.length > 0);
        const isArrange = menuType === 'arrange';
        if (onlyOriginalMenu && isOriginal) return true;
        if (onlySetMenu && isSet) return true;
        if (onlyArrangeMenu && isArrange) return true;
        return false;
      });
    }

    // 絞り込み：fav = all | mine | not
    const favSet = new Set(myMenuIds || []);
    if (fav === 'mine') {
      list = list.filter((it) => favSet.has(String(it.id)));
    } else if (fav === 'not') {
      list = list.filter((it) => !favSet.has(String(it.id)));
    }
    const resultCount = list.length;
    const favoritesCount = myMenuIds.length;

    // UI用：fav=mine の場合は種類/ジャンル/調理方法の選択状態を空にして表示
    res.render('users/myMenuShared', {
      kinds, junles, cooks, menuContents,
      selected: {
        kind,
        junle,
        cook,
        menuContent,
        keyword,
        fav,
        seasonal: onlySeasonal,
        seasonalMonth: onlySeasonalByMonth,
        originalMenu: onlyOriginalMenu,
        setMenu: onlySetMenu,
        arrangeMenu: onlyArrangeMenu
      },
      list,
      resultCount,
      myMenuIds,
      favoritesCount,
      myOwnTypes,
      myMenuFreq
    });
  } catch (err) { next(err); }
});

// 自分のマイメニュー一覧（myMenuSharedの絞り込みをmineで表示）
router.get('/mine', (req, res) => {
  const base = '/users/my-menu/shared-register';
  const query = new URLSearchParams({ fav: 'mine' });
  res.redirect(`${base}?${query.toString()}`);
});

// カレンダーに割当: メニューを指定日・食事区分へ追加
router.post('/assign-to-plan', express.json(), async (req, res, next) => {
  try {
    const { menuId, dateISO, mealType, groupId: bodyGroup, replaceSlotId } = req.body || {};
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = bodyGroup || defaultGroupId || (groups[0]?._id?.toString() ?? '');
    if (!groupId || !groups.some((g) => String(g._id) === String(groupId))) return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    if (!menuId) return res.status(400).json({ error: 'menuId を指定してください。' });
    if (!dateISO) return res.status(400).json({ error: '日付を指定してください。' });
    if (!['breakfast','lunch','dinner'].includes(String(mealType))) return res.status(400).json({ error: '不正な食事区分です。' });

    const parseDate = (v) => {
      if (!v) return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(0,0,0,0);
      return d;
    };
    const date = parseDate(dateISO);
    if (!date) return res.status(400).json({ error: '不正な日付です。' });

    const startOfWeek = (value) => { const dt = new Date(value); dt.setHours(0,0,0,0); const day = dt.getDay(); const offset = (day + 6) % 7; dt.setDate(dt.getDate() - offset); return dt; };
    const weekStart = startOfWeek(date);
    // Find or create weekly plan for this group/week
    let plan = await WeeklyMenuPlan.findOne({ group: groupId, weekStart }).exec();
    if (!plan) {
      plan = new WeeklyMenuPlan({ group: groupId, createdBy: req.user._id, weekStart, dayPlans: [] });
    }

    // Compute dayIndex relative to weekStart (Monday=0)
    const diff = Math.round((date.getTime() - weekStart.getTime()) / (24*60*60*1000));
    const dayIndex = Number.isInteger(diff) ? diff : 0;

    // map mealType -> slotType
    const slotTypeMap = { breakfast: 'breakfast-main', lunch: 'lunch-main', dinner: 'dinner-main' };
    const slotType = slotTypeMap[mealType] || 'dinner-main';

    // Find or create dayPlan
    let dayPlan = (plan.dayPlans || []).find((d) => d.dayIndex === dayIndex);
    if (!dayPlan) {
      dayPlan = { dayIndex, date, mealType, slots: [] };
      plan.dayPlans.push(dayPlan);
    }

    // Push or replace slot by stable slot id
    dayPlan.slots = dayPlan.slots || [];
    let replaced = false;
    let replacedSlotId = null;
    if (replaceSlotId) {
      // try subdoc id lookup
      let found = null;
      try {
        if (dayPlan.slots && typeof dayPlan.slots.id === 'function') {
          found = dayPlan.slots.id(replaceSlotId);
        }
      } catch (_) { found = null; }
      if (!found) {
        for (let i = 0; i < dayPlan.slots.length; i++) {
          const s = dayPlan.slots[i];
          if (s && s._id && String(s._id) === String(replaceSlotId)) { found = s; break; }
        }
      }
      if (found) {
        found.slotType = slotType;
        found.menu = menuId;
        replaced = true;
        replacedSlotId = String(found._id || replaceSlotId);
      }
    }
    if (!replaced) {
      const slot = { slotType, menu: menuId };
      dayPlan.slots.push(slot);
    }

    await plan.save();

    // Notify group members about plan addition (simple notification)
    try {
      const menuDoc = await Menu.findById(menuId).select('name').lean();
      await scheduleMyMenuAdded({ actorId: req.user._id, groupId, menuNames: [menuDoc?.name || ''] });
    } catch (e) { /* ignore notify errors */ }

    return res.json({ success: true, planId: plan._id, weekStart: plan.weekStart, replaced, replacedSlotId });
  } catch (err) {
    return next(err);
  }
});

// Get existing slots for a given date & meal (for comparison UI)
router.get('/plan-slots', async (req, res, next) => {
  try {
    const { dateISO, mealType, groupId: qGroup } = req.query || {};
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = qGroup || defaultGroupId || (groups[0]?._id?.toString() ?? '');
    if (!groupId || !groups.some((g) => String(g._id) === String(groupId))) return res.status(403).json({ error: 'このグループに対する権限がありません。' });
    if (!dateISO) return res.status(400).json({ error: '日付を指定してください。' });
    if (!['breakfast','lunch','dinner'].includes(String(mealType))) return res.status(400).json({ error: '不正な食事区分です。' });

    const d = new Date(dateISO);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: '不正な日付です。' });
    const startOfWeek = (value) => { const dt = new Date(value); dt.setHours(0,0,0,0); const day = dt.getDay(); const offset = (day + 6) % 7; dt.setDate(dt.getDate() - offset); return dt; };
    const weekStart = startOfWeek(d);
    const diff = Math.round((d.setHours(0,0,0,0) - weekStart.getTime()) / (24*60*60*1000));
    const dayIndex = Number.isInteger(diff) ? diff : 0;

    const plan = await WeeklyMenuPlan.findOne({ group: groupId, weekStart }).lean();
    if (!plan) return res.json({ slots: [] });
    const dayPlan = (plan.dayPlans || []).find((p) => Number(p.dayIndex) === Number(dayIndex) && String(p.mealType) === String(mealType));
    if (!dayPlan) return res.json({ slots: [] });
    const slots = (dayPlan.slots || []).map((s, idx) => ({
      index: idx,
      slotId: s._id ? String(s._id) : '',
      slotType: s.slotType,
      menuId: String(s.menu)
    }));
    // populate menu info
    const menuIds = Array.from(new Set(slots.map((s) => s.menuId).filter(Boolean)));
    const menus = menuIds.length ? await Menu.find({ _id: { $in: menuIds } }).select('name imageUrl').lean() : [];
    const menuMap = new Map((menus||[]).map(m => [String(m._id), { name: m.name || '', imageUrl: m.imageUrl || '' }]));
    const out = slots.map(s => ({ index: s.index, slotId: s.slotId, slotType: s.slotType, menuId: s.menuId, name: menuMap.get(s.menuId)?.name || '', imageUrl: menuMap.get(s.menuId)?.imageUrl || '' }));
    return res.json({ slots: out });
  } catch (err) { return next(err); }
});

// メニュー情報取得（比較用）
router.get('/menu-info', async (req, res, next) => {
  try {
    const { menuId } = req.query || {};
    if (!menuId) return res.status(400).json({ error: 'menuId を指定してください' });
    if (!mongoose.Types.ObjectId.isValid(menuId)) return res.status(400).json({ error: 'menuId が不正です' });
    const menu = await Menu.findById(menuId)
      .select('name time ingredients seasoning imageUrl')
      .populate({ path: 'ingredients.name', select: 'ingredient unit' })
      .populate({ path: 'seasoning.name', select: 'seasoning unit' })
      .lean();
    if (!menu) return res.status(404).json({ error: 'メニューが見つかりません' });
    const ingredients = (menu.ingredients || []).map((it) => ({ ingredient: it.name?.ingredient || '', amount: it.amount || '', unit: it.unit || '' }));
    const seasonings = (menu.seasoning || []).map((it) => ({ seasoning: it.name?.seasoning || '', amount: it.amount || '', unit: it.unit || '' }));
    return res.json({ menu: { id: String(menu._id), name: menu.name || '', time: menu.time || '', imageUrl: menu.imageUrl || '', ingredients, seasonings } });
  } catch (err) { return next(err); }
});

// 共有メニューをマイメニューへ登録
router.post('/shared-register', async (req, res, next) => {
  try {
    const { menuId, favorite = 'false', frequency = '3' } = req.body;
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/users/my-menu/shared-register');
    }
    const menu = await Menu.findById(menuId).lean();
    if (!menu) {
      req.flash('error', '対象のメニューが見つかりません');
      return res.redirect('/users/my-menu/shared-register');
    }

    const created = await Mymenu.create({
      menu: menu._id,
      favorite: String(favorite) === 'true',
      frequency: Math.max(1, Math.min(5, Number(frequency) || 3)),
      sourceType: 'shared',
      user: req.user._id,
      group: groupId
    });
    // 通知に積む
    await scheduleMyMenuAdded({ actorId: req.user._id, groupId, menuNames: [menu.name || ''] });
    req.flash('success', 'マイメニューに登録しました');
    res.redirect('/users/my-menu');
  } catch (err) { next(err); }
});

// レシピサイトから登録 画面
router.get('/from-url', async (req, res, next) => {
  try {
    const { kinds, junles, cooks } = await getFacetLists();
    // 現在の登録件数
    const myUrlCount = await Mymenu.countDocuments({ user: req.user._id, sourceType: 'url' });
    const menuNames = await Menu.find().distinct('menu');
    // グループ表示スコープ: グローバル(=groupなし) + 自分のグループ
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    const groupScope = groupId
      ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] }
      : {};
    const ingredients = await Ingredient.find(groupScope).select('ingredient classification unit imageUrl').lean();
    const seasonings = await Seasoning.find(groupScope).select('seasoning classification unit imageUrl').lean();
    const allUnits = Array.from(new Set([
      ...((ingredients||[]).flatMap(i=>Array.isArray(i.unit)?i.unit:i.unit? [i.unit]:[])),
      ...((seasonings||[]).flatMap(s=>Array.isArray(s.unit)?s.unit:s.unit? [s.unit]:[]))
    ].filter(Boolean)));
    res.render('users/myMenuUrl', { kinds, junles, cooks, myUrlCount, menuNames, ingredients, seasonings, allUnits });
  } catch (err) { next(err); }
});

// メタ取得（簡易OGP抽出）
router.post('/from-url/fetch', express.json(), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'URLを指定してください' });
    }
    let host = '';
    try { host = new URL(url).hostname || ''; } catch (_) { host = ''; }
    const duplicate = await Menu.findOne({ url }).select('_id name').lean();
    if (duplicate) {
      return res.json({ duplicate: true, name: duplicate.name || '' });
    }
    // Node18+ fetch 前提。ネットワーク不可環境では失敗しうる
    const resp = await fetch(url, { method: 'GET' });
    const html = await resp.text();
    const pickOg = (name) => {
      const rgx = new RegExp(`<meta[^>]+(?:property|name)=["']og:${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
      const m = html.match(rgx);
      return m ? m[1] : '';
    };
    const pickTwitter = (name) => {
      const rgx = new RegExp(`<meta[^>]+(?:property|name)=["']twitter:${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
      const m = html.match(rgx);
      return m ? m[1] : '';
    };
    const title = pickOg('title') || pickTwitter('title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '');
    let image = pickOg('image') || pickTwitter('image') || pickTwitter('image:src') || '';

    // Helpers for structured data
    const parseISODurationToMinutes = (value) => {
      if (!value || typeof value !== 'string') return null;
      // PT1H30M, PT45M, PT2H, P0DT30M, etc.
      const m = value.match(/P(?:\d+Y)?(?:\d+M)?(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
      if (!m) return null;
      const h = parseInt(m[1] || '0', 10);
      const min = parseInt(m[2] || '0', 10);
      const s = parseInt(m[3] || '0', 10);
      const total = h * 60 + min + (s ? Math.round(s / 60) : 0);
      return total || null;
    };
    const toHalfWidth = (str) => str.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));

    let time = null; // minutes
    let people = null; // number
    let comment = '';

    // Kurashiru (and similar) fallback: use <video ... poster="...">
    if (!image) {
      try {
        const posterMatch = html.match(/<video[^>]+poster=["']([^"']+)["'][^>]*>/i);
        if (posterMatch && posterMatch[1] && /kurashiru\.com/i.test(host)) {
          image = posterMatch[1];
        } else if (posterMatch && posterMatch[1]) {
          // As a general fallback if no OGP found, accept poster
          image = posterMatch[1];
        }
      } catch (_e) {
        // ignore URL parse errors
      }
    }

    // Parse JSON-LD blocks for Recipe data (image/time/people/ingredients/instructions)
    const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    const parseBlocks = [];
    for (const block of jsonLdMatches) {
      try {
        const jsonText = block.replace(/^[\s\S]*?>/, '').replace(/<\/(?:script)>[\s\S]*$/, '');
        const data = JSON.parse(jsonText);
        parseBlocks.push(data);
      } catch (_) { /* ignore JSON parse error */ }
    }

    const flatten = (x) => (Array.isArray(x) ? x : [x]).filter(Boolean);
    const matchType = (obj, typeName) => {
      const t = obj && obj['@type'];
      if (!t) return false;
      return (Array.isArray(t) ? t : [t]).some((v) => String(v).toLowerCase() === typeName.toLowerCase());
    };
    let recipe = null;
    const walk = (node) => {
      if (!node || recipe) return;
      if (typeof node !== 'object') return;
      if (matchType(node, 'Recipe')) { recipe = node; return; }
      Object.values(node).forEach((v) => {
        if (recipe) return; if (v && typeof v === 'object') walk(v);
      });
    };
    parseBlocks.forEach((d) => walk(d));

    if (recipe) {
      // Prefer image from Recipe if still empty
      if (!image) {
        if (typeof recipe.image === 'string') image = recipe.image;
        else if (Array.isArray(recipe.image) && recipe.image.length) image = recipe.image[0];
        else if (recipe.image && typeof recipe.image === 'object' && recipe.image.url) image = recipe.image.url;
        else if (typeof recipe.thumbnailUrl === 'string') image = recipe.thumbnailUrl;
      }
      // Time
      time = parseISODurationToMinutes(recipe.totalTime) || parseISODurationToMinutes(recipe.cookTime) || parseISODurationToMinutes(recipe.prepTime) || time;
      // People
      const yieldRaw = recipe.recipeYield || recipe.yield || null;
      if (yieldRaw) {
        const text = toHalfWidth(String(Array.isArray(yieldRaw) ? yieldRaw[0] : yieldRaw));
        const m = text.match(/(\d+)/);
        if (m) people = parseInt(m[1], 10) || null;
      }
      // Comment (材料 + 作り方)
      try {
        const ingredients = flatten(recipe.recipeIngredient).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
        const collectSteps = (ri) => {
          if (!ri) return [];
          const arr = flatten(ri);
          const out = [];
          for (const step of arr) {
            if (!step) continue;
            if (typeof step === 'string') { out.push(step.trim()); continue; }
            if (Array.isArray(step)) { step.forEach((x) => { if (typeof x === 'string') out.push(x.trim()); }); continue; }
            if (step['@type'] && String(step['@type']).toLowerCase() === 'howtostep' && step.text) {
              out.push(String(step.text).trim());
              continue;
            }
            if (step.itemListElement) {
              flatten(step.itemListElement).forEach((el) => {
                if (typeof el === 'string') out.push(el.trim());
                else if (el && el.text) out.push(String(el.text).trim());
              });
            }
          }
          return out.filter(Boolean);
        };
        const steps = collectSteps(recipe.recipeInstructions);
        if (ingredients.length || steps.length) {
          const parts = [];
          if (ingredients.length) {
            parts.push('材料');
            ingredients.forEach((line) => parts.push(`・${line}`));
          }
          if (steps.length) {
            if (parts.length) parts.push('');
            parts.push('作り方');
            steps.forEach((line, idx) => parts.push(`${idx + 1}. ${line}`));
          }
          comment = parts.join('\n');
        }
      } catch (_) { /* ignore */ }
    }

    // If still no image, try JSON-LD generic blocks (thumbnailUrl/image)
    if (!image) {
      for (const data of parseBlocks) {
        const list = Array.isArray(data) ? data : [data];
        for (const obj of list) {
          if (obj && typeof obj === 'object') {
            if (typeof obj.thumbnailUrl === 'string' && obj.thumbnailUrl) { image = obj.thumbnailUrl; break; }
            if (obj.image && typeof obj.image === 'string') { image = obj.image; break; }
            if (obj.image && Array.isArray(obj.image) && obj.image.length) { image = obj.image[0]; break; }
          }
        }
        if (image) break;
      }
    }

    // Heuristic fallbacks for time & people if still missing
    if (!time) {
      const m = html.match(/(?:調理時間|所要時間)[^\d]*(\d+)\s*分/i);
      const mh = html.match(/(?:調理時間|所要時間)[^\d]*(\d+)\s*時間(?:\s*(\d+)\s*分)?/i);
      if (mh) {
        const h = parseInt(mh[1] || '0', 10);
        const mm = parseInt(mh[2] || '0', 10);
        time = h * 60 + mm;
      } else if (m) {
        time = parseInt(m[1] || '0', 10) || null;
      }
    }
    if (!people) {
      const mp = html.match(/([0-9０-９]+)\s*人分/i) || html.match(/([0-9０-９]+)\s*人(?![\w一-龥])/i);
      if (mp) {
        const n = parseInt(toHalfWidth(mp[1] || ''), 10);
        if (!Number.isNaN(n)) people = n;
      }
    }

    // Site-specific: sirogohan.com — extract 材料/作り方 sections and optional servings
    if (/sirogohan\.com$/i.test(host)) {
      const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+$/g, '').trim();
      const pickSection = (titleRx) => {
        const rx = new RegExp(`<h[1-6][^>]*>\n?\s*([^<]*${titleRx}[^<]*)<\/h[1-6]>`, 'i');
        const m = html.match(rx);
        if (!m) return '';
        const startIdx = m.index + m[0].length;
        const rest = html.slice(startIdx);
        const nextHead = rest.search(/<h[1-6][^>]*>/i);
        const block = nextHead >= 0 ? rest.slice(0, nextHead) : rest;
        // collect list items first, fallback to paragraphs
        const lis = Array.from(block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (lis.length) return lis.join('\n');
        const ps = Array.from(block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        return ps.join('\n');
      };
      // 材料セクション（「材料」含む見出し）
      const ingText = pickSection('材料');
      // 作り方セクション
      const howText = pickSection('作り方');
      if (!comment && (ingText || howText)) {
        const parts = [];
        if (ingText) {
          parts.push('材料');
          ingText.split(/\n+/).forEach((line) => { if (line) parts.push(`・${line}`); });
        }
        if (howText) {
          if (parts.length) parts.push('');
          parts.push('作り方');
          howText.split(/\n+/).forEach((line, idx) => { if (line) parts.push(`${idx + 1}. ${line}`); });
        }
        comment = parts.join('\n');
      }
      // 人数の表記が「◯合分」の場合でも拾っておく（人数未取得時のみ）
      if (!people) {
        const mg = html.match(/([0-9０-９]+)\s*合分/i);
        if (mg) {
          const n = parseInt(toHalfWidth(mg[1] || ''), 10);
          if (!Number.isNaN(n)) people = n; // 備考: 合→人数の換算はせず、そのまま数値を設定
        }
      }
    }

    // Site-specific: oceans-nadia.com — try to extract time, 材料, 作り方
    if (/oceans-nadia\.com$/i.test(host)) {
      const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+$/g, '').trim();
      // Prefer explicit cook time in the main time header
      try {
        const cookMain = html.match(/<h2[^>]+class=["'][^"']*RecipeInfo_cookTimeMain[^"']*["'][^>]*>[\s\S]*?<span[^>]*>\s*([0-9０-９]+)[\s\S]*?分\s*<\/span>/i);
        if (cookMain) {
          const n = parseInt(toHalfWidth(cookMain[1] || ''), 10);
          if (!Number.isNaN(n)) time = n; // override with precise minutes shown in header
        }
      } catch(_) { /* ignore */ }
      // time near clock icon
      if (!time) {
        // Look around icons like fa-clock/icon-time, capture H/M patterns
        const m1 = html.match(/<(?:i|svg)[^>]+(?:fa-?clock|icon-?time)[^>]*>[\s\S]{0,400}?([0-9０-９]+)\s*(時間|分)/i);
        if (m1) {
          const n = parseInt(toHalfWidth(m1[1] || ''), 10);
          if (!Number.isNaN(n)) time = m1[2] === '時間' ? (n * 60) : n;
        } else {
          // Generic fallback within a time badge
          const m2 = html.match(/(?:調理時間|所要時間|時間|約)\s*[:：]?\s*([0-9０-９]+)\s*(時間|分)/i);
          if (m2) {
            const n = parseInt(toHalfWidth(m2[1] || ''), 10);
            if (!Number.isNaN(n)) time = m2[2] === '時間' ? (n * 60) : n;
          } else {
            // Fallback: pick the first small "NN分" occurrence
            const m3 = html.match(/([0-9０-９]{1,3})\s*分(?!\w)/i);
            if (m3) {
              const n = parseInt(toHalfWidth(m3[1] || ''), 10);
              if (!Number.isNaN(n) && n > 0 && n <= 300) time = n;
            }
          }
        }
      }
      // Build sections by headings
      const pickSection = (titleRx) => {
        // Nadia often uses h2/h3 or definition lists around sections
        const rx = new RegExp(`<h[1-6][^>]*>\n?\s*([^<]*${titleRx}[^<]*)<\/h[1-6]>`, 'i');
        const m = html.match(rx);
        if (!m) return '';
        const startIdx = m.index + m[0].length;
        const rest = html.slice(startIdx);
        // stop at next heading
        const nextHead = rest.search(/<h[1-6][^>]*>/i);
        const block = nextHead >= 0 ? rest.slice(0, nextHead) : rest;
        // li list
        const lis = Array.from(block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (lis.length) return lis.join('\n');
        // table rows
        const trs = Array.from(block.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)).map((tr) => stripTags(tr[0])).filter(Boolean);
        if (trs.length) return trs.join('\n');
        // dl list
        const dds = Array.from(block.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (dds.length) return dds.join('\n');
        // paragraphs
        const ps = Array.from(block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        return ps.join('\n');
      };
      let ingText = pickSection('材料');
      // If not found, look for a UL near any "材料" text (non-heading)
      if (!ingText) {
        const near = html.match(/材料[\s\S]{0,800}?<ul[\s\S]*?<\/ul>/i);
        if (near) {
          const block = near[0];
          const lis = Array.from(block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
          if (lis.length) ingText = lis.join('\n');
        }
      }
      // If still not, scan for an ingredients container by class name
      if (!ingText) {
        const container = html.match(/<(section|div)[^>]+(?:ingredient|ingredients|\u6750\u6599)[^>]*>[\s\S]*?<\/(?:section|div)>/i);
        if (container) {
          const bl = container[0];
          const lis = Array.from(bl.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
          if (lis.length) ingText = lis.join('\n');
          else {
            const dds = Array.from(bl.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
            if (dds.length) ingText = dds.join('\n');
          }
        }
      }
      const howText = pickSection('作り方');
      // If not found, attempt to find ordered/unordered lists near "作り方"
      let howOut = howText;
      if (!howOut) {
        const near = html.match(/作り方[\s\S]{0,1200}?(<ol[\s\S]*?<\/ol>|<ul[\s\S]*?<\/ul>)/i);
        if (near) {
          const block = near[1] || near[0];
          const lis = Array.from(block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
          if (lis.length) howOut = lis.join('\n');
        }
        if (!howOut) {
          const ps = Array.from((html.match(/作り方[\s\S]{0,1200}?((?:<p[\s\S]*?<\/p>)+)/i) || [])[1]?.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi) || []).map((x)=> stripTags(x[1])).filter(Boolean);
          if (ps.length) howOut = ps.join('\n');
        }
      }
      if (!comment && (ingText || howText)) {
        const parts = [];
        if (ingText) {
          parts.push('材料');
          ingText.split(/\n+/).forEach((line) => { if (line) parts.push(`・${line}`); });
        }
        if (howOut) {
          if (parts.length) parts.push('');
          parts.push('作り方');
          howOut.split(/\n+/).forEach((line, idx) => { if (line) parts.push(`${idx + 1}. ${line}`); });
        }
        comment = parts.join('\n');
      }
      // 人数: 見出しや材料の括弧表記から
      if (!people) {
        const mp = html.match(/材料[^<\n]*?\(([0-9０-９]+)\s*人分\)/i) || html.match(/([0-9０-９]+)\s*人分/i);
        if (mp) {
          const n = parseInt(toHalfWidth(mp[1] || ''), 10);
          if (!Number.isNaN(n)) people = n;
        }
      }
    }

    // Site-specific: daidokolog.pal-system.co.jp — extract 材料/作り方 into comment
    if (/daidokolog\.pal-system\.co\.jp$/i.test(host)) {
      const stripTags = (s) => s.replace(/<\/?(script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
                                .replace(/<[^>]*>/g, '')
                                .replace(/\u00a0/g, ' ')
                                .replace(/\s+$/g, '')
                                .trim();
      const pickSectionByHeading = (titleRx) => {
        const rx = new RegExp(`<h[1-6][^>]*>\n?\s*([^<]*${titleRx}[^<]*)<\/h[1-6]>`, 'i');
        const m = html.match(rx);
        if (!m) return '';
        const startIdx = m.index + m[0].length;
        const rest = html.slice(startIdx);
        const nextHead = rest.search(/<h[1-6][^>]*>/i);
        const block = nextHead >= 0 ? rest.slice(0, nextHead) : rest;
        const lis = Array.from(block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (lis.length) return lis.join('\n');
        const dds = Array.from(block.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (dds.length) return dds.join('\n');
        const trs = Array.from(block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (trs.length) return trs.join('\n');
        const ps = Array.from(block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        return ps.join('\n');
      };
      const pickNearLabel = (labelRx, span = 1200) => {
        const near = html.match(new RegExp(`${labelRx}[\\s\\S]{0,${span}}?(<ol[\\s\\S]*?<\\/ol>|<ul[\\s\\S]*?<\\/ul>|<table[\\s\\S]*?<\\/table>|((?:<p[\\s\\S]*?<\\/p>)+))`, 'i'));
        if (!near) return '';
        const block = near[1] || near[0];
        const lis = Array.from(block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (lis.length) return lis.join('\n');
        const cells = Array.from(block.matchAll(/<(?:td|th|dd)[^>]*>([\s\S]*?)<\/(?:td|th|dd)>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (cells.length) return cells.join('\n');
        const ps = Array.from((near[2] || '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (ps.length) return ps.join('\n');
        return '';
      };

      let ingText = '';
      // Strong selector: section.sec.ingredient table rows th + td
      const secIng = html.match(/<section[^>]+class=["'][^"']*\bsec\b[^"']*\bingredient\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i);
      if (secIng) {
        const tbody = secIng[1];
        const rows = Array.from(tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
        const lines = [];
        rows.forEach((r) => {
          const row = r[1] || '';
          const th = (row.match(/<th[^>]*>([\s\S]*?)<\/th>/i) || [])[1] || '';
          const td = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || '';
          const left = stripTags(th);
          const right = stripTags(td);
          const line = [left, right].filter(Boolean).join(' ');
          if (line) lines.push(line);
        });
        if (lines.length) ingText = lines.join('\n');
      }
      if (!ingText) ingText = pickSectionByHeading('材料');
      if (!ingText) ingText = pickNearLabel('材料');
      if (!ingText) {
        const ingContainer = html.match(/<(section|div)[^>]+(?:ingredient|ingredients|\u6750\u6599)[^>]*>[\s\S]*?<\/(?:section|div)>/i);
        if (ingContainer) {
          const bl = ingContainer[0];
          const lis = Array.from(bl.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          const dds = Array.from(bl.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          if (lis.length) ingText = lis.join('\n');
          else if (dds.length) ingText = dds.join('\n');
        }
      }

      let howText = '';
      // Strong selector: section.sec.making then div.text[itemprop=recipeInstructions]
      const secMak = html.match(/<section[^>]+class=["'][^"']*\bsec\b[^"']*\bmaking\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i);
      if (secMak) {
        const block = secMak[1];
        const texts = Array.from(block.matchAll(/<div[^>]+class=["'][^"']*text[^"']*["'][^>]*itemprop=["']recipeInstructions["'][^>]*>([\s\S]*?)<\/div>/gi));
        const steps = [];
        texts.forEach((m) => {
          let raw = m[1] || '';
          raw = raw.replace(/<br\s*\/?>(?:\s*<br\s*\/?>)*/gi, '\n');
          const txt = stripTags(raw);
          if (txt) steps.push(txt);
        });
        if (steps.length) howText = steps.join('\n');
      }
      if (!howText) howText = pickSectionByHeading('作り方');
      if (!howText) howText = pickNearLabel('作り方');
      if (!howText) {
        const howContainer = html.match(/<(section|div)[^>]+(?:instruction|howto|method|\u4f5c\u308a\u65b9)[^>]*>[\s\S]*?<\/(?:section|div)>/i);
        if (howContainer) {
          const bl = howContainer[0];
          const lis = Array.from(bl.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          const ps = Array.from(bl.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          howText = lis.length ? lis.join('\n') : (ps.length ? ps.join('\n') : '');
        }
      }

      if (!comment && (ingText || howText)) {
        const parts = [];
        if (ingText) {
          parts.push('材料');
          ingText.split(/\n+/).forEach((line) => { if (line) parts.push(`・${line}`); });
        }
        if (howText) {
          if (parts.length) parts.push('');
          parts.push('作り方');
          howText.split(/\n+/).forEach((line, idx) => { if (line) parts.push(`${idx + 1}. ${line}`); });
        }
        comment = parts.join('\n');
      }
    }

    // Site-specific: sotorecipe.com — extract 材料/作り方 into comment
    if (/sotorecipe\.com$/i.test(host)) {
      const stripTags = (s) => s
        .replace(/<\/?(script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
        .replace(/<br\s*\/?>(?:\s*<br\s*\/?>)*/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+$/g, '')
        .trim();

      const pickNearLabel = (labelRx, span = 1500) => {
        const near = html.match(new RegExp(`${labelRx}[\\s\\S]{0,${span}}?(<ol[\\s\\S]*?<\\/ol>|<ul[\\s\\S]*?<\\/ul>|<table[\\s\\S]*?<\\/table>|((?:<p[\\s\\S]*?<\\/p>)+))`, 'i'));
        if (!near) return '';
        const block = near[1] || near[0];
        const lis = Array.from(block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (lis.length) return lis.join('\n');
        const rows = Array.from(block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (rows.length) return rows.join('\n');
        const ps = Array.from((near[2] || '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map((x) => stripTags(x[1])).filter(Boolean);
        if (ps.length) return ps.join('\n');
        return '';
      };

      // Ingredients: try itemprop=recipeIngredient first
      let ingLines = [];
      const ingByItemprop = Array.from(html.matchAll(/<(?:li|tr|div|span|p)[^>]*itemprop=["']recipeIngredient["'][^>]*>([\s\S]*?)<\/(?:li|tr|div|span|p)>/gi));
      if (ingByItemprop.length) {
        ingLines = ingByItemprop.map((m) => stripTags(m[1] || '')).filter(Boolean);
      }
      // Also handle table rows with itemprop on <tr>
      if (!ingLines.length) {
        const trItemprop = Array.from(html.matchAll(/<tr[^>]*itemprop=["']recipeIngredient["'][^>]*>([\s\S]*?)<\/tr>/gi));
        if (trItemprop.length) {
          ingLines = trItemprop.map((m) => stripTags(m[1] || '')).filter(Boolean);
        }
      }
      // Fallback to heading/text-near search
      let ingText = ingLines.join('\n');
      if (!ingText) ingText = pickNearLabel('材料');
      if (!ingText) {
        const ingContainer = html.match(/<(section|div)[^>]+(?:ingredient|ingredients|\u6750\u6599)[^>]*>[\s\S]*?<\/(?:section|div)>/i);
        if (ingContainer) {
          const bl = ingContainer[0];
          const lis = Array.from(bl.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          const dds = Array.from(bl.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          const trs = Array.from(bl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          ingText = lis.length ? lis.join('\n') : (dds.length ? dds.join('\n') : (trs.length ? trs.join('\n') : ''));
        }
      }

      // Instructions: try itemprop=recipeInstructions first
      let howLines = [];
      const instByItemprop = Array.from(html.matchAll(/<(?:li|div|span|p)[^>]*itemprop=["']recipeInstructions["'][^>]*>([\s\S]*?)<\/(?:li|div|span|p)>/gi));
      if (instByItemprop.length) {
        howLines = instByItemprop.map((m) => stripTags(m[1] || '')).filter(Boolean);
      }
      // Also capture OL/UL near 作り方 label
      let howText = howLines.join('\n');
      if (!howText) howText = pickNearLabel('作り方');
      if (!howText) {
        const instContainer = html.match(/<(section|div)[^>]+(?:instruction|howto|method|\u4f5c\u308a\u65b9)[^>]*>[\s\S]*?<\/(?:section|div)>/i);
        if (instContainer) {
          const bl = instContainer[0];
          const lis = Array.from(bl.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          const ps = Array.from(bl.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)).map((x)=>stripTags(x[1])).filter(Boolean);
          howText = lis.length ? lis.join('\n') : (ps.length ? ps.join('\n') : '');
        }
      }

      if (!comment && (ingText || howText)) {
        const parts = [];
        if (ingText) {
          parts.push('材料');
          ingText.split(/\n+/).forEach((line) => { if (line) parts.push(`・${line}`); });
        }
        if (howText) {
          if (parts.length) parts.push('');
          parts.push('作り方');
          howText.split(/\n+/).forEach((line, idx) => { if (line) parts.push(`${idx + 1}. ${line}`); });
        }
        comment = parts.join('\n');
      }
    }

    return res.json({ title, image, time, people, comment, duplicate: false });
  } catch (e) {
    return res.status(500).json({ error: 'メタ情報の取得に失敗しました' });
  }
});

// レシピサイトから登録 保存
router.post('/from-url', async (req, res, next) => {
  try {
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/users/my-menu/from-url');
    }

    const {
      name, yomi, menu, kind, junle, cook,
      url, imageUrl, time, people,
      // 食材・調味料: id配列/数量/単位（adminに準拠）
      ingredient_ids = [], ingredient_amounts = [], ingredient_units = [],
      seasoning_ids = [], seasoning_amounts = [], seasoning_units = [],
      favorite = 'false', frequency = '3',
      makeAhead = 'false',
      basicMenu = 'false',
      share = 'true', shareScope = 'all'
    } = req.body;

    const ingredients = (Array.isArray(ingredient_ids) ? ingredient_ids : [ingredient_ids]).filter(Boolean).map((id, i) => ({
      name: id,
      amount: Array.isArray(ingredient_amounts) ? ingredient_amounts[i] : ingredient_amounts,
      unit: Array.isArray(ingredient_units) ? ingredient_units[i] : ingredient_units
    }));
    const seasonings = (Array.isArray(seasoning_ids) ? seasoning_ids : [seasoning_ids]).filter(Boolean).map((id, i) => ({
      name: id,
      amount: Array.isArray(seasoning_amounts) ? seasoning_amounts[i] : seasoning_amounts,
      unit: Array.isArray(seasoning_units) ? seasoning_units[i] : seasoning_units
    }));

    // Duplicate guard by URL
    if (url) {
      const exists = await Menu.findOne({ url }).select('_id').lean();
      if (exists) {
        req.flash('error', 'このURLは既に登録されています');
        return res.redirect('/users/my-menu/from-url');
      }
    }

    const newMenu = await Menu.create({
      name, yomi, menu, kind, junle, cook,
      url, imageUrl, time, people: Number(people) || 1,
      servings: parseServings(req.body),
      ingredients, seasoning: seasonings,
      comment: req.body.comment || '',
      makeAhead: String(makeAhead) === 'true',
      basicMenu: String(basicMenu) === 'true',
      share: String(share) === 'true'
    });

    // URL 由来は一般公開不可
    const scope = (shareScope === 'all' ? 'all' : 'group');
    const publicToken = undefined;
    await Mymenu.create({
      menu: newMenu._id,
      favorite: String(favorite) === 'true',
      frequency: Math.max(1, Math.min(5, Number(frequency) || 3)),
      myurl: url || '',
      share: String(share) === 'true',
      shareScope: scope,
      ...(publicToken ? { publicToken } : {}),
      sourceType: 'url',
      user: req.user._id,
      group: groupId
    });
    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    await scheduleMyMenuAdded({ actorId: req.user._id, groupId, menuNames: [newMenu.name || ''] });
    await notifyAdminsMenuAdded({
      menu: newMenu,
      ingredientIds: ingredients.map((i) => i.name),
      seasoningIds: seasonings.map((s) => s.name),
      actor: req.user,
      groupId,
      baseUrl
    });

    req.flash('success', 'レシピサイトから登録しました');
    res.redirect('/users/my-menu');
  } catch (err) { next(err); }
});

// --- 食材/調味料 検索API（adminと同等のUI用） ---
router.get('/api/ingredients', async (req, res) => {
  const { keyword, genre, favorite, recent, meta, limit } = req.query;
  try {
    // return genre metadata only
    if (meta === 'genres') {
      const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
      const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
      const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
      const scope = groupId ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] } : {};
      const list = await Ingredient.find(scope).distinct('classification');
      return res.json({ genres: (list || []).filter(Boolean) });
    }
    if (recent === 'true') {
      const recentIngredients = await Ingredient.find({ used_date: { $exists: true } })
        .sort({ used_date: -1 })
        .limit(20);
      return res.json(recentIngredients);
    }

    // グローバル + 自グループ
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    const baseScope = groupId
      ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] }
      : {};

    const filter = { ...baseScope };
    if (keyword) {
      const keywordRegex = new RegExp(keyword, 'i');
      filter.$or = [
        { ingredient: keywordRegex },
        { yomi: keywordRegex },
        { classification: keywordRegex },
        { unit: { $in: [keywordRegex] } }
      ];
    }
    if (genre) filter.classification = genre;
    if (favorite === 'true') filter.favorite = true;

    const hardLimit = Number(limit) || (keyword ? 50 : 1000);
    const results = await Ingredient.find(filter).limit(hardLimit);
    const mappedResults = results.map(item => {
      const short_nutrition = item.energy
        ? `${item.energy}kcal P${item.protein || 0}g F${item.lipid || 0}g C${item.carbohydrate || 0}g`
        : '';
      return {
        ...item.toObject(),
        short_nutrition
      };
    });
    return res.json(mappedResults);
  } catch (e) {
    return res.status(500).json({ error: '取得に失敗しました' });
  }
});

router.get('/api/seasonings', async (req, res) => {
  const { keyword, genre, favorite, recent, meta, limit } = req.query;
  try {
    if (meta === 'genres') {
      const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
      const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
      const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
      const scope = groupId ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] } : {};
      const list = await Seasoning.find(scope).distinct('classification');
      return res.json({ genres: (list || []).filter(Boolean) });
    }
    if (recent === 'true') {
      const recentSeasonings = await Seasoning.find({ used_date: { $exists: true } })
        .sort({ used_date: -1 })
        .limit(20);
      return res.json(recentSeasonings);
    }

    // グローバル + 自グループ
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    const baseScope = groupId
      ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] }
      : {};

    const filter = { ...baseScope };
    if (keyword) {
      const keywordRegex = new RegExp(keyword, 'i');
      filter.$or = [
        { seasoning: keywordRegex },
        { yomi: keywordRegex },
        { classification: keywordRegex },
        { unit: { $in: [keywordRegex] } }
      ];
    }
    if (genre) filter.classification = genre;
    if (favorite === 'true') filter.favorite = true;

    const hardLimit = Number(limit) || (keyword ? 50 : 1000);
    const results = await Seasoning.find(filter).limit(hardLimit);
    const mappedResults = results.map(item => {
      const short_nutrition = item.energy
        ? `${item.energy}kcal P${item.protein || 0}g F${item.lipid || 0}g C${item.carbohydrate || 0}g`
        : '';
      return {
        ...item.toObject(),
        short_nutrition
      };
    });
    return res.json(mappedResults);
  } catch (e) {
    return res.status(500).json({ error: '取得に失敗しました' });
  }
});

// オリジナルレシピ登録 画面
router.get('/original', async (req, res, next) => {
  try {
    const { kinds, junles, cooks } = await getFacetLists();
    // 自分の登録件数
    const myOriginalCount = await Mymenu.countDocuments({ user: req.user._id, sourceType: 'original' });
    // 食材・調味料と単位候補（from-url と同等のUI用）
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    const groupScope = groupId
      ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] }
      : {};
    const ingredients = await Ingredient.find(groupScope).select('ingredient classification unit imageUrl').lean();
    const seasonings = await Seasoning.find(groupScope).select('seasoning classification unit imageUrl').lean();
    const allUnits = Array.from(new Set([
      ...((ingredients||[]).flatMap(i=>Array.isArray(i.unit)?i.unit:i.unit? [i.unit]:[])),
      ...((seasonings||[]).flatMap(s=>Array.isArray(s.unit)?s.unit:s.unit? [s.unit]:[]))
    ].filter(Boolean)));
    const menuNames = await Menu.find().distinct('menu');
    const setMenuCandidates = await Menu.find({ menuType: { $ne: 'set' }, isPrivate: { $ne: true } })
      .select('name menu kind junle cook imageUrl menuType')
      .lean();
    res.render('users/myMenuOriginal', { kinds, junles, cooks, myOriginalCount, ingredients, seasonings, allUnits, menuNames, setMenuCandidates, arrangeMenuCandidates: setMenuCandidates });
  } catch (err) { next(err); }
});

// 共有メニューを複製してオリジナル作成画面へ
router.get('/duplicate/:id', async (req, res, next) => {
  try {
    const menuId = String(req.params.id || '').trim();
    if (!menuId) return res.redirect('/users/my-menu/shared-register');

    // 共通の候補リスト（/original と同じ）
    const { kinds, junles, cooks } = await getFacetLists();
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    const groupScope = groupId
      ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] }
      : {};
    const ingredients = await Ingredient.find(groupScope).select('ingredient classification unit imageUrl').lean();
    const seasonings = await Seasoning.find(groupScope).select('seasoning classification unit imageUrl').lean();
    const allUnits = Array.from(new Set([
      ...((ingredients||[]).flatMap(i=>Array.isArray(i.unit)?i.unit:i.unit? [i.unit]:[])),
      ...((seasonings||[]).flatMap(s=>Array.isArray(s.unit)?s.unit:s.unit? [s.unit]:[]))
    ].filter(Boolean)));

    const menu = await Menu.findById(menuId).lean();
    if (!menu) {
      req.flash('error', '対象メニューが見つかりません');
      return res.redirect('/users/my-menu/shared-register');
    }

    const prefill = {
      name: `【オリジナル】${menu.name || ''}`,
      yomi: menu.yomi || '',
      menu: menu.menu || '',
      kind: menu.kind || '',
      junle: menu.junle || '',
      cook: menu.cook || '',
      imageUrl: menu.imageUrl || '',
      time: menu.time || '',
      people: menu.people || 1,
      servings: menu.servings || {},
      instruction: menu.instructionText || '',
      comment: menu.comment || '',
      makeAhead: !!menu.makeAhead,
      ingredients: (menu.ingredients || []).map((x)=>({ id: String(x.name||''), amount: x.amount || '', unit: x.unit || '' })),
      seasonings: (menu.seasoning || []).map((x)=>({ id: String(x.name||''), amount: x.amount || '', unit: x.unit || '' }))
    };

    // Render original creation view with prefill
    const myOriginalCount = await Mymenu.countDocuments({ user: req.user._id, sourceType: 'original' });
    const menuNames = await Menu.find().distinct('menu');
    const setMenuCandidates = await Menu.find({ menuType: { $ne: 'set' }, isPrivate: { $ne: true } })
      .select('name menu kind junle cook imageUrl menuType')
      .lean();
    res.render('users/myMenuOriginal', { kinds, junles, cooks, myOriginalCount, ingredients, seasonings, allUnits, menuNames, setMenuCandidates, arrangeMenuCandidates: setMenuCandidates, prefillOriginal: prefill });
  } catch (err) { next(err); }
});

// 自分のオリジナルレシピ一覧
router.get('/original-list', async (req, res, next) => {
  try {
    const showHidden = String(req.query.show_hidden || '') === 'true';
    const keyword = String(req.query.keyword || '').trim();
    const menuContent = String(req.query.menuContent || '').trim();
    const criteria = { user: req.user._id, sourceType: 'original' };
    if (!showHidden) {
      criteria.$or = [ { hidden: { $exists: false } }, { hidden: false } ];
    }
    let list = await Mymenu.find(criteria)
      .populate({
        path: 'menu',
        select: 'name imageUrl kind junle cook menu yomi update_date entry_date menuType setMenus',
        populate: { path: 'setMenus', select: 'imageUrl menuType' }
      })
      .sort({ update_date: -1, entry_date: -1 })
      .lean();
    const menuContents = unique(list.map((mm) => mm?.menu?.menu).filter(Boolean));
    if (menuContent) {
      list = list.filter((mm) => (mm.menu?.menu || '') === menuContent);
    }
    if (keyword) {
      const rx = new RegExp(escapeRegex(keyword), 'i');
      list = list.filter((mm) => {
        const m = mm.menu || {};
        const fields = [m.name, m.yomi, m.kind, m.junle, m.cook, m.menu].filter(Boolean).join(' ');
        return rx.test(fields);
      });
    }
    res.render('users/myMenuOriginalList', { list, showHidden, keyword, menuContent, menuContents });
  } catch (err) { next(err); }
});

// オリジナルレシピ登録 保存（画像は Cloudinary にアップロード済みの URL を受け取る前提）
router.post('/original', async (req, res, next) => {
  try {
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/users/my-menu/original');
    }

    const {
      name, yomi, menu, kind, junle, cook,
      imageUrl, time, people,
      ingredient_ids = [], ingredient_amounts = [], ingredient_units = [],
      seasoning_ids = [], seasoning_amounts = [], seasoning_units = [],
      menuType = 'single', setType = [], set_menu_ids = [], arrange_base_menu_id = '',
      instruction = '',
      comment = '',
      favorite = 'false', frequency = '3',
      makeAhead = 'false',
      basicMenu = 'false',
      hidden = 'false',
      share = 'true', shareScope = 'all'
    } = req.body;

    const ingredients = (Array.isArray(ingredient_ids) ? ingredient_ids : [ingredient_ids]).filter(Boolean).map((id, i) => ({
      name: id,
      amount: Array.isArray(ingredient_amounts) ? ingredient_amounts[i] : ingredient_amounts,
      unit: Array.isArray(ingredient_units) ? ingredient_units[i] : ingredient_units
    }));
    const seasonings = (Array.isArray(seasoning_ids) ? seasoning_ids : [seasoning_ids]).filter(Boolean).map((id, i) => ({
      name: id,
      amount: Array.isArray(seasoning_amounts) ? seasoning_amounts[i] : seasoning_amounts,
      unit: Array.isArray(seasoning_units) ? seasoning_units[i] : seasoning_units
    }));

    const normalizedMenuType = menuType === 'set'
      ? 'set'
      : (menuType === 'arrange' ? 'arrange' : 'single');
    const rawSetTypes = Array.isArray(setType) ? setType : (setType ? [setType] : []);
    const normalizedSetType = rawSetTypes
      .map((t) => String(t || '').trim())
      .filter((t) => ['morning', 'lunch', 'dinner'].includes(t));
    let setMenus = [];
    if (normalizedMenuType === 'set') {
      const rawSetMenus = Array.isArray(set_menu_ids) ? set_menu_ids : [set_menu_ids];
      const candidateIds = rawSetMenus
        .map((id) => String(id || '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id));
      const uniqueIds = Array.from(new Set(candidateIds));
      if (uniqueIds.length) {
        const validMenus = await Menu.find({ _id: { $in: uniqueIds }, menuType: { $ne: 'set' }, isPrivate: { $ne: true } })
          .select('_id')
          .lean();
        setMenus = validMenus.map((m) => m._id);
      }
    }
    let arrangeBaseMenu = null;
    if (normalizedMenuType === 'arrange') {
      const candidateId = String(arrange_base_menu_id || '').trim();
      if (mongoose.Types.ObjectId.isValid(candidateId)) {
        const baseMenu = await Menu.findOne({ _id: candidateId, menuType: { $ne: 'set' }, isPrivate: { $ne: true } })
          .select('_id')
          .lean();
        if (baseMenu) arrangeBaseMenu = baseMenu._id;
      }
      if (!arrangeBaseMenu) {
        req.flash('error', 'アレンジ元メニューを選択してください');
        return res.redirect('/users/my-menu/original');
      }
    }

    // オリジナルは URL なし。作り方とコメントを別々に保存
    const newMenu = await Menu.create({
      name, yomi, menu, kind, junle, cook,
      menuType: normalizedMenuType,
      setType: normalizedMenuType === 'set' ? normalizedSetType : [],
      setMenus,
      arrangeBaseMenu: normalizedMenuType === 'arrange' ? arrangeBaseMenu : null,
      url: '',
      imageUrl: normalizedMenuType === 'set' ? '' : imageUrl,
      time,
      people: Number(people) || 1,
      servings: parseServings(req.body),
      ingredients,
      seasoning: normalizedMenuType === 'set' ? [] : seasonings,
      instructionText: String(instruction || ''),
      comment: String(comment || ''),
      makeAhead: normalizedMenuType === 'arrange' ? false : (String(makeAhead) === 'true'),
      basicMenu: normalizedMenuType === 'arrange' ? false : (String(basicMenu) === 'true'),
      share: String(share) === 'true'
    });

    const scope = (shareScope === 'all' ? 'all' : (shareScope === 'public' ? 'public' : 'group'));
    const publicToken = (String(share) === 'true' && scope === 'public') ? generatePublicToken(24) : undefined;
    await Mymenu.create({
      menu: newMenu._id,
      favorite: String(favorite) === 'true',
      frequency: Math.max(1, Math.min(5, Number(frequency) || 3)),
      hidden: String(hidden) === 'true',
      share: String(share) === 'true',
      shareScope: scope,
      ...(publicToken ? { publicToken } : {}),
      sourceType: 'original',
      user: req.user._id,
      group: groupId
    });
    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    await scheduleMyMenuAdded({ actorId: req.user._id, groupId, menuNames: [newMenu.name || ''] });
    await notifyAdminsMenuAdded({
      menu: newMenu,
      ingredientIds: ingredients.map((i) => i.name),
      seasoningIds: seasonings.map((s) => s.name),
      actor: req.user,
      groupId,
      baseUrl
    });

    req.flash('success', 'オリジナルレシピを登録しました');
    res.redirect('/users/my-menu/original-list');
  } catch (err) { next(err); }
});

// グループメンバーのマイメニュー
router.get('/group-members', async (req, res, next) => {
  try {
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const currentGroup = groups.find((g) => g._id.toString() === defaultGroupId) || groups[0] || null;
    if (!currentGroup) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/users/my-menu');
    }

    const { keyword = '', kind = '', junle = '', cook = '', menuContent = '' } = req.query;
    const members = unique([
      currentGroup.createdBy?.toString?.() || '',
      ...((currentGroup.members || []).map((m) => m.toString ? m.toString() : String(m)))
    ]).filter((id) => id && id !== req.user._id.toString());

    const mymenus = await Mymenu.find({ group: currentGroup._id, user: { $in: members } })
      .populate('menu')
      .populate('user', 'displayname username email')
      .lean();

    const filtered = mymenus.filter((mm) => {
      const x = mm.menu || {};
      if (!x) return false;
      if (kind && x.kind !== kind) return false;
      if (junle && x.junle !== junle) return false;
      if (cook && x.cook !== cook) return false;
      if (menuContent && x.menu !== menuContent) return false;
      if (keyword) {
        const rx = new RegExp(escapeRegex(keyword), 'i');
        const fields = [x.name, x.yomi, x.kind, x.junle, x.cook, x.menu].filter(Boolean).join(' ');
        return rx.test(fields);
      }
      return true;
    });

    const { kinds, junles, cooks, menuContents } = await getFacetLists();
    res.render('users/myMenuGroupMembers', {
      currentGroup,
      kinds, junles, cooks, menuContents,
      selected: { keyword, kind, junle, cook, menuContent },
      items: filtered
    });
  } catch (err) { next(err); }
});

export default router;

// 画像アップロード（Cloudinary）: フォームからのAJAX専用
router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'menu-service' });
    // アップロード成功時はローカルの一時ファイルを削除
    try {
      await fs.unlink(req.file.path);
    } catch (unlinkErr) {
      console.warn('temp file unlink failed:', unlinkErr);
    }
    return res.json({ url: result.secure_url });
  } catch (e) {
    console.error('upload error', e);
    return res.status(500).json({ error: 'アップロードに失敗しました' });
  }
});

// オリジナル食材/調味料の作成（グループ内のみ表示）
router.post('/api/ingredients/custom', express.json(), async (req, res) => {
  try {
    const { name, classification = '', units = '' } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) return res.status(400).json({ error: 'group not found' });
    const unitArr = String(units || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    // 重複ガード（同名・同グループ）
    const dup = await Ingredient.findOne({ ingredient: name.trim(), group: groupId }).select('_id').lean();
    if (dup) return res.status(409).json({ error: 'duplicate' });
    const created = await Ingredient.create({
      ingredient: name.trim(),
      classification: classification || '',
      unit: unitArr,
      group: groupId,
      createdBy: req.user?._id || null
    });
    return res.json(created);
  } catch (e) { return res.status(500).json({ error: 'failed' }); }
});

router.post('/api/seasonings/custom', express.json(), async (req, res) => {
  try {
    const { name, classification = '', units = '' } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) return res.status(400).json({ error: 'group not found' });
    const unitArr = String(units || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    // 重複ガード（同名・同グループ）
    const dup = await Seasoning.findOne({ seasoning: name.trim(), group: groupId }).select('_id').lean();
    if (dup) return res.status(409).json({ error: 'duplicate' });
    const created = await Seasoning.create({
      seasoning: name.trim(),
      classification: classification || '',
      unit: unitArr,
      group: groupId,
      createdBy: req.user?._id || null
    });
    return res.json(created);
  } catch (e) { return res.status(500).json({ error: 'failed' }); }
});

// 既存オリジナル食材の単位を追加（自グループ所有のみ）
router.post('/api/ingredients/:id/units', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) return res.status(400).json({ error: 'group not found' });
    const item = await Ingredient.findById(id).select('group unit').lean();
    if (!item) return res.status(404).json({ error: 'not found' });
    if (!item.group || String(item.group) !== String(groupId)) return res.status(403).json({ error: 'forbidden' });
    const unitsRaw = (req.body?.units || req.body?.unit || '').toString();
    const unitArr = unitsRaw.split(',').map(s=>s.trim()).filter(Boolean);
    if (!unitArr.length) return res.status(400).json({ error: 'units required' });
    const updated = await Ingredient.findByIdAndUpdate(
      id,
      { $addToSet: { unit: { $each: unitArr } }, update_date: new Date() },
      { new: true }
    ).select('unit');
    return res.json({ units: updated.unit || [] });
  } catch (e) { return res.status(500).json({ error: 'failed' }); }
});

// 既存オリジナル調味料の単位を追加（自グループ所有のみ）
router.post('/api/seasonings/:id/units', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) return res.status(400).json({ error: 'group not found' });
    const item = await Seasoning.findById(id).select('group unit').lean();
    if (!item) return res.status(404).json({ error: 'not found' });
    if (!item.group || String(item.group) !== String(groupId)) return res.status(403).json({ error: 'forbidden' });
    const unitsRaw = (req.body?.units || req.body?.unit || '').toString();
    const unitArr = unitsRaw.split(',').map(s=>s.trim()).filter(Boolean);
    if (!unitArr.length) return res.status(400).json({ error: 'units required' });
    const updated = await Seasoning.findByIdAndUpdate(
      id,
      { $addToSet: { unit: { $each: unitArr } }, update_date: new Date() },
      { new: true }
    ).select('unit');
    return res.json({ units: updated.unit || [] });
  } catch (e) { return res.status(500).json({ error: 'failed' }); }
});

// 画像差し替え（Cloudinary）：新規アップロード成功後に旧画像を削除
router.post('/upload-replace', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
    const { oldUrl = '' } = req.body || {};

    // まずアップロード
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'menu-service' });
    try { await fs.unlink(req.file.path); } catch (_) {}

    // 旧URLが Cloudinary の場合は削除を試行
    const deleteOldIfCloudinary = async (url) => {
      if (!url || typeof url !== 'string') return;
      try {
        const u = new URL(url);
        if (!/cloudinary\.com$/i.test(u.hostname)) return; // cloudinary以外は無視
        const idx = u.pathname.indexOf('/upload/');
        if (idx < 0) return;
        let rest = u.pathname.slice(idx + '/upload/'.length); // v<ver>/<folder>/<name>.<ext>
        const parts = rest.split('/').filter(Boolean);
        if (!parts.length) return;
        // 先頭が v123 形式なら除去
        if (/^v\d+$/i.test(parts[0])) parts.shift();
        if (!parts.length) return;
        const last = parts.pop();
        const withoutExt = (last || '').replace(/\.[^.]+$/, '');
        const publicId = [...parts, withoutExt].filter(Boolean).join('/');
        if (!publicId) return;
        await cloudinary.uploader.destroy(publicId);
      } catch (e) {
        // 解析や削除失敗は致命的ではないのでログのみ
        console.warn('old cloudinary delete failed:', e?.message || e);
      }
    };
    await deleteOldIfCloudinary(oldUrl);

    return res.json({ url: result.secure_url });
  } catch (e) {
    console.error('upload-replace error', e);
    return res.status(500).json({ error: 'アップロードに失敗しました' });
  }
});

// --- 自分が登録したURL/オリジナルのレシピ編集 ---
router.get('/edit/:menuId', async (req, res, next) => {
  try {
    const { menuId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(menuId)) {
      req.flash('error', '不正なIDです');
      return res.redirect('/users/my-menu/shared-register?fav=mine');
    }
    const owned = await Mymenu.findOne({ user: req.user._id, menu: menuId, sourceType: { $in: ['url','original'] } }).lean();
    if (!owned) {
      req.flash('error', '編集権限がありません');
      return res.redirect('/users/my-menu/shared-register?fav=mine');
    }
    const menuDoc = await Menu.findById(menuId)
      .populate({ path: 'setMenus', select: 'name menu kind junle cook imageUrl menuType' })
      .populate({ path: 'arrangeBaseMenu', select: 'name menu kind junle cook imageUrl menuType' })
      .lean();
    if (!menuDoc) {
      req.flash('error', 'メニューが見つかりません');
      return res.redirect('/users/my-menu/shared-register?fav=mine');
    }
    const { kinds, junles, cooks } = await getFacetLists();
    const menuNames = await Menu.find().distinct('menu');
    const setMenuCandidates = await Menu.find({ _id: { $ne: menuId }, menuType: { $ne: 'set' }, isPrivate: { $ne: true } })
      .select('name menu kind junle cook imageUrl menuType')
      .lean();
    // グローバル + 自グループの候補を表示
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    const groupScope = groupId
      ? { $or: [ { group: { $exists: false } }, { group: null }, { group: groupId } ] }
      : {};
    const ingredients = await Ingredient.find(groupScope).select('ingredient classification unit imageUrl').lean();
    const seasonings = await Seasoning.find(groupScope).select('seasoning classification unit imageUrl').lean();
    const allUnits = Array.from(new Set([
      ...((ingredients||[]).flatMap(i=>Array.isArray(i.unit)?i.unit:i.unit? [i.unit]:[])),
      ...((seasonings||[]).flatMap(s=>Array.isArray(s.unit)?s.unit:s.unit? [s.unit]:[]))
    ].filter(Boolean)));
    // Prepare instruction/comment for edit view
    // Prefer fields as saved; only fallback to split legacy comment if instruction is empty.
    let instructionText = String(menuDoc.instructionText || '');
    let commentText = String(menuDoc.comment || '');
    if ((owned && owned.sourceType === 'original') && !instructionText && commentText) {
      const raw = commentText;
      const parts = raw.split(/\n{2,}/); // split by blank line(s)
      if (parts.length > 1) {
        instructionText = (parts.shift() || '').trim();
        commentText = parts.join('\n\n').trim();
      }
    }
    // 公開URL（一般公開時のみ）
    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const publicUrl = (owned && owned.share && owned.shareScope === 'public' && owned.publicToken)
      ? `${baseUrl}/users/my-menu/public/${owned.publicToken}`
      : '';
    const initialArrangeBaseMenu = menuDoc?.arrangeBaseMenu
      ? {
          _id: String(menuDoc.arrangeBaseMenu?._id || ''),
          name: menuDoc.arrangeBaseMenu?.name || '',
          menu: menuDoc.arrangeBaseMenu?.menu || '',
          kind: menuDoc.arrangeBaseMenu?.kind || '',
          junle: menuDoc.arrangeBaseMenu?.junle || '',
          cook: menuDoc.arrangeBaseMenu?.cook || '',
          imageUrl: menuDoc.arrangeBaseMenu?.imageUrl || '',
          menuType: menuDoc.arrangeBaseMenu?.menuType || ''
        }
      : null;
    return res.render('users/myMenuEdit', { menuDoc, kinds, junles, cooks, menuNames, ingredients, seasonings, allUnits, owned, instructionText, commentText, publicUrl, setMenuCandidates, arrangeMenuCandidates: setMenuCandidates, initialArrangeBaseMenu });
  } catch (err) { next(err); }
});

router.post('/edit/:menuId', async (req, res, next) => {
  try {
    const { menuId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(menuId)) {
      req.flash('error', '不正なIDです');
      return res.redirect('/users/my-menu/shared-register?fav=mine');
    }
    const owned = await Mymenu.findOne({ user: req.user._id, menu: menuId, sourceType: { $in: ['url','original'] } }).lean();
    if (!owned) {
      req.flash('error', '編集権限がありません');
      return res.redirect('/users/my-menu/shared-register?fav=mine');
    }

    const {
      name,
      kind,
      junle,
      cook,
      menu,
      url,
      imageUrl,
      time,
      people,
      comment,
      instruction = '',
      yomi,
      favorite = 'true',
      frequency = '3',
      makeAhead = 'false',
      basicMenu = 'false',
      share = 'false',
      shareScope = 'group',
      ingredient_ids = [],
      ingredient_amounts = [],
      ingredient_units = [],
      seasoning_ids = [],
      seasoning_amounts = [],
      seasoning_units = [],
      menuType = 'single',
      setType = [],
      set_menu_ids = [],
      arrange_base_menu_id = ''
    } = req.body;

    const ingredients = (Array.isArray(ingredient_ids) ? ingredient_ids : [ingredient_ids]).filter(Boolean).map((id, i) => ({
      name: id,
      amount: Array.isArray(ingredient_amounts) ? ingredient_amounts[i] : ingredient_amounts,
      unit: Array.isArray(ingredient_units) ? ingredient_units[i] : ingredient_units
    }));
    const seasonings = (Array.isArray(seasoning_ids) ? seasoning_ids : [seasoning_ids]).filter(Boolean).map((id, i) => ({
      name: id,
      amount: Array.isArray(seasoning_amounts) ? seasoning_amounts[i] : seasoning_amounts,
      unit: Array.isArray(seasoning_units) ? seasoning_units[i] : seasoning_units
    }));
    const normalizedMenuType = menuType === 'set'
      ? 'set'
      : (menuType === 'arrange' ? 'arrange' : 'single');
    const rawSetTypes = Array.isArray(setType) ? setType : (setType ? [setType] : []);
    const normalizedSetType = rawSetTypes
      .map((t) => String(t || '').trim())
      .filter((t) => ['morning', 'lunch', 'dinner'].includes(t));
    let setMenus = [];
    if (normalizedMenuType === 'set') {
      const rawSetMenus = Array.isArray(set_menu_ids) ? set_menu_ids : [set_menu_ids];
      const candidateIds = rawSetMenus
        .map((id) => String(id || '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .filter((id) => id !== String(menuId));
      const uniqueIds = Array.from(new Set(candidateIds));
      if (uniqueIds.length) {
        const validMenus = await Menu.find({ _id: { $in: uniqueIds }, menuType: { $ne: 'set' }, isPrivate: { $ne: true } })
          .select('_id')
          .lean();
        setMenus = validMenus.map((m) => m._id);
      }
    }
    let arrangeBaseMenu = null;
    if (normalizedMenuType === 'arrange') {
      const candidateId = String(arrange_base_menu_id || '').trim();
      if (mongoose.Types.ObjectId.isValid(candidateId)) {
        const baseMenu = await Menu.findOne({ _id: candidateId, menuType: { $ne: 'set' }, isPrivate: { $ne: true } })
          .select('_id')
          .lean();
        if (baseMenu) arrangeBaseMenu = baseMenu._id;
      }
      if (!arrangeBaseMenu) {
        req.flash('error', 'アレンジ元メニューを選択してください');
        return res.redirect(`/users/my-menu/edit/${menuId}`);
      }
    }
    const updatePayload = {
      name,
      kind,
      junle,
      cook,
      menu,
      menuType: normalizedMenuType,
      setType: normalizedMenuType === 'set' ? normalizedSetType : [],
      setMenus,
      arrangeBaseMenu: normalizedMenuType === 'arrange' ? arrangeBaseMenu : null,
      url: normalizedMenuType === 'set' ? '' : url,
      imageUrl: normalizedMenuType === 'set' ? '' : imageUrl,
      time,
      people: Number(people) || 1,
      servings: parseServings(req.body),
      comment,
      makeAhead: normalizedMenuType === 'arrange' ? false : (String(makeAhead) === 'true'),
      basicMenu: normalizedMenuType === 'arrange' ? false : (String(basicMenu) === 'true'),
      ingredients,
      seasoning: normalizedMenuType === 'set' ? [] : seasonings
    };
    if (owned && owned.sourceType === 'original') {
      updatePayload.instructionText = String(instruction || '');
    }
    await Menu.findByIdAndUpdate(menuId, updatePayload);

    // 更新時に自分のマイメニュー設定も反映（存在すれば）
    // 一般公開はオリジナルのみ許可
    const allowPublic = !!(owned && owned.sourceType === 'original');
    const scope = allowPublic ? (shareScope === 'all' ? 'all' : (shareScope === 'public' ? 'public' : 'group'))
                              : (shareScope === 'all' ? 'all' : 'group');
    const mymenu = await Mymenu.findOne({ user: req.user._id, menu: menuId });
    const updateShare = {
        favorite: String(favorite) === 'true',
        frequency: Math.max(1, Math.min(5, Number(frequency) || 3)),
        share: String(share) === 'true',
        shareScope: scope,
    };
    if (allowPublic && String(share) === 'true' && scope === 'public' && (!mymenu || !mymenu.publicToken)) {
      updateShare.publicToken = generatePublicToken(24);
    }
    await Mymenu.findOneAndUpdate(
      { user: req.user._id, menu: menuId },
      { ...updateShare, ...(owned && owned.sourceType === 'original' ? { hidden: String(req.body.hidden) === 'true' } : {}) },
      { upsert: false }
    );
    req.flash('success', 'レシピを更新しました');
    if (owned && owned.sourceType === 'original') {
      return res.redirect('/users/my-menu/original-list');
    }
    return res.redirect('/users/my-menu/shared-register?fav=mine');
  } catch (err) { next(err); }
});

// MyMenu 登録/更新（weekMenu からの♡用）
router.post('/api/upsert', express.json(), async (req, res) => {
  try {
    const { menuId, favorite = true, frequency = 3 } = req.body || {};
    if (!menuId || !mongoose.Types.ObjectId.isValid(menuId)) {
      return res.status(400).json({ error: 'menuIdが不正です' });
    }
    const menu = await Menu.findById(menuId).select('_id').lean();
    if (!menu) return res.status(404).json({ error: 'メニューが見つかりません' });

    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) return res.status(400).json({ error: 'グループが見つかりません' });

    const update = {
      favorite: !!favorite,
      frequency: Math.max(1, Math.min(5, Number(frequency) || 3)),
      update_date: new Date()
    };

    const existing = await Mymenu.findOne({ user: req.user._id, group: groupId, menu: menu._id });
    if (existing) {
      await Mymenu.findByIdAndUpdate(existing._id, update);
      return res.json({ success: true, status: 'updated' });
    }

    await Mymenu.create({
      menu: menu._id,
      user: req.user._id,
      group: groupId,
      sourceType: 'shared',
      ...update
    });
    // 新規作成の場合のみ通知に積む
    const menuDoc = await Menu.findById(menu._id).select('name').lean();
    await scheduleMyMenuAdded({ actorId: req.user._id, groupId, menuNames: [menuDoc?.name || ''] });
    return res.json({ success: true, status: 'created' });
  } catch (e) {
    console.error('mymenu upsert error', e);
    return res.status(500).json({ error: '登録に失敗しました' });
  }
});

// MyMenu 削除（weekMenu の色付き♡を押した場合）
router.delete('/api/:menuId', async (req, res) => {
  try {
    const { menuId } = req.params;
    if (!menuId || !mongoose.Types.ObjectId.isValid(menuId)) {
      return res.status(400).json({ error: 'menuIdが不正です' });
    }

    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const groupId = defaultGroupId || (groups[0]?._id?.toString() ?? null);
    if (!groupId) return res.status(400).json({ error: 'グループが見つかりません' });

    const doc = await Mymenu.findOneAndDelete({ user: req.user._id, group: groupId, menu: menuId });
    if (!doc) {
      return res.status(404).json({ error: 'マイメニュー登録は見つかりませんでした' });
    }
    return res.json({ success: true, status: 'deleted' });
  } catch (e) {
    console.error('mymenu delete error', e);
    return res.status(500).json({ error: '削除に失敗しました' });
  }
});

async function notifyAdminsMenuAdded({ menu, ingredientIds = [], seasoningIds = [], actor, groupId, baseUrl }) {
  try {
    if (!menu) return;
    const admins = await User.find({ isAdmin: true, isMail: { $ne: false } }).select('email').lean();
    const recipients = (admins || [])
      .map((a) => String(a.email || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((email, idx, arr) => idx === arr.findIndex((v) => v === email));
    if (!recipients.length) return;

    const normalizedBase = (baseUrl || '').replace(/\/+$/, '');
    const buildUrl = (path) => (normalizedBase ? `${normalizedBase}${path}` : path);
    const validIngredientIds = Array.from(new Set((ingredientIds || [])
      .map((id) => id?.toString?.() || '')
      .filter((id) => id && mongoose.Types.ObjectId.isValid(id))));
    const validSeasoningIds = Array.from(new Set((seasoningIds || [])
      .map((id) => id?.toString?.() || '')
      .filter((id) => id && mongoose.Types.ObjectId.isValid(id))));

    const ingredientDocs = validIngredientIds.length
      ? await Ingredient.find({ _id: { $in: validIngredientIds }, group: groupId }).select('ingredient').lean()
      : [];
    const seasoningDocs = validSeasoningIds.length
      ? await Seasoning.find({ _id: { $in: validSeasoningIds }, group: groupId }).select('seasoning').lean()
      : [];

    const actorName = actor?.displayname || actor?.username || actor?.email || 'ユーザー';
    const html = await renderTemplate('adminMyMenuAdded', {
      actorName,
      menuName: menu.name || '',
      menuEditUrl: buildUrl(`/admin/menu-edit/${menu._id}`),
      ingredients: (ingredientDocs || []).map((ing) => ({
        name: ing.ingredient || '',
        editUrl: buildUrl(`/admin/ingredient-edit/${ing._id}`)
      })),
      seasonings: (seasoningDocs || []).map((s) => ({
        name: s.seasoning || '',
        editUrl: buildUrl(`/admin/seasoning-edit/${s._id}`)
      }))
    });
    const subject = `${actorName}様によって「${menu.name || ''}」が追加されました`;
    await sendMail({ to: recipients, subject, html });
  } catch (e) {
    console.error('admin menu notify error:', e);
  }
}

// 共通: 翌朝8時通知にメニュー追加を積む
async function scheduleMyMenuAdded({ actorId, groupId, menuNames = [] }) {
  try {
    if (!groupId || !actorId) return;
    // 翌朝8時
    const now = new Date();
    const scheduledAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);

    // 宛先: グループ作成者 + メンバー（email有り、isMail=true、自分以外）
    const groupFull = await Group.findById(groupId)
      .populate({ path: 'createdBy', select: 'email displayname username isMail' })
      .populate({ path: 'members', select: 'email displayname username isMail' })
      .lean();
    const rawUsers = [];
    if (groupFull?.createdBy) rawUsers.push(groupFull.createdBy);
    if (Array.isArray(groupFull?.members)) rawUsers.push(...groupFull.members);
    const recipients = rawUsers
      .filter(u => u && String(u._id) !== String(actorId))
      .filter(u => !!u.email && (u.isMail === undefined || u.isMail === true))
      .map(u => ({ id: String(u._id), email: String(u.email).trim().toLowerCase() }))
      .filter((u, idx, arr) => idx === arr.findIndex(v => v.email === u.email));

    const items = (menuNames || []).filter(Boolean).map((name) => ({ name }));
    if (!items.length || !recipients.length) return;

    // 受信者ごとに upsert で蓄積
    await Promise.all(recipients.map((r) => (
      Notification.findOneAndUpdate(
        { group: groupId, recipient: r.id, actor: actorId, type: 'myMenuAdded', scheduledAt },
        { $setOnInsert: { group: groupId, recipient: r.id, actor: actorId, type: 'myMenuAdded', scheduledAt }, $push: { items: { $each: items } } },
        { upsert: true }
      )
    )));
  } catch (e) { console.error('scheduleMyMenuAdded error:', e); }
}
