import express from 'express';
import mongoose from 'mongoose';
import { isLoggedIn } from '../middleware.js';
import Menu from '../models/menu.js';
import Mymenu from '../models/mymenu.js';
import Group from '../models/groups.js';
import multer from 'multer';
import cloudinary from '../utils/cloudinary.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';

const upload = multer({ dest: 'uploads/' });

const router = express.Router();

router.use(isLoggedIn);

// ユーティリティ: 重複無し配列
const unique = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

// ユーティリティ: 周辺のユニークリストを作成
async function getFacetLists() {
  const allMenus = await Menu.find().select('kind junle cook').lean();
  return {
    kinds: unique(allMenus.map((m) => m.kind)),
    junles: unique(allMenus.map((m) => m.junle)),
    cooks: unique(allMenus.map((m) => m.cook))
  };
}

// マイメニューTOP
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user._id;

    const [sharedCount, urlCount, originalCount] = await Promise.all([
      Mymenu.countDocuments({ user: userId, sourceType: 'shared' }),
      Mymenu.countDocuments({ user: userId, sourceType: 'url' }),
      Mymenu.countDocuments({ user: userId, sourceType: 'original' })
    ]);

    const mySharedSamples = await Mymenu.find({ user: userId, sourceType: 'shared' })
      .populate('menu', 'name imageUrl kind')
      .sort({ update_date: -1, entry_date: -1 })
      .limit(4)
      .lean();

    const myOriginalSamples = await Mymenu.find({ user: userId, sourceType: 'original' })
      .populate('menu', 'name imageUrl kind')
      .sort({ update_date: -1, entry_date: -1 })
      .limit(4)
      .lean();

    const myUrlSamples = await Mymenu.find({ user: userId, sourceType: 'url' })
      .populate('menu', 'name imageUrl kind')
      .sort({ update_date: -1, entry_date: -1 })
      .limit(4)
      .lean();

    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const defaultGroupId = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
    const currentGroup = groups.find((g) => g._id.toString() === defaultGroupId) || groups[0] || null;

    let groupMemberItems = [];
    if (currentGroup) {
      groupMemberItems = await Mymenu.find({
        group: currentGroup._id,
        user: { $ne: userId }
      })
        .populate('menu', 'name imageUrl kind')
        .populate('user', 'displayname username')
        .sort({ update_date: -1, entry_date: -1 })
        .limit(10)
        .lean();
    }

    res.render('users/myMenu', {
      mymenuStats: { sharedCount, urlCount, originalCount },
      mySharedSamples,
      myOriginalSamples,
      myUrlSamples,
      groupMemberItems,
      currentGroup
    });
  } catch (err) { next(err); }
});

