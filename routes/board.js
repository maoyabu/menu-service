import express from 'express';
import { isLoggedIn } from '../middleware.js';
import Group from '../models/groups.js';
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

async function getMemberOptions(groupId){
  if (!groupId) return { list: [], idSet: new Set(), labelMap: new Map(), emailMap: new Map() };
  const group = await Group.findById(groupId)
    .populate('createdBy members', 'displayname username email')
    .lean();
  if (!group) return { list: [], idSet: new Set(), labelMap: new Map(), emailMap: new Map() };
  const map = new Map();
  const emailMap = new Map();
  const pushUser = (u) => {
    if (!u) return;
    const id = u._id?.toString?.() || (typeof u === 'string' ? u : '');
    if (!id || map.has(id)) return;
    map.set(id, { id, name: userLabel(u) });
    emailMap.set(id, u.email || '');
  };
  pushUser(group.createdBy);
  (group.members || []).forEach(pushUser);
  const list = Array.from(map.values());
  return { list, idSet: new Set(list.map((u)=>u.id)), labelMap: new Map(list.map((u)=>[u.id, u.name])), emailMap };
}

const normalizeTask = (task) => ({
  id: task._id?.toString() || task.id,
  title: task.title,
  category: task.category || '',
  createdBy: task.createdBy?.toString?.() || task.createdBy,
  assignees: (task.assignees || []).map((a)=> a?.toString?.() || a),
  startAt: task.startAt || null,
  dueAt: task.dueAt || null,
  started: !!task.started,
  status: task.status,
  completedAt: task.completedAt || null,
  kind: task.kind || 'task',
  confirmedBy: (task.confirmedBy || (task.confirmed ? [task.createdBy] : [])).map((a)=> a?.toString?.() || a),
  statusBy: (task.statusBy || []).map((s)=> ({
    user: s.user?.toString?.() || s.user,
    status: s.status || 'not_started'
  })),
  note: task.note || '',
  recurrence: task.recurrence || { type: 'none', interval: 1, weekdays: [], dayOfMonth: null },
  source: task.source || 'manual',
  sourceId: task.sourceId ? task.sourceId.toString() : null,
  createdAt: task.createdAt || null,
  updatedAt: task.updatedAt || null
});

function isAllCompleted(task){
  const assignees = Array.isArray(task.assignees) ? task.assignees.map(String) : [];
  if (!assignees.length) return false;
  const statusMap = new Map((task.statusBy || []).map((s)=> [String(s.user), s.status || 'not_started']));
  return assignees.every((id)=> statusMap.get(String(id)) === 'completed');
}

function computeNextRecurrence(task){
  const recur = task.recurrence || {};
  if (!recur || recur.type === 'none') return null;
  const interval = Math.max(1, Number(recur.interval || 1) || 1);
  const baseDate = task.completedAt || task.dueAt || task.startAt || new Date();
  const base = new Date(baseDate);
  base.setHours(0,0,0,0);
  const next = new Date(base);
  const addDays = (days)=> { const d = new Date(base); d.setDate(d.getDate() + days); return d; };

  if (recur.type === 'daily'){
    return addDays(interval);
  }
  if (recur.type === 'weekly'){
    const weekdays = Array.isArray(recur.weekdays) ? recur.weekdays.filter((n)=> Number.isInteger(n) && n >=0 && n<=6) : [];
    if (!weekdays.length) return addDays(7 * interval);
    for (let i=1; i<= (7*interval)+7; i++){
      const cand = addDays(i);
      const weekOffset = Math.floor(i/7);
      if (weekOffset % interval !== 0) continue;
      if (weekdays.includes(cand.getDay())) return cand;
    }
    return addDays(7 * interval);
  }
  if (recur.type === 'monthly'){
    const day = recur.dayOfMonth || base.getDate();
    const cand = new Date(base);
    cand.setMonth(cand.getMonth() + interval);
    cand.setDate(Math.min(day, 28 + Math.max(0, day - 28))); // clamp end of month
    return cand;
  }
  return null;
}

async function sendTaskMail({ groupId, toIds, subject, template, payload }){
  try{
    if (!Array.isArray(toIds) || !toIds.length) return;
    const users = await User.find({ _id: { $in: toIds } }).select('email isMail').lean();
    const emails = (users || []).filter((u)=> u.isMail !== false).map((u)=> u.email).filter(Boolean);
    if (!emails.length) return;
    const html = await renderTemplate(template, payload);
    await sendMail({ to: emails, subject, html });
  }catch(_){ /* best effort */ }
}

