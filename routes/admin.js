import express from 'express';
import fs from 'fs';
import path from 'path';
import Menu from '../models/menu.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import Stock from '../models/stock.js';
import MyEquipment from '../models/myEquipment.js';
import StoragePlace from '../models/storagePlace.js';
import { isAdmin } from '../middleware.js';
import Equipment from '../models/equipment.js';
import MailTemplateSetting from '../models/mailTemplateSetting.js';
import Mymenu from '../models/mymenu.js';
import AdminLog from '../models/adminLog.js';
import Notice from '../models/notice.js';
import User from '../models/users.js';
import { renderTemplate, sendMail } from '../utils/mailer.js';
import { normalizeSeasonList } from '../utils/season.js';
// import { writeFileSync } from 'fs';
// import { join } from 'path';
import ExcelJS from 'exceljs';


const router = express.Router();
// 管理画面は管理者のみアクセス可能
router.use(isAdmin);

async function logAdminAction(action, payload = {}) {
  try {
    const { menuId = null, menuName = '', actorId = null, detail = '' } = payload;
    await AdminLog.create({
      action,
      menu: menuId,
      menuName,
      actor: actorId,
      detail
    });
  } catch (e) {
    console.error('admin log save error:', e?.message || e);
  }
}

const normalizeUnitPayload = (unitInput, gramsInput) => {
  const unitArray = Array.isArray(unitInput)
    ? unitInput
    : (typeof unitInput !== 'undefined' ? [unitInput] : []);
  const gramsArray = Array.isArray(gramsInput)
    ? gramsInput
    : (typeof gramsInput !== 'undefined' ? [gramsInput] : []);
  const units = [];
  const conversions = [];
  unitArray.forEach((rawLabel, index) => {
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
    if (!label) return;
    units.push(label);
    const gramsRaw = gramsArray[index];
    const gramsVal = typeof gramsRaw === 'string' && gramsRaw.trim() === ''
      ? NaN
      : Number(gramsRaw);
    if (!Number.isNaN(gramsVal) && gramsVal > 0) {
      conversions.push({ label, grams: gramsVal });
    }
  });
  return { units, conversions };
};

const buildIngredientCategoryList = async () => {
  const classifications = await Ingredient.distinct('classification');
  const set = new Set((classifications || []).filter(Boolean));
  // Always include 飲料 and show it above その他
  set.add('飲料');
  const list = Array.from(set);
  const middle = list
    .filter((v) => v !== '飲料' && v !== 'その他')
    .sort((a, b) => String(a).localeCompare(String(b), 'ja'));
  const result = [...middle];
  if (list.includes('飲料')) result.push('飲料');
  if (list.includes('その他')) result.push('その他');
  return result;
};

const toBool = (val) => {
  if (Array.isArray(val)) return val.some((v) => toBool(v));
  if (val === undefined || val === null) return false;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === 'on' || s === '1';
};

