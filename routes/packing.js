import express from 'express';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { isLoggedIn } from '../middleware.js';
import Group from '../models/groups.js';
import PackingEvent from '../models/packingEvent.js';
import PackingItem from '../models/packingItem.js';
import PackingStorage from '../models/packingStorage.js';
import PackingMasterItem from '../models/packingMasterItem.js';
import Task from '../models/task.js';
import User from '../models/users.js';
import { renderTemplate, sendMail } from '../utils/mailer.js';

const router = express.Router();
router.use(isLoggedIn);
router.use(express.json());

function getGroupId(res){
  const groups = Array.isArray(res.locals.userGroups) ? res.locals.userGroups : [];
  const def = res.locals.userDefaultGroupId ? String(res.locals.userDefaultGroupId) : '';
  return def || (groups[0]?._id?.toString?.() ?? null);
}

const userLabel = (user) => (user?.displayname || user?.username || user?.email || '').toString();

const parseBool = (val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return ['1', 'true', 'on', 'yes'].includes(val.toLowerCase());
  if (typeof val === 'number') return val === 1;
  return false;
};

async function sendPackingMail(toIds, subject, { title, note, dueAt }){
  try{
    if (!Array.isArray(toIds) || !toIds.length) return;
    const users = await User.find({ _id: { $in: toIds } }).select('email isMail').lean();
    const emails = (users || []).filter((u)=> u.isMail !== false).map((u)=> u.email).filter(Boolean);
    if (!emails.length) return;
    const html = await renderTemplate('taskNotification', { title, content: note || '', dueAt });
    await sendMail({ to: emails, subject, html });
  }catch(_){ /* best effort */ }
}

async function syncPackingTasks(eventDoc, participantIds, groupId){
  if (!groupId || !eventDoc?._id) return;
  const startAt = eventDoc.startAt ? new Date(eventDoc.startAt) : null;
  const dueAt = startAt ? (()=> { const d = new Date(startAt); d.setDate(d.getDate() - 1); return d; })() : null;
  const list = Array.isArray(participantIds) ? participantIds.map(String) : [];
  const existing = await Task.find({ group: groupId, source: 'packing', sourceId: eventDoc._id }).lean();
  const existingMap = new Map((existing || []).map((t)=> [(t.assignees?.[0] || '').toString(), t]));
  const removeIds = existing.filter((t)=> !list.includes((t.assignees?.[0] || '').toString())).map((t)=> t._id);
  if (removeIds.length) await Task.deleteMany({ _id: { $in: removeIds }, group: groupId });
  await Promise.all(list.map(async (pid)=> {
    const target = existingMap.get(pid);
    if (target){
      await Task.updateOne({ _id: target._id }, {
        $set: {
          title: `${eventDoc.name || 'パッキング'}の準備`,
          category: 'パッキング',
          startAt,
          dueAt,
          status: eventDoc.completed ? 'completed' : (target.status === 'completed' ? 'completed' : 'not_started'),
          completedAt: eventDoc.completed ? (target.completedAt || new Date()) : null
        }
      });
    } else {
      await Task.create({
        group: groupId,
        title: `${eventDoc.name || 'パッキング'}の準備`,
        category: 'パッキング',
        createdBy: eventDoc.createdBy || null,
        assignees: [pid],
        startAt,
        dueAt,
        started: false,
        status: eventDoc.completed ? 'completed' : 'not_started',
        completedAt: eventDoc.completed ? new Date() : null,
        source: 'packing',
        sourceId: eventDoc._id,
        note: 'パッキングプランに基づくタスク'
      });
    }
  }));
}

async function getMemberOptions(groupId){
  if (!groupId) return { list: [], idSet: new Set(), labelMap: new Map() };
  const group = await Group.findById(groupId)
    .populate('createdBy members', 'displayname username email')
    .lean();
  if (!group) return { list: [], idSet: new Set(), labelMap: new Map() };
  const map = new Map();
  const pushUser = (u) => {
    if (!u) return;
    const id = u._id?.toString?.() || (typeof u === 'string' ? u : '');
    if (!id || map.has(id)) return;
    map.set(id, { id, name: userLabel(u) });
  };
  pushUser(group.createdBy);
  (group.members || []).forEach(pushUser);
  const list = Array.from(map.values());
  return { list, idSet: new Set(list.map((u)=>u.id)), labelMap: new Map(list.map((u)=>[u.id, u.name])) };
}

async function hydrateItemWeights(itemsRaw, masterMap, groupId){
  if (!Array.isArray(itemsRaw) || !itemsRaw.length) return [];
  const updates = [];
  const items = itemsRaw.map((it)=>{
    const weightNum = Number(it.weight || 0) || 0;
    const master = it.thingId ? masterMap.get(it.thingId.toString()) : null;
    let next = { ...it };
    if (weightNum <= 0){
      const fallback = Number(master?.defaultWeight || 0) || 0;
      if (fallback > 0){
        next.weight = fallback;
      }
    }
    if (master?.owner && String(master.owner) !== String(it.owner || '')){
      next.owner = String(master.owner);
    } else {
      next.owner = String(it.owner || 'all');
    }
    if ((!it.category || !it.category.trim()) && master?.category){
      next.category = master.category;
    }
    if (next.wish && (it.storageId || it.storageName)) {
      next.storageId = null;
      next.storageName = '';
    }
    if (next.weight !== it.weight || next.category !== it.category || String(next.owner || '') !== String(it.owner || '') || next.wish !== it.wish || next.storageId !== it.storageId || next.storageName !== it.storageName){
      updates.push({ id: it._id, weight: next.weight, category: next.category, owner: next.owner, wish: next.wish, storageId: next.storageId, storageName: next.storageName });
    }
    return next;
  });
  if (updates.length){
    try{
      await Promise.all(updates.map((u)=> {
        const set = { weight: u.weight, category: u.category, owner: u.owner, wish: u.wish };
        if (u.wish && (u.storageId || u.storageName)) {
          set.storageId = null;
          set.storageName = '';
        } else {
          set.storageId = u.storageId;
          set.storageName = u.storageName;
        }
        return PackingItem.updateOne({ _id: u.id, group: groupId }, { $set: set });
      }));
    } catch(_) { /* best effort */ }
  }
  return items;
}