router.get('/', async (req, res, next) => {
  try{
    const groupId = getGroupId(res);
    if (!groupId) return res.render('users/board', { members: [], tasks: [], categories: [], currentGroupName: '' });
    const [memberInfo, tasksRaw, group] = await Promise.all([
      getMemberOptions(groupId),
      Task.find({ group: groupId }).sort({ status: 1, dueAt: 1, startAt: 1, createdAt: 1 }).lean(),
      Group.findById(groupId).select('group_name').lean()
    ]);
    const memberIdSet = memberInfo.idSet || new Set();
    const categories = Array.from(new Set(tasksRaw.map((t)=> (t.category || '').trim()).filter(Boolean))).sort((a,b)=> a.localeCompare(b,'ja'));
    const tasks = tasksRaw.map(normalizeTask).map((t)=> {
      const statusByMap = new Map((t.statusBy || []).map((s)=> [String(s.user), s]));
      return {
        ...t,
        assignees: Array.from(new Set((t.assignees || []).filter((id)=> memberIdSet.has(String(id))))),
        confirmedBy: Array.from(new Set((t.confirmedBy || []).filter((id)=> memberIdSet.has(String(id))))),
        statusBy: Array.from(statusByMap.values()).filter((s)=> memberIdSet.has(String(s.user)))
      };
    });
    res.render('users/board', {
      members: memberInfo.list,
      tasks,
      categories,
      currentGroupName: group?.group_name || '',
      currentUserId: req.user?._id ? String(req.user._id) : ''
    });
  }catch(e){ next(e); }
});

router.get('/api/tasks', async (req, res) => {
  try{
    const groupId = getGroupId(res);
    if (!groupId) return res.json([]);
    const memberInfo = await getMemberOptions(groupId);
    const q = { group: groupId };
    const status = String(req.query.status || 'active');
    if (status === 'active'){
      q.status = { $ne: 'completed' };
    } else if (status === 'completed'){
      q.status = 'completed';
    }
    const assignees = Array.isArray(req.query.assignee) ? req.query.assignee : String(req.query.assignee || '').split(',').filter(Boolean);
    if (assignees.length){
      q.assignees = { $in: assignees.filter((id)=> memberInfo.idSet.has(String(id))) };
    }
    const categories = Array.isArray(req.query.category) ? req.query.category : String(req.query.category || '').split(',').filter(Boolean);
    if (categories.length){
      q.category = { $in: categories };
    }
    if (req.query.createdBy){
      const cid = String(req.query.createdBy);
      if (memberInfo.idSet.has(cid)) q.createdBy = cid;
    }
    const memberIdSet = memberInfo.idSet || new Set();
    const tasksRaw = await Task.find(q).sort({ status: 1, dueAt: 1, startAt: 1, createdAt: 1 }).lean();
    const tasks = tasksRaw.map(normalizeTask).map((t)=> {
      const statusByMap = new Map((t.statusBy || []).map((s)=> [String(s.user), s]));
      return {
        ...t,
        assignees: Array.from(new Set((t.assignees || []).filter((id)=> memberIdSet.has(String(id))))),
        confirmedBy: Array.from(new Set((t.confirmedBy || []).filter((id)=> memberIdSet.has(String(id))))),
        statusBy: Array.from(statusByMap.values()).filter((s)=> memberIdSet.has(String(s.user)))
      };
    });
    res.json(tasks);
  }catch(_){ res.status(500).json({ error: 'failed' }); }
});

router.post('/api/tasks', async (req, res) => {
  try{
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const memberInfo = await getMemberOptions(groupId);
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    const category = String(req.body?.category || '').trim();
    const assignees = Array.isArray(req.body?.assignees) ? req.body.assignees.map(String).filter((id)=> memberInfo.idSet.has(id)) : [];
    const startAt = req.body?.startAt ? new Date(req.body.startAt) : null;
    const dueAt = req.body?.dueAt ? new Date(req.body.dueAt) : null;
    const status = ['not_started','in_progress','on_hold','completed'].includes(req.body?.status) ? req.body.status : 'not_started';
    const kind = ['task','bulletin'].includes(req.body?.kind) ? req.body.kind : 'task';
    const confirmed = !!req.body?.confirmed;
    const userStatus = (kind === 'bulletin' && confirmed) ? 'completed' : status;
    const aggregateStatus = isAllCompleted({ assignees, statusBy: [{ user: req.user._id, status: userStatus }] }) ? 'completed' : 'not_started';
    const recurrence = req.body?.recurrence || {};
    const created = await Task.create({
      group: groupId,
      title,
      category,
      createdBy: req.user._id,
      assignees,
      startAt,
      dueAt,
      started: !!req.body?.started,
      status: aggregateStatus,
      completedAt: aggregateStatus === 'completed' ? new Date() : null,
      kind,
      confirmedBy: confirmed ? [req.user._id] : [],
      statusBy: [{ user: req.user._id, status: userStatus }],
      note: req.body?.note || '',
      recurrence: {
        type: recurrence.type || 'none',
        interval: recurrence.interval || 1,
        weekdays: recurrence.weekdays || [],
        dayOfMonth: recurrence.dayOfMonth || null
      },
      source: req.body?.source || 'manual',
      sourceId: req.body?.sourceId || null
    });
    const task = normalizeTask(created);
    const baseUrl = process.env.APP_BASE_URL || process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    const confirmUrl = `${baseUrl}/users/board?confirm=${encodeURIComponent(task.id)}`;
    const typeLabel = task.kind === 'bulletin' ? '掲示物' : 'タスク';
    sendTaskMail({
      groupId,
      toIds: Array.from(new Set([task.createdBy, ...task.assignees])),
      subject: `${typeLabel}が作成されました: ${task.title}`,
      template: 'taskNotification',
      payload: { title: task.title, content: task.note || '', dueAt: task.dueAt, typeLabel, confirmUrl }
    });
    res.json(task);
  }catch(_){ res.status(500).json({ error: 'failed' }); }
});

