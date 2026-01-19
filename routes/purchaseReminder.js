import express from 'express';
import mongoose from 'mongoose';
import { isLoggedIn } from '../middleware.js';
import Group from '../models/groups.js';
import Stock from '../models/stock.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import MyEquipment from '../models/myEquipment.js';
import PurchaseReminderHistory from '../models/purchaseReminderHistory.js';

const router = express.Router();
router.use(isLoggedIn);

function getGroupId(res){
  const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
  const def = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
  return def || (groups[0]?._id?.toString?.() ?? null);
}

const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${m}/${day}`;
};

async function fetchPending(groupId){
  const today = new Date(); today.setHours(0,0,0,0);
  const limit = new Date(today); limit.setDate(limit.getDate() + 31);
  const [stocksRaw, equipments] = await Promise.all([
    Stock.find({
      group: groupId,
      expiryDate: { $gte: today, $lte: limit }
    }).lean(),
    MyEquipment.find({
      group: groupId,
      expiryDate: { $gte: today, $lte: limit }
    }).lean()
  ]);

  // Fetch meta names for stock
  const ingredientIds = [];
  const seasoningIds = [];
  (stocksRaw || []).forEach((s)=>{
    if (s.type === 'ingredient') ingredientIds.push(s.item);
    if (s.type === 'seasoning') seasoningIds.push(s.item);
  });
  const [ingredients, seasonings] = await Promise.all([
    ingredientIds.length ? Ingredient.find({ _id: { $in: ingredientIds } }).select('ingredient').lean() : [],
    seasoningIds.length ? Seasoning.find({ _id: { $in: seasoningIds } }).select('seasoning').lean() : []
  ]);
  const ingMap = new Map((ingredients||[]).map((i)=> [String(i._id), i.ingredient || '']));
  const seaMap = new Map((seasonings||[]).map((i)=> [String(i._id), i.seasoning || '']));

  const stocks = (stocksRaw || []).map((s)=> {
    const name = s.type === 'ingredient'
      ? (ingMap.get(String(s.item)) || '')
      : (seaMap.get(String(s.item)) || '');
    return {
      id: String(s._id),
      itemId: String(s.item),
      name: name || '不明',
      expiryDate: s.expiryDate,
      expiryLabel: formatDate(s.expiryDate),
      type: 'stock',
      stockType: s.type
    };
  });

  const equipmentsList = (equipments || []).map((e)=> ({
    id: String(e._id),
    name: e.name || '',
    expiryDate: e.expiryDate,
    expiryLabel: formatDate(e.expiryDate),
    type: 'equipment'
  }));

  return { stocks, equipments: equipmentsList };
}

async function fetchHistory(groupId){
  const rows = await PurchaseReminderHistory.find({ group: groupId })
    .sort({ purchasedAt: -1 })
    .limit(30)
    .lean();
  return rows.map((r)=> ({
    id: String(r._id),
    name: r.name || '',
    itemType: r.itemType,
    purchasedAt: r.purchasedAt,
    purchasedAtLabel: formatDate(r.purchasedAt),
    prevExpiryLabel: formatDate(r.prevExpiry),
    nextExpiryLabel: formatDate(r.nextExpiry)
  }));
}

router.get('/', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.redirect('/users/my-top');

    const [pending, history] = await Promise.all([
      fetchPending(groupId),
      fetchHistory(groupId)
    ]);

    res.render('users/purchaseReminder', {
      pendingStocks: pending.stocks,
      pendingEquipments: pending.equipments,
      history
    });
  } catch (e) { next(e); }
});

router.get('/api/list', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const [pending, history] = await Promise.all([
      fetchPending(groupId),
      fetchHistory(groupId)
    ]);
    res.json({
      stocks: pending.stocks,
      equipments: pending.equipments,
      history
    });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

router.post('/api/purchase', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const { type, id, nextExpiry } = req.body || {};
    if (!type || !id) return res.status(400).json({ error: 'bad request' });
    const nextDate = nextExpiry ? new Date(nextExpiry) : null;
    const userId = req.user?._id || null;

    if (type === 'stock') {
      const doc = await Stock.findOne({ _id: id, group: groupId });
      if (!doc) return res.status(404).json({ error: 'not found' });
      const prevExpiry = doc.expiryDate || null;
      doc.expiryDate = nextDate;
      await doc.save();

      let name = '';
      if (doc.type === 'ingredient') {
        const meta = await Ingredient.findById(doc.item).select('ingredient').lean();
        name = meta?.ingredient || '';
      } else if (doc.type === 'seasoning') {
        const meta = await Seasoning.findById(doc.item).select('seasoning').lean();
        name = meta?.seasoning || '';
      }

      await PurchaseReminderHistory.create({
        group: groupId,
        itemType: 'stock',
        itemId: doc._id,
        name,
        prevExpiry,
        nextExpiry: nextDate,
        purchasedAt: new Date(),
        purchasedBy: userId
      });
      return res.json({ ok: true });
    }

    if (type === 'equipment') {
      const doc = await MyEquipment.findOne({ _id: id, group: groupId });
      if (!doc) return res.status(404).json({ error: 'not found' });
      const prevExpiry = doc.expiryDate || null;
      doc.expiryDate = nextDate;
      await doc.save();

      await PurchaseReminderHistory.create({
        group: groupId,
        itemType: 'equipment',
        itemId: doc._id,
        name: doc.name || '',
        prevExpiry,
        nextExpiry: nextDate,
        purchasedAt: new Date(),
        purchasedBy: userId
      });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'bad request' });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

export default router;
