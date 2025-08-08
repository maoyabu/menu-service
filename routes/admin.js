import express from 'express';
import Menu from '../models/menu.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import { isAdmin } from '../middleware.js';
// import { writeFileSync } from 'fs';
// import { join } from 'path';
import ExcelJS from 'exceljs';


const router = express.Router();
// 管理画面は管理者のみアクセス可能
router.use(isAdmin);

// システム設定画面の表示
router.get('/admin-setting', (req, res) => {
  res.render('admin/admin-setting');
});

// 管理者ダッシュボード表示
router.get('/admin-top', async (req, res) => {
  try {
    const menuCount = await Menu.countDocuments();
    const ingredientCount = await Ingredient.countDocuments();
    const seasoningCount = await Seasoning.countDocuments();

    res.render('admin/admin-top', {
      menuCount,
      ingredientCount,
      seasoningCount
    });
  } catch (err) {
    console.error('ダッシュボード表示エラー:', err);
    res.status(500).send('ダッシュボードを表示できませんでした');
  }
});

// レシピ一覧画面（DBから取得）
router.get('/menu-list', async (req, res) => {
  try {
    const { kind, junle, cook, keyword } = req.query;

    const filter = {};

    if (kind) filter.kind = kind;
    if (junle) filter.junle = junle;
    if (cook) filter.cook = cook;
    if (keyword) {
      filter.$or = [
        { name: new RegExp(keyword, 'i') },
        { yomi: new RegExp(keyword, 'i') },
        { kind: new RegExp(keyword, 'i') },
        { cook: new RegExp(keyword, 'i') },
        { content: new RegExp(keyword, 'i') },
        { ingredient: new RegExp(keyword, 'i') },
      ];
    }

    const menus = await Menu.find(filter)
      .populate({ path: 'ingredients.name', model: 'Ingredient' })
      .populate({ path: 'seasoning.name', model: 'Seasoning' });

    // kind, junle, cook のユニークな一覧を取得
    const allMenus = await Menu.find(); // 全体から取得するため再取得
    const kindList = [...new Set(allMenus.map(menu => menu.kind).filter(Boolean))];
    const junleList = [...new Set(allMenus.map(menu => menu.junle).filter(Boolean))];
    const cookList = [...new Set(allMenus.map(menu => menu.cook).filter(Boolean))];
    const ingredientList = await Ingredient.find();
    const seasoningList = await Seasoning.find();

    res.render('admin/menu-list', {
      menus,
      kindList,
      junleList,
      cookList,
      selectedType: kind || '',
      selectedJunle: junle || '',
      selectedCook: cook || '',
      keyword: keyword || '',
      menusJSON: JSON.stringify(menus), // 🔸追加
      ingredientList,
      seasoningList
    });
  } catch (err) {
    console.error('メニュー取得エラー:', err);
    res.status(500).send('メニューを取得できませんでした');
  }
});

// レシピ一覧絞り込み処理（POST → GET へリダイレクト）
router.post('/menu-list', (req, res) => {
  const { kind, junle, cook, keyword } = req.body;

  const query = new URLSearchParams();
  if (kind) query.append('kind', kind);
  if (junle) query.append('junle', junle);
  if (cook) query.append('cook', cook);
  if (keyword) query.append('keyword', keyword);

  res.redirect(`/admin/menu-list?${query.toString()}`);
});

// レシピ新規作成画面の表示
router.get('/menu-new', async (req, res) => {
  try {
    const allMenus = await Menu.find(); // 既存データからセレクトボックスの候補を取得
    const kindList = [...new Set(allMenus.map(menu => menu.kind).filter(Boolean))];
    const junleList = [...new Set(allMenus.map(menu => menu.junle).filter(Boolean))];
    const cookList = [...new Set(allMenus.map(menu => menu.cook).filter(Boolean))];

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
      seasoningGenreList
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
      time,
      people,
      comment,
      yomi,
      material,
      ingredient_ids = [],
      ingredient_amounts = [],
      ingredient_units = [],
      seasoning_ids = [],
      seasoning_amounts = [],
      seasoning_units = []
    } = req.body;

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

    const newMenu = new Menu({
      name,
      kind,
      junle,
      cook,
      menu,
      url,
      time,
      people,
      comment,
      yomi,
      material: material === 'true',
      ingredients,
      seasoning: seasonings,
      share: false,
      entry_date: new Date()
    });

    await newMenu.save();
    res.redirect('/admin/menu-list');
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
      initialSeasonings
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
      time,
      people,
      comment,
      yomi,
      material,
      ingredient_ids = [],
      ingredient_amounts = [],
      ingredient_units = [],
      seasoning_ids = [],
      seasoning_amounts = [],
      seasoning_units = []
    } = req.body;

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

    await Menu.findByIdAndUpdate(req.params.id, {
      name,
      kind,
      junle,
      cook,
      menu,
      url,
      time,
      people,
      comment,
      yomi,
      material: material === 'true',
      ingredients,
      seasoning: seasonings
    });

    res.redirect('/admin/menu-list');
  } catch (err) {
    console.error('レシピ更新エラー:', err);
    res.status(500).send('レシピを更新できませんでした');
  }
});

// レシピ削除処理
router.post('/menu-delete/:id', async (req, res) => {
  try {
    await Menu.findByIdAndDelete(req.params.id);
    res.redirect('/admin/menu-list');
  } catch (err) {
    console.error('レシピ削除エラー:', err);
    res.status(500).send('レシピを削除できませんでした');
  }
});