router.get('/', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.render('users/packingChecklist', { members: [], events: [], storages: [], masterItems: [] });
    const [memberInfo, eventsRaw, storagesRaw, masterItemsRaw] = await Promise.all([
      getMemberOptions(groupId),
      PackingEvent.find({ group: groupId, completed: { $ne: true } }).lean(),
      PackingStorage.find({ group: groupId }).lean(),
      PackingMasterItem.find({ group: groupId }).sort({ createdAt: -1 }).lean()
    ]);
    const eventsSorted = (eventsRaw || []).slice().sort((a,b)=>{
      const ta = new Date(a.lastOpenedAt || a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.lastOpenedAt || b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
    const events = eventsSorted.map((ev)=>({
      id: String(ev._id),
      name: ev.name,
      startAt: ev.startAt || null,
      participants: (ev.participants || []).map(String),
      lastOpenedAt: ev.lastOpenedAt || null
    }));
    const storages = (storagesRaw || [])
      .slice()
      .sort((a,b)=> (a.name||'').localeCompare(b.name||'', 'ja'))
      .map((s)=> ({ id: String(s._id), name: s.name, maxWeight: s.maxWeight || 0, owner: s.owner || 'all' }));
    const masterItems = (masterItemsRaw || []).map((it)=> ({
      id: String(it._id),
      name: it.name,
      owner: it.owner || 'all',
      defaultQuantity: it.defaultQuantity || 1,
      defaultWeight: it.defaultWeight || 0,
      category: it.category || '',
      comment: it.comment || '',
      wish: !!it.wish
    }));
    const masterCategories = Array.from(new Set((masterItemsRaw || []).map((m)=> (m.category || '').trim()).filter(Boolean)));
    res.render('users/packingChecklist', {
      members: memberInfo.list,
      events,
      storages,
      masterItems,
      masterCategories,
      currentUserId: (req.user?._id?.toString?.() || '')
    });
  } catch (e) { next(e); }
});

router.get('/completed', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.render('users/packingCompleted', { events: [], members: [] });
    const [memberInfo, eventsRaw] = await Promise.all([
      getMemberOptions(groupId),
      PackingEvent.find({ group: groupId, completed: true }).lean()
    ]);
    const eventsSorted = (eventsRaw || []).slice().sort((a,b)=>{
      const ta = new Date(a.completedAt || a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.completedAt || b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
    const events = eventsSorted.map((ev)=>({
      id: String(ev._id),
      name: ev.name,
      participants: (ev.participants || []).map(String),
      completedAt: ev.completedAt || null
    }));
    res.render('users/packingCompleted', {
      events,
      members: memberInfo.list
    });
  } catch (e) { next(e); }
});

// Storages master
router.get('/api/storages', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.json([]);
    const list = await PackingStorage.find({ group: groupId }).sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.post('/api/storages', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const maxWeight = Math.max(0, Number(req.body?.maxWeight) || 0);
    const owner = String(req.body?.owner || 'all') || 'all';
    const created = await PackingStorage.create({ name, maxWeight, owner, group: groupId, createdBy: req.user._id });
    res.json({ id: created._id, name: created.name, maxWeight: created.maxWeight || 0, owner: created.owner || 'all' });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.patch('/api/storages/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const maxWeight = Math.max(0, Number(req.body?.maxWeight) || 0);
    const owner = String(req.body?.owner || 'all') || 'all';
    const updated = await PackingStorage.findOneAndUpdate({ _id: req.params.id, group: groupId }, { $set: { name, maxWeight, owner } }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    // update items storage name snapshots
    await PackingItem.updateMany({ group: groupId, storageId: updated._id }, { $set: { storageName: updated.name } });
    res.json({ id: String(updated._id), name: updated.name, maxWeight: updated.maxWeight || 0, owner: updated.owner || 'all' });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.delete('/api/storages/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const deleted = await PackingStorage.findOneAndDelete({ _id: req.params.id, group: groupId });
    if (!deleted) return res.status(404).json({ error: 'not found' });
    await PackingItem.updateMany({ group: groupId, storageId: deleted._id }, { $set: { storageId: null, storageName: '' } });
    res.json({ ok: true });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Master items
router.post('/api/master-items', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const defaultQuantity = Math.max(0, Number(req.body?.defaultQuantity ?? 1) || 1);
    const defaultWeight = Math.max(0, Number(req.body?.defaultWeight) || 0);
    const owner = String(req.body?.owner || 'all');
    const category = String(req.body?.category || '').trim();
    const comment = String(req.body?.comment || '').trim();
    const wish = parseBool(req.body?.wish);
    const created = await PackingMasterItem.create({ name, defaultQuantity, defaultWeight, owner, category, comment, wish, group: groupId, createdBy: req.user._id });
    res.json({
      id: created._id,
      name: created.name,
      owner: created.owner,
      defaultQuantity: created.defaultQuantity,
      defaultWeight: created.defaultWeight,
      category: created.category || '',
      comment: created.comment,
      wish: !!created.wish
    });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.patch('/api/master-items/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const update = {};
    if (typeof req.body?.name === 'string') update.name = String(req.body.name || '').trim();
    if (typeof req.body?.owner === 'string') update.owner = String(req.body.owner || 'all');
    if (typeof req.body?.comment === 'string') update.comment = String(req.body.comment || '').trim();
    if (typeof req.body?.category === 'string') update.category = String(req.body.category || '').trim();
    if (typeof req.body?.defaultQuantity !== 'undefined') update.defaultQuantity = Math.max(0, Number(req.body.defaultQuantity) || 0);
    if (typeof req.body?.defaultWeight !== 'undefined') update.defaultWeight = Math.max(0, Number(req.body.defaultWeight) || 0);
    if (typeof req.body?.wish !== 'undefined') update.wish = parseBool(req.body.wish);
    const updated = await PackingMasterItem.findOneAndUpdate({ _id: req.params.id, group: groupId }, { $set: update }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    if (typeof update.wish === 'boolean') {
      const set = { wish: update.wish };
      if (update.wish) {
        set.storageId = null;
        set.storageName = '';
      }
      await PackingItem.updateMany({ group: groupId, thingId: updated._id }, { $set: set });
    }
    res.json({
      id: String(updated._id),
      name: updated.name,
      owner: updated.owner,
      defaultQuantity: updated.defaultQuantity,
      defaultWeight: updated.defaultWeight,
      category: updated.category || '',
      comment: updated.comment,
      wish: !!updated.wish
    });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.delete('/api/master-items/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res); if (!groupId) return res.status(400).json({ error: 'no group' });
    const deleted = await PackingMasterItem.findOneAndDelete({ _id: req.params.id, group: groupId });
    if (!deleted) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

// Events
router.post('/api/events', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const name = String(req.body?.name || '').trim();
    const participantIds = Array.isArray(req.body?.participants) ? req.body.participants.map(String) : [];
    const startAt = req.body?.startAt ? new Date(req.body.startAt) : null;
    if (!name) return res.status(400).json({ error: 'name required' });
    const memberInfo = await getMemberOptions(groupId);
    const participantSet = new Set(participantIds.filter((id)=> memberInfo.idSet.has(id)));
    const created = await PackingEvent.create({
      name,
      storageContainers: [], // legacy field unused now
      participants: Array.from(participantSet),
      startAt,
      group: groupId,
      createdBy: req.user._id
    });
    await syncPackingTasks(created, Array.from(participantSet), groupId);
    const dueAt = startAt ? (()=> { const d = new Date(startAt); d.setDate(d.getDate() - 1); return d; })() : null;
    if (participantSet.size){
      await sendPackingMail(Array.from(participantSet), `パッキングプラン開始: ${created.name}`, { title: created.name, note: 'パッキングプランが作成されました', dueAt });
    }
    res.json({
      id: created._id,
      name: created.name,
      startAt: created.startAt,
      participants: created.participants.map(String),
      planStatus: Object.fromEntries(created.planStatus || [])
    });
  } catch (_) {
    res.status(500).json({ error: 'failed' });
  }
});

router.patch('/api/events/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const id = req.params.id;
    const event = await PackingEvent.findOne({ _id: id, group: groupId });
    if (!event) return res.status(404).json({ error: 'not found' });
    const prevCompleted = !!event.completed;

    const memberInfo = await getMemberOptions(groupId);
    if (Array.isArray(req.body?.participants)) {
      const participantIds = req.body.participants.map(String);
      const participants = participantIds.filter((pid)=> memberInfo.idSet.has(pid));
      event.participants = participants;
    }
    if (req.body?.startAt){
      const startAt = req.body.startAt ? new Date(req.body.startAt) : null;
      event.startAt = startAt;
    }
    if (req.body?.planStatus && typeof req.body.planStatus === 'object'){
      const currentUserId = req.user?._id?.toString?.() || '';
      const participantSet = new Set((event.participants || []).map((pid)=> (pid ? pid.toString() : '')).filter(Boolean));
      const existingEntries = event.planStatus instanceof Map ? Array.from(event.planStatus.entries()) : Object.entries(event.planStatus || {});
      const existing = new Map(existingEntries.map(([pid, val])=> [String(pid), !!val]));
      const nextStatus = new Map(
        Array.from(existing.entries()).filter(([pid])=> memberInfo.idSet.has(pid) && participantSet.has(pid))
      );
      if (currentUserId && participantSet.has(currentUserId) && Object.prototype.hasOwnProperty.call(req.body.planStatus, currentUserId)) {
        nextStatus.set(currentUserId, parseBool(req.body.planStatus[currentUserId]));
      }
      event.planStatus = nextStatus;
    }
    // storage selection
    const hasStorageIds = Array.isArray(req.body?.storageIds);
    const rawStorageIds = hasStorageIds ? req.body.storageIds : [];
    const prevStorageIds = (event.storageIds || []).map((x)=> x.toString());
    if (hasStorageIds) {
      let storageIds = [];
      if (rawStorageIds.length) {
        const valid = await PackingStorage.find({ _id: { $in: rawStorageIds }, group: groupId }).select('_id').lean();
        storageIds = valid.map((s)=> s._id.toString());
      }
      event.storageIds = storageIds;
    }

    if (typeof req.body?.name === 'string') {
      const nm = String(req.body.name || '').trim();
      if (nm) event.name = nm;
    }
    if (typeof req.body?.completed !== 'undefined') {
      const completed = parseBool(req.body.completed);
      event.completed = completed;
      event.completedAt = completed ? new Date() : null;
    }
    await event.save();
    await syncPackingTasks(event, event.participants, groupId);
    if (prevCompleted !== !!event.completed && event.participants?.length){
      const subject = event.completed ? `パッキングプラン完了: ${event.name}` : `パッキングプラン更新: ${event.name}`;
      const dueAt = event.startAt ? (()=> { const d = new Date(event.startAt); d.setDate(d.getDate() - 1); return d; })() : null;
      await sendPackingMail(event.participants, subject, { title: event.name, note: event.completed ? 'パッキングプランが完了しました' : 'パッキングプランが更新されました', dueAt });
    }

    // detach items from removed storages
    const removedStorageIds = hasStorageIds ? prevStorageIds.filter((sid)=> !(event.storageIds || []).map(String).includes(sid)) : [];
    if (removedStorageIds.length) {
      await PackingItem.updateMany(
        { group: groupId, event: event._id, storageId: { $in: removedStorageIds } },
        { $set: { storageId: null, storageName: '' } }
      );
    }

    res.json({
      id: event._id.toString(),
      name: event.name,
      startAt: event.startAt,
      participants: event.participants.map(String),
      storageIds: event.storageIds ? event.storageIds.map((x)=> x.toString()) : undefined,
      completed: !!event.completed,
      completedAt: event.completedAt,
      planStatus: Object.fromEntries(event.planStatus || [])
    });
  } catch (_) {
    res.status(500).json({ error: 'failed' });
  }
});

router.delete('/api/events/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const id = req.params.id;
    const ev = await PackingEvent.findOne({ _id: id, group: groupId }).lean();
    if (!ev) return res.status(404).json({ error: 'not found' });
    await PackingItem.deleteMany({ group: groupId, event: ev._id });
    await PackingEvent.deleteOne({ _id: ev._id, group: groupId });
    res.json({ ok: true });
  } catch (_) {
    res.status(500).json({ error: 'failed' });
  }
});

router.post('/api/events/:id/duplicate', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const id = req.params.id;
    const source = await PackingEvent.findOne({ _id: id, group: groupId }).lean();
    if (!source) return res.status(404).json({ error: 'not found' });
    const nameRaw = String(req.body?.name || '').trim();
    const name = nameRaw || `${source.name || 'イベント'}のコピー`;
    const memberInfo = await getMemberOptions(groupId);
    let participantIds = Array.isArray(req.body?.participants) ? req.body.participants.map(String) : (source.participants || []).map(String);
    participantIds = participantIds.filter((pid)=> memberInfo.idSet.has(pid));

    const storageDocs = await PackingStorage.find({ _id: { $in: source.storageIds || [] }, group: groupId }).lean();
    const storageMap = new Map((storageDocs || []).map((s)=> [s._id.toString(), s.name || '']));
    const storageIds = Array.from(storageMap.keys());

    const created = await PackingEvent.create({
      name,
      storageContainers: [],
      participants: participantIds,
      startAt: source.startAt || null,
      storageIds,
      group: groupId,
      createdBy: req.user._id,
      completed: false,
      completedAt: null
    });

    const items = await PackingItem.find({ group: groupId, event: source._id }).lean();
    if (items.length){
      const docs = items.map((it)=> {
        const storageId = (!it.wish && storageMap.has(String(it.storageId || ''))) ? it.storageId : null;
        const storageName = storageId ? (storageMap.get(String(storageId)) || '') : '';
        return {
          name: it.name,
          thingId: it.thingId || null,
          storageId,
          storageName,
          owner: it.owner || 'all',
          quantity: it.quantity || 0,
          weight: it.weight || 0,
          category: it.category || '',
          comment: it.comment || '',
          wish: !!it.wish,
          checked: false,
          checkedAt: null,
          checkedBy: '',
          group: groupId,
          event: created._id,
          createdBy: req.user._id,
          reusedFrom: it._id
        };
      });
      await PackingItem.insertMany(docs);
    }

    await syncPackingTasks(created, participantIds, groupId);

    res.json({
      id: String(created._id),
      name: created.name,
      startAt: created.startAt || null,
      participants: created.participants.map(String),
      storageIds: created.storageIds ? created.storageIds.map((x)=> x.toString()) : [],
      completed: false
    });
  } catch (_) {
    res.status(500).json({ error: 'failed' });
  }
});

router.get('/shop/:eventId', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.redirect('/users/packing');
    const eventId = req.params.eventId;
    const [ev, itemsRaw, masterItemsRaw] = await Promise.all([
      PackingEvent.findOne({ _id: eventId, group: groupId }).lean(),
      PackingItem.find({ group: groupId, event: eventId }).lean(),
      PackingMasterItem.find({ group: groupId }).lean()
    ]);
    if (!ev) return res.redirect('/users/packing');
    const masterMap = new Map((masterItemsRaw || []).map((m)=> [m._id.toString(), { defaultWeight: m.defaultWeight || 0, category: m.category || '', owner: m.owner ? String(m.owner) : 'all', wish: !!m.wish }]));
    const hydratedItems = await hydrateItemWeights(itemsRaw || [], masterMap, groupId);
    const items = (hydratedItems || [])
      .filter((it)=> !!it.wish)
      .filter((it)=> !it.hidden)
      .map((it)=> ({
        id: String(it._id),
        name: it.name,
        quantity: it.quantity || 0,
        weight: it.weight || 0,
        category: it.category || '',
        hidden: !!it.hidden,
        owner: it.owner ? String(it.owner) : 'all',
        comment: it.comment || ''
      }));
    res.render('users/packingShop', {
      event: { id: String(ev._id), name: ev.name },
      items
    });
  } catch(e){ next(e); }
});

// Checklist Excel export
router.get('/check/:eventId.xlsx', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).send('group required');
    const eventId = req.params.eventId;
    const owner = String(req.query.owner || 'all');
    const [ev, storagesRaw, itemsRaw, memberInfo] = await Promise.all([
      PackingEvent.findOne({ _id: eventId, group: groupId }).lean(),
      PackingStorage.find({ group: groupId }).lean(),
      PackingItem.find({ group: groupId, event: eventId }).lean(),
      getMemberOptions(groupId)
    ]);
    if (!ev) return res.status(404).send('not found');
    const storageIds = (ev.storageIds || []).map((x)=> x.toString());
    const storages = (storagesRaw || [])
      .slice()
      .map((s)=> ({ id: String(s._id), name: s.name || '収納', owner: s.owner || 'all' }))
      .filter((s)=> !storageIds.length || storageIds.includes(s.id))
      .sort((a,b)=> (a.name||'').localeCompare(b.name||'', 'ja'));
    const items = (itemsRaw || [])
      .filter((it)=> !it.hidden)
      .filter((it)=> {
        if (!storageIds.length) return true;
        return storageIds.includes(String(it.storageId || ''));
      })
      .map((it)=> ({
        id: String(it._id),
        name: it.name || '',
        storageId: it.storageId ? String(it.storageId) : '',
        quantity: it.quantity || 0,
        owner: it.owner ? String(it.owner) : 'all'
      }))
      .filter((it)=> {
        if (owner === 'all') return true;
        if (it.owner === 'all') return true;
        return it.owner === owner;
      });
    const storageNameById = new Map(storages.map((s)=> [s.id, s.name || '収納']));
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('チェックリスト');
    sheet.properties.defaultRowHeight = 22;
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth()+1).padStart(2,'0');
    const d = String(today.getDate()).padStart(2,'0');
    const ownerLabel = owner === 'all'
      ? '共有'
      : (memberInfo.labelMap.get(owner) || 'メンバー');
    const title = `${ev.name || 'パッキングプラン'}${ownerLabel}${y}${m}${d}のチェックリスト`;
    sheet.mergeCells('A1:D1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = title;
    titleCell.font = { name: 'Meiryo UI', size: 16, bold: true };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 26;
    sheet.columns = [
      { key: 'storage', width: 18 },
      { key: 'item', width: 28 },
      { key: 'qty', width: 12 },
      { key: 'check', width: 12 }
    ];
    const headerRowNumber = 3;
    const addBorder = (row)=> row.eachCell((cell)=> {
      const isHeader = row.number === headerRowNumber;
      cell.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
      cell.font = { name: 'Meiryo UI', size: 16, bold: isHeader };
      const col = cell.col;
      if (col === 3) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if (col === 4) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else if (isHeader) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else {
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      }
    });
    const header = sheet.getRow(headerRowNumber);
    header.values = ['収納先', '持ち物', '数量', 'チェック欄'];
    addBorder(header);
    const sortedRows = items
      .map((it)=> ({
        storage: storageNameById.get(it.storageId) || '未設定',
        item: it.name || '',
        qty: it.quantity || '',
        check: ''
      }))
      .sort((a,b)=> a.storage.localeCompare(b.storage,'ja') || (a.item||'').localeCompare(b.item||'','ja'));
    sortedRows.forEach((row)=> addBorder(sheet.addRow(row)));
    const minRows = 25;
    while (sheet.rowCount < minRows + 3) {
      addBorder(sheet.addRow({ storage:'', item:'', qty:'', check:'' }));
    }
    const baseName = `${ev.name || 'パッキングプラン'}${ownerLabel}${y}${m}${d}のチェックリスト.xlsx`;
    const encoded = encodeURIComponent(baseName);
    const fallback = 'packing-checklist.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    const buffer = await workbook.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) { next(e); }
});

