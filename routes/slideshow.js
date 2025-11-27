import express from 'express';
import { isLoggedIn } from '../middleware.js';
import Menu from '../models/menu.js';
import Mymenu from '../models/mymenu.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import User from '../models/users.js';

const router = express.Router();

const shuffle = (arr = []) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const takeRandom = (arr = [], max = 80) => shuffle(arr).slice(0, Math.max(1, Math.min(max, arr.length)));

const currentMonthLabel = () => {
  const month = (new Date()).getMonth() + 1;
  return `${month}月`;
};

const nutrientChips = (doc) => {
  const chips = [];
  if (doc.energy !== undefined && doc.energy !== null && doc.energy !== '') chips.push(`エネルギー ${doc.energy}${typeof doc.energy === 'number' ? 'kcal' : ''}`);
  if (doc.protein !== undefined && doc.protein !== null && doc.protein !== '') chips.push(`たんぱく質 ${doc.protein}${typeof doc.protein === 'number' ? 'g' : ''}`);
  if (doc.lipid !== undefined && doc.lipid !== null && doc.lipid !== '') chips.push(`脂質 ${doc.lipid}${typeof doc.lipid === 'number' ? 'g' : ''}`);
  if (doc.carbohydrate !== undefined && doc.carbohydrate !== null && doc.carbohydrate !== '') chips.push(`炭水化物 ${doc.carbohydrate}${typeof doc.carbohydrate === 'number' ? 'g' : ''}`);
  if (doc.water !== undefined && doc.water !== null && doc.water !== '') chips.push(`水分 ${doc.water}${typeof doc.water === 'number' ? 'g' : ''}`);
  return chips;
};

async function buildSlides(type, userId) {
  const typeKey = String(type || 'favorites');
  const monthLabel = currentMonthLabel();

  if (typeKey === 'favorites') {
    const favs = await Mymenu.find({ user: userId, favorite: true })
      .populate({
        path: 'menu',
        populate: [
          { path: 'ingredients.name', select: 'ingredient classification imageUrl month energy water protein lipid carbohydrate' }
        ],
        select: 'name imageUrl menu time people kind junle cook ingredients'
      })
      .lean();
    const slides = (favs || []).map((f) => {
      const m = f.menu || {};
      if (!m.imageUrl) return null;
      const ingNames = (m.ingredients || [])
        .map((i) => i?.name?.ingredient)
        .filter(Boolean);
      return {
        imageUrl: m.imageUrl || '',
        title: m.name || 'お気に入りレシピ',
        subtitle: m.menu || '',
        tags: [m.junle, m.kind, m.cook].filter(Boolean),
        detail: m.time ? `${m.time}分 / ${m.people || 1}人分` : `${m.people || 1}人分`,
        chips: ingNames,
        source: 'お気に入り'
      };
    }).filter(Boolean);
    return takeRandom(slides, 80);
  }

  if (typeKey === 'seasonal-menus') {
    const seasonalIngredients = await Ingredient.find({
      month: { $exists: true, $ne: [] }
    }).select('_id month').lean();
    const seasonalIds = new Set(
      seasonalIngredients
        .filter((ing) => {
          const months = Array.isArray(ing.month) ? ing.month : [];
          return months.includes(monthLabel);
        })
        .map((ing) => ing._id.toString())
    );
    if (!seasonalIds.size) return [];
    const menus = await Menu.find({ 'ingredients.name': { $in: Array.from(seasonalIds) } })
      .select('name imageUrl menu time people kind junle cook ingredients')
      .populate({ path: 'ingredients.name', select: 'ingredient classification imageUrl month energy water protein lipid carbohydrate' })
      .lean();
    const slides = (menus || []).map((m) => {
      if (!m.imageUrl) return null;
      const ingNames = (m.ingredients || [])
        .filter((ing) => ing?.name && seasonalIds.has(String(ing.name._id || ing.name)))
        .map((ing) => ing.name.ingredient)
        .filter(Boolean);
      return {
        imageUrl: m.imageUrl || '',
        title: m.name || '旬なメニュー',
        subtitle: m.menu || '',
        tags: [m.junle, m.kind, m.cook].filter(Boolean),
        detail: m.time ? `${m.time}分 / ${m.people || 1}人分` : `${m.people || 1}人分`,
        chips: ingNames,
        source: `旬の食材 (${monthLabel})`
      };
    }).filter(Boolean);
    return takeRandom(slides, 80);
  }

  if (typeKey === 'seasonal-ingredients') {
    const ingredients = await Ingredient.find({ month: monthLabel, imageUrl: { $ne: '' } })
      .select('ingredient classification imageUrl energy water protein lipid carbohydrate')
      .lean();
    const slides = (ingredients || []).map((ing) => ({
      imageUrl: ing.imageUrl || '',
      title: ing.ingredient || '旬の食材',
      subtitle: monthLabel,
      tags: [ing.classification || '食材'].filter(Boolean),
      detail: '100gあたり',
      chips: nutrientChips(ing),
      source: '旬の食材'
    }));
    return takeRandom(slides, 80);
  }

  if (typeKey === 'ingredients') {
    const ingredients = await Ingredient.find({ imageUrl: { $ne: '' } })
      .select('ingredient classification imageUrl energy water protein lipid carbohydrate')
      .lean();
    const slides = (ingredients || []).map((ing) => ({
      imageUrl: ing.imageUrl || '',
      title: ing.ingredient || '食材',
      subtitle: '100gあたり',
      tags: [ing.classification || '食材'].filter(Boolean),
      detail: '栄養情報',
      chips: nutrientChips(ing),
      source: '食材図鑑'
    }));
    return takeRandom(slides, 100);
  }

  if (typeKey === 'seasonings') {
    const seasonings = await Seasoning.find({ imageUrl: { $ne: '' } })
      .select('seasoning classification imageUrl')
      .lean();
    const slides = (seasonings || []).map((s) => ({
      imageUrl: s.imageUrl || '',
      title: s.seasoning || '調味料',
      subtitle: '',
      tags: [s.classification || '調味料'].filter(Boolean),
      detail: '',
      chips: [],
      source: '調味料図鑑'
    }));
    return takeRandom(slides, 100);
  }

  return [];
}