router.patch('/api/tasks/:id', async (req, res) => {
  try{
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const memberInfo = await getMemberOptions(groupId);
    const task = await Task.findOne({ _id: req.params.id, group: groupId });
    if (!task) return res.status(404).json({ error: 'not found' });
    const prevStatus = task.status;
    const uid = req.user?._id?.toString?.() || '';
    const updateStatusBy = (statusValue) => {
      if (!uid) return;
      const existing = Array.isArray(task.statusBy) ? task.statusBy : [];
      const idx = existing.findIndex((s)=> s.user?.toString?.() === uid);
      if (idx >= 0) existing[idx].status = statusValue;
      else existing.push({ user: req.user._id, status: statusValue });
      task.statusBy = existing;
    };

    if (typeof req.body?.title === 'string') task.title = req.body.title.trim() || task.title;
    if (typeof req.body?.category === 'string') task.category = req.body.category.trim();
    if (Array.isArray(req.body?.assignees)){
      task.assignees = req.body.assignees.map(String).filter((id)=> memberInfo.idSet.has(id));
    }
    if (req.body?.startAt) task.startAt = new Date(req.body.startAt);
    if (req.body?.dueAt) task.dueAt = new Date(req.body.dueAt);
    if (typeof req.body?.started === 'boolean') task.started = req.body.started;
    if (typeof req.body?.confirmed === 'boolean'){
      if (uid){
        const current = new Set((task.confirmedBy || []).map((id)=> id.toString()));
        if (req.body.confirmed) current.add(uid); else current.delete(uid);
        task.confirmedBy = Array.from(current);
        if (task.kind === 'bulletin'){
          const statusValue = req.body.confirmed ? 'completed' : 'not_started';
          updateStatusBy(statusValue);
        }
      }
    }
    if (typeof req.body?.note === 'string') task.note = req.body.note;
    if (typeof req.body?.kind === 'string' && ['task','bulletin'].includes(req.body.kind)){
      task.kind = req.body.kind;
    }
    if (req.body?.status && ['not_started','in_progress','on_hold','completed'].includes(req.body.status)){
      updateStatusBy(req.body.status);
      if (task.kind === 'bulletin'){
        const current = new Set((task.confirmedBy || []).map((id)=> id.toString()));
        if (req.body.status === 'completed') current.add(uid); else current.delete(uid);
        task.confirmedBy = Array.from(current);
      }
    }
    if (req.body?.recurrence){
      const r = req.body.recurrence;
      task.recurrence = {
        type: r.type || 'none',
        interval: r.interval || 1,
        weekdays: r.weekdays || [],
        dayOfMonth: r.dayOfMonth || null
      };
    }
    const allCompleted = isAllCompleted(task);
    task.status = allCompleted ? 'completed' : 'not_started';
    task.completedAt = allCompleted ? (task.completedAt || new Date()) : null;
    await task.save();
    if (prevStatus !== 'completed' && task.status === 'completed'){
      const nextDate = computeNextRecurrence(normalizeTask(task));
      if (nextDate){
        await Task.create({
          group: task.group,
          title: task.title,
          category: task.category,
          createdBy: task.createdBy,
          assignees: task.assignees,
          startAt: nextDate,
          dueAt: nextDate,
          started: false,
          status: 'not_started',
          note: task.note,
          recurrence: task.recurrence,
          source: task.source || 'manual',
          sourceId: task.sourceId || null
        });
      }
      const typeLabel = task.kind === 'bulletin' ? '掲示物' : 'タスク';
      sendTaskMail({
        groupId,
        toIds: Array.from(new Set([task.createdBy.toString(), ...task.assignees.map(String)])),
        subject: `${typeLabel}が完了しました: ${task.title}`,
        template: 'taskNotification',
        payload: { title: task.title, content: task.note || '', dueAt: task.dueAt, typeLabel }
      });
    }
    res.json(normalizeTask(task.toObject()));
  }catch(_){ res.status(500).json({ error: 'failed' }); }
});

router.delete('/api/tasks/:id', async (req, res) => {
  try{
    const groupId = getGroupId(res);
    if (!groupId) return res.status(400).json({ error: 'no group' });
    const task = await Task.findOne({ _id: req.params.id, group: groupId });
    if (!task) return res.status(404).json({ error: 'not found' });
    const uid = req.user?._id?.toString?.() || '';
    if (task.source !== 'manual' || uid !== task.createdBy?.toString()){
      return res.status(403).json({ error: 'forbidden' });
    }
    await Task.deleteOne({ _id: task._id });
    res.json({ ok: true });
  }catch(_){ res.status(500).json({ error: 'failed' }); }
});

export default router;
