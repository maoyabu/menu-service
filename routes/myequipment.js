import express from 'express';
import { isLoggedIn } from '../middleware.js';
import Group from '../models/groups.js';
import StoragePlace from '../models/storagePlace.js';
import Equipment from '../models/equipment.js';
import CustomEquipmentPreset from '../models/customEquipmentPreset.js';
import MyEquipment from '../models/myEquipment.js';

const router = express.Router();
router.use(isLoggedIn);

function getGroupId(res){
  const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
  const def = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
  return def || (groups[0]?._id?.toString?.() ?? null);
}

const getCycleStart = (cadence = 'monthly') => {
  const now = new Date();
  if (cadence === 'quarter') {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return new Date(now.getFullYear(), quarterStartMonth, 1);
  }
  if (cadence === 'half') {
    const halfStartMonth = now.getMonth() < 6 ? 0 : 6;
    return new Date(now.getFullYear(), halfStartMonth, 1);
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

// My Equipment main page
router.get('/', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    const allowedTypes = ['house', 'disaster', 'camping', 'wishlist'];
    const type = allowedTypes.includes(String(req.query?.type)) ? String(req.query.type) : 'all';
    if (!groupId) return res.render('users/myEquipment', { places: [], placeMap: {}, type, categories: { house: [], disaster: [], camping: [], maintenance: [], units: [] } });

    const [items, places] = await Promise.all([
      MyEquipment.find({ group: groupId }).lean(),
      StoragePlace.find({ group: groupId }).lean()
    ]);
    const placeNameById = new Map((places||[]).map(p=> [String(p._id), p.name]));

    const filtered = items.filter(it => {
      if (type === 'wishlist') {
        const qty = Number(it.quantity) || 0;
        return !it.place || qty <= 0;
      }
      if (type === 'house') return !!(it.houseCategory && it.houseCategory.trim());
      if (type === 'disaster') return !!(it.disasterCategory && it.disasterCategory.trim());
      if (type === 'camping') return !!(it.campingCategory && it.campingCategory.trim());
      return true;
    });

    // group by place name
    const placeMap = {};
    filtered.forEach(it => {
      const qty = Number(it.quantity) || 0;
      const pname = (!it.place && qty <= 0)
        ? 'ウィッシュリスト'
        : (placeNameById.get(String(it.place||'')) || '未設定');
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

// Inventory checklist (equipment)
router.get('/inventory', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.redirect('/users/my-equipment');
    const group = await Group.findById(groupId).select('equipmentInventory group_name').lean();
    const cadence = group?.equipmentInventory?.cadence || 'monthly';
    const enabled = group?.equipmentInventory?.enabled !== false;
    if (!enabled) {
      req.flash('error', 'グループの備品棚卸しが無効になっています。設定から有効にしてください。');
      return res.redirect('/settings');
    }
    const cycleStart = getCycleStart(cadence);
    const [items, places] = await Promise.all([
      MyEquipment.find({ group: groupId })
        .populate('place', 'name')
        .populate('lastInventoryBy', 'displayname username')
        .lean(),
      StoragePlace.find({ group: groupId }).lean()
    ]);
    const placeNameById = new Map((places || []).map((p) => [String(p._id), p.name]));
    const entries = items.map((it) => {
      const placeName = (!it.place && (Number(it.quantity) || 0) <= 0)
        ? 'ウィッシュリスト'
        : (placeNameById.get(String(it.place || '')) || '未設定');
      const byName = it.lastInventoryBy
        ? (it.lastInventoryBy.displayname || it.lastInventoryBy.username || '')
        : '';
      return {
        id: String(it._id),
        name: it.name || '',
        quantity: Number(it.quantity) || 0,
        unit: it.unit || '',
        placeName,
        lastInventoryAt: it.lastInventoryAt || null,
        lastInventoryBy: byName || '',
        lastCount: Number(it.lastCount) || 0,
        lastComment: it.lastComment || '',
        imageUrl: it.productImageUrl || ''
      };
    });
    const monthLabel = (() => {
      const y = cycleStart.getFullYear();
      const m = cycleStart.getMonth() + 1;
      return `${y}年${m}月`;
    })();
    res.render('users/myEquipmentInventory', {
      groupName: group?.group_name || '',
      cadence,
      cycleStartISO: cycleStart.toISOString(),
      items: entries,
      monthLabel
    });
  } catch (e) { next(e); }
});

// Inventory toggle API
router.post('/api/inventory/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const checked = !!req.body?.checked;
    const countVal = Number(req.body?.count);
    const noteVal = typeof req.body?.note === 'string' ? req.body.note : '';
    const update = checked
      ? {
          lastInventoryAt: new Date(),
          lastInventoryBy: req.user._id,
          lastCount: Number.isFinite(countVal) ? countVal : 0,
          lastComment: noteVal || ''
        }
      : { lastInventoryAt: null, lastInventoryBy: null, lastCount: 0, lastComment: '' };
    const updated = await MyEquipment.findOneAndUpdate(
      { _id: req.params.id, group: groupId },
      { $set: update },
      { new: true }
    ).populate('lastInventoryBy', 'displayname username').lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    const byName = updated.lastInventoryBy
      ? (updated.lastInventoryBy.displayname || updated.lastInventoryBy.username || '')
      : '';
    res.json({
      id: updated._id.toString(),
      lastInventoryAt: updated.lastInventoryAt,
      lastInventoryBy: byName,
      lastCount: updated.lastCount || 0,
      lastComment: updated.lastComment || ''
    });
  } catch (_) { res.status(500).json({ error: 'failed' }); }
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
    const groupId = getGroupId(res);
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

    let customList = [];
    if (groupId) {
      const customFilter = and.length ? { $and: [...and, { group: groupId }] } : { group: groupId };
      customList = await CustomEquipmentPreset.find(customFilter).sort({ name: 1 }).lean();
    }

    res.json([...(customList || []), ...list]);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.post('/api/custom-presets', express.json(), async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const doc = await CustomEquipmentPreset.create({
      group: groupId,
      createdBy: req.user._id,
      name,
      unit: String(body.unit || '').trim(),
      isConsumable: !!body.isConsumable,
      houseCategory: String(body.houseCategory || '').trim(),
      disasterCategory: String(body.disasterCategory || '').trim(),
      campingCategory: String(body.campingCategory || '').trim(),
      maintenance: String(body.maintenance || '').trim()
    });
    res.json(doc.toObject());
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
      tracked: !!b.tracked,
      lastCount: Number(b.lastCount) || 0,
      lastComment: String(b.lastComment || '').trim(),
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
    ['name','unit','houseCategory','disasterCategory','campingCategory','maintenance','productUrl','productImageUrl','comment','lastComment'].forEach(k=>{
      if (k in b) update[k] = String(b[k] || '').trim();
    });
    if ('isConsumable' in b) update.isConsumable = !!b.isConsumable;
    if ('quantity' in b) update.quantity = Number(b.quantity) || 0;
    if ('tracked' in b) update.tracked = !!b.tracked;
    if ('lastCount' in b) update.lastCount = Number(b.lastCount) || 0;
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