// 食材一覧画面の表示（分類によるフィルター付き）
router.get('/ingredient-list', async (req, res) => {
  try {
    const { classification, keyword } = req.query;

    const filter = {};
    if (classification) filter.classification = classification;
    if (keyword) {
      const keywordRegex = new RegExp(keyword, 'i');
      filter.$or = [
        { ingredient: keywordRegex },
        { yomi: keywordRegex },
        { classification: keywordRegex },
        { unit: { $in: [keywordRegex] } }
      ];
    }

    const ingredients = await Ingredient.find(filter);

    // 分類一覧のユニーク値を取得
    const allIngredients = await Ingredient.find();
    const categoryList = [...new Set(allIngredients.map(item => item.classification).filter(Boolean))];

    res.render('admin/ingredient-list', {
      ingredients,
      categoryList,
      selectedCategory: classification || '',
      classification: classification || '',
      keyword: keyword || ''
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

  const query = new URLSearchParams();
  if (classification) query.append('classification', classification);
  if (keyword) query.append('keyword', keyword);

  res.redirect(`/admin/ingredient-list?${query.toString()}`);
});

// 食材新規作成画面の表示
router.get('/ingredient-new', async (req, res) => {
  try {
    const allIngredients = await Ingredient.find();
    const classificationList = [...new Set(allIngredients.map(item => item.classification).filter(Boolean))];

    res.render('admin/ingredient-new', {
      classificationList
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

    const allIngredients = await Ingredient.find();
    const classificationList = [...new Set(allIngredients.map(item => item.classification).filter(Boolean))];

    res.render('admin/ingredient-edit', {
      ingredient,
      classificationList
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
      season,
      month
    } = req.body;

    const newIngredient = new Ingredient({
      classification,
      ingredient,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: Array.isArray(unit) ? unit : [unit],
      season: Array.isArray(season) ? season : season ? [season] : [],
      month:  Array.isArray(month)  ? month  : month  ? [month]  : []
    });

    await newIngredient.save();
    res.redirect('/admin/ingredient-list');
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
      season,
      month
    } = req.body;

    await Ingredient.findByIdAndUpdate(req.params.id, {
      classification,
      ingredient,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: Array.isArray(unit) ? unit : [unit],
      season: Array.isArray(season) ? season : season ? [season] : [],
      month:  Array.isArray(month)  ? month  : month  ? [month]  : []
    });

    res.redirect('/admin/ingredient-list');
  } catch (err) {
    console.error('食材更新エラー:', err);
    res.status(500).send('食材を更新できませんでした');
  }
});


// 食材削除処理
router.post('/ingredient-delete/:id', async (req, res) => {
  try {
    await Ingredient.findByIdAndDelete(req.params.id);
    res.redirect('/admin/ingredient-list');
  } catch (err) {
    console.error('食材削除エラー:', err);
    res.status(500).send('食材を削除できませんでした');
  }
});

// 調味料一覧画面の表示（分類によるフィルター付き）
router.get('/seasoning-list', async (req, res) => {
  try {
    const { classification, keyword } = req.query;

    const filter = {};
    if (classification) filter.classification = classification;
    if (keyword) {
      filter.$or = [
        { seasoning: new RegExp(keyword, 'i') },
        { yomi: new RegExp(keyword, 'i') },
        { classification: new RegExp(keyword, 'i') },
        { unit: { $elemMatch: { $regex: new RegExp(keyword, 'i') } } }
      ];
    }

    const seasonings = await Seasoning.find(filter);
    const allSeasonings = await Seasoning.find();
    const categoryList = [...new Set(allSeasonings.map(item => item.classification).filter(Boolean))];

    res.render('admin/seasoning-list', {
      seasonings,
      categoryList,
      selectedCategory: classification || '',
      classification: classification || '',
      keyword: keyword || ''
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

  const query = new URLSearchParams();
  if (classification) query.append('classification', classification);
  if (keyword) query.append('keyword', keyword);

  res.redirect(`/admin/seasoning-list?${query.toString()}`);
});

// 調味料新規作成画面の表示
router.get('/seasoning-new', async (req, res) => {
  try {
    const allSeasonings = await Seasoning.find();
    const classificationList = [...new Set(allSeasonings.map(item => item.classification).filter(Boolean))];

    res.render('admin/seasoning-new', {
      classificationList
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

    res.render('admin/seasoning-edit', {
      seasoning,
      classificationList
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
      unit
    } = req.body;

    const newSeasoning = new Seasoning({
      classification,
      seasoning,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: Array.isArray(unit) ? unit : [unit]
    });

    await newSeasoning.save();
    res.redirect('/admin/seasoning-list');
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
      unit
    } = req.body;

    await Seasoning.findByIdAndUpdate(req.params.id, {
      classification,
      seasoning,
      yomi,
      energy,
      water,
      protein,
      lipid,
      carbohydrate,
      unit: Array.isArray(unit) ? unit : [unit]
    });

    res.redirect('/admin/seasoning-list');
  } catch (err) {
    console.error('調味料更新エラー:', err);
    res.status(500).send('調味料を更新できませんでした');
  }
});

// 調味料削除処理
router.post('/seasoning-delete/:id', async (req, res) => {
  try {
    await Seasoning.findByIdAndDelete(req.params.id);
    res.redirect('/admin/seasoning-list');
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
      { header: '時間', key: 'time' },
      { header: '人数', key: 'people' },
      { header: '素材フラグ', key: 'material' },
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
        time: menu.time,
        people: menu.people,
        material: menu.material,
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
      { header: '単位', key: 'unit' }
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
        unit: item.unit?.join(', ')
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
      { header: '単位', key: 'unit' }
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
        unit: item.unit?.join(', ')
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



export default router;
