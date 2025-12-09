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
  note: task.note || '',
  recurrence: task.recurrence || { type: 'none', interval: 1, weekdays: [], dayOfMonth: null },
  source: task.source || 'manual',
  sourceId: task.sourceId ? task.sourceId.toString() : null,
  createdAt: task.createdAt || null,
  updatedAt: task.updatedAt || null
});

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
    const tasks = tasksRaw.map(normalizeTask).map((t)=> ({
      ...t,
      assignees: Array.from(new Set((t.assignees || []).filter((id)=> memberIdSet.has(String(id)))))
    }));
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
    const tasks = tasksRaw.map(normalizeTask).map((t)=> ({
      ...t,
      assignees: Array.from(new Set((t.assignees || []).filter((id)=> memberIdSet.has(String(id)))))
    }));
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
      status,
      completedAt: status === 'completed' ? new Date() : null,
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
    sendTaskMail({
      groupId,
      toIds: Array.from(new Set([task.createdBy, ...task.assignees])),
      subject: `タスクが作成されました: ${task.title}`,
      template: 'taskNotification',
      payload: { title: task.title, content: task.note || '', dueAt: task.dueAt }
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

    if (typeof req.body?.title === 'string') task.title = req.body.title.trim() || task.title;
    if (typeof req.body?.category === 'string') task.category = req.body.category.trim();
    if (Array.isArray(req.body?.assignees)){
      task.assignees = req.body.assignees.map(String).filter((id)=> memberInfo.idSet.has(id));
    }
    if (req.body?.startAt) task.startAt = new Date(req.body.startAt);
    if (req.body?.dueAt) task.dueAt = new Date(req.body.dueAt);
    if (typeof req.body?.started === 'boolean') task.started = req.body.started;
    if (typeof req.body?.note === 'string') task.note = req.body.note;
    if (req.body?.status && ['not_started','in_progress','on_hold','completed'].includes(req.body.status)){
      task.status = req.body.status;
      task.completedAt = req.body.status === 'completed' ? (task.completedAt || new Date()) : null;
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
      sendTaskMail({
        groupId,
        toIds: Array.from(new Set([task.createdBy.toString(), ...task.assignees.map(String)])),
        subject: `タスクが完了しました: ${task.title}`,
        template: 'taskNotification',
        payload: { title: task.title, content: task.note || '', dueAt: task.dueAt }
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
