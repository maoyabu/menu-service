import express from 'express';
import { isLoggedIn } from '../middleware.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import StoragePlace from '../models/storagePlace.js';
import Stock from '../models/stock.js';

const router = express.Router();
router.use(isLoggedIn);

function getGroupId(res){
  const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
  const def = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
  return def || (groups[0]?._id?.toString?.() ?? null);
}

router.get('/', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.render('users/myStock', { grouped: { ingredient: {}, seasoning: {} }, places: [], placeGrouped: {}, onlyStockpile: false });
    const onlyStockpile = String(req.query.stockpile || '') === 'true';
    let [stocks, places] = await Promise.all([
      Stock.find({ group: groupId, user: req.user._id }).lean(),
      StoragePlace.find({ group: groupId }).lean()
    ]);
    if (onlyStockpile) stocks = stocks.filter(s=> !!s.stockpile);
    const ingIds = stocks.filter(s=> s.type==='ingredient').map(s=> s.item);
    const seaIds = stocks.filter(s=> s.type==='seasoning').map(s=> s.item);
    const [ings, seas] = await Promise.all([
      Ingredient.find({ _id: { $in: ingIds } }).select('ingredient classification unit').lean(),
      Seasoning.find({ _id: { $in: seaIds } }).select('seasoning classification unit').lean()
    ]);
    const ingMap = new Map(ings.map(x=> [String(x._id), x]));
    const seaMap = new Map(seas.map(x=> [String(x._id), x]));
    const grouped = { ingredient: {}, seasoning: {} };
    const placeGrouped = {};
    const placeNameById = new Map((places||[]).map(p=> [String(p._id), p.name]));
    stocks.forEach(s=>{
      if (s.type==='ingredient'){
        const it = ingMap.get(String(s.item)); if(!it) return;
        const cls = it.classification || '未分類';
        grouped.ingredient[cls] = grouped.ingredient[cls] || [];
        grouped.ingredient[cls].push({ stock:s, meta: it });
        const pname = placeNameById.get(String(s.place||'')) || '未設定';
        placeGrouped[pname] = placeGrouped[pname] || { ingredient: [], seasoning: [] };
        placeGrouped[pname].ingredient.push({ stock:s, meta: it });
      } else {
        const it = seaMap.get(String(s.item)); if(!it) return;
        const cls = it.classification || '未分類';
        grouped.seasoning[cls] = grouped.seasoning[cls] || [];
        grouped.seasoning[cls].push({ stock:s, meta: it });
        const pname = placeNameById.get(String(s.place||'')) || '未設定';
        placeGrouped[pname] = placeGrouped[pname] || { ingredient: [], seasoning: [] };
        placeGrouped[pname].seasoning.push({ stock:s, meta: it });
      }
    });
    res.render('users/myStock', { grouped, places, placeGrouped, onlyStockpile });
  } catch (e) { next(e); }
});

// Places
router.get('/api/places', async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.json([]);
    const list = await StoragePlace.find({ group: groupId }).lean();
    res.json(list);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.post('/api/places', express.json(), async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const dup = await StoragePlace.findOne({ group: groupId, name }).select('_id').lean();
    if (dup) return res.status(409).json({ error: 'duplicate' });
    const created = await StoragePlace.create({ name, group: groupId, createdBy: req.user._id });
    res.json(created);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Stocks
router.get('/api/stocks', async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.json([]);
    const list = await Stock.find({ group: groupId, user: req.user._id }).lean();
    res.json(list);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.post('/api/stocks', express.json(), async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    const { type, id, amount, unit, placeId, expiryDate, stockpile, comment } = req.body || {};
    const typeRef = type==='ingredient' ? 'Ingredient' : 'Seasoning';
    if (!type || !id) return res.status(400).json({ error: 'bad request' });
    const created = await Stock.create({ type, typeRef, item: id, amount: Number(amount)||0, unit: unit||'', place: placeId||null, expiryDate: expiryDate? new Date(expiryDate): null, stockpile: !!stockpile, comment: String(comment||'').trim(), user: req.user._id, group: groupId });
    res.json(created);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.delete('/api/stocks/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    await Stock.deleteOne({ _id: req.params.id, user: req.user._id, group: groupId });
    res.json({ ok: true });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Update a stock
router.put('/api/stocks/:id', express.json(), async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    const { amount, unit, placeId, expiryDate, stockpile, comment } = req.body || {};
    const update = {
      amount: typeof amount === 'number' ? amount : Number(amount)||0,
      unit: unit || '',
      place: placeId || null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      ...(typeof stockpile !== 'undefined' ? { stockpile: !!stockpile } : {})
    };
    if (typeof comment !== 'undefined') update.comment = String(comment||'').trim();
    const updated = await Stock.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, group: groupId },
      { $set: update },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

export default router;
