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

const IMAGE_META_PATTERNS = [
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']og:image:url["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  /<img[^>]+id=["']landingImage["'][^>]+(?:src|data-old-hires)=["']([^"']+)["']/i,
  /<img[^>]+data-old-hires=["']([^"']+)["']/i,
  /<img[^>]+class=["'][^"']*?product-image[^"']*["'][^>]+src=["']([^"']+)["']/i,
  /data-a-dynamic-image=["'][^"']*?(https?:\/\/[^"']+?\.jpg)[^"']*["']/i,
  /<ul[^>]+regularAltImageViewLayout[^>]*>[\s\S]*?<img[^>]+src=["']([^"']+?\.jpg)["']/i
];

const JSON_IMAGE_PATTERNS = [
  /"hiRes"\s*:\s*"([^"]+)"/i,
  /"large"\s*:\s*"([^"]+)"/i,
  /"mainUrl"\s*:\s*"([^"]+)"/i,
  /"displayImageUri"\s*:\s*"([^"]+)"/i,
  /"originalImageUri"\s*:\s*"([^"]+)"/i
];

const normalizeAmazonImage = (url) => {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (/amazon\./i.test(u.hostname)) {
      return url.replace(/_AC_[A-Z]{2}\d+(?:,\d+)?_/gi, '_AC_SL1000_');
    }
    return url;
  } catch {
    return url;
  }
};

const resolveImageUrlFromValue = (value, base) => {
  if (!value) return null;
  try {
    const resolved = new URL(value, base).toString();
    return normalizeAmazonImage(resolved);
  } catch {
    return null;
  }
};

const sanitizeImageValue = (value) => String(value || '')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/\\u0026/gi, '&')
  .replace(/\\u002f/gi, '/')
  .trim();

const extractImageUrl = (html, base) => {
  if (!html) return null;
  for (const re of IMAGE_META_PATTERNS) {
    const match = re.exec(html);
    if (match && match[1]) {
      const cleaned = sanitizeImageValue(match[1]);
      const resolved = resolveImageUrlFromValue(cleaned, base);
      if (resolved) return resolved;
    }
  }
  for (const re of JSON_IMAGE_PATTERNS) {
    const match = re.exec(html);
    if (match && match[1]) {
      const cleaned = sanitizeImageValue(match[1]);
      const resolved = resolveImageUrlFromValue(cleaned, base);
      if (resolved) return resolved;
    }
  }
  return null;
};

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
    const { type, id, amount, unit, placeId, expiryDate, stockpile, comment, productUrl, productImageUrl } = req.body || {};
    const typeRef = type==='ingredient' ? 'Ingredient' : 'Seasoning';
    if (!type || !id) return res.status(400).json({ error: 'bad request' });
    const created = await Stock.create({
      type,
      typeRef,
      item: id,
      amount: Number(amount)||0,
      unit: unit||'',
      place: placeId||null,
      expiryDate: expiryDate? new Date(expiryDate): null,
      stockpile: !!stockpile,
      comment: String(comment||'').trim(),
      productUrl: String(productUrl||'').trim(),
      productImageUrl: String(productImageUrl||'').trim(),
      user: req.user._id,
      group: groupId
    });
    res.json(created);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.get('/api/product-image', async (req, res) => {
  try {
    const rawUrl = String(req.query?.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'url required' });
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: 'invalid url' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(target.href, {
        headers: { 'User-Agent': 'Mozilla/5.0 (MenuService)', 'Accept-Language': 'ja,en-US;q=0.9' },
        signal: controller.signal
      });
      if (!response.ok) return res.status(502).json({ error: 'fetch failed' });
      const html = await response.text();
      const imageUrl = extractImageUrl(html, target.href);
      return res.json({ imageUrl: imageUrl || '' });
    } catch (err) {
      if (err?.name === 'AbortError') return res.status(504).json({ error: 'timeout' });
      return res.status(500).json({ error: 'failed' });
    } finally {
      clearTimeout(timeout);
    }
  } catch (_) {
    return res.status(500).json({ error: 'failed' });
  }
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
    const { amount, unit, placeId, expiryDate, stockpile, comment, productUrl, productImageUrl } = req.body || {};
    const update = {
      amount: typeof amount === 'number' ? amount : Number(amount)||0,
      unit: unit || '',
      place: placeId || null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      ...(typeof stockpile !== 'undefined' ? { stockpile: !!stockpile } : {})
    };
    if (typeof comment !== 'undefined') update.comment = String(comment||'').trim();
    if (typeof productUrl !== 'undefined') update.productUrl = String(productUrl||'').trim();
    if (typeof productImageUrl !== 'undefined') update.productImageUrl = String(productImageUrl||'').trim();
    const updated = await Stock.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, group: groupId },
      { $set: update },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Checklist: mark checked with optional note
router.post('/api/check/:id', express.json(), async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    const note = String(req.body?.note || '').trim();
    const amountRaw = req.body?.amount;
    const update = { lastCheckedAt: new Date(), lastCheckedNote: note, lastCheckedBy: (req.user?.displayname || req.user?.username || req.user?.email || '').toString() };
    if (typeof amountRaw !== 'undefined' && amountRaw !== null && amountRaw !== '') {
      const n = Math.max(0, Number(amountRaw) || 0);
      update.amount = n;
    }
    const updated = await Stock.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id, group: groupId },
      { $set: update },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, item: updated });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Checklist page
router.get('/checklist', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.render('users/myStockChecklist', { places: [], items: [] });
    const [stocks, places] = await Promise.all([
      Stock.find({ group: groupId, user: req.user._id }).lean(),
      StoragePlace.find({ group: groupId }).lean()
    ]);
    const placeNameById = new Map((places||[]).map(p=> [String(p._id), p.name]));
    // Resolve names for ingredients/seasonings
    const ingIds = stocks.filter(s=> s.type==='ingredient').map(s=> s.item);
    const seaIds = stocks.filter(s=> s.type==='seasoning').map(s=> s.item);
    const [ings, seas] = await Promise.all([
      Ingredient.find({ _id: { $in: ingIds } }).select('ingredient').lean(),
      Seasoning.find({ _id: { $in: seaIds } }).select('seasoning').lean()
    ]);
    const ingName = new Map((ings||[]).map(x=>[String(x._id), x.ingredient]));
    const seaName = new Map((seas||[]).map(x=>[String(x._id), x.seasoning]));
    const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const items = (stocks||[]).map(s=>({
      id: String(s._id),
      type: s.type,
      name: s.type==='ingredient' ? (ingName.get(String(s.item)) || '') : (seaName.get(String(s.item)) || ''),
      placeId: String(s.place||''),
      place: placeNameById.get(String(s.place||'')) || '未設定',
      amount: s.amount || 0,
      unit: s.unit || '',
      imageUrl: s.productImageUrl || '',
      lastCheckedAt: s.lastCheckedAt ? new Date(s.lastCheckedAt) : null,
      lastCheckedNote: s.lastCheckedNote || '',
      lastCheckedBy: s.lastCheckedBy || ''
    }));
    res.render('users/myStockChecklist', { places, items, monthLabel: `${now.getFullYear()}年${now.getMonth()+1}月`, monthStartISO: start.toISOString() });
  } catch(e) { next(e); }
});

export default router;