// Event detail
router.get('/:eventId', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.redirect('/users/packing');
    const eventId = req.params.eventId;
    const [ev, memberInfo, storagesRaw, masterItemsRaw, itemsRaw] = await Promise.all([
      PackingEvent.findOne({ _id: eventId, group: groupId }).lean(),
      getMemberOptions(groupId),
      PackingStorage.find({ group: groupId }).lean(),
      PackingMasterItem.find({ group: groupId }).lean(),
      PackingItem.find({ group: groupId, event: eventId }).lean()
    ]);
    if (!ev) return res.redirect('/users/packing');
    const storages = (storagesRaw || []).map((s)=> ({ id: String(s._id), name: s.name, maxWeight: s.maxWeight || 0, owner: s.owner || 'all' }));
    const eventStorageIds = (ev.storageIds || []).map((id)=> id.toString());
    const masterItems = (masterItemsRaw || []).map((it)=> ({
      id: String(it._id),
      name: it.name,
      owner: it.owner ? String(it.owner) : 'all',
      defaultQuantity: it.defaultQuantity || 1,
      defaultWeight: it.defaultWeight || 0,
      category: it.category || '',
      comment: it.comment || '',
      wish: !!it.wish
    }));
    const masterMap = new Map(masterItemsRaw.map((m)=> [m._id.toString(), { defaultWeight: m.defaultWeight || 0, category: m.category || '', owner: m.owner ? String(m.owner) : 'all', wish: !!m.wish }]));
    const hydratedItemsRaw = await hydrateItemWeights(itemsRaw || [], masterMap, groupId);
    let items = (hydratedItemsRaw || []).map((it)=>({
      id: String(it._id),
      name: it.name,
      owner: it.owner ? String(it.owner) : 'all',
      quantity: it.quantity || 0,
      weight: it.weight || 0,
      category: it.category || '',
      hidden: !!it.hidden,
      comment: it.comment || '',
      storageId: it.storageId ? String(it.storageId) : '',
      storageName: it.storageName || '',
      wish: !!it.wish,
      checked: !!it.checked,
      checkedAt: it.checkedAt,
      checkedBy: it.checkedBy,
      thingId: it.thingId ? String(it.thingId) : null
    }));
    // auto-reflect master items: create missing items (unassigned) per master
    const existingThingIds = new Set(items.map((it)=> it.thingId).filter(Boolean));
    const toCreate = masterItems.filter((m)=> !existingThingIds.has(m.id));
    if (toCreate.length){
      const docs = await PackingItem.insertMany(toCreate.map((m)=> ({
        name: m.name,
        thingId: m.id,
        storageId: null,
        storageName: '',
        owner: m.owner || 'all',
      quantity: m.defaultQuantity || 0,
      weight: m.defaultWeight || 0,
      category: m.category || '',
      comment: m.comment || '',
      wish: !!m.wish,
      group: groupId,
      event: ev._id,
      createdBy: req.user._id
    })));
    const appended = docs.map((d)=> ({
        id: String(d._id),
        name: d.name,
        owner: d.owner ? String(d.owner) : 'all',
        quantity: d.quantity || 0,
      weight: d.weight || 0,
      category: d.category || '',
      comment: d.comment || '',
      storageId: '',
      storageName: '',
      wish: !!d.wish,
      hidden: !!d.hidden,
      checked: !!d.checked,
      checkedAt: d.checkedAt,
      checkedBy: d.checkedBy,
      thingId: d.thingId ? String(d.thingId) : null
    }));
      items = items.concat(appended);
    }
    const memberNameById = new Map(memberInfo.list.map((m)=> [m.id, m.name]));
    const planStatusMap = new Map(Object.entries(ev.planStatus || {}).map(([k,v])=> [k, !!v]));
    memberInfo.list.forEach((m)=> { if (!planStatusMap.has(m.id)) planStatusMap.set(m.id, false); });
    await PackingEvent.updateOne({ _id: ev._id }, { $set: { lastOpenedAt: new Date() } });
    res.render('users/packingEvent', {
      event: {
        id: String(ev._id),
        name: ev.name,
        startAt: ev.startAt || null,
        participants: (ev.participants || []).map(String),
        storageIds: eventStorageIds,
        completed: !!ev.completed,
        completedAt: ev.completedAt || null
      },
      members: memberInfo.list,
      memberNameById,
      planStatus: Object.fromEntries(planStatusMap),
      storages,
      masterItems,
      items,
      currentUserId: req.user?._id ? String(req.user._id) : ''
    });
  } catch(e) { next(e); }
});