router.get('/', isLoggedIn, (req, res) => {
  const defaults = req.user?.slideshowSettings || {};
  const presetBgm = [
    'https://upload.wikimedia.org/wikipedia/commons/4/45/Beethoven_Moonlight_1st_movement.ogg',
    'https://archive.org/download/testmp3testfile/mpthreetest.mp3'
  ];
  const bgmList = Array.isArray(defaults.bgmList) && defaults.bgmList.length
    ? defaults.bgmList
    : presetBgm;
  res.render('users/slideshow', {
    monthLabel: currentMonthLabel(),
    defaults: {
      type: defaults.type || 'favorites',
      effect: defaults.effect || 'fade',
      interval: defaults.interval || 5,
      bgmList,
      volume: typeof defaults.volume === 'number' ? defaults.volume : 0.4,
      mute: !!defaults.mute
    }
  });
});

router.get('/data', isLoggedIn, async (req, res) => {
  try {
    const type = req.query.type || 'favorites';
    const slides = await buildSlides(type, req.user._id);
    return res.json({ slides });
  } catch (err) {
    console.error('slideshow data error', err);
    return res.status(500).json({ error: 'failed to load slides' });
  }
});

router.post('/settings', isLoggedIn, async (req, res) => {
  try {
    const {
      type = 'favorites',
      effect = 'fade',
      interval = 5,
      bgmList = [],
      volume = 0.4,
      mute = false
    } = req.body || {};

    const effectAllow = ['fade','slide','zoom','blur','pan','flip','wipe','glow','random'];
    const typeAllow = ['favorites','seasonal-menus','seasonal-ingredients','ingredients','seasonings'];

    const clean = {
      type: typeAllow.includes(type) ? type : 'favorites',
      effect: effectAllow.includes(effect) ? effect : 'fade',
      interval: Math.max(2, Math.min(20, Number(interval) || 5)),
      bgmList: Array.isArray(bgmList)
        ? bgmList.map((s) => String(s || '').trim()).filter(Boolean)
        : String(bgmList || '')
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
      volume: Math.max(0, Math.min(1, Number(volume) || 0.4)),
      mute: !!mute
    };

    await User.findByIdAndUpdate(req.user._id, { slideshowSettings: clean });
    if (req.user) req.user.slideshowSettings = clean;
    return res.json({ success: true });
  } catch (err) {
    console.error('slideshow settings save error', err);
    return res.status(500).json({ error: 'failed to save settings' });
  }
});

export default router;