// 共有メニューから登録 画面 + 検索
router.get('/shared-register', async (req, res, next) => {
  try {
    const { keyword = '', kind = '', junle = '', cook = '', fav = 'all' } = req.query;
    const { kinds, junles, cooks } = await getFacetLists();

    // 管理者が登録した共有メニュー（share=true を優先、なければ全件）
    const menuFilter = [];
    if (kind) menuFilter.push({ kind });
    if (junle) menuFilter.push({ junle });
    if (cook) menuFilter.push({ cook });
    if (keyword) {
      const rx = new RegExp(keyword, 'i');
      menuFilter.push({
        $or: [ { name: rx }, { yomi: rx }, { kind: rx }, { junle: rx }, { cook: rx }, { menu: rx } ]
      });
    }
    const adminShared = await Menu.find(menuFilter.length ? { $and: menuFilter } : {})
      .lean();

    // 会員の共有メニュー（Mymenu.share = true）
    const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
    const myId = req.user._id.toString();
    const myGroupIds = new Set(groups.map((g) => g._id.toString()));

    const sharedUserMenus = await Mymenu.find({ share: true })
      .populate('menu')
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
      if (keyword) {
        const rx = new RegExp(keyword, 'i');
        const fields = [x.name, x.yomi, x.kind, x.junle, x.cook, x.menu].filter(Boolean).join(' ');
        return rx.test(fields);
      }
      return true;
    });

    // 自分のマイメニューID一覧（色付き♡判定用）
    const groupId = res.locals.userDefaultGroupId
      || (groups[0]?._id?.toString() ?? '');
    let myMenuIds = [];
    if (groupId) {
      const mymenus = await Mymenu.find({ user: req.user._id, group: groupId }).select('menu').lean();
      myMenuIds = (mymenus || []).map((m) => (m.menu ? m.menu.toString() : '')).filter(Boolean);
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
      combinedMap.set(m._id.toString(), {
        id: m._id.toString(),
        name: m.name || '',
        kind: m.kind || '',
        junle: m.junle || '',
        cook: m.cook || '',
        imageUrl: m.imageUrl || '',
        url: m.url || '',
        by: null,
        canEdit: myEditableMenuIds.has(m._id.toString())
      });
    });
    (filteredSharedUserMenus || []).forEach((mm) => {
      const m = mm.menu || null;
      if (!m || !m._id) return;
      const id = m._id.toString();
      const byName = (mm.user?.displayname || mm.user?.username || '') || null;
      const existing = combinedMap.get(id);
      if (existing) {
        if (!existing.by && byName) existing.by = byName;
        existing.canEdit = existing.canEdit || myEditableMenuIds.has(id);
      } else {
        combinedMap.set(id, {
          id,
          name: m.name || '',
          kind: m.kind || '',
          junle: m.junle || '',
          cook: m.cook || '',
          imageUrl: m.imageUrl || '',
          url: m.url || '',
          by: byName,
          canEdit: myEditableMenuIds.has(id)
        });
      }
    });

    let list = Array.from(combinedMap.values());
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
      kinds, junles, cooks,
      selected: { kind, junle, cook, keyword, fav },
      list,
      resultCount,
      myMenuIds,
      favoritesCount
    });
  } catch (err) { next(err); }
});

// 自分のマイメニュー一覧（myMenuSharedの絞り込みをmineで表示）
router.get('/mine', (req, res) => {
  const base = '/users/my-menu/shared-register';
  const query = new URLSearchParams({ fav: 'mine' });
  res.redirect(`${base}?${query.toString()}`);
});