// Event items (assignment)
router.post('/api/items', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const { eventId, name, storageId, owner, quantity, comment, thingId } = req.body || {};
    const itemName = String(name || '').trim();
    if (!eventId || !itemName) return res.status(400).json({ error: 'bad request' });
    const [event, storage, thing, memberInfo] = await Promise.all([
      PackingEvent.findOne({ _id: eventId, group: groupId }).lean(),
      storageId ? PackingStorage.findOne({ _id: storageId, group: groupId }).lean() : null,
      thingId ? PackingMasterItem.findOne({ _id: thingId, group: groupId }).lean() : null,
      getMemberOptions(groupId)
    ]);
    if (!event) return res.status(404).json({ error: 'event not found' });
    const wish = typeof req.body?.wish !== 'undefined' ? parseBool(req.body.wish) : !!thing?.wish;
    const storageName = !wish && storage ? storage.name : '';
    const ownerId = memberInfo.idSet.has(String(owner || '')) ? String(owner) : 'all';
    const qtyNum = Math.max(0, Number(quantity ?? thing?.defaultQuantity ?? 1) || 1);
    const weightNum = Math.max(0, Number(req.body?.weight || (thing?.defaultWeight ?? 0)) || 0);
    const category = String(req.body?.category || thing?.category || "").trim();
    let master = thing;
    if (!master) {
      master = await PackingMasterItem.create({
        name: itemName,
        owner: ownerId || 'all',
        defaultQuantity: qtyNum,
        defaultWeight: weightNum,
        category: String(req.body?.category || '').trim(),
        comment: String(comment || '').trim(),
        wish,
        group: groupId,
        createdBy: req.user._id
      });
    } else if (category && !master.category) {
      await PackingMasterItem.updateOne({ _id: master._id }, { $set: { category } });
      master.category = category;
    }
    const created = await PackingItem.create({
      name: itemName,
      thingId: master?._id || null,
      storageId: wish ? null : (storage?._id || null),
      storageName,
      owner: ownerId || 'all',
      quantity: qtyNum,
      weight: weightNum,
      category,
      comment: String(comment || '').trim(),
      wish,
      group: groupId,
      event: event._id,
      createdBy: req.user._id,
      reusedFrom: null
    });
    res.json({
      id: created._id,
      eventId: String(created.event),
      name: created.name,
      thingId: created.thingId ? String(created.thingId) : '',
      storageId: created.storageId ? String(created.storageId) : '',
      storageName: created.storageName || '',
      owner: created.owner,
      quantity: created.quantity,
      weight: created.weight,
      category: created.category || '',
      comment: created.comment,
      wish: !!created.wish,
      checked: created.checked,
      checkedAt: created.checkedAt,
      checkedBy: created.checkedBy,
      hidden: !!created.hidden
    });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

router.patch('/api/items/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const id = req.params.id;
    const item = await PackingItem.findOne({ _id: id, group: groupId }).lean();
    if (!item) return res.status(404).json({ error: 'not found' });
    const [storage, thing, memberInfo] = await Promise.all([
      req.body?.storageId ? PackingStorage.findOne({ _id: req.body.storageId, group: groupId }).lean() : null,
      req.body?.thingId ? PackingMasterItem.findOne({ _id: req.body.thingId, group: groupId }).lean() : null,
      getMemberOptions(groupId)
    ]);
    const masterWish = typeof thing?.wish === 'boolean' ? thing.wish : item.wish;
    const wish = typeof req.body?.wish !== 'undefined' ? parseBool(req.body.wish) : !!masterWish;
    if (wish && req.body?.storageId) return res.status(400).json({ error: 'wish item cannot have storage' });
    const ownerId = memberInfo.idSet.has(String(req.body?.owner || '')) ? String(req.body.owner) : 'all';
    const storageAllowed = !wish && storage;
    const update = {
      name: String(req.body?.name || item.name || '').trim(),
      owner: ownerId,
      quantity: Math.max(0, Number(req.body?.quantity) || 0),
      weight: Math.max(0, Number(req.body?.weight) || item.weight || 0),
      category: typeof req.body?.category === 'string' ? String(req.body.category || '').trim() : item.category || '',
      comment: String(req.body?.comment || '').trim(),
      thingId: thing?._id || item.thingId || null,
      storageId: storageAllowed ? storage._id : null,
      storageName: storageAllowed ? storage.name : '',
      wish
    };
    if (req.body?.hidden !== undefined){
      const hide = parseBool(req.body.hidden);
      update.hidden = hide;
      update.hiddenAt = hide ? new Date() : null;
      if (hide){
        update.categoryBeforeHide = item.category || '';
        update.category = '非表示';
        update.storageId = null;
        update.storageName = '';
      } else {
        update.category = item.categoryBeforeHide || item.category || '';
        update.categoryBeforeHide = '';
      }
    }
    if (update.category && item.thingId && !update.hidden) {
      await PackingMasterItem.updateOne({ _id: item.thingId, group: groupId }, { $set: { category: update.category } });
    }
    const updated = await PackingItem.findOneAndUpdate(
      { _id: id, group: groupId },
      { $set: update },
      { new: true }
    ).lean();
    res.json({
      id: String(updated._id),
      eventId: updated.event ? String(updated.event) : '',
      name: updated.name,
      owner: updated.owner,
      quantity: updated.quantity,
      comment: updated.comment,
      storageId: updated.storageId ? String(updated.storageId) : '',
      storageName: updated.storageName || '',
      checked: updated.checked,
      checkedAt: updated.checkedAt,
      checkedBy: updated.checkedBy,
      category: updated.category || '',
      wish: !!updated.wish,
      hidden: !!updated.hidden
    });
  } catch (_) { res.status(500).json({ error: 'failed' }); }
});