const fetchWikiImage = async (wikiUrl) => {
  const parsed = new URL(wikiUrl);
  const isWikipedia = /(^|\.)wikipedia\.org$/.test(parsed.hostname);
  if (!isWikipedia) {
    throw new Error('wikipediaリンクではありません');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!segments.length) throw new Error('ページ名を特定できません');
  let title = segments.pop();
  if (!title) throw new Error('ページ名を特定できません');
  title = decodeURIComponent(title);
  const summaryUrl = `${parsed.protocol}//${parsed.hostname}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const response = await fetch(summaryUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('WIKI APIの取得に失敗しました');
  const data = await response.json();
  const imageUrl = data?.originalimage?.source || data?.thumbnail?.source || '';
  return {
    title: data?.title || title,
    imageUrl,
    extract: data?.extract || ''
  };
};

router.get('/api/wiki-image', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = await fetchWikiImage(url);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '画像取得に失敗しました' });
  }
});

// システム設定画面の表示
router.get('/admin-setting', async (req, res) => {
  try {
    const tplDir = path.resolve(process.cwd(), 'utils', 'templates');
    const files = fs.readdirSync(tplDir).filter((f) => f.endsWith('.ejs') && !f.startsWith('_'));
    const settings = await MailTemplateSetting.find({ templateName: { $in: files } }).lean();
    const settingMap = settings.reduce((acc, s) => {
      acc[s.templateName] = s;
      return acc;
    }, {});
    const templates = files.map((name) => ({
      name,
      enabled: settingMap[name]?.enabled || false,
      timing: settingMap[name]?.timing || ''
    }));
    res.render('admin/admin-setting', { templates });
  } catch (err) {
    console.error('admin-setting load error:', err);
    res.status(500).send('システム設定を読み込めませんでした');
  }
});

router.post('/admin-setting/mail', async (req, res) => {
  try {
    const enabledMap = req.body?.enabled || {};
    const timingMap = req.body?.timing || {};
    const tplDir = path.resolve(process.cwd(), 'utils', 'templates');
    const files = fs.readdirSync(tplDir).filter((f) => f.endsWith('.ejs') && !f.startsWith('_'));
    const ops = files.map(async (name) => {
      const enabled = enabledMap[name] === 'on';
      const timing = (timingMap[name] || '').toString().trim();
      await MailTemplateSetting.findOneAndUpdate(
        { templateName: name },
        { $set: { enabled, timing, updatedBy: req.user?._id || null } },
        { upsert: true }
      );
    });
    await Promise.all(ops);
    req.flash('success', 'メール配信設定を保存しました');
    return res.redirect('/admin/admin-setting');
  } catch (err) {
    console.error('admin-setting mail save error:', err);
    req.flash('error', 'メール配信設定の保存に失敗しました');
    return res.redirect('/admin/admin-setting');
  }
});

// 管理者ダッシュボード表示
router.get('/admin-top', async (req, res) => {
  try {
    const menuCount = await Menu.countDocuments();
    const ingredientCount = await Ingredient.countDocuments();
    const seasoningCount = await Seasoning.countDocuments();
    const equipmentCount = await Equipment.countDocuments();

    res.render('admin/admin-top', {
      menuCount,
      ingredientCount,
      seasoningCount,
      equipmentCount
    });
  } catch (err) {
    console.error('ダッシュボード表示エラー:', err);
    res.status(500).send('ダッシュボードを表示できませんでした');
  }
});

router.get('/logs', async (req, res) => {
  try {
    const pageSize = 50;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const selectedAction = (req.query.action || '').toString().trim();
    const filter = {};
    if (selectedAction) filter.action = selectedAction;

    const [logs, total, actions] = await Promise.all([
      AdminLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .populate('actor', 'displayname username email')
        .lean(),
      AdminLog.countDocuments(filter),
      AdminLog.distinct('action')
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    res.render('admin/admin-logs', {
      logs,
      actions,
      selectedAction,
      page,
      totalPages
    });
  } catch (err) {
    console.error('管理ログ表示エラー:', err);
    res.status(500).send('ログを表示できませんでした');
  }
});

// お知らせ 管理
router.get('/notices', async (req, res) => {
  try {
    const notices = await Notice.find({})
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(50)
      .lean();
    const categories = await Notice.distinct('category');
    res.render('admin/admin-notices', {
      notices,
      categories,
      editTarget: null,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (e) {
    console.error('notice list error', e);
    req.flash('error', 'お知らせの読み込みに失敗しました');
    res.redirect('/admin/admin-top');
  }
});

router.post('/notices', async (req, res) => {
  try {
    const title = (req.body?.title || '').trim();
    const category = (req.body?.category || '').trim();
    const body = (req.body?.body || '').trim();
    const url = (req.body?.url || '').trim();
    const notifyMail = req.body?.notifyMail === 'true' || req.body?.notifyMail === 'on';
    if (!title) {
      req.flash('error', 'タイトルを入力してください');
      return res.redirect('/admin/notices');
    }
    const created = await Notice.create({
      title,
      category,
      body,
      url,
      notifyMail,
      publishedAt: new Date(),
      createdBy: req.user?._id || null
    });
    if (notifyMail) {
      try {
        const users = await User.find({ isMail: true }).select('email').lean();
        const emails = (users || []).map((u) => u.email).filter(Boolean);
        if (emails.length) {
          const subject = `【7 DAYS PLANからのお知らせ】${title}`;
          const html = await renderTemplate('notice', { title, body, url });
          await sendMail({ to: emails, subject, html });
        }
      } catch (mailErr) {
        console.error('notice mail error', mailErr);
      }
    }
    req.flash('success', 'お知らせを登録しました');
    await logAdminAction('create_notice', { actorId: req.user?._id || null, detail: created._id?.toString?.() || '' });
    res.redirect('/admin/notices');
  } catch (e) {
    console.error('notice create error', e);
    req.flash('error', 'お知らせの登録に失敗しました');
    res.redirect('/admin/notices');
  }
});

router.get('/notices/:id', async (req, res) => {
  try {
    const notice = await Notice.findById(req.params.id).lean();
    if (!notice) {
      req.flash('error', 'お知らせが見つかりません');
      return res.redirect('/admin/notices');
    }
    const categories = await Notice.distinct('category');
    res.render('admin/admin-notices', {
      notices: await Notice.find({}).sort({ publishedAt: -1, createdAt: -1 }).lean(),
      categories,
      editTarget: notice,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (e) {
    console.error('notice edit page error', e);
    req.flash('error', 'お知らせの取得に失敗しました');
    res.redirect('/admin/notices');
  }
});

router.post('/notices/:id', async (req, res) => {
  try {
    const title = (req.body?.title || '').trim();
    const category = (req.body?.category || '').trim();
    const body = (req.body?.body || '').trim();
    const url = (req.body?.url || '').trim();
    const notifyMail = req.body?.notifyMail === 'true' || req.body?.notifyMail === 'on';
    if (!title) {
      req.flash('error', 'タイトルを入力してください');
      return res.redirect(`/admin/notices/${req.params.id}`);
    }
    const updated = await Notice.findByIdAndUpdate(req.params.id, {
      $set: { title, category, body, url, notifyMail }
    }, { new: true });
    if (!updated) {
      req.flash('error', 'お知らせが見つかりません');
      return res.redirect('/admin/notices');
    }
    req.flash('success', 'お知らせを更新しました');
    await logAdminAction('update_notice', { actorId: req.user?._id || null, detail: updated._id?.toString?.() || '' });
    res.redirect('/admin/notices');
  } catch (e) {
    console.error('notice update error', e);
    req.flash('error', 'お知らせの更新に失敗しました');
    res.redirect(`/admin/notices/${req.params.id}`);
  }
});

router.post('/notices/:id/delete', async (req, res) => {
  try {
    const deleted = await Notice.findByIdAndDelete(req.params.id);
    if (!deleted) {
      req.flash('error', 'お知らせが見つかりません');
      return res.redirect('/admin/notices');
    }
    req.flash('success', 'お知らせを削除しました');
    await logAdminAction('delete_notice', { actorId: req.user?._id || null, detail: deleted._id?.toString?.() || '' });
    res.redirect('/admin/notices');
  } catch (e) {
    console.error('notice delete error', e);
    req.flash('error', 'お知らせの削除に失敗しました');
    res.redirect('/admin/notices');
  }
});

// 備品一覧
router.get('/equipment-list', async (req, res) => {
  try {
    const { keyword, houseCategory, disasterCategory, campingCategory, consumable } = req.query;
    const filter = {};
    const and = [];
    if (keyword) {
      const re = new RegExp(String(keyword), 'i');
      and.push({ $or: [
        { name: re },
        { unit: re },
        { houseCategory: re },
        { disasterCategory: re },
        { campingCategory: re },
        { maintenance: re }
      ]});
    }
    if (houseCategory) and.push({ houseCategory });
    if (disasterCategory) and.push({ disasterCategory });
    if (campingCategory) and.push({ campingCategory });
    if (consumable === 'true') and.push({ isConsumable: true });
    if (consumable === 'false') and.push({ isConsumable: false });
    if (and.length) filter.$and = and;

    const equipments = await Equipment.find(filter).sort({ name: 1 }).lean();
    const equipmentIds = equipments.map(e => e._id).filter(Boolean);
    let usageMap = {};
    if (equipmentIds.length) {
      const usageStats = await MyEquipment.aggregate([
        { $match: { equipment: { $in: equipmentIds } } },
        { $group: { _id: '$equipment', count: { $sum: 1 } } }
      ]);
      usageMap = usageStats.reduce((acc, stat) => {
        acc[String(stat._id)] = stat.count;
        return acc;
      }, {});
    }
    const equipmentsWithUsage = equipments.map(e => ({
      ...e,
      usageCount: usageMap[String(e._id)] || 0
    }));

    // distinct values for selects
    const [units, houseCategories, disasterCategories, campingCategories, maintenances] = await Promise.all([
      Equipment.distinct('unit'),
      Equipment.distinct('houseCategory'),
      Equipment.distinct('disasterCategory'),
      Equipment.distinct('campingCategory'),
      Equipment.distinct('maintenance')
    ]);

    res.render('admin/equipment-list', {
      equipments: equipmentsWithUsage,
      keyword: keyword || '',
      selectedHouse: houseCategory || '',
      selectedDisaster: disasterCategory || '',
      selectedCamping: campingCategory || '',
      selectedConsumable: consumable || '',
      units,
      houseCategories,
      disasterCategories,
      campingCategories,
      maintenances
    });
  } catch (err) {
    console.error('備品一覧取得エラー:', err);
    res.status(500).send('備品一覧を取得できませんでした');
  }
});

// 備品新規作成 画面
router.get('/equipment-new', async (req, res) => {
  try {
    const [units, houseCategories, disasterCategories, campingCategories, maintenances] = await Promise.all([
      Equipment.distinct('unit'),
      Equipment.distinct('houseCategory'),
      Equipment.distinct('disasterCategory'),
      Equipment.distinct('campingCategory'),
      Equipment.distinct('maintenance')
    ]);
    res.render('admin/equipment-new', { units, houseCategories, disasterCategories, campingCategories, maintenances });
  } catch (err) {
    console.error('備品新規作成ページ表示エラー:', err);
    res.status(500).send('備品新規作成ページを表示できませんでした');
  }
});

// 備品新規作成 保存
router.post('/equipment-new', async (req, res) => {
  try {
    const { name, unit, isConsumable, houseCategory, disasterCategory, campingCategory, maintenance } = req.body;
    await Equipment.create({
      name: String(name || '').trim(),
      unit: String(unit || '').trim(),
      isConsumable: isConsumable === 'true' || isConsumable === true || isConsumable === 'on',
      houseCategory: String(houseCategory || '').trim(),
      disasterCategory: String(disasterCategory || '').trim(),
      campingCategory: String(campingCategory || '').trim(),
      maintenance: String(maintenance || '').trim()
    });
    res.redirect('/admin/equipment-list');
  } catch (err) {
    console.error('備品保存エラー:', err);
    res.status(500).send('備品を保存できませんでした');
  }
});

// 備品編集 画面
router.get('/equipment-edit/:id', async (req, res) => {
  try {
    const eq = await Equipment.findById(req.params.id).lean();
    if (!eq) return res.status(404).send('該当の備品が見つかりません');
    const [units, houseCategories, disasterCategories, campingCategories, maintenances] = await Promise.all([
      Equipment.distinct('unit'),
      Equipment.distinct('houseCategory'),
      Equipment.distinct('disasterCategory'),
      Equipment.distinct('campingCategory'),
      Equipment.distinct('maintenance')
    ]);
    res.render('admin/equipment-edit', { eq, units, houseCategories, disasterCategories, campingCategories, maintenances });
  } catch (err) {
    console.error('備品編集画面表示エラー:', err);
    res.status(500).send('編集画面を表示できませんでした');
  }
});

// 備品編集 保存
router.post('/equipment-edit/:id', async (req, res) => {
  try {
    const { name, unit, isConsumable, houseCategory, disasterCategory, campingCategory, maintenance } = req.body;
    await Equipment.findByIdAndUpdate(req.params.id, {
      name: String(name || '').trim(),
      unit: String(unit || '').trim(),
      isConsumable: isConsumable === 'true' || isConsumable === true || isConsumable === 'on',
      houseCategory: String(houseCategory || '').trim(),
      disasterCategory: String(disasterCategory || '').trim(),
      campingCategory: String(campingCategory || '').trim(),
      maintenance: String(maintenance || '').trim()
    });
    res.redirect('/admin/equipment-list');
  } catch (err) {
    console.error('備品更新エラー:', err);
    res.status(500).send('備品を更新できませんでした');
  }
});

// 備品削除
router.post('/equipment-delete/:id', async (req, res) => {
  try {
    await Equipment.findByIdAndDelete(req.params.id);
    res.redirect('/admin/equipment-list');
  } catch (err) {
    console.error('備品削除エラー:', err);
    res.status(500).send('備品を削除できませんでした');
  }
});

// レシピ一覧画面（DBから取得）
router.get('/menu-list', async (req, res) => {
  try {
    const { kind, junle, cook, keyword, image: imageFilter, makeAhead, basicMenu } = req.query;

    const filterConditions = [];

    if (kind) filterConditions.push({ kind });
    if (junle) filterConditions.push({ junle });
    if (cook) filterConditions.push({ cook });
    if (keyword) {
      filterConditions.push({
        $or: [
          { name: new RegExp(keyword, 'i') },
          { yomi: new RegExp(keyword, 'i') },
          { kind: new RegExp(keyword, 'i') },
          { cook: new RegExp(keyword, 'i') },
          { content: new RegExp(keyword, 'i') },
          { ingredient: new RegExp(keyword, 'i') }
        ]
      });
    }

    if (imageFilter === 'with') {
      filterConditions.push({
        imageUrl: { $exists: true, $nin: [null, ''] }
      });
    } else if (imageFilter === 'without') {
      filterConditions.push({
        $or: [
          { imageUrl: { $exists: false } },
          { imageUrl: null },
          { imageUrl: '' }
        ]
      });
    }
    if (toBool(makeAhead)) {
      filterConditions.push({ makeAhead: true });
    }
    if (toBool(basicMenu)) {
      filterConditions.push({ basicMenu: true });
    }

    const composedFilter = filterConditions.length ? { $and: filterConditions } : {};

    const menus = await Menu.find(composedFilter)
      .populate({ path: 'ingredients.name', model: 'Ingredient' })
      .populate({ path: 'seasoning.name', model: 'Seasoning' });

    // kind, junle, cook のユニークな一覧を取得
    const allMenus = await Menu.find(); // 全体から取得するため再取得
    const kindList = [...new Set(allMenus.map(menu => menu.kind).filter(Boolean))];
    const junleList = [...new Set(allMenus.map(menu => menu.junle).filter(Boolean))];
    const cookList = [...new Set(allMenus.map(menu => menu.cook).filter(Boolean))];
    const ingredientList = await Ingredient.find();
    const seasoningList = await Seasoning.find();

    const appliedParams = new URLSearchParams();
    if (kind) appliedParams.append('kind', kind);
    if (junle) appliedParams.append('junle', junle);
    if (cook) appliedParams.append('cook', cook);
    if (keyword) appliedParams.append('keyword', keyword);
    if (imageFilter) appliedParams.append('image', imageFilter);
    if (toBool(makeAhead)) appliedParams.append('makeAhead', 'true');
    if (toBool(basicMenu)) appliedParams.append('basicMenu', 'true');
    const filterQueryString = appliedParams.toString();
    const filterQueryEncoded = encodeURIComponent(filterQueryString);

    res.render('admin/menu-list', {
      menus,
      kindList,
      junleList,
      cookList,
      selectedType: kind || '',
      selectedJunle: junle || '',
      selectedCook: cook || '',
      keyword: keyword || '',
      selectedImageFilter: imageFilter || '',
      selectedMakeAhead: toBool(makeAhead) ? 'true' : '',
      selectedBasicMenu: toBool(basicMenu) ? 'true' : '',
      menusJSON: JSON.stringify(menus), // 🔸追加
      ingredientList,
      seasoningList,
      filterQueryString,
      filterQueryEncoded
    });
  } catch (err) {
    console.error('メニュー取得エラー:', err);
    res.status(500).send('メニューを取得できませんでした');
  }
});

// レシピ一覧絞り込み処理（POST → GET へリダイレクト）
router.post('/menu-list', (req, res) => {
  const { kind, junle, cook, keyword, image, makeAhead, basicMenu } = req.body;

  const query = new URLSearchParams();
  if (kind) query.append('kind', kind);
  if (junle) query.append('junle', junle);
  if (cook) query.append('cook', cook);
  if (keyword) query.append('keyword', keyword);
  if (image) query.append('image', image);
  if (makeAhead) query.append('makeAhead', makeAhead);
  if (basicMenu) query.append('basicMenu', basicMenu);

  res.redirect(`/admin/menu-list?${query.toString()}`);
});

// レシピ新規作成画面の表示
router.get('/menu-new', async (req, res) => {
  try {
    const allMenus = await Menu.find(); // 既存データからセレクトボックスの候補を取得
    const kindList = [...new Set(allMenus.map(menu => menu.kind).filter(Boolean))];
    const junleList = [...new Set(allMenus.map(menu => menu.junle).filter(Boolean))];
    const cookList = [...new Set(allMenus.map(menu => menu.cook).filter(Boolean))];
    const filterParam = typeof req.query.filters === 'string' ? req.query.filters : '';
    let filters = '';
    try { filters = filterParam ? decodeURIComponent(filterParam) : ''; } catch (_) { filters = filterParam; }

    // Fetch all existing menu names from DB (distinct)
    const menuList = await Menu.find().distinct('menu');

    // 🔽 食材と調味料の取得を short_nutrition 含めて取得
    const ingredientsRaw = await Ingredient.find().select('ingredient classification unit energy protein lipid carbohydrate');
    const ingredients = ingredientsRaw.map(item => {
      const short_nutrition = item.energy
        ? `${item.energy}kcal P${item.protein || 0}g F${item.lipid || 0}g C${item.carbohydrate || 0}g`
        : '';
      return {
        ...item.toObject(),
        short_nutrition
      };
    });
    const seasoningsRaw = await Seasoning.find().select('seasoning classification unit energy protein lipid carbohydrate');
    const seasonings = seasoningsRaw.map(item => {
      const short_nutrition = item.energy
        ? `${item.energy}kcal P${item.protein || 0}g F${item.lipid || 0}g C${item.carbohydrate || 0}g`
        : '';
      return {
        ...item.toObject(),
        short_nutrition
      };
    });
    const initialIngredients = ingredients.slice(0, 10);
    const initialSeasonings = seasonings.slice(0, 10);

    const genreList = [...new Set(ingredients.map(i => i.classification).filter(Boolean))];
    const seasoningGenreList = [...new Set(seasonings.map(s => s.classification).filter(Boolean))];
    res.render('admin/menu-new', {
      kindList,
      junleList,
      menuList,
      cookList,
      ingredients,
      seasonings,
      junleListJSON: JSON.stringify(junleList),
      initialIngredients,
      initialSeasonings,
      genreList,
      seasoningGenreList,
      filters
    });
  } catch (err) {
    console.error('新規作成ページ表示エラー:', err);
    res.status(500).send('新規作成ページを表示できませんでした');
  }
});

router.get('/api/ingredients', async (req, res) => {
  const { keyword, genre, favorite } = req.query;

  // recent=true で直近使用順
  if (req.query.recent === 'true') {
    const recentIngredients = await Ingredient.find({ used_date: { $exists: true } })
      .sort({ used_date: -1 })
      .limit(20);
    return res.json(recentIngredients);
  }

  const filter = {};
  if (keyword) {
    const keywordRegex = new RegExp(keyword, 'i');
    filter.$or = [
      { ingredient: keywordRegex },
      { yomi: keywordRegex },
      { classification: keywordRegex },
      { unit: { $in: [keywordRegex] } }
    ];
  }
  if (genre) {
    filter.classification = genre;
  }
  if (favorite === 'true') {
    filter.favorite = true;
  }

  const applyLimit = (keyword && keyword.length>0) || (genre && genre.length>0) || favorite === 'true' || req.query.recent === 'true';
  let query = Ingredient.find(filter);
  if (applyLimit) query = query.limit(200);
  const results = await query;
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
});


// 調味料検索用APIエンドポイント
router.get('/api/seasonings', async (req, res) => {
  const { keyword, genre, favorite } = req.query;

  // recent=true で直近使用順
  if (req.query.recent === 'true') {
    const recentSeasonings = await Seasoning.find({ used_date: { $exists: true } })
      .sort({ used_date: -1 })
      .limit(20);
    return res.json(recentSeasonings);
  }

  const filter = {};
  if (keyword) {
    const keywordRegex = new RegExp(keyword, 'i');
    filter.$or = [
      { seasoning: keywordRegex },
      { yomi: keywordRegex },
      { classification: keywordRegex },
      { unit: { $in: [keywordRegex] } }
    ];
  }
  if (genre) {
    filter.classification = genre;
  }
  if (favorite === 'true') {
    filter.favorite = true;
  }

  const applyLimit = (keyword && keyword.length>0) || (genre && genre.length>0) || favorite === 'true' || req.query.recent === 'true';
  let query = Seasoning.find(filter);
  if (applyLimit) query = query.limit(200);
  const results = await query;
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
});

// お気に入りトグル（共通: ingredient, seasoning）
router.post('/api/favorite/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const Model = type === 'ingredient' ? Ingredient : type === 'seasoning' ? Seasoning : null;
    if (!Model) return res.status(400).json({ error: 'Invalid type' });

    const item = await Model.findById(id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    item.favorite = true;
    await item.save();
    res.json({ success: true, favorite: item.favorite });
  } catch (err) {
    console.error('お気に入り追加エラー:', err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.delete('/api/favorite/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const Model = type === 'ingredient' ? Ingredient : type === 'seasoning' ? Seasoning : null;
    if (!Model) return res.status(400).json({ error: 'Invalid type' });

    const item = await Model.findById(id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    item.favorite = false;
    await item.save();
    res.json({ success: true, favorite: item.favorite });
  } catch (err) {
    console.error('お気に入り削除エラー:', err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// レシピ新規作成処理（保存）
router.post('/menu-new', async (req, res) => {
  try {
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
      yomi,
      material,
      makeAhead,
      basicMenu,
      season = [],
      ingredient_ids = [],
      ingredient_amounts = [],
      ingredient_units = [],
      seasoning_ids = [],
      seasoning_amounts = [],
      seasoning_units = [],
      filters: filtersRaw = ''
    } = req.body;
    const filters = typeof filtersRaw === 'string' ? filtersRaw.replace(/^\?/, '') : '';

    // 食材の構造を整える
    const ingredients = ingredient_ids.map((id, index) => ({
      name: id,
      amount: ingredient_amounts[index],
      unit: ingredient_units[index]
    }));

    // 調味料の構造を整える
    const seasonings = seasoning_ids.map((id, index) => ({
      name: id,
      amount: seasoning_amounts[index],
      unit: seasoning_units[index]
    }));
    const selectedSeasons = normalizeSeasonList(season);

    const newMenu = new Menu({
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
      yomi,
      material: toBool(material),
      makeAhead: toBool(makeAhead),
      basicMenu: toBool(basicMenu),
      isPrivate: toBool(req.body.isPrivate),
      ingredients,
      seasoning: seasonings,
      season: selectedSeasons,
      share: false,
      entry_date: new Date()
    });

    await newMenu.save();
    await logAdminAction('menu:create', {
      menuId: newMenu._id,
      menuName: newMenu.name || '',
      actorId: req.user?._id || null,
      detail: `created by admin (${req.user?.username || req.user?.email || 'unknown'})`
    });
    if (filters) {
      res.redirect(`/admin/menu-list?${filters}`);
    } else {
      res.redirect('/admin/menu-list');
    }
  } catch (err) {
    console.error('レシピ保存エラー:', err);
    res.status(500).send('レシピを保存できませんでした');
  }
});

// レシピ編集画面の表示
router.get('/menu-edit/:id', async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.id)
      .populate({ path: 'ingredients.name', model: 'Ingredient' })
      .populate({ path: 'seasoning.name', model: 'Seasoning' });
    if (!menu) {
      return res.status(404).send('該当レシピが見つかりません');
    }

    const allMenus = await Menu.find(); // セレクトボックスの候補用
    const kindList = [...new Set(allMenus.map(menu => menu.kind).filter(Boolean))];
    const junleList = [...new Set(allMenus.map(menu => menu.junle).filter(Boolean))];
    const cookList = [...new Set(allMenus.map(menu => menu.cook).filter(Boolean))];

    // Fetch all existing menu names from DB (distinct)
    const menuList = await Menu.find().distinct('menu');

    // 追加: 食材と調味料を取得（栄養情報含む）＋ short_nutrition を動的生成
    const ingredientsRaw = await Ingredient.find().select('ingredient classification unit energy protein lipid carbohydrate');
    const ingredients = ingredientsRaw.map(item => {
      const short_nutrition = item.energy
        ? `${item.energy}kcal P${item.protein || 0}g F${item.lipid || 0}g C${item.carbohydrate || 0}g`
        : '';
      return {
        ...item.toObject(),
        short_nutrition
      };
    });
    const seasoningsRaw = await Seasoning.find().select('seasoning classification unit energy protein lipid carbohydrate');
    const seasonings = seasoningsRaw.map(item => {
      const short_nutrition = item.energy
        ? `${item.energy}kcal P${item.protein || 0}g F${item.lipid || 0}g C${item.carbohydrate || 0}g`
        : '';
      return {
        ...item.toObject(),
        short_nutrition
      };
    });
    const genreList = [...new Set(ingredients.map(i => i.classification).filter(Boolean))];
    const seasoningGenreList = [...new Set(seasonings.map(s => s.classification).filter(Boolean))];
    const initialIngredients = ingredients.slice(0, 10);
    const initialSeasonings = seasonings.slice(0, 10);

    const filtersRaw = typeof req.query.filters === 'string' ? req.query.filters : '';
    let filters = '';
    try { filters = filtersRaw ? decodeURIComponent(filtersRaw) : ''; } catch (_) { filters = filtersRaw; }
    const backToListUrl = filters ? `/admin/menu-list?${filters}` : '/admin/menu-list';
    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const menuUrlForForm = menu.url || `${baseUrl}/users/menu/${menu._id}`;

    res.render('admin/menu-edit', {
      menu,
      kindList,
      junleList,
      menuList,
      cookList,
      junleListJSON: JSON.stringify(junleList),
      ingredients,
      seasonings,
      ingredientList: ingredients,
      seasoningList: seasonings,
      genreList,
      seasoningGenreList,
      initialIngredients,
      initialSeasonings,
      filters,
      backToListUrl,
      menuUrlForForm
    });
  } catch (err) {
    console.error('レシピ編集画面表示エラー:', err);
    res.status(500).send('編集画面を表示できませんでした');
  }
});

// レシピ編集処理（保存）
router.post('/menu-edit/:id', async (req, res) => {
  try {
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
      yomi,
      material,
      makeAhead,
      basicMenu,
      season = [],
      ingredient_ids = [],
      ingredient_amounts = [],
      ingredient_units = [],
      seasoning_ids = [],
      seasoning_amounts = [],
      seasoning_units = [],
      filters: filtersRaw = ''
    } = req.body;
    const filters = typeof filtersRaw === 'string' ? filtersRaw.replace(/^\?/, '') : '';

    // 食材の構造を整える
    const ingredients = ingredient_ids.map((id, index) => ({
      name: id,
      amount: ingredient_amounts[index],
      unit: ingredient_units[index]
    }));

    // 調味料の構造を整える
    const seasonings = seasoning_ids.map((id, index) => ({
      name: id,
      amount: seasoning_amounts[index],
      unit: seasoning_units[index]
    }));
    const selectedSeasons = normalizeSeasonList(season);

    await Menu.findByIdAndUpdate(req.params.id, {
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
      yomi,
      material: toBool(material),
      makeAhead: toBool(makeAhead),
      basicMenu: toBool(basicMenu),
      isPrivate: toBool(req.body.isPrivate),
      ingredients,
      seasoning: seasonings,
      season: selectedSeasons
    });

    const redirectUrl = filters ? `/admin/menu-list?${filters}` : '/admin/menu-list';
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('レシピ更新エラー:', err);
    res.status(500).send('レシピを更新できませんでした');
  }
});

// レシピ削除処理
router.post('/menu-delete/:id', async (req, res) => {
  try {
    const filtersRaw = typeof req.body.filters === 'string'
      ? req.body.filters
      : (typeof req.query.filters === 'string' ? req.query.filters : '');
    const filters = filtersRaw ? filtersRaw.replace(/^\?/, '') : '';
    const targetMenu = await Menu.findById(req.params.id).lean();
    await Mymenu.deleteMany({ menu: req.params.id }); // レシピ削除時に紐づくマイメニューも掃除
    await Menu.findByIdAndDelete(req.params.id);
    if (targetMenu) {
      await logAdminAction('menu:delete', {
        menuId: targetMenu._id,
        menuName: targetMenu.name || '',
        actorId: req.user?._id || null,
        detail: `deleted by admin (${req.user?.username || req.user?.email || 'unknown'})`
      });
    } else {
      await logAdminAction('menu:delete', {
        menuId: req.params.id,
        menuName: '',
        actorId: req.user?._id || null,
        detail: 'delete attempted but menu not found'
      });
    }
    if (filters) {
      res.redirect(`/admin/menu-list?${filters}`);
    } else {
      res.redirect('/admin/menu-list');
    }
  } catch (err) {
    console.error('レシピ削除エラー:', err);
    res.status(500).send('レシピを削除できませんでした');
  }
});


// 食材一覧画面の表示（分類によるフィルター付き）
router.get('/ingredient-list', async (req, res) => {
  try {
    const { classification, keyword } = req.query;
    const missingConversion = req.query.missingConversion === 'true';
    const missingSeason = req.query.missingSeason === 'true';
    const missingMonth = req.query.missingMonth === 'true';
    const missingWiki = req.query.missingWiki === 'true';

    const and = [];
    if (classification) and.push({ classification });
    if (keyword) {
      const keywordRegex = new RegExp(keyword, 'i');
      and.push({
        $or: [
          { ingredient: keywordRegex },
          { yomi: keywordRegex },
          { classification: keywordRegex },
          { unit: { $in: [keywordRegex] } }
        ]
      });
    }
    if (missingConversion) {
      and.push({
        $or: [
          { unitConversions: { $exists: false } },
          { unitConversions: { $size: 0 } },
          { unitConversions: { $not: { $elemMatch: { grams: { $gt: 0 } } } } }
        ]
      });
    }
    if (missingSeason) {
      and.push({
        $or: [
          { season: { $exists: false } },
          { season: { $size: 0 } },
          { season: { $in: [null, ''] } }
        ]
      });
    }
    if (missingMonth) {
      and.push({
        $or: [
          { month: { $exists: false } },
          { month: { $size: 0 } },
          { month: { $in: [null, ''] } }
        ]
      });
    }
    if (missingWiki) {
      and.push({
        $or: [
          { wikiUrl: { $exists: false } },
          { wikiUrl: { $in: [null, ''] } }
        ]
      });
    }

    const filter = and.length ? { $and: and } : {};

    const ingredients = await Ingredient.find(filter);
    const categoryList = await buildIngredientCategoryList();

    const currentQuery = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)
      : '';

    res.render('admin/ingredient-list', {
      ingredients,
      categoryList,
      selectedCategory: classification || '',
      classification: classification || '',
      keyword: keyword || '',
      missingConversion,
      missingSeason,
      missingMonth,
      missingWiki,
      currentQuery
    });
  } catch (err) {
    console.error('食材取得エラー:', err);
    res.status(500).send('食材を取得できませんでした');
  }
});

// 食材一覧絞り込み処理（POST → GET へリダイレクト）
router.post('/ingredient-list', (req, res) => {
  // Accept both 'category' and legacy 'classification' from form
  const classification = req.body.classification;
  const keyword = req.body.keyword;
  const missingConversion = req.body.missingConversion;
  const missingSeason = req.body.missingSeason;
  const missingMonth = req.body.missingMonth;
  const missingWiki = req.body.missingWiki;

  const query = new URLSearchParams();
  if (classification) query.append('classification', classification);
  if (keyword) query.append('keyword', keyword);
  if (missingConversion === 'true' || missingConversion === 'on') query.append('missingConversion', 'true');
  if (missingSeason === 'true' || missingSeason === 'on') query.append('missingSeason', 'true');
  if (missingMonth === 'true' || missingMonth === 'on') query.append('missingMonth', 'true');
  if (missingWiki === 'true' || missingWiki === 'on') query.append('missingWiki', 'true');

  res.redirect(`/admin/ingredient-list?${query.toString()}`);
});

// 食材新規作成画面の表示
router.get('/ingredient-new', async (req, res) => {
  try {
    const classificationList = await buildIngredientCategoryList();
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';

    res.render('admin/ingredient-new', {
      classificationList,
      returnTo
    });
  } catch (err) {
    console.error('食材新規作成ページ表示エラー:', err);
    res.status(500).send('食材新規作成ページを表示できませんでした');
  }
});

// 食材編集画面の表示
router.get('/ingredient-edit/:id', async (req, res) => {
  try {
    const ingredient = await Ingredient.findById(req.params.id);
    if (!ingredient) {
      return res.status(404).send('該当の食材が見つかりません');
    }

    const classificationList = await buildIngredientCategoryList();
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';

    res.render('admin/ingredient-edit', {
      ingredient,
      classificationList,
      returnTo
    });
  } catch (err) {
    console.error('食材編集画面表示エラー:', err);
    res.status(500).send('編集画面を表示できませんでした');
  }
});

// 食材新規作成処理（保存）
router.post('/ingredient-new', async (req, res) => {
  try {
    const {
      classification,
      ingredient,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit,
      unitGrams,
      season,
      month,
      comment,
      wikiUrl,
      imageUrl,
      returnTo
    } = req.body;

    const { units, conversions } = normalizeUnitPayload(unit, unitGrams);
    const newIngredient = new Ingredient({
      classification,
      ingredient,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: units,
      unitConversions: conversions,
      season: Array.isArray(season) ? season : season ? [season] : [],
      month:  Array.isArray(month)  ? month  : month  ? [month]  : [],
      comment,
      wikiUrl: typeof wikiUrl === 'string' ? wikiUrl.trim() : '',
      imageUrl: typeof imageUrl === 'string' ? imageUrl.trim() : ''
    });

    await newIngredient.save();
    if (returnTo && typeof returnTo === 'string') {
      const sanitized = returnTo.replace(/^\?/, '');
      res.redirect(`/admin/ingredient-list${sanitized ? '?' + sanitized : ''}`);
    } else {
      res.redirect('/admin/ingredient-list');
    }
  } catch (err) {
    console.error('食材保存エラー:', err);
    res.status(500).send('食材を保存できませんでした');
  }
});

// 食材編集処理（保存）
router.post('/ingredient-edit/:id', async (req, res) => {
  try {
    const {
      classification,
      ingredient,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit,
      unitGrams,
      season,
      month,
      comment,
      wikiUrl,
      imageUrl,
      returnTo
    } = req.body;

    const { units, conversions } = normalizeUnitPayload(unit, unitGrams);
    await Ingredient.findByIdAndUpdate(req.params.id, {
      classification,
      ingredient,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: units,
      unitConversions: conversions,
      season: Array.isArray(season) ? season : season ? [season] : [],
      month:  Array.isArray(month)  ? month  : month  ? [month]  : [],
      comment,
      wikiUrl: typeof wikiUrl === 'string' ? wikiUrl.trim() : '',
      imageUrl: typeof imageUrl === 'string' ? imageUrl.trim() : ''
    });

    if (returnTo && typeof returnTo === 'string') {
      const sanitized = returnTo.replace(/^\?/, '');
      res.redirect(`/admin/ingredient-list${sanitized ? '?' + sanitized : ''}`);
    } else {
      res.redirect('/admin/ingredient-list');
    }
  } catch (err) {
    console.error('食材更新エラー:', err);
    res.status(500).send('食材を更新できませんでした');
  }
});


// 食材削除処理
router.post('/ingredient-delete/:id', async (req, res) => {
  try {
    const returnTo = typeof req.body.returnTo === 'string' ? req.body.returnTo : '';
    await Ingredient.findByIdAndDelete(req.params.id);
    if (returnTo) {
      const sanitized = returnTo.replace(/^\?/, '');
      res.redirect(`/admin/ingredient-list${sanitized ? '?' + sanitized : ''}`);
    } else {
      res.redirect('/admin/ingredient-list');
    }
  } catch (err) {
    console.error('食材削除エラー:', err);
    res.status(500).send('食材を削除できませんでした');
  }
});

// 調味料一覧画面の表示（分類によるフィルター付き）
router.get('/seasoning-list', async (req, res) => {
  try {
    const { classification, keyword } = req.query;
    const missingWiki = req.query.missingWiki === 'true';

    const and = [];
    if (classification) and.push({ classification });
    if (keyword) {
      const keywordRegex = new RegExp(keyword, 'i');
      and.push({
        $or: [
          { seasoning: keywordRegex },
          { yomi: keywordRegex },
          { classification: keywordRegex },
          { unit: { $in: [keywordRegex] } }
        ]
      });
    }
    if (missingWiki) {
      and.push({
        $or: [
          { wikiUrl: { $exists: false } },
          { wikiUrl: { $in: [null, ''] } }
        ]
      });
    }

    const filter = and.length ? { $and: and } : {};

    const seasonings = await Seasoning.find(filter);
    const allSeasonings = await Seasoning.find();
    const categoryList = [...new Set(allSeasonings.map(item => item.classification).filter(Boolean))];

    const currentQuery = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)
      : '';

    res.render('admin/seasoning-list', {
      seasonings,
      categoryList,
      selectedCategory: classification || '',
      classification: classification || '',
      keyword: keyword || '',
      missingWiki,
      currentQuery
    });
  } catch (err) {
    console.error('調味料取得エラー:', err);
    res.status(500).send('調味料を取得できませんでした');
  }
});

// 調味料一覧絞り込み処理（POST → GET へリダイレクト）
router.post('/seasoning-list', (req, res) => {
  const classification = req.body.classification;
  const keyword = req.body.keyword;
  const missingWiki = req.body.missingWiki;

  const query = new URLSearchParams();
  if (classification) query.append('classification', classification);
  if (keyword) query.append('keyword', keyword);
  if (missingWiki === 'true' || missingWiki === 'on') query.append('missingWiki', 'true');

  res.redirect(`/admin/seasoning-list?${query.toString()}`);
});

// 調味料新規作成画面の表示
router.get('/seasoning-new', async (req, res) => {
  try {
    const allSeasonings = await Seasoning.find();
    const classificationList = [...new Set(allSeasonings.map(item => item.classification).filter(Boolean))];
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';

    res.render('admin/seasoning-new', {
      classificationList,
      returnTo
    });
  } catch (err) {
    console.error('調味料新規作成ページ表示エラー:', err);
    res.status(500).send('調味料新規作成ページを表示できませんでした');
  }
});

// 調味料編集画面の表示
router.get('/seasoning-edit/:id', async (req, res) => {
  try {
    const seasoning = await Seasoning.findById(req.params.id);
    if (!seasoning) {
      return res.status(404).send('該当の調味料が見つかりません');
    }

    const allSeasonings = await Seasoning.find();
    const classificationList = [...new Set(allSeasonings.map(item => item.classification).filter(Boolean))];
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';

    res.render('admin/seasoning-edit', {
      seasoning,
      classificationList,
      returnTo
    });
  } catch (err) {
    console.error('調味料編集画面表示エラー:', err);
    res.status(500).send('編集画面を表示できませんでした');
  }
});

// 調味料新規作成処理（保存）
router.post('/seasoning-new', async (req, res) => {
  try {
    const {
      classification,
      seasoning,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit,
      unitGrams,
      comment,
      wikiUrl,
      imageUrl,
      returnTo
    } = req.body;

    const { units, conversions } = normalizeUnitPayload(unit, unitGrams);
    const newSeasoning = new Seasoning({
      classification,
      seasoning,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: units,
      unitConversions: conversions,
      comment,
      wikiUrl: typeof wikiUrl === 'string' ? wikiUrl.trim() : '',
      imageUrl: typeof imageUrl === 'string' ? imageUrl.trim() : ''
    });

    await newSeasoning.save();
    if (returnTo && typeof returnTo === 'string') {
      const sanitized = returnTo.replace(/^\?/, '');
      res.redirect(`/admin/seasoning-list${sanitized ? `?${sanitized}` : ''}`);
    } else {
      res.redirect('/admin/seasoning-list');
    }
  } catch (err) {
    console.error('調味料保存エラー:', err);
    res.status(500).send('調味料を保存できませんでした');
  }
});

// 調味料編集処理（保存）
router.post('/seasoning-edit/:id', async (req, res) => {
  try {
    const {
      classification,
      seasoning,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit,
      unitGrams,
      comment,
      wikiUrl,
      imageUrl,
      returnTo
    } = req.body;

    const { units, conversions } = normalizeUnitPayload(unit, unitGrams);
    await Seasoning.findByIdAndUpdate(req.params.id, {
      classification,
      seasoning,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: units,
      unitConversions: conversions,
      comment,
      wikiUrl: typeof wikiUrl === 'string' ? wikiUrl.trim() : '',
      imageUrl: typeof imageUrl === 'string' ? imageUrl.trim() : ''
    });

    if (returnTo && typeof returnTo === 'string') {
      const sanitized = returnTo.replace(/^\?/, '');
      res.redirect(`/admin/seasoning-list${sanitized ? `?${sanitized}` : ''}`);
    } else {
      res.redirect('/admin/seasoning-list');
    }
  } catch (err) {
    console.error('調味料更新エラー:', err);
    res.status(500).send('調味料を更新できませんでした');
  }
});

// 調味料削除処理
router.post('/seasoning-delete/:id', async (req, res) => {
  try {
    const returnTo = typeof req.body.returnTo === 'string' ? req.body.returnTo : '';
    await Seasoning.findByIdAndDelete(req.params.id);
    if (returnTo) {
      const sanitized = returnTo.replace(/^\?/, '');
      res.redirect(`/admin/seasoning-list${sanitized ? `?${sanitized}` : ''}`);
    } else {
      res.redirect('/admin/seasoning-list');
    }
  } catch (err) {
    console.error('調味料削除エラー:', err);
    res.status(500).send('調味料を削除できませんでした');
  }
});


// 食材使用記録 API
router.post('/api/ingredient-used/:id', async (req, res) => {
  try {
    const ingredient = await Ingredient.findById(req.params.id);
    if (!ingredient) return res.status(404).json({ error: 'Ingredient not found' });

    ingredient.used_date = new Date();
    await ingredient.save();
    res.json({ success: true });
  } catch (err) {
    console.error('食材使用記録エラー:', err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 調味料使用記録 API
router.post('/api/seasoning-used/:id', async (req, res) => {
  try {
    const seasoning = await Seasoning.findById(req.params.id);
    if (!seasoning) return res.status(404).json({ error: 'Seasoning not found' });

    seasoning.used_date = new Date();
    await seasoning.save();
    res.json({ success: true });
  } catch (err) {
    console.error('調味料使用記録エラー:', err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// メニューデータのExcel書き出し
router.get('/export/menus', async (req, res) => {
  try {
    const menus = await Menu.find()
      .sort({ update_date: -1 })
      .populate({ path: 'ingredients.name', model: 'Ingredient' })
      .populate({ path: 'seasoning.name', model: 'Seasoning' });
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Menus');

    // Freeze the first row
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    worksheet.columns = [
      { header: 'メニュー名', key: 'name' },
      { header: 'よみ', key: 'yomi' },
      { header: '種類', key: 'kind' },
      { header: 'メニュー内容', key: 'menu' },
      { header: 'ジャンル', key: 'junle' },
      { header: '調理法', key: 'cook' },
      { header: 'URL', key: 'url' },
      { header: '画像URL', key: 'imageUrl' },
      { header: '時間', key: 'time' },
      { header: '人数', key: 'people' },
      { header: '素材フラグ', key: 'material' },
      { header: '非公開フラグ', key: 'isPrivate' },
      { header: 'コメント', key: 'comment' },
      { header: '作り方テキスト', key: 'instructionText' },
      { header: '食材', key: 'ingredientsText' },
      { header: '調味料', key: 'seasoningText' },
      { header: '共有', key: 'share' },
      { header: '登録日', key: 'entry_date' },
      { header: '更新日', key: 'update_date' },
    ];
    // Style header row
    worksheet.getRow(1).eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'becffdb' } 
      };
    });

    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: worksheet.columns.length }
    };

    menus.forEach(menu => {
      const ingredientsText = JSON.stringify((menu.ingredients || []).map(i => ({
        id: i.name?._id?.toString() || '',
        name: i.name?.ingredient || '',
        amount: i.amount,
        unit: i.unit
      })));

      const seasoningText = JSON.stringify((menu.seasoning || []).map(s => ({
        id: s.name?._id?.toString() || '',
        name: s.name?.seasoning || '',
        amount: s.amount,
        unit: s.unit
      })));

      worksheet.addRow({
        name: menu.name,
        yomi: menu.yomi,
        kind: menu.kind,
        menu: menu.menu,
        junle: menu.junle,
        cook: menu.cook,
        url: menu.url,
        imageUrl: menu.imageUrl,
        time: menu.time,
        people: menu.people,
        material: menu.material,
        isPrivate: menu.isPrivate,
        comment: menu.comment,
        instructionText: menu.instructionText,
        ingredientsText,
        seasoningText,
        share: menu.share,
        entry_date: menu.entry_date,
        update_date: menu.update_date,
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=menus.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('メニュー書き出しエラー:', err);
    res.status(500).send('書き出しに失敗しました');
  }
});

// 食材データのExcel書き出し
router.get('/export/ingredients', async (req, res) => {
  try {
    const ingredients = await Ingredient.find();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ingredients');

    worksheet.columns = [
      { header: '分類', key: 'classification' },
      { header: '食材名', key: 'ingredient' },
      { header: 'よみ', key: 'yomi' },
      { header: 'エネルギー', key: 'energy' },
      { header: '水分', key: 'water' },
      { header: 'たんぱく質', key: 'protein' },
      { header: '脂質', key: 'lipid' },
      { header: '炭水化物', key: 'carbohydrate' },
      { header: '単位', key: 'unit' },
      { header: '単位換算', key: 'unitConversions' },
      { header: 'Wiki URL', key: 'wikiUrl' },
      { header: '画像URL', key: 'imageUrl' },
      { header: 'コメント', key: 'comment' },
      { header: 'お気に入り', key: 'favorite' },
      { header: '旬な季節', key: 'season' },
      { header: '旬な月', key: 'month' },
      { header: '登録日', key: 'entry_date' },
      { header: '更新日', key: 'update_date' },
      { header: '最終使用日', key: 'used_date' },
      { header: 'グループID', key: 'group' },
      { header: '登録者ID', key: 'createdBy' }
    ];

    ingredients.forEach(item => {
      worksheet.addRow({
        classification: item.classification,
        ingredient: item.ingredient,
        yomi: item.yomi,
        energy: item.energy,
        water: item.water,
        protein: item.protein,
        lipid: item.lipid,
        carbohydrate: item.carbohydrate,
        unit: item.unit?.join(', '),
        unitConversions: Array.isArray(item.unitConversions) ? JSON.stringify(item.unitConversions) : '',
        wikiUrl: item.wikiUrl,
        imageUrl: item.imageUrl,
        comment: item.comment,
        favorite: item.favorite,
        season: Array.isArray(item.season) ? item.season.join(', ') : '',
        month: Array.isArray(item.month) ? item.month.join(', ') : '',
        entry_date: item.entry_date,
        update_date: item.update_date,
        used_date: item.used_date,
        group: item.group,
        createdBy: item.createdBy
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ingredients.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('食材書き出しエラー:', err);
    res.status(500).send('書き出しに失敗しました');
  }
});

// 調味料データのExcel書き出し
router.get('/export/seasonings', async (req, res) => {
  try {
    const seasonings = await Seasoning.find();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Seasonings');

    worksheet.columns = [
      { header: '分類', key: 'classification' },
      { header: '調味料名', key: 'seasoning' },
      { header: 'よみ', key: 'yomi' },
      { header: 'エネルギー', key: 'energy' },
      { header: '水分', key: 'water' },
      { header: 'たんぱく質', key: 'protein' },
      { header: '脂質', key: 'lipid' },
      { header: '炭水化物', key: 'carbohydrate' },
      { header: '単位', key: 'unit' },
      { header: '単位換算', key: 'unitConversions' },
      { header: 'Wiki URL', key: 'wikiUrl' },
      { header: '画像URL', key: 'imageUrl' },
      { header: 'コメント', key: 'comment' },
      { header: 'お気に入り', key: 'favorite' },
      { header: '登録日', key: 'entry_date' },
      { header: '更新日', key: 'update_date' },
      { header: '最終使用日', key: 'used_date' },
      { header: 'グループID', key: 'group' },
      { header: '登録者ID', key: 'createdBy' }
    ];

    seasonings.forEach(item => {
      worksheet.addRow({
        classification: item.classification,
        seasoning: item.seasoning,
        yomi: item.yomi,
        energy: item.energy,
        water: item.water,
        protein: item.protein,
        lipid: item.lipid,
        carbohydrate: item.carbohydrate,
        unit: item.unit?.join(', '),
        unitConversions: Array.isArray(item.unitConversions) ? JSON.stringify(item.unitConversions) : '',
        wikiUrl: item.wikiUrl,
        imageUrl: item.imageUrl,
        comment: item.comment,
        favorite: item.favorite,
        entry_date: item.entry_date,
        update_date: item.update_date,
        used_date: item.used_date,
        group: item.group,
        createdBy: item.createdBy
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=seasonings.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('調味料書き出しエラー:', err);
    res.status(500).send('書き出しに失敗しました');
  }
});

// マイストックのExcel書き出し
router.get('/export/my-stock', async (req, res) => {
  try {
    const stocks = await Stock.find()
      .populate('item')
      .populate('place', 'name')
      .populate('user', 'displayname username email')
      .populate('group', 'group_name')
      .lean();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('MyStock');
    worksheet.columns = [
      { header: '種類', key: 'type' },
      { header: 'アイテムID', key: 'itemId' },
      { header: 'アイテム名', key: 'itemName' },
      { header: 'グループ', key: 'group' },
      { header: 'ユーザー', key: 'user' },
      { header: '数量', key: 'amount' },
      { header: '単位', key: 'unit' },
      { header: '保管場所', key: 'place' },
      { header: '賞味期限', key: 'expiryDate' },
      { header: '備蓄品', key: 'stockpile' },
      { header: '商品URL', key: 'productUrl' },
      { header: '画像URL', key: 'productImageUrl' },
      { header: 'コメント', key: 'comment' },
      { header: '最終チェック日時', key: 'lastCheckedAt' },
      { header: '最終チェックメモ', key: 'lastCheckedNote' },
      { header: '最終チェック実施者', key: 'lastCheckedBy' },
      { header: '登録日', key: 'entry_date' },
      { header: '更新日', key: 'update_date' }
    ];
    stocks.forEach((s) => {
      const isIng = s.type === 'ingredient';
      const name = isIng ? s.item?.ingredient : s.item?.seasoning;
      worksheet.addRow({
        type: s.type,
        itemId: s.item?._id?.toString() || '',
        itemName: name || '',
        group: s.group?.group_name || s.group || '',
        user: s.user?.displayname || s.user?.username || '',
        amount: s.amount,
        unit: s.unit,
        place: s.place?.name || '',
        expiryDate: s.expiryDate,
        stockpile: s.stockpile ? 'はい' : 'いいえ',
        productUrl: s.productUrl,
        productImageUrl: s.productImageUrl,
        comment: s.comment,
        lastCheckedAt: s.lastCheckedAt,
        lastCheckedNote: s.lastCheckedNote,
        lastCheckedBy: s.lastCheckedBy,
        entry_date: s.createdAt,
        update_date: s.updatedAt
      });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=my-stock.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('マイストック書き出しエラー:', err);
    res.status(500).send('書き出しに失敗しました');
  }
});

// マイ備品のExcel書き出し
router.get('/export/my-equipment', async (req, res) => {
  try {
    const [items, places] = await Promise.all([
      MyEquipment.find()
        .populate('group', 'group_name')
        .populate('createdBy', 'displayname username email')
        .populate('owner', 'displayname username email')
        .populate('place', 'name')
        .lean(),
      StoragePlace.find().select('name').lean()
    ]);
    const placeNameById = new Map((places || []).map((p) => [String(p._id), p.name]));
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('MyEquipment');
    worksheet.columns = [
      { header: 'グループ', key: 'group' },
      { header: '登録者', key: 'user' },
      { header: '所有者', key: 'owner' },
      { header: '備品名', key: 'name' },
      { header: '数量', key: 'quantity' },
      { header: '単位', key: 'unit' },
      { header: '保管場所', key: 'place' },
      { header: '消耗品', key: 'isConsumable' },
      { header: '家ストック分類', key: 'houseCategory' },
      { header: '防災対策分類', key: 'disasterCategory' },
      { header: 'キャンプ分類', key: 'campingCategory' },
      { header: 'メンテナンス周期', key: 'maintenance' },
      { header: '商品URL', key: 'productUrl' },
      { header: '画像URL', key: 'productImageUrl' },
      { header: 'コメント', key: 'comment' },
      { header: '消費期限', key: 'expiryDate' },
      { header: '棚卸し日時', key: 'lastInventoryAt' },
      { header: '棚卸し実施者', key: 'lastInventoryBy' },
      { header: '棚卸し数量', key: 'lastCount' },
      { header: '棚卸しコメント', key: 'lastComment' },
      { header: '登録日', key: 'entry_date' },
      { header: '更新日', key: 'update_date' }
    ];
    items.forEach((it) => {
      const place = it.place ? (it.place.name || placeNameById.get(String(it.place)) || '') : '';
      const by = it.lastInventoryBy?.displayname || it.lastInventoryBy?.username || '';
      const owner = it.owner ? (it.owner.displayname || it.owner.username || '') : '全員';
      worksheet.addRow({
        group: it.group?.group_name || '',
        user: it.createdBy?.displayname || it.createdBy?.username || '',
        owner,
        name: it.name,
        quantity: it.quantity,
        unit: it.unit,
        place,
        isConsumable: it.isConsumable ? 'はい' : 'いいえ',
        houseCategory: it.houseCategory,
        disasterCategory: it.disasterCategory,
        campingCategory: it.campingCategory,
        maintenance: it.maintenance,
        productUrl: it.productUrl,
        productImageUrl: it.productImageUrl,
        comment: it.comment,
        expiryDate: it.expiryDate,
        lastInventoryAt: it.lastInventoryAt,
        lastInventoryBy: by || '',
        lastCount: it.lastCount,
        lastComment: it.lastComment,
        entry_date: it.createdAt,
        update_date: it.updatedAt
      });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=my-equipment.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('マイ備品書き出しエラー:', err);
    res.status(500).send('書き出しに失敗しました');
  }
});



export default router;