// 共有メニューをマイメニューへ登録
router.post('/shared-register', async (req, res, next) => {
  try {
    const { menuId, favorite = 'false', frequency = '3', skill = 'false' } = req.body;
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
      skill: String(skill) === 'true',
      sourceType: 'shared',
      user: req.user._id,
      group: groupId
    });
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
    const ingredients = await Ingredient.find().select('ingredient classification unit').lean();
    const seasonings = await Seasoning.find().select('seasoning classification unit').lean();
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
    const duplicate = await Menu.findOne({ url }).select('_id name').lean();
    if (duplicate) {
      return res.json({ duplicate: true, name: duplicate.name || '' });
    }
    // Node18+ fetch 前提。ネットワーク不可環境では失敗しうる
    const resp = await fetch(url, { method: 'GET' });
    const html = await resp.text();
    const pick = (name) => {
      const rgx = new RegExp(`<meta[^>]+property=["']og:${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
      const m = html.match(rgx);
      return m ? m[1] : '';
    };
    const title = pick('title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '');
    const image = pick('image') || '';
    return res.json({ title, image, duplicate: false });
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
      favorite = 'false', frequency = '3', skill = 'false',
      share = 'false', shareScope = 'group'
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
      ingredients, seasoning: seasonings,
      comment: req.body.comment || '',
      share: String(share) === 'true'
    });

    await Mymenu.create({
      menu: newMenu._id,
      favorite: String(favorite) === 'true',
      frequency: Math.max(1, Math.min(5, Number(frequency) || 3)),
      skill: String(skill) === 'true',
      myurl: url || '',
      share: String(share) === 'true',
      shareScope: shareScope === 'all' ? 'all' : 'group',
      sourceType: 'url',
      user: req.user._id,
      group: groupId
    });

    req.flash('success', 'レシピサイトから登録しました');
    res.redirect('/users/my-menu');
  } catch (err) { next(err); }
});

// --- 食材/調味料 検索API（adminと同等のUI用） ---
router.get('/api/ingredients', async (req, res) => {
  const { keyword, genre, favorite, recent } = req.query;
  try {
    if (recent === 'true') {
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
    if (genre) filter.classification = genre;
    if (favorite === 'true') filter.favorite = true;

    const results = await Ingredient.find(filter).limit(20);
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
  const { keyword, genre, favorite, recent } = req.query;
  try {
    if (recent === 'true') {
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
    if (genre) filter.classification = genre;
    if (favorite === 'true') filter.favorite = true;

    const results = await Seasoning.find(filter).limit(20);
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
    res.render('users/myMenuOriginal', { kinds, junles, cooks, myOriginalCount });
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
      instruction = '',
      favorite = 'false', frequency = '3', skill = 'false',
      share = 'false', shareScope = 'group'
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

    // オリジナルはURLは無し、コメントに作り方を格納
    const newMenu = await Menu.create({
      name, yomi, menu, kind, junle, cook,
      url: '', imageUrl, time, people: Number(people) || 1,
      ingredients, seasoning: seasonings,
      comment: instruction,
      share: String(share) === 'true'
    });

    await Mymenu.create({
      menu: newMenu._id,
      favorite: String(favorite) === 'true',
      frequency: Math.max(1, Math.min(5, Number(frequency) || 3)),
      skill: String(skill) === 'true',
      share: String(share) === 'true',
      shareScope: shareScope === 'all' ? 'all' : 'group',
      sourceType: 'original',
      user: req.user._id,
      group: groupId
    });

    req.flash('success', 'オリジナルレシピを登録しました');
    res.redirect('/users/my-menu');
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

    const { keyword = '', kind = '', junle = '', cook = '' } = req.query;
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
      if (keyword) {
        const rx = new RegExp(keyword, 'i');
        const fields = [x.name, x.yomi, x.kind, x.junle, x.cook, x.menu].filter(Boolean).join(' ');
        return rx.test(fields);
      }
      return true;
    });

    const { kinds, junles, cooks } = await getFacetLists();
    res.render('users/myMenuGroupMembers', {
      currentGroup,
      kinds, junles, cooks,
      selected: { keyword, kind, junle, cook },
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
    return res.json({ url: result.secure_url });
  } catch (e) {
    console.error('upload error', e);
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
    const menuDoc = await Menu.findById(menuId).lean();
    if (!menuDoc) {
      req.flash('error', 'メニューが見つかりません');
      return res.redirect('/users/my-menu/shared-register?fav=mine');
    }
    const { kinds, junles, cooks } = await getFacetLists();
    const menuNames = await Menu.find().distinct('menu');
    const ingredients = await Ingredient.find().select('ingredient classification unit').lean();
    const seasonings = await Seasoning.find().select('seasoning classification unit').lean();
    const allUnits = Array.from(new Set([
      ...((ingredients||[]).flatMap(i=>Array.isArray(i.unit)?i.unit:i.unit? [i.unit]:[])),
      ...((seasonings||[]).flatMap(s=>Array.isArray(s.unit)?s.unit:s.unit? [s.unit]:[]))
    ].filter(Boolean)));
    return res.render('users/myMenuEdit', { menuDoc, kinds, junles, cooks, menuNames, ingredients, seasonings, allUnits });
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
      yomi,
      ingredient_ids = [],
      ingredient_amounts = [],
      ingredient_units = [],
      seasoning_ids = [],
      seasoning_amounts = [],
      seasoning_units = []
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

    await Menu.findByIdAndUpdate(menuId, {
      name, kind, junle, cook, menu, url, imageUrl, time, people: Number(people) || 1, comment, ingredients, seasoning: seasonings
    });
    req.flash('success', 'レシピを更新しました');
    return res.redirect('/users/my-menu/shared-register?fav=mine');
  } catch (err) { next(err); }
});

// MyMenu 登録/更新（weekMenu からの♡用）
router.post('/api/upsert', express.json(), async (req, res) => {
  try {
    const { menuId, favorite = true, frequency = 3, skill = false } = req.body || {};
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
      skill: !!skill,
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