router.delete('/api/items/:id', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const id = req.params.id;
    const before = await PackingItem.findOne({ _id: id, group: groupId }).lean();
    const deleted = await PackingItem.findOneAndUpdate(
      { _id: id, group: groupId },
      { $set: { hidden: true, hiddenAt: new Date(), categoryBeforeHide: before?.category || '', category: '非表示', storageId: null, storageName: '' } },
      { new: true }
    );
    if (!deleted) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch(_) { res.status(500).json({ error: 'failed' }); }
});

router.post('/api/items/:id/check', async (req, res) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const id = req.params.id;
    const checked = !!req.body?.checked;
    const update = {
      checked,
      checkedAt: checked ? new Date() : null,
      checkedBy: checked ? userLabel(req.user) : ''
    };
    const updated = await PackingItem.findOneAndUpdate(
      { _id: id, group: groupId },
      { $set: update },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({
      id: String(updated._id),
      checked: updated.checked,
      checkedAt: updated.checkedAt,
      checkedBy: updated.checkedBy,
      category: updated.category || ''
    });
  } catch (_) {
    res.status(500).json({ error: 'failed' });
  }
});

export default router;
// Checklist Excel export (place before HTML route to avoid param collision)
router.get('/check/:eventId.xlsx', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).send('group required');
    const eventId = req.params.eventId;
    const owner = String(req.query.owner || 'all');
    const [ev, storagesRaw, itemsRaw, memberInfo] = await Promise.all([
      PackingEvent.findOne({ _id: eventId, group: groupId }).lean(),
      PackingStorage.find({ group: groupId }).lean(),
      PackingItem.find({ group: groupId, event: eventId }).lean(),
      getMemberOptions(groupId)
    ]);
    if (!ev) return res.status(404).send('not found');
    const storageIds = (ev.storageIds || []).map((x)=> x.toString());
    const storages = (storagesRaw || [])
      .slice()
      .map((s)=> ({ id: String(s._id), name: s.name || '収納', owner: s.owner || 'all' }))
      .filter((s)=> !storageIds.length || storageIds.includes(s.id))
      .sort((a,b)=> (a.name||'').localeCompare(b.name||'', 'ja'));
    const items = (itemsRaw || [])
      .filter((it)=> !it.hidden)
      .filter((it)=> {
        if (!storageIds.length) return true;
        return storageIds.includes(String(it.storageId || ''));
      })
      .map((it)=> ({
        id: String(it._id),
        name: it.name || '',
        storageId: it.storageId ? String(it.storageId) : '',
        quantity: it.quantity || 0,
        owner: it.owner ? String(it.owner) : 'all'
      }))
      .filter((it)=> {
        if (owner === 'all') return true;
        if (it.owner === 'all') return true;
        return it.owner === owner;
      });
    const storageNameById = new Map(storages.map((s)=> [s.id, s.name || '収納']));
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('チェックリスト');
    sheet.properties.defaultRowHeight = 22;
    const title = `${ev.name || 'パッキング'} チェックリスト`;
    sheet.mergeCells('A1:D1');
    sheet.getCell('A1').value = title;
    sheet.getCell('A1').font = { name: 'Meiryo UI', size: 16, bold: true };
    sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.columns = [
      { header: '収納先', key: 'storage', width: 18 },
      { header: '持ち物', key: 'item', width: 28 },
      { header: '数量', key: 'qty', width: 12 },
      { header: 'チェック欄', key: 'check', width: 12 }
    ];
    const addBorder = (row)=> row.eachCell((cell)=> {
      const isHeader = row.number === 3;
      cell.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
      cell.font = { name: 'Meiryo UI', size: 16, bold: isHeader };
      const col = cell.col;
      if (col === 3) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else if (col === 4) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else if (isHeader) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else {
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      }
    });
    const header = sheet.getRow(3);
    header.values = ['収納先', '持ち物', '数量', 'チェック欄'];
    addBorder(header);
    const sortedRows = items
      .map((it)=> ({
        storage: storageNameById.get(it.storageId) || '未設定',
        item: it.name || '',
        qty: it.quantity || '',
        check: ''
      }))
      .sort((a,b)=> a.storage.localeCompare(b.storage,'ja') || (a.item||'').localeCompare(b.item||'','ja'));
    sortedRows.forEach((row)=> addBorder(sheet.addRow(row)));
    const minRows = 25;
    while (sheet.rowCount < minRows + 3) {
      addBorder(sheet.addRow({ storage:'', item:'', qty:'', check:'' }));
    }
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth()+1).padStart(2,'0');
    const d = String(today.getDate()).padStart(2,'0');
    const ownerLabel = owner === 'all'
      ? '共有'
      : (memberInfo.labelMap.get(owner) || 'メンバー');
    const baseName = `${ev.name || 'パッキングプラン'}${ownerLabel}${y}${m}${d}のチェックリスト.xls`;
    const encoded = encodeURIComponent(baseName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}"; filename*=UTF-8''${encoded}`);
    const buffer = await workbook.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) { next(e); }
});

