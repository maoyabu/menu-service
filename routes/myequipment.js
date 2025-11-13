import express from 'express';
import { isLoggedIn } from '../middleware.js';
import Group from '../models/groups.js';
import StoragePlace from '../models/storagePlace.js';
import Equipment from '../models/equipment.js';
import MyEquipment from '../models/myEquipment.js';

const router = express.Router();
router.use(isLoggedIn);

function getGroupId(res){
  const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
  const def = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
  return def || (groups[0]?._id?.toString?.() ?? null);
}

// My Equipment main page
router.get('/', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    const type = ['house','disaster','camping'].includes(String(req.query?.type)) ? String(req.query.type) : 'all';
    if (!groupId) return res.render('users/myEquipment', { places: [], placeMap: {}, type, categories: { house: [], disaster: [], camping: [], maintenance: [], units: [] } });

    const [items, places] = await Promise.all([
      MyEquipment.find({ group: groupId }).lean(),
      StoragePlace.find({ group: groupId }).lean()
    ]);
    const placeNameById = new Map((places||[]).map(p=> [String(p._id), p.name]));

    const filtered = items.filter(it => {
      if (type === 'house') return !!(it.houseCategory && it.houseCategory.trim());
      if (type === 'disaster') return !!(it.disasterCategory && it.disasterCategory.trim());
      if (type === 'camping') return !!(it.campingCategory && it.campingCategory.trim());
      return true;
    });

    // group by place name
    const placeMap = {};
    filtered.forEach(it => {
      const pname = placeNameById.get(String(it.place||'')) || '未設定';
      if (!placeMap[pname]) placeMap[pname] = [];
      placeMap[pname].push(it);
    });

    // collect distinct options (units, categories, maintenance) from both Equipment and MyEquipment
    const [unitsE, unitsM, houseE, houseM, disE, disM, campE, campM, maintE, maintM] = await Promise.all([
      Equipment.distinct('unit'), MyEquipment.distinct('unit'),
      Equipment.distinct('houseCategory'), MyEquipment.distinct('houseCategory'),
      Equipment.distinct('disasterCategory'), MyEquipment.distinct('disasterCategory'),
      Equipment.distinct('campingCategory'), MyEquipment.distinct('campingCategory'),
      Equipment.distinct('maintenance'), MyEquipment.distinct('maintenance')
    ]);
    const uniq = (arr) => Array.from(new Set((arr||[]).filter(Boolean)));
    const categories = {
      units: uniq([...(unitsE||[]), ...(unitsM||[])]),
      house: uniq([...(houseE||[]), ...(houseM||[])]),
      disaster: uniq([...(disE||[]), ...(disM||[])]),
      camping: uniq([...(campE||[]), ...(campM||[])]),
      maintenance: uniq([...(maintE||[]), ...(maintM||[])])
    };

    res.render('users/myEquipment', { places, placeMap, type, categories });
  } catch (e) { next(e); }
});

// Places API
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

// Presets search
router.get('/api/presets', async (req, res) => {
  try {
    const { keyword, houseCategory, disasterCategory, campingCategory } = req.query;
    const and = [];
    if (keyword) {
      const re = new RegExp(String(keyword), 'i');
      and.push({ $or: [ { name: re }, { unit: re }, { houseCategory: re }, { disasterCategory: re }, { campingCategory: re }, { maintenance: re } ] });
    }
    if (houseCategory) and.push({ houseCategory });
    if (disasterCategory) and.push({ disasterCategory });
    if (campingCategory) and.push({ campingCategory });
    const filter = and.length? { $and: and } : {};
    const list = await Equipment.find(filter).sort({ name: 1 }).limit(300).lean();
    res.json(list);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Add my equipment (preset or original)
router.post('/api/add', express.json(), async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    const b = req.body || {};
    // resolve place by name (optional)
    let placeId = null;
    if (b.placeName && String(b.placeName).trim()) {
      const name = String(b.placeName).trim();
      let place = await StoragePlace.findOne({ group: groupId, name }).lean();
      if (!place) {
        place = await StoragePlace.create({ group: groupId, name, createdBy: req.user._id });
      }
      placeId = place._id || place; // create() returns doc
    } else if (b.placeId) {
      placeId = b.placeId;
    }

    const doc = {
      group: groupId,
      createdBy: req.user._id,
      equipment: b.equipmentId || null,
      name: String(b.name || '').trim(),
      quantity: Number(b.quantity) || 0,
      unit: String(b.unit || '').trim(),
      place: placeId || null,
      isConsumable: !!b.isConsumable,
      houseCategory: String(b.houseCategory || '').trim(),
      disasterCategory: String(b.disasterCategory || '').trim(),
      campingCategory: String(b.campingCategory || '').trim(),
      maintenance: String(b.maintenance || '').trim(),
      productUrl: String(b.productUrl || '').trim(),
      productImageUrl: String(b.productImageUrl || '').trim(),
      comment: String(b.comment || '').trim(),
      expiryDate: b.expiryDate ? new Date(b.expiryDate) : null
    };
    if (!doc.name) return res.status(400).json({ error: 'name required' });

    const created = await MyEquipment.create(doc);
    res.json(created);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Update my equipment
router.put('/api/:id', express.json(), async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    const b = req.body || {};
    const update = {};
    ['name','unit','houseCategory','disasterCategory','campingCategory','maintenance','productUrl','productImageUrl','comment'].forEach(k=>{
      if (k in b) update[k] = String(b[k] || '').trim();
    });
    if ('isConsumable' in b) update.isConsumable = !!b.isConsumable;
    if ('quantity' in b) update.quantity = Number(b.quantity) || 0;
    if ('expiryDate' in b) update.expiryDate = b.expiryDate ? new Date(b.expiryDate) : null;
    if (b.placeId || b.placeName) {
      let pid = null;
      if (b.placeId) pid = b.placeId;
      else if (b.placeName && String(b.placeName).trim()) {
        const name = String(b.placeName).trim();
        let place = await StoragePlace.findOne({ group: groupId, name }).lean();
        if (!place) place = await StoragePlace.create({ group: groupId, name, createdBy: req.user._id });
        pid = place._id || place;
      }
      update.place = pid;
    }
    const updated = await MyEquipment.findOneAndUpdate({ _id: req.params.id, group: groupId }, { $set: update }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.delete('/api/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res); if(!groupId) return res.status(400).json({ error: 'no group' });
    await MyEquipment.deleteOne({ _id: req.params.id, group: groupId });
    res.json({ ok: true });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

export default router;