router.get('/check/:eventId', async (req, res, next) => {
  try {
    const groupId = getGroupId(res);
    if (!groupId) return res.redirect('/users/packing');
    const eventId = req.params.eventId;
    const [ev, storagesRaw, itemsRaw, masterItemsRaw, memberInfo] = await Promise.all([
      PackingEvent.findOne({ _id: eventId, group: groupId }).lean(),
      PackingStorage.find({ group: groupId }).lean(),
      PackingItem.find({ group: groupId, event: eventId }).lean(),
      PackingMasterItem.find({ group: groupId }).lean(),
      getMemberOptions(groupId)
    ]);
    if (!ev) return res.redirect('/users/packing');
    const storageIds = (ev.storageIds || []).map((x)=> x.toString());
    const storages = (storagesRaw || [])
      .slice()
      .sort((a,b)=> (a.name||'').localeCompare(b.name||'', 'ja'))
      .map((s)=> ({ id: String(s._id), name: s.name, maxWeight: s.maxWeight || 0, owner: s.owner || 'all' }));
    const filteredStorages = storageIds.length ? storages.filter((s)=> storageIds.includes(s.id)) : storages;
    const masterMap = new Map((masterItemsRaw || []).map((m)=> [m._id.toString(), { defaultWeight: m.defaultWeight || 0, category: m.category || '', owner: m.owner ? String(m.owner) : 'all', wish: !!m.wish }]));
    const hydratedItems = await hydrateItemWeights(itemsRaw || [], masterMap, groupId);
    const items = (hydratedItems || [])
      .filter((it)=> !it.hidden)
      .map((it)=> ({
      id: String(it._id),
      name: it.name,
      storageId: it.storageId ? String(it.storageId) : '',
      storageName: it.storageName || '',
      checked: !!it.checked,
      checkedAt: it.checkedAt,
      checkedBy: it.checkedBy,
      quantity: it.quantity || 0,
      weight: it.weight || 0,
      category: it.category || '',
      hidden: !!it.hidden,
      owner: it.owner ? String(it.owner) : 'all',
      wish: !!it.wish,
      comment: it.comment || ''
    }));
    await PackingEvent.updateOne({ _id: ev._id }, { $set: { lastOpenedAt: new Date() } });
    const participantOptions = (ev.participants || [])
      .map((id)=> ({ id: String(id), name: memberInfo.labelMap.get(String(id)) || 'メンバー' }))
      .filter((opt)=> !!opt.name);
    if (!participantOptions.length && memberInfo.list.length){
      participantOptions.push(...memberInfo.list.map((m)=> ({ id: m.id, name: m.name })));
    }
    res.render('users/packingCheck', {
      event: { id: String(ev._id), name: ev.name },
      storages: filteredStorages,
      items,
      members: participantOptions
    });
  } catch(e){ next(e); }
});
