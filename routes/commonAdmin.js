// Migrated from common-admin 36c3c1f; uses the existing Mongoose connection.
import express from 'express';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import archiver from 'archiver';
import multer from 'multer';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';
import fsSync from 'node:fs';
import { EJSON } from 'bson';
import nodemailer from 'nodemailer';
import { fetchNeighborhoodRoles } from '../utils/commonAdminRoles.js';

const app = express.Router();
const backupDir = path.resolve(process.env.COMMON_ADMIN_BACKUP_DIR || './backup/common-admin');
const backupLogPath = path.join(backupDir, 'backup-log.json');
const upload = multer({ dest: path.resolve('./tmp-restore'), limits: { fileSize: 500 * 1024 * 1024 } });
fsSync.mkdirSync(path.resolve('./tmp-restore'), { recursive: true });

const serviceCatalog = [
	{ id: 'allaboutme', label: 'All About me', tone: 'blue' },
	{ id: 'finance', label: '家計簿 / Dashboard', tone: 'teal' },
		{ id: 'assets', label: '資産管理', tone: 'amber' },
	{ id: 'message', label: 'Message', tone: 'coral' },
	{ id: 'plan', label: '7 DAYS PLAN', tone: 'blue' },
	{ id: 'stock', label: 'ストック管理', tone: 'green' },
	{ id: 'packing', label: 'パッキングプラン', tone: 'coral' },
	{ id: 'board', label: '掲示板', tone: 'violet' }
];
const serviceIds = serviceCatalog.map((service) => service.id);
const accountbookServiceIds = ['allaboutme', 'finance', 'assets', 'message'];
const menuServiceIds = ['plan', 'stock', 'packing', 'board'];
const emailCatalog = {
	allaboutme: [
		{ id: 'diaryReminder', label: '日記記入リマインダー' }, { id: 'passwordReset', label: 'パスワードリセット' },
		{ id: 'invite', label: 'グループ招待・再招待' }, { id: 'planner_request', label: 'Planner申請' },
		{ id: 'planner_yes', label: 'Planner承認' }, { id: 'planner_no', label: 'Planner非承認' },
		{ id: 'infoNotice', label: '管理者からのお知らせ' }, { id: 'otoiawaseRes', label: '問い合わせ回答' }
	],
	finance: [
		{ id: 'financeDailySummary', label: '日次入力サマリー' }, { id: 'fiscalBudgetSetupNotice', label: '年度予算設定案内' },
		{ id: 'budgetNotice', label: '月次予算到達通知' }, { id: 'financeCloseNotice', label: '月次締め完了' },
		{ id: 'financeYearCloseNotice', label: '年次締め完了' }, { id: 'aweekReminder', label: 'まとめ入力リマインダー' },
		{ id: 'matometeReminder', label: '月次まとめ入力' }, { id: 'matometeNag', label: '前月まとめ入力督促' }
	],
	assets: [{ id: 'equipmentInventoryReminder', label: '備品棚卸し開始' }, { id: 'purchaseReminder', label: '購入リマインダー（備品）' }],
	message: [
		{ id: 'messageAliveConfirmed', label: 'Alive確認完了' }, { id: 'messageAliveCheck', label: 'Alive確認' },
		{ id: 'messagePreNotice', label: 'Message予告' }, { id: 'messageWarning', label: 'Message警告' },
		{ id: 'messageFinal', label: 'Message最終通知' }, { id: 'messageFinalPassword', label: 'Message閲覧パスワード' }
	],
	plan: [
		{ id: 'myMenuAdded', label: 'マイメニュー追加' }, { id: 'planMenuAdded', label: 'これ食べたい通知' },
		{ id: 'notEating', label: '食事不可通知' }, { id: 'eatingAgain', label: '再度食べる通知' },
		{ id: 'dailyMenu', label: '当日の予定メニュー' }, { id: 'weeklyPlanReady', label: '週間プラン作成リマインダー' },
		{ id: 'adminMyMenuAdded', label: '管理者向けマイメニュー追加' }
	],
	stock: [{ id: 'monthlyStockReminder', label: 'マイストック定期点検' }, { id: 'monthlyStockReminderFollowup', label: '点検未実施通知' }, { id: 'purchaseReminder', label: '購入リスト' }],
	packing: [{ id: 'taskNotification', label: 'パッキングプラン更新・完了' }],
	board: [{ id: 'taskNotification', label: '掲示板タスク作成・完了' }]
};

// Reuse menu-service authentication; never allow an unauthenticated development mode.
app.use((req, res, next) => {
  if (!req.isAuthenticated?.() || !req.user?.isAdmin) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: '管理者としてログインしてください。' });
    return res.redirect('/user/login');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
      return res.status(403).json({ error: '不正なリクエスト元です。' });
    }
  }
  next();
});
app.use(express.json({ limit: '1mb' }));

const usersCollection = () => mongoose.connection.collection('users');
const groupsCollection = () => mongoose.connection.collection('groups');
const idString = (value) => value ? String(value?._id || value) : '';
const escapeEmailHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const deletionMailTransport = () => {
	const host = String(process.env.SMTP_HOST || '').trim();
	const port = Number(process.env.SMTP_PORT || 587);
	const smtpUser = String(process.env.SMTP_USER || '').trim();
	const smtpPass = String(process.env.SMTP_PASS || '');
	if (host && smtpUser && smtpPass) {
		return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: smtpUser, pass: smtpPass } });
	}
	const mailUser = String(process.env.MAIL_USER || '').trim();
	const mailPass = String(process.env.MAIL_PASS || '');
	if (mailUser && mailPass) return nodemailer.createTransport({ service: 'gmail', auth: { user: mailUser, pass: mailPass } });
	return null;
};
const sendDeletionNotice = async ({ recipients, subject, heading, message }) => {
	const addresses = [...new Set(recipients.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
	if (!addresses.length) return { sent: false, reason: 'no-recipients' };
	const transporter = deletionMailTransport();
	if (!transporter) return { sent: false, reason: 'mail-not-configured' };
	const from = process.env.MAIL_FROM || process.env.SMTP_USER || process.env.MAIL_USER;
	await transporter.sendMail({
		from,
		to: from,
		bcc: addresses,
		subject,
		text: `${heading}\n\n${message}\n\nこのメールは共通システム管理画面から自動送信されています。`,
		html: `<div style="font-family:sans-serif;line-height:1.7;color:#17202d"><h2>${escapeEmailHtml(heading)}</h2><p>${escapeEmailHtml(message)}</p><p style="color:#697586;font-size:12px">このメールは共通システム管理画面から自動送信されています。</p></div>`
	});
	return { sent: true, recipientCount: addresses.length };
};
const mailWarning = (result) => {
	if (result.sent) return null;
	if (result.reason === 'no-recipients') return '通知先のメールアドレスが登録されていないため、メールは送信されませんでした。';
	if (result.reason === 'mail-not-configured') return 'メール送信設定がないため、削除通知メールは送信されませんでした。';
	return '削除は完了しましたが、通知メールの送信に失敗しました。';
};

const toUserView = (user, groups) => {
	const userId = idString(user._id);
	const memberships = groups
		.filter((group) => idString(group.createdBy) === userId || (group.members || []).some((member) => idString(member) === userId))
		.map((group) => {
			const permission = (group.memberServicePermissions || []).find((entry) => idString(entry.member) === userId);
			const groupId = idString(group._id);
			const accountbookPermission = user.servicesByGroup?.[groupId];
			const groupServices = {};
			serviceIds.forEach((serviceId) => {
				const userService = user.services?.[serviceId];
				const permissionValue = permission?.services?.[serviceId];
				const accountbookValue = accountbookPermission?.[serviceId];
				groupServices[serviceId] = accountbookValue !== undefined
					? accountbookValue !== false
					: permissionValue !== undefined
					? permissionValue !== false
					: userService !== undefined ? userService !== false : true;
			});
			return { id: groupId, name: group.group_name || '名称未設定', owner: idString(group.createdBy) === userId, services: groupServices };
		});

	const mailPreferences = user.serviceMailPreferences || user.serviceMail || {};
	const services = Object.fromEntries(serviceIds.map((serviceId) => [serviceId, user.services?.[serviceId] !== false]));
	const mail = Object.fromEntries(serviceIds.map((serviceId) => [serviceId, typeof mailPreferences[serviceId] === 'object' ? mailPreferences[serviceId].enabled !== false : mailPreferences[serviceId] !== false]));
	const mailDetails = Object.fromEntries(serviceIds.map((serviceId) => [serviceId, Object.fromEntries((emailCatalog[serviceId] || []).map((email) => [email.id, typeof mailPreferences[serviceId] === 'object' ? mailPreferences[serviceId].emails?.[email.id] !== false : mailPreferences[serviceId] !== false]))]));
	return {
		id: userId,
		displayName: user.displayname || user.displayName || user.username || '名前未設定',
		avatar: user.avatar || '',
		lastAccessAt: user.lastAccessAt || user.last_access_at || user.lastLoginAt || null,
		username: user.username || '',
		email: user.email || '',
		birthDate: user.birth_date || user.birthDate || null,
		sex: user.sex || '',
		blood: [user.blood, user.rh].filter(Boolean).join(' ') || '',
		isAdmin: user.isAdmin === true,
		isPlanner: user.isPlanner === true,
		active: !user.unsubscribe_date && user.isActive !== false,
		groups: memberships,
		services,
		mail,
		mailDetails
	};
};

const fetchUsers = async () => {
	const [users, groups, neighborhoodRoles] = await Promise.all([
		usersCollection().find({}).sort({ lastAccessAt: -1, displayname: 1, username: 1 }).toArray(),
		groupsCollection().find({}).sort({ group_name: 1 }).toArray(),
		fetchNeighborhoodRoles(mongoose.connection.db)
	]);
	return { users: users.map((user) => toUserView(user, groups)), groups, neighborhoodRoles };
};

app.get('/api/catalog', (req, res) => res.json({ services: serviceCatalog, emails: emailCatalog }));

app.get('/api/users', async (req, res, next) => {
	try {
		const { users, groups, neighborhoodRoles } = await fetchUsers();
		res.json({ users, neighborhoodRoles, groups: groups.map((group) => ({ id: idString(group._id), name: group.group_name || '名称未設定' })) });
	} catch (error) {
		next(error);
	}
});

app.get('/api/users/:id', async (req, res, next) => {
	try {
		const user = await usersCollection().findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
		if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません。' });
		const groups = await groupsCollection().find({}).toArray();
		res.json(toUserView(user, groups));
	} catch (error) {
		next(error);
	}
});

app.put('/api/users/:id', async (req, res, next) => {
	try {
		const userId = new mongoose.Types.ObjectId(req.params.id);
		const current = await usersCollection().findOne({ _id: userId });
		if (!current) return res.status(404).json({ error: 'ユーザーが見つかりません。' });

		const update = {};
		if (typeof req.body.isAdmin === 'boolean') {
			if (current.isAdmin === true && req.body.isAdmin === false) {
				const adminCount = await usersCollection().countDocuments({ isAdmin: true, _id: { $ne: userId } });
				if (adminCount === 0) return res.status(400).json({ error: '管理者は最低1名必要です。' });
			}
			update.isAdmin = req.body.isAdmin;
		}
		if (typeof req.body.isPlanner === 'boolean') update.isPlanner = req.body.isPlanner;
		if (req.body.services && typeof req.body.services === 'object') {
			update.services = { ...(current.services || {}), ...Object.fromEntries(serviceIds.map((id) => [id, req.body.services[id] !== false])) };
		}
		if (req.body.mail && typeof req.body.mail === 'object') {
			update.serviceMailPreferences = Object.fromEntries(serviceIds.map((id) => [id, req.body.mail[id] !== false]));
		}
		if (req.body.mailDetails && typeof req.body.mailDetails === 'object') {
			const currentMail = current.serviceMailPreferences && typeof current.serviceMailPreferences === 'object' ? current.serviceMailPreferences : {};
			update.serviceMailPreferences = Object.fromEntries(serviceIds.map((serviceId) => [serviceId, {
				enabled: req.body.mail?.[serviceId] !== false,
				emails: Object.fromEntries((emailCatalog[serviceId] || []).map((email) => [email.id, req.body.mailDetails[serviceId]?.[email.id] !== false]))
			}]));
			Object.keys(currentMail).forEach((serviceId) => {
				if (!serviceIds.includes(serviceId)) update.serviceMailPreferences[serviceId] = currentMail[serviceId];
			});
		}
		await usersCollection().updateOne({ _id: userId }, { $set: update });

		if (req.body.groups && typeof req.body.groups === 'object') {
			const servicesByGroup = current.servicesByGroup && typeof current.servicesByGroup === 'object'
				? { ...current.servicesByGroup }
				: {};
			for (const [groupId, services] of Object.entries(req.body.groups)) {
				if (!mongoose.isValidObjectId(groupId) || !services || typeof services !== 'object') continue;
				const group = await groupsCollection().findOne({ _id: new mongoose.Types.ObjectId(groupId) });
				if (!group || (idString(group.createdBy) !== req.params.id && !(group.members || []).some(member => idString(member) === req.params.id))) continue;
				const normalizedServices = Object.fromEntries(accountbookServiceIds.map((id) => [id, services[id] !== false]));
				servicesByGroup[groupId] = normalizedServices;
				const entries = Array.isArray(group.memberServicePermissions) ? [...group.memberServicePermissions] : [];
				const menuServiceValues = Object.fromEntries(menuServiceIds.map((id) => [id, services[id] !== false]));
				const entryIndex = entries.findIndex((entry) => idString(entry.member) === req.params.id);
				const nextEntry = { member: userId, services: menuServiceValues };
				if (entryIndex >= 0) entries[entryIndex] = { ...entries[entryIndex], ...nextEntry };
				else entries.push(nextEntry);
				await groupsCollection().updateOne({ _id: group._id }, { $set: { memberServicePermissions: entries } });
			}
			update.servicesByGroup = servicesByGroup;
			await usersCollection().updateOne({ _id: userId }, { $set: { servicesByGroup } });
		}
		const { users } = await fetchUsers();
		res.json(users.find((user) => user.id === req.params.id));
	} catch (error) {
		next(error);
	}
});

app.delete('/api/users/:id', async (req, res, next) => {
	try {
		if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: '不正なユーザーIDです。' });
		const userId = new mongoose.Types.ObjectId(req.params.id);
		const current = await usersCollection().findOne({ _id: userId });
		if (!current) return res.status(404).json({ error: 'ユーザーが見つかりません。' });

		const confirmationName = current.username || current.displayname || current.displayName || '';
		if (!confirmationName || req.body?.confirmationName !== confirmationName) {
			return res.status(400).json({ error: '確認用のユーザー名が一致しません。' });
		}
		if (current.isAdmin === true) {
			const otherAdminCount = await usersCollection().countDocuments({ isAdmin: true, _id: { $ne: userId } });
			if (otherAdminCount === 0) return res.status(400).json({ error: '最後の管理者は削除できません。' });
		}

		const userReferences = [userId, req.params.id];
		const ownedGroup = await groupsCollection().findOne({ createdBy: { $in: userReferences } });
		if (ownedGroup) {
			return res.status(409).json({ error: `「${ownedGroup.group_name || '名称未設定'}」のオーナーです。先にグループを削除するか、オーナーを変更してください。` });
		}

		const result = await usersCollection().deleteOne({ _id: userId });
		if (!result.deletedCount) return res.status(404).json({ error: 'ユーザーが見つかりません。' });
		await groupsCollection().updateMany({}, {
			$pull: {
				members: { $in: userReferences },
				memberServicePermissions: { member: { $in: userReferences } }
			}
		});
		let email;
		try {
			email = await sendDeletionNotice({
				recipients: [current.email],
				subject: '【共通システム】ユーザーアカウント削除のお知らせ',
				heading: 'ユーザーアカウントを削除しました',
				message: `${current.displayname || current.displayName || current.username || 'ユーザー'} 様のアカウントは、管理者により削除されました。`
			});
		} catch (mailError) {
			console.error('ユーザー削除通知メールの送信に失敗しました:', mailError);
			email = { sent: false, reason: 'send-failed' };
		}
		res.json({ ok: true, id: req.params.id, email, warning: mailWarning(email) });
	} catch (error) {
		next(error);
	}
});

const toGroupView = (group, users) => {
	const owner = users.find((user) => idString(user._id) === idString(group.createdBy));
	const memberIds = [...new Set([...(group.members || []).map(idString), idString(group.createdBy)].filter(Boolean))];
	return {
		id: idString(group._id),
		name: group.group_name || '名称未設定',
		createdAt: group.createdAt || group.created_at || null,
		updatedAt: group.updatedAt || group.updated_at || null,
		owner: owner ? { id: idString(owner._id), name: owner.displayname || owner.displayName || owner.username || '名前未設定', email: owner.email || '' } : { id: idString(group.createdBy), name: '不明', email: '' },
		members: memberIds.map((memberId) => {
			const user = users.find((item) => idString(item._id) === memberId);
			const permission = (group.memberServicePermissions || []).find((entry) => idString(entry.member) === memberId);
			const accountbook = user?.servicesByGroup?.[idString(group._id)] || {};
			const isOwner = memberId === idString(group.createdBy);
			return { id: memberId, name: user?.displayname || user?.displayName || user?.username || '名前未設定', username: user?.username || '', email: user?.email || '', avatar: user?.avatar || '', owner: isOwner, services: Object.fromEntries(serviceIds.map((serviceId) => [serviceId, accountbook[serviceId] !== undefined ? accountbook[serviceId] !== false : permission?.services?.[serviceId] !== false])) };
		})
	};
};

app.get('/api/groups', async (req, res, next) => {
	try {
		const [groups, users] = await Promise.all([groupsCollection().find({}).sort({ group_name: 1 }).toArray(), usersCollection().find({}).toArray()]);
		res.json(groups.map((group) => toGroupView(group, users)));
	} catch (error) { next(error); }
});

app.get('/api/groups/:id', async (req, res, next) => {
	try {
		const group = await groupsCollection().findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
		if (!group) return res.status(404).json({ error: 'グループが見つかりません。' });
		const users = await usersCollection().find({}).toArray();
		res.json(toGroupView(group, users));
	} catch (error) { next(error); }
});

app.put('/api/groups/:id', async (req, res, next) => {
	try {
		const groupId = new mongoose.Types.ObjectId(req.params.id);
		const group = await groupsCollection().findOne({ _id: groupId });
		if (!group) return res.status(404).json({ error: 'グループが見つかりません。' });
		if (typeof req.body.name === 'string' && req.body.name.trim()) await groupsCollection().updateOne({ _id: groupId }, { $set: { group_name: req.body.name.trim(), updatedAt: new Date() } });
		if (req.body.members && typeof req.body.members === 'object') {
			const users = await usersCollection().find({}).toArray();
			const currentGroup = await groupsCollection().findOne({ _id: groupId });
			const entries = Array.isArray(currentGroup.memberServicePermissions) ? [...currentGroup.memberServicePermissions] : [];
			for (const [memberId, services] of Object.entries(req.body.members)) {
				if (!mongoose.isValidObjectId(memberId) || !services || typeof services !== 'object') continue;
                if (idString(group.createdBy) !== memberId && !(group.members || []).some(member => idString(member) === memberId)) continue;
				const userId = new mongoose.Types.ObjectId(memberId);
				const normalized = Object.fromEntries(accountbookServiceIds.map((id) => [id, services[id] !== false]));
				const user = users.find((item) => idString(item._id) === memberId);
				const servicesByGroup = user?.servicesByGroup && typeof user.servicesByGroup === 'object' ? { ...user.servicesByGroup } : {};
				servicesByGroup[req.params.id] = normalized;
				await usersCollection().updateOne({ _id: userId }, { $set: { servicesByGroup } });
				const menuServices = Object.fromEntries(menuServiceIds.map((id) => [id, services[id] !== false]));
				const index = entries.findIndex((entry) => idString(entry.member) === memberId);
				const entry = { member: userId, services: menuServices };
				if (index >= 0) entries[index] = { ...entries[index], ...entry }; else entries.push(entry);
			}
			await groupsCollection().updateOne({ _id: groupId }, { $set: { memberServicePermissions: entries, updatedAt: new Date() } });
		}
		const users = await usersCollection().find({}).toArray();
		const saved = await groupsCollection().findOne({ _id: groupId });
		res.json(toGroupView(saved, users));
	} catch (error) { next(error); }
});

app.delete('/api/groups/:id', async (req, res, next) => {
	try {
		if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: '不正なグループIDです。' });
		const groupId = new mongoose.Types.ObjectId(req.params.id);
		const group = await groupsCollection().findOne({ _id: groupId });
		if (!group) return res.status(404).json({ error: 'グループが見つかりません。' });
		const recipientIds = [...new Set([idString(group.createdBy), ...(group.members || []).map(idString)].filter(Boolean))];
		const recipients = recipientIds.length
			? await usersCollection().find({ _id: { $in: recipientIds.filter(mongoose.isValidObjectId).map((id) => new mongoose.Types.ObjectId(id)) } }).project({ email: 1 }).toArray()
			: [];
		const result = await groupsCollection().deleteOne({ _id: groupId });
		if (!result.deletedCount) return res.status(404).json({ error: 'グループが見つかりません。' });
		await usersCollection().updateMany({}, { $pull: { groups: groupId }, $unset: { [`servicesByGroup.${req.params.id}`]: '' } });
		await usersCollection().updateMany({ defaultGroup: groupId }, { $unset: { defaultGroup: '' } });
		let email;
		try {
			email = await sendDeletionNotice({
				recipients: recipients.map((user) => user.email),
				subject: `【共通システム】グループ「${group.group_name || '名称未設定'}」削除のお知らせ`,
				heading: 'グループを削除しました',
				message: `所属していたグループ「${group.group_name || '名称未設定'}」は、管理者により削除されました。`
			});
		} catch (mailError) {
			console.error('グループ削除通知メールの送信に失敗しました:', mailError);
			email = { sent: false, reason: 'send-failed' };
		}
		res.json({ ok: true, email, warning: mailWarning(email) });
	} catch (error) { next(error); }
});

const backupName = () => `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
const readBackupLog = async () => {
	try { return JSON.parse(await fs.readFile(backupLogPath, 'utf8')); }
	catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const writeBackupLog = async (entry) => {
	await fs.mkdir(backupDir, { recursive: true });
	const log = await readBackupLog();
	log.push(entry);
	await fs.writeFile(backupLogPath, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
};
const listBackups = async () => {
	const log = await readBackupLog();
	return log.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

let dataOperationRunning = false;
const withDataOperation = async (operation) => {
  if (dataOperationRunning) throw Object.assign(new Error('バックアップまたは復元が実行中です。'), { status: 409 });
  dataOperationRunning = true;
  try { return await operation(); } finally { dataOperationRunning = false; }
};
const createBackup = async (trigger = 'manual') => withDataOperation(async () => {
	await fs.mkdir(backupDir, { recursive: true });
	const filename = backupName();
	const target = path.join(backupDir, filename);
	const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
	const archive = archiver('zip', { zlib: { level: 9 } });
	const output = (await import('node:fs')).createWriteStream(target);
	const completion = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
	archive.pipe(output);
	archive.append(EJSON.stringify({ createdAt: new Date(), database: mongoose.connection.name, format: 'mongo-ejson-v1' }, null, 2, { relaxed: false }), { name: 'BACKUP_META.json' });
	for (const { name } of collections) {
		if (name.startsWith('system.')) continue;
		const documents = await mongoose.connection.db.collection(name).find({}).toArray();
		archive.append(EJSON.stringify(documents, null, 2, { relaxed: false }), { name: `${name}.json` });
	}
	await archive.finalize();
	await completion;
	const createdAt = new Date().toISOString();
	await writeBackupLog({ filename, createdAt, trigger, status: 'success' });
	const previousFiles = (await fs.readdir(backupDir)).filter((name) => /^backup-.*\.zip$/.test(name) && name !== filename);
	await Promise.all(previousFiles.map((name) => fs.unlink(path.join(backupDir, name))));
	return { filename, createdAt, trigger, status: 'success' };
});

const sessionCollectionNames = ['sessions', 'chounaikai_sessions'];
const restoreBackup = async (filePath, { includeSessions = false } = {}) => withDataOperation(async () => {
	const directory = await unzipper.Open.file(filePath);
	const entries = directory.files.filter((entry) => entry.path.endsWith('.json') && entry.path !== 'BACKUP_META.json');
	if (!entries.length) throw new Error('復元可能なコレクションがありません。');
	const documentsByCollection = [];
	for (const entry of entries) {
		const collection = path.basename(entry.path, '.json');
        if (entry.path !== `${collection}.json` || !collection || collection.startsWith('system.') || collection.includes('$') || collection.includes('\0')) throw new Error('不正なコレクション名です。');
        if (documentsByCollection.some(item => item.collection === collection)) throw new Error('重複するコレクションです。');
		const documents = EJSON.parse((await entry.buffer()).toString('utf8'), { relaxed: false });
		if (!Array.isArray(documents)) throw new Error(`${collection}.json は配列ではありません。`);
		documentsByCollection.push({ collection, documents });
	}
	const restoreCollections = documentsByCollection.filter(({ collection }) => includeSessions || !sessionCollectionNames.includes(collection));
	if (!includeSessions) {
		// Invalidate destination logins even when the ZIP contains no sessions.
		// Do this before replacing user data so failed restores cannot leave stale logins.
		for (const collection of sessionCollectionNames) {
			await mongoose.connection.db.collection(collection).deleteMany({});
		}
	}
	for (const { collection, documents } of restoreCollections) {
		const target = mongoose.connection.db.collection(collection);
		await target.deleteMany({});
		if (documents.length) await target.insertMany(documents, { ordered: false });
	}
	return restoreCollections.map(({ collection, documents }) => ({ collection, count: documents.length }));
});

app.get('/api/backups', async (req, res, next) => {
	try {
		const backups = await listBackups();
		res.json(backups.map((entry) => ({ ...entry, downloadable: entry.status === 'success' && entry === backups.find(item => item.status === 'success') })));
	} catch (error) { next(error); }
});
// Return immediately so proxy request timeouts do not interrupt the browser.
let manualBackupJob = null;
app.post('/api/backups', (req, res) => {
  if (dataOperationRunning || manualBackupJob?.status === 'running') {
    return res.status(409).json({ error: 'バックアップまたは復元が実行中です。' });
  }
  const job = { id: randomUUID(), status: 'running' };
  manualBackupJob = job;
  res.status(202).json(job);
  void (async () => {
    try {
      job.result = await createBackup('manual');
      job.status = 'success';
    } catch (error) {
      console.error('手動バックアップ失敗:', error);
      job.error = 'バックアップに失敗しました。サーバーログと保存先の空き容量・権限を確認してください。';
      job.status = 'failed';
      try { await writeBackupLog({ createdAt: new Date().toISOString(), trigger: 'manual', status: 'failed', error: error.message }); }
      catch (logError) { console.error('バックアップログ保存失敗:', logError); }
    }
  })();
});
app.get('/api/backups/jobs/:id', (req, res) => {
  if (!manualBackupJob || manualBackupJob.id !== req.params.id) {
    return res.status(404).json({ error: '実行状況が見つかりません。サーバー再起動の可能性があります。履歴を確認してください。' });
  }
  res.set('Cache-Control', 'no-store').json(manualBackupJob);
});
app.get('/api/backups/:filename/download', async (req, res, next) => {
	try {
		const filename = path.basename(req.params.filename);
		if (!/^backup-.*\.zip$/.test(filename)) return res.status(400).json({ error: '不正なバックアップ名です。' });
		const latest = (await listBackups()).find((entry) => entry.status === 'success');
		if (!latest || latest.filename !== filename) return res.status(403).json({ error: 'ダウンロードできるのは最新バックアップのみです。' });
		const filePath = path.join(backupDir, filename);
		await fs.access(filePath);
		res.download(filePath, filename);
	} catch (error) { next(error); }
});
app.post('/api/backups/restore', upload.single('backup'), async (req, res, next) => {
	try {
		if (!req.file || String(req.body.confirm || '') !== 'RESTORE') return res.status(400).json({ error: 'ファイルと RESTORE の確認入力が必要です。' });
		const result = await restoreBackup(req.file.path, { includeSessions: req.body.includeSessions === 'true' });
		if (req.body.includeSessions !== 'true' && req.session) {
      await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    }
    res.json({ ok: true, collections: result });
	} catch (error) { next(error); }
	finally { if (req.file?.path) await fs.rm(req.file.path, { force: true }); }
});

export function startCommonAdminBackupScheduler() {
return cron.schedule('0 0 * * *', async () => {
	try { const result = await createBackup('automatic'); console.log(`自動バックアップ成功: ${result.filename}`); }
	catch (error) { console.error('自動バックアップ失敗:', error); try { await writeBackupLog({ createdAt: new Date().toISOString(), trigger: 'automatic', status: 'failed', error: error.message }); } catch (logError) { console.error('バックアップログ保存失敗:', logError); } }
}, { timezone: process.env.BACKUP_TIMEZONE || 'Asia/Tokyo' });

}

app.get('*', (req, res) => {
	if (req.path === '/') return res.render('admin/common-top', {
    serviceCount: serviceCatalog.length,
    seo: { title: '共通システム管理' }
  });
  const screens = {
    '/users': { title: 'ユーザー管理', description: 'ユーザーの利用サービスやメールサービスの管理を行います', html: page },
    '/groups': { title: 'グループ管理', description: 'グループ、参加メンバー、利用サービスを管理します', html: groupsPageWithMailNotice },
    '/data': { title: 'データ管理', description: 'データのバックアップ、ダウンロード、復元を管理します', html: dataPageWithRestoreOptions }
  };
  const screen = screens[req.path];
  if (!screen) return res.sendStatus(404);
  // Keep the existing interactive controls, inside the same EJS layout as admin-top.
  const styles = [...screen.html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(([, css]) => css.replace(/:root|\bbody(?=\s*\{)/g, ':scope')).join('\n');
  const content = screen.html.match(/<body>([\s\S]*?)<\/body>/)[1]
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<header class="(?:topbar|head)">[\s\S]*?<\/header>/, '')
    .replace(/<nav class="nav">[\s\S]*?<\/nav>/, '');
  res.render('admin/common-page', {
    title: screen.title, description: screen.description, activePage: req.path,
    content, styles, seo: { title: `共通システム管理 | ${screen.title}` }
  });
});

app.use((error, req, res, next) => {
	console.error(error);
	res.status(error.status || (error instanceof multer.MulterError ? 400 : 500)).json({ error: error.status === 409 ? error.message : 'データベースに接続できないか、処理に失敗しました。' });
});

const groupsPage = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>共通システム管理 | グループ管理</title><style>:root{--ink:#17202d;--muted:#697586;--line:#e1e5ea;--paper:#f8f9fb;--panel:#fff;--accent:#087f73;--danger:#d94b4b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;font-size:13px}.shell{max-width:1280px;margin:auto;padding:28px 38px 60px}.eyebrow{font-size:11px;letter-spacing:.12em;color:#788391;font-weight:800}.head{display:flex;justify-content:space-between;align-items:end;margin-bottom:22px}.head h1{font-size:30px;margin:5px 0}.sub{display:block;color:var(--muted);font-size:11px;margin-top:4px}.nav{display:flex;gap:8px;margin-bottom:20px}.nav a{padding:8px 12px;color:#53616c;text-decoration:none;border-radius:4px}.nav a.active,.nav a:hover{background:#eef1f4}.panel{background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 5px 14px #18243410}.toolbar{padding:16px;display:flex;justify-content:space-between;border-bottom:1px solid var(--line)}.count{color:var(--muted)}.table{width:100%;border-collapse:collapse}.table th{text-align:left;color:#84909d;font-size:11px;padding:12px 16px;border-bottom:1px solid var(--line)}.table td{padding:15px 16px;border-bottom:1px solid #edf0f3}.table tr{cursor:pointer}.table tr:hover{background:#f7fafb}.group-name{font-weight:750}.button{border:0;border-radius:5px;padding:9px 13px;background:var(--ink);color:#fff;cursor:pointer}.button.danger{background:var(--danger)}.button.light{background:#eef1f4;color:var(--ink)}.detail{display:none;margin-top:20px;padding:22px}.detail.open{display:block}.detail-head{display:flex;justify-content:space-between;align-items:start;border-bottom:1px solid var(--line);padding-bottom:16px}.detail h2{font-size:24px;margin:5px 0}.members{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}.member{border:1px solid var(--line);border-radius:7px;padding:14px}.member-top{display:flex;justify-content:space-between;margin-bottom:12px}.member-name{font-weight:750;cursor:pointer;color:#1755bf}.member-name:hover{text-decoration:underline}.member-email{display:block;color:var(--muted);font-size:11px;margin-top:3px}.owner-tag{font-size:11px;color:#087f73}.services{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.service{display:flex;align-items:center;justify-content:space-between;gap:7px;border:1px solid #e1e7ee;border-radius:6px;padding:8px 9px;font-size:11px}.toggle{appearance:none;width:32px;height:18px;border-radius:18px;background:#d9dfdb;position:relative;cursor:pointer}.toggle:after{content:"";position:absolute;width:12px;height:12px;left:3px;top:3px;border-radius:50%;background:#fff;transition:.15s}.toggle:checked{background:var(--accent)}.toggle:checked:after{transform:translateX(14px)}.detail-actions{display:flex;justify-content:space-between;margin-top:20px}.empty{padding:45px;text-align:center;color:var(--muted)}.modal{display:none;position:fixed;z-index:5;inset:0;background:#17232266;align-items:center;justify-content:center;padding:16px}.modal.open{display:flex}.modal-box{width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:8px;padding:22px}.profile{display:flex;gap:12px;align-items:center}.avatar{width:58px;height:58px;border-radius:50%;object-fit:cover;background:#f1f3f4}.facts{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:20px 0}.fact label{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}.modal-section{border-top:1px solid var(--line);padding-top:14px;margin-top:16px}.modal-section h3{font-size:12px;margin:0 0 8px}.modal-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #edf0f3}@media(max-width:720px){.shell{padding:22px 16px}.members{grid-template-columns:1fr}.panel{overflow:auto}.table{min-width:680px}.services{grid-template-columns:1fr}}</style></head><body><main class="shell"><header class="head"><div><div class="eyebrow">共通システム / 管理画面</div><h1>グループ管理</h1><div class="sub">グループ、参加メンバー、利用サービスを管理します</div></div></header><nav class="nav"><a href="/admin/common/">ダッシュボード</a><a href="/admin/common/users">ユーザー管理</a><a class="active" href="/admin/common/groups">グループ管理</a><a href="/admin/common/data">データ管理</a></nav><section class="panel"><div class="toolbar"><strong>グループ一覧</strong><span id="count" class="count">読み込み中</span></div><div style="overflow:auto"><table class="table"><thead><tr><th>グループ名</th><th>メンバー数</th><th>グループオーナー</th><th>作成日</th><th>最新更新日</th><th></th></tr></thead><tbody id="groups"></tbody></table></div></section><section id="detail" class="panel detail"></section></main><div id="userModal" class="modal"><div id="userModalBox" class="modal-box"></div></div><script>const state={groups:[],selected:null};const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const date=v=>v?new Date(v).toLocaleDateString('ja-JP'):'未登録';const services=[{id:'allaboutme',label:'All About me',icon:'♙'},{id:'finance',label:'家計簿 / Dashboard',icon:'▣'},{id:'assets',label:'資産管理',icon:'◇'},{id:'message',label:'Message',icon:'✉'},{id:'plan',label:'7 DAYS PLAN',icon:'▣'},{id:'stock',label:'ストック管理',icon:'◇'},{id:'packing',label:'パッキングプラン',icon:'▤'},{id:'board',label:'掲示板',icon:'▱'}];async function load(){state.groups=await fetch('/admin/common/api/groups').then(r=>r.json());renderGroups()}function renderGroups(){$('#count').textContent=state.groups.length+' グループ';$('#groups').innerHTML=state.groups.map(g=>'<tr data-id="'+g.id+'"><td><span class="group-name">'+esc(g.name)+'</span></td><td>'+g.members.length+' 名</td><td>'+esc(g.owner.name)+'<span class="sub">'+esc(g.owner.email)+'</span></td><td>'+date(g.createdAt)+'</td><td>'+date(g.updatedAt)+'</td><td><button class="button light" data-open="'+g.id+'">詳細</button></td></tr>').join('')||'<tr><td colspan="6" class="empty">グループがありません</td></tr>';document.querySelectorAll('[data-open]').forEach(b=>b.onclick=e=>{e.stopPropagation();openGroup(b.dataset.open)});document.querySelectorAll('#groups tr[data-id]').forEach(r=>r.onclick=()=>openGroup(r.dataset.id))}function openGroup(id){const g=state.groups.find(x=>x.id===id);if(!g)return;state.selected=g;$('#detail').classList.add('open');$('#detail').innerHTML='<div class="detail-head"><div><div class="eyebrow">グループ詳細</div><h2>'+esc(g.name)+'</h2><span class="sub">オーナー: '+esc(g.owner.name)+' / '+esc(g.owner.email)+'</span></div><button class="button light" id="closeDetail">閉じる</button></div><div class="members">'+g.members.map(m=>'<article class="member"><div class="member-top"><div><span class="member-name" data-user="'+m.id+'">'+esc(m.name)+'</span><span class="member-email">'+esc(m.email)+'</span></div>'+(m.owner?'<span class="owner-tag">オーナー</span>':'')+'</div><div class="services">'+services.map(s=>'<label class="service"><span>'+s.icon+' '+s.label+'</span><input class="toggle" type="checkbox" data-member="'+m.id+'" data-service="'+s.id+'" '+(m.services[s.id]?'checked':'')+'></label>').join('')+'</div></article>').join('')+'</div><div class="detail-actions"><button class="button danger" id="deleteGroup">グループを削除</button><button class="button" id="saveGroup">変更を保存</button></div>';$('#closeDetail').onclick=()=>$('#detail').classList.remove('open');$('#saveGroup').onclick=saveGroup;$('#deleteGroup').onclick=deleteGroup;document.querySelectorAll('[data-user]').forEach(e=>e.onclick=()=>openUser(e.dataset.user))}async function saveGroup(){const g=state.selected,members={};document.querySelectorAll('[data-member]').forEach(i=>{members[i.dataset.member]??={};members[i.dataset.member][i.dataset.service]=i.checked});const r=await fetch('/admin/common/api/groups/'+g.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({members})});if(!r.ok)return alert('保存に失敗しました');const saved=await r.json();state.groups=state.groups.map(x=>x.id===saved.id?saved:x);renderGroups();$('#detail').classList.remove('open');alert('変更を保存しました')}async function deleteGroup(){const g=state.selected;if(!confirm('このグループを削除しますか？'))return;const r=await fetch('/admin/common/api/groups/'+g.id,{method:'DELETE'});if(!r.ok)return alert('削除に失敗しました');state.groups=state.groups.filter(x=>x.id!==g.id);renderGroups();$('#detail').classList.remove('open')}async function openUser(id){const m=state.selected.members.find(x=>x.id===id);if(!m)return;$('#userModalBox').innerHTML='<div class="detail-head"><div class="profile">'+(m.avatar?'<img class="avatar" src="'+esc(m.avatar)+'" alt="プロフィール画像">':'')+'<div><div class="eyebrow">プロフィール詳細</div><h2>'+esc(m.name)+'</h2><span class="sub">'+esc(m.email)+'</span></div></div><button class="button light" id="closeUser">閉じる</button></div><div class="facts"><div class="fact"><label>ユーザー名</label><div>'+esc(m.username)+'</div></div><div class="fact"><label>所属グループ</label><div>'+esc(state.selected.name)+'</div></div></div><div class="modal-section"><h3>グループ別利用サービス</h3>'+services.map(s=>'<div class="modal-row"><span>'+s.icon+' '+s.label+'</span><span>'+(m.services[s.id]?'有効':'無効')+'</span></div>').join('')+'</div>';$('#userModal').classList.add('open');$('#closeUser').onclick=()=>$('#userModal').classList.remove('open')}$('#userModal').onclick=e=>{if(e.target.id==='userModal')$('#userModal').classList.remove('open')};load();</script></body></html>`;

const groupsPageWithEdit = groupsPage.replace("<h2>'+esc(g.name)+'</h2>","<h2><input id=\"groupName\" value=\"'+esc(g.name)+'\" style=\"font:inherit;font-size:24px;font-weight:750;border:1px solid #e1e5ea;border-radius:5px;padding:5px 8px;max-width:100%\"></h2>").replace('JSON.stringify({members})','JSON.stringify({name:document.querySelector(\'#groupName\')?.value,members})').replace('.detail{display:none;margin-top:20px;padding:22px}.detail.open{display:block}', '.detail{display:none;position:fixed;z-index:5;inset:20px auto 20px 50%;transform:translateX(-50%);width:min(900px,calc(100% - 32px));max-height:calc(100vh - 40px);overflow:auto;margin:0;padding:22px;box-shadow:0 0 0 100vmax #17232266,0 20px 60px #17232233}.detail.open{display:block}@media(max-width:720px){.detail{inset:12px auto 12px 50%;max-height:calc(100vh - 24px)}}');
const groupsPageWithMailNotice = groupsPageWithEdit.replace("if(!r.ok)return alert('削除に失敗しました');state.groups", "const result=await r.json();if(!r.ok)return alert(result.error||'削除に失敗しました');alert(result.warning||'グループを削除し、通知メールを送信しました');state.groups");

const dataPage = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>共通システム管理 | データ管理</title><style>:root{--ink:#17202d;--muted:#697586;--line:#e1e5ea;--paper:#f8f9fb;--panel:#fff;--accent:#087f73;--danger:#d94b4b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;font-size:13px}.shell{max-width:1000px;margin:auto;padding:28px 38px 60px}.eyebrow{font-size:11px;letter-spacing:.12em;color:#788391;font-weight:800}.head h1{font-size:30px;margin:5px 0}.sub{color:var(--muted);font-size:12px}.nav{display:flex;gap:8px;margin:22px 0}.nav a{padding:8px 12px;color:#53616c;text-decoration:none;border-radius:4px}.nav a.active,.nav a:hover{background:#eef1f4}.panel{background:#fff;border:1px solid var(--line);border-radius:8px;padding:20px;margin-top:16px;box-shadow:0 5px 14px #18243410}.panel h2{font-size:16px;margin:0 0 8px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.button{border:0;border-radius:5px;padding:10px 14px;background:var(--ink);color:#fff;cursor:pointer}.button.light{background:#eef1f4;color:var(--ink)}.button.danger{background:var(--danger)}.backup-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid #edf0f3}.backup-name{font-weight:700}.meta{display:block;color:var(--muted);font-size:11px;margin-top:3px}.restore-box{border:1px solid #f0d6d6;background:#fffafa;padding:14px;border-radius:6px}.restore-box input[type=file]{margin:12px 0}.confirm{width:100%;max-width:300px;padding:9px;border:1px solid #d8dfe6;border-radius:5px}.notice{margin-top:12px;color:var(--muted);font-size:12px}.empty{padding:18px;color:var(--muted)}@media(max-width:600px){.shell{padding:22px 16px}.backup-row{align-items:flex-start;flex-direction:column}.actions .button{width:100%}}</style></head><body><main class="shell"><header class="head"><div class="eyebrow">共通システム / 管理画面</div><h1>データ管理</h1><div class="sub">データのバックアップ、ダウンロード、復元を管理します</div></header><nav class="nav"><a href="/admin/common/">ダッシュボード</a><a href="/admin/common/users">ユーザー管理</a><a href="/admin/common/groups">グループ管理</a><a class="active" href="/admin/common/data">データ管理</a></nav><section class="panel"><h2>バックアップ</h2><p class="sub">MongoDB の全コレクションを ZIP 形式で保存します。自動バックアップは毎日0:00（東京時間）に実行されます。</p><div class="actions"><button class="button" id="create">今すぐバックアップを作成</button></div><div id="status" class="notice"></div></section><section class="panel"><h2>バックアップデータ</h2><div id="backups"><div class="empty">読み込み中...</div></div></section><section class="panel restore-box"><h2>バックアップから復元</h2><p class="sub">復元すると、ZIP 内に含まれるコレクションの現在データを置き換えます。実行前に必ず現在のバックアップを作成してください。</p><input id="file" type="file" accept=".zip,application/zip"><br><input id="confirm" class="confirm" placeholder="確認のため RESTORE と入力"><div class="actions"><button class="button danger" id="restore">復元を実行</button></div><div id="restoreStatus" class="notice"></div></section></main><script>const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function requestJson(url,options){let response;try{response=await fetch(url,options)}catch{throw new Error('サーバーに接続できません。接続とバックアップ履歴を確認してください。')}if(response.redirected)throw new Error('ログイン状態を確認して画面を再読み込みしてください。');if(!(response.headers.get('content-type')||'').includes('application/json'))throw new Error('サーバーから正常な応答がありません（HTTP '+response.status+'）。バックアップ履歴とサーバーログを確認してください。');const result=await response.json();if(!response.ok)throw new Error(result.error||'処理に失敗しました（HTTP '+response.status+'）。');return result}async function waitForBackup(job){while(job.status==='running'){await new Promise(resolve=>setTimeout(resolve,1500));job=await requestJson('/admin/common/api/backups/jobs/'+encodeURIComponent(job.id))}if(job.status==='failed')throw new Error(job.error);return job.result}async function load(){const files=await requestJson('/admin/common/api/backups');$('#backups').innerHTML=files.length?files.map(file=>'<div class="backup-row"><div><span class="backup-name">'+esc(file.filename)+'</span><span class="meta">サーバー保存済み</span></div><a class="button light" href="/admin/common/api/backups/'+encodeURIComponent(file.filename)+'/download">ダウンロード</a></div>').join(''):'<div class="empty">バックアップはありません</div>'}$('#create').onclick=async()=>{const button=$('#create');button.disabled=true;$('#status').textContent='バックアップを作成しています...';try{const job=await requestJson('/admin/common/api/backups',{method:'POST'});const result=await waitForBackup(job);$('#status').textContent='作成しました: '+result.filename;await load()}catch(error){$('#status').textContent=error.message}finally{button.disabled=false}};$('#restore').onclick=async()=>{const file=$('#file').files[0];if(!file)return $('#restoreStatus').textContent='ZIPファイルを選択してください';if($('#confirm').value!=='RESTORE')return $('#restoreStatus').textContent='確認欄に RESTORE と入力してください';const form=new FormData();form.append('backup',file);form.append('confirm',$('#confirm').value);$('#restoreStatus').textContent='復元しています...';try{const result=await requestJson('/admin/common/api/backups/restore',{method:'POST',body:form});$('#restoreStatus').textContent='復元しました: '+result.collections.map(item=>item.collection+'('+item.count+'件)').join(', ')}catch(error){$('#restoreStatus').textContent=error.message}};load().catch(error=>{$('#backups').textContent=error.message});</script></body></html>`;

const dataPageWithLog = dataPage
	.replace('files.map(file=>', 'files.map((file,index)=>')
	.replace('<span class="meta">サーバー保存済み</span>', '<span class="meta">\'+(file.status===\'success\'?\'成功\':\'失敗\')+\' / \'+(file.trigger===\'automatic\'?\'自動\':\'手動\')+\'</span>')
	.replace('<a class="button light" href="/admin/common/api/backups/\'+encodeURIComponent(file.filename)+\'/download">ダウンロード</a>', '\'+(file.downloadable?\'<a class="button light" href="/admin/common/api/backups/\'+encodeURIComponent(file.filename)+\'/download">最新をダウンロード</a>\':\'\')+\'');

const dataPageWithRestoreOptions = dataPageWithLog
	.replace('<input id="confirm" class="confirm" placeholder="確認のため RESTORE と入力">', '<input id="confirm" class="confirm" placeholder="確認のため RESTORE と入力"><label style="display:block;margin-top:12px"><input id="includeSessions" type="checkbox"> セッションも復元する（通常はオフ推奨）</label><p class="notice">オフの場合、共通システムと町内会システムのセッションは復元せず、復元先の既存セッションも削除します。復元後はログインし直してください。復元中は対象アプリを停止してください。</p>')
	.replace("form.append('confirm',$('#confirm').value)", "form.append('confirm',$('#confirm').value);form.append('includeSessions',$('#includeSessions').checked?'true':'false')");

const page = `<!doctype html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>共通システム管理 | ユーザー管理</title>
<style>
:root{--ink:#172322;--muted:#687572;--line:#d9e1dc;--paper:#f5f7f2;--panel:#fff;--teal:#087f73;--coral:#e76f51;--shadow:0 18px 50px #24423b12}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 100% 0,#dff2eb 0,transparent 34%),var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif}button,input{font:inherit}.shell{max-width:1440px;margin:auto;padding:28px 34px 64px}.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:30px}.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);font-weight:800}.brand{font-family:Georgia,serif;font-size:clamp(30px,4vw,48px);letter-spacing:-.03em;margin:6px 0 0}.status{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:#39a77b}.layout{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:22px}.panel{background:var(--panel);border:1px solid #e6ebe5;border-radius:8px;box-shadow:var(--shadow)}.toolbar{padding:18px;display:flex;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--line)}.search{flex:1;min-width:220px;border:1px solid var(--line);border-radius:5px;padding:12px 14px;color:var(--ink);outline:none}.search:focus{border-color:var(--teal);box-shadow:0 0 0 3px #087f7316}.select{border:1px solid var(--line);border-radius:5px;padding:11px 12px;background:#fff;color:var(--ink)}.summary{padding:16px 18px;font-size:13px;color:var(--muted);display:flex;justify-content:space-between}.table-wrap{overflow:auto}.user-table{width:100%;border-collapse:collapse;min-width:880px}.user-table th{text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#84918c;font-weight:700;padding:12px 18px;border-bottom:1px solid var(--line);white-space:nowrap}.user-table td{padding:15px 18px;border-bottom:1px solid #edf0ed;vertical-align:middle;font-size:13px}.user-table tr{cursor:pointer;transition:background .18s}.user-table tbody tr:hover{background:#f5faf7}.user-table tr.inactive{color:#9aa49f;background:#f6f7f5}.name{font-weight:750;color:var(--ink)}.inactive .name{color:#89938e}.sub{display:block;color:var(--muted);font-size:12px;margin-top:3px}.badge{display:inline-flex;align-items:center;padding:5px 8px;border-radius:4px;background:#eef5f1;color:var(--teal);font-size:11px;margin:2px 3px 2px 0}.role{font-size:16px;margin-right:7px}.role.on{color:var(--teal)}.role.off{color:#bdc6c1}.service-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 3px 0 0}.service-dot.on{background:var(--teal)}.service-dot.off{background:#d9dfdb}.detail{padding:22px;position:sticky;top:20px;align-self:start}.empty{padding:50px 12px;text-align:center;color:var(--muted)}.detail-head{display:flex;justify-content:space-between;gap:10px;align-items:start;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:20px}.detail h2{font-family:Georgia,serif;font-size:28px;margin:4px 0}.close{border:0;background:#eef4ef;border-radius:50%;width:32px;height:32px;color:var(--muted);cursor:pointer}.section{margin-top:22px}.section-title{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:800;margin-bottom:10px}.facts{display:grid;grid-template-columns:1fr 1fr;gap:12px}.fact{min-width:0}.fact label{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}.fact div{font-size:13px;overflow-wrap:anywhere}.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #eef1ee;font-size:13px}.toggle{appearance:none;width:38px;height:22px;border-radius:20px;background:#d9dfdb;position:relative;cursor:pointer;transition:.2s}.toggle:after{content:"";position:absolute;width:16px;height:16px;border-radius:50%;left:3px;top:3px;background:white;box-shadow:0 1px 3px #0002;transition:.2s}.toggle:checked{background:var(--teal)}.toggle:checked:after{transform:translateX(16px)}.group-block{border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:10px}.group-name{font-weight:750;font-size:13px;margin-bottom:7px}.owner{color:var(--coral);font-size:11px;margin-left:6px}.save{width:100%;border:0;border-radius:5px;background:var(--ink);color:#fff;padding:13px;margin-top:22px;cursor:pointer;font-weight:700}.save:disabled{opacity:.5}.toast{position:fixed;right:22px;bottom:22px;background:var(--ink);color:#fff;padding:13px 16px;border-radius:5px;box-shadow:var(--shadow);opacity:0;transform:translateY(10px);transition:.2s}.toast.show{opacity:1;transform:none}@media(max-width:1050px){.layout{grid-template-columns:1fr}.detail{position:fixed;z-index:3;inset:0 0 0 auto;width:min(430px,100%);overflow:auto;border-radius:0;transform:translateX(102%);transition:.25s}.detail.open{transform:none}.shell{padding:22px 16px 50px}}@media(max-width:600px){.topbar{display:block}.status{margin-top:12px}.toolbar{padding:12px}.summary{padding:12px}.detail{padding:20px}.facts{grid-template-columns:1fr}}
</style></head><body><main class="shell"><header class="topbar"><div><div class="eyebrow">Shared systems / administration</div><h1 class="brand">Common Admin</h1></div><div class="status"><span class="dot"></span><span id="connection">MongoDB に接続中</span></div></header><div class="layout"><section class="panel"><div class="toolbar"><input id="search" class="search" placeholder="グループ名、ユーザー名、メールで検索"><select id="role" class="select"><option value="">すべての権限</option><option value="admin">管理者</option><option value="planner">Planner</option></select><select id="service" class="select"><option value="">すべてのサービス</option></select></div><div class="summary"><span id="count">読み込み中</span><span>クリックで詳細</span></div><div class="table-wrap"><table class="user-table"><thead><tr><th>ユーザー</th><th>所属グループ</th><th>権限</th><th>利用サービス</th><th>状態</th></tr></thead><tbody id="users"></tbody></table></div></section><aside id="detail" class="panel detail"><div class="empty">ユーザーを選択してください</div></aside></div></main><div id="toast" class="toast"></div>
<script>
const state={users:[],catalog:[],selected:null};
const $=(selector)=>document.querySelector(selector);
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatDate=(value)=>value?new Date(value).toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'}):'未登録';
async function load(){try{const [users,catalog]=await Promise.all([fetch('/admin/common/api/users').then((r)=>r.json()),fetch('/admin/common/api/catalog').then((r)=>r.json())]);state.users=users.users;state.neighborhoodRoles=users.neighborhoodRoles||{};state.catalog=catalog.services;state.emails=catalog.emails;$('#service').insertAdjacentHTML('beforeend',state.catalog.map((s)=>'<option value="'+s.id+'">'+s.label+'</option>').join(''));render();}catch(error){$('#users').innerHTML='<tr><td colspan="5" class="empty">データを読み込めませんでした</td></tr>';}}
function filtered(){const query=$('#search').value.trim().toLowerCase(),role=$('#role').value,service=$('#service').value;return state.users.filter((user)=>{const hay=[user.displayName,user.username,user.email,...user.groups.map((g)=>g.name)].join(' ').toLowerCase();return(!query||hay.includes(query))&&(!role||(role==='admin'?user.isAdmin:user.isPlanner))&&(!service||user.services[service]);});}
function render(){const users=filtered();$('#count').textContent=users.length+' 名 / 全 '+state.users.length+' 名';$('#users').innerHTML=users.map((user)=>'<tr class="'+(user.active?'':'inactive')+'" data-id="'+user.id+'"><td><span class="name">'+escapeHtml(user.displayName)+'</span><span class="sub">'+escapeHtml(user.username)+' ・ '+escapeHtml(user.email)+'</span></td><td>'+user.groups.map((g)=>'<span class="badge">'+escapeHtml(g.name)+'</span>').join('')+'</td><td><span class="role '+(user.isAdmin?'on':'off')+'" title="管理者">♟</span><span class="role '+(user.isPlanner?'on':'off')+'" title="Planner">◈</span></td><td>'+state.catalog.map((s)=>'<span class="service-dot '+(user.services[s.id]?'on':'off')+'" title="'+s.label+'"></span>').join('')+'</td><td>'+(user.active?'有効':'無効')+'</td></tr>').join('')||'<tr><td colspan="5" class="empty">条件に一致するユーザーはいません</td></tr>';document.querySelectorAll('#users tr[data-id]').forEach((row)=>row.addEventListener('click',()=>openDetail(row.dataset.id)));}
function toggle(label,checked,attrs){return '<div class="toggle-row"><span>'+label+'</span><input class="toggle" type="checkbox" '+(checked?'checked':'')+' '+attrs+'></div>';}
function openDetail(id){const user=state.users.find((item)=>item.id===id);if(!user)return;state.selected=user;$('#detail').classList.add('open');$('#detail').innerHTML='<div class="detail-head"><div><div class="eyebrow">User profile</div><h2>'+escapeHtml(user.displayName)+'</h2><span class="sub">'+escapeHtml(user.email)+'</span></div><button class="close" aria-label="閉じる">×</button></div><div class="facts"><div class="fact"><label>ユーザー名</label><div>'+escapeHtml(user.username)+'</div></div><div class="fact"><label>誕生日</label><div>'+formatDate(user.birthDate)+'</div></div><div class="fact"><label>性別</label><div>'+escapeHtml(user.sex||'未登録')+'</div></div><div class="fact"><label>血液型</label><div>'+escapeHtml(user.blood||'未登録')+'</div></div></div><div class="section"><div class="section-title">権限と状態</div>'+toggle('有効',user.active,'data-user-toggle="active" disabled')+toggle('管理者',user.isAdmin,'data-user-toggle="isAdmin"')+toggle('Planner',user.isPlanner,'data-user-toggle="isPlanner"')+'</div><div class="section"><div class="section-title">グループ別サービス</div>'+user.groups.map((group)=>'<div class="group-block"><div class="group-name">'+escapeHtml(group.name)+(group.owner?'<span class="owner">オーナー</span>':'')+'</div>'+state.catalog.map((service)=>toggle(service.label,group.services[service.id],'data-group="'+group.id+'" data-service="'+service.id+'"')).join('')+'</div>').join('')+'</div><div class="section"><div class="section-title">サービスメール</div>'+state.catalog.map((service)=>toggle(service.label,user.mail[service.id],'data-mail="'+service.id+'"')).join('')+'</div><button class="save">変更を保存</button>';$('#detail .close').addEventListener('click',()=>$('#detail').classList.remove('open'));$('#detail .save').addEventListener('click',saveDetail);}
async function saveDetail(){const button=$('#detail .save'),user=state.selected;button.disabled=true;const groups={};document.querySelectorAll('[data-group]').forEach((input)=>{groups[input.dataset.group]??={};groups[input.dataset.group][input.dataset.service]=input.checked;});const body={isAdmin:document.querySelector('[data-user-toggle="isAdmin"]').checked,isPlanner:document.querySelector('[data-user-toggle="isPlanner"]').checked,mail:Object.fromEntries([...document.querySelectorAll('[data-mail]')].map((input)=>[input.dataset.mail,input.checked])),groups};try{const response=await fetch('/admin/common/api/users/'+user.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error);state.users=state.users.map((item)=>item.id===result.id?result:item);render();openDetail(result.id);showToast('変更を保存しました');}catch(error){showToast(error.message);}finally{button.disabled=false;}}
function showToast(message){const toast=$('#toast');toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2400);}
const serviceIcons={allaboutme:'♙',finance:'▣',assets:'◇',message:'✉',plan:'▣',stock:'◇',packing:'▤',board:'▱'};
function roleTabs(user){return '<span class="role-tabs">'+(user.isAdmin?'<span class="role-tab role-admin">管理者</span>':'')+(user.isPlanner?'<span class="role-tab role-planner">Planner</span>':'')+(state.neighborhoodRoles?.[user.id]||[]).map(role=>'<span class="role-tab role-neighborhood" title="'+escapeHtml(role.associationName)+'">町内会：'+escapeHtml(role.name)+'</span>').join('')+'</span>';}
function compactDetails(label,content){return '<details class="list-details"><summary>'+label+'</summary><div class="list-details-content">'+content+'</div></details>';}
const renderTable=render;render=()=>{renderTable();const users=filtered();const header=document.querySelector('.user-table thead tr');header.innerHTML='<th>ユーザー・権限</th><th>所属グループ</th><th>利用サービス</th><th>状態</th><th class="last-access-header">最終アクセス日時</th>';document.querySelectorAll('#users tr[data-id]').forEach((row,index)=>{const user=users[index];if(!user)return;const enabledServices=state.catalog.filter(service=>user.services[service.id]);row.children[0].innerHTML='<div class="user-id-line"><button type="button" class="user-profile-trigger" aria-label="ID '+escapeHtml(user.username)+' の詳細を表示">'+escapeHtml(user.username)+'</button>'+roleTabs(user)+'</div>';row.children[1].innerHTML=compactDetails(user.groups.length+' グループ',user.groups.map(group=>'<span class="badge">'+escapeHtml(group.name)+'</span>').join('')||'所属グループはありません');row.children[2].innerHTML=compactDetails(enabledServices.length+' サービス',enabledServices.map(service=>'<span class="service-name enabled"><span class="service-symbol">'+serviceIcons[service.id]+'</span>'+escapeHtml(service.label)+'</span>').join('')||'利用サービスはありません');row.children[3].textContent=user.active?'有効':'無効';row.children[4].className='last-access';row.children[4].textContent=formatDate(user.lastAccessAt);row.querySelectorAll('.list-details').forEach(details=>details.addEventListener('click',event=>event.stopPropagation()));});};
const originalOpenDetail=openDetail;openDetail=(id)=>{originalOpenDetail(id);const modal=$('#detail');const user=state.selected;modal.querySelector('.detail-head').insertAdjacentHTML('afterend',roleTabs(user));modal.querySelector('.eyebrow').textContent='プロフィール詳細';modal.querySelectorAll('.section-title')[0].textContent='権限と状態';modal.querySelectorAll('.section-title')[1].textContent='グループ別利用サービス';modal.querySelectorAll('.section-title')[2].textContent='サービスごとのメール送信';modal.querySelectorAll('[data-group],[data-mail]').forEach((input)=>{const serviceId=input.dataset.service;const label=input.parentElement.querySelector('span');if(label&&serviceId)label.innerHTML='<span class="detail-service-icon">'+serviceIcons[serviceId]+'</span>'+state.catalog.find((service)=>service.id===serviceId)?.label;});modal.querySelectorAll('.group-block').forEach((group,index)=>{group.classList.add('service-chip-group');if(user?.groups?.[index]?.owner){group.insertAdjacentHTML('afterbegin','<div class="owner-note">マスター管理者として設定できます</div>');}});};
const openDetailWithAvatar=openDetail;openDetail=(id)=>{openDetailWithAvatar(id);const user=state.selected;const head=$('#detail .detail-head');if(!user||!head||!user.avatar)return;const image=document.createElement('img');image.src=user.avatar;image.alt='プロフィール画像';image.className='profile-avatar';image.onerror=()=>{image.style.display='none';};head.firstElementChild.classList.add('profile-heading');head.firstElementChild.prepend(image);};
const avatarStyle=document.createElement('style');avatarStyle.textContent='.profile-heading{display:flex;align-items:center;gap:12px}.profile-avatar{width:64px;height:64px;border-radius:50%;object-fit:cover;border:1px solid #d9e1dc;background:#f1f3f4}.owner-note{padding:8px 10px;margin-bottom:8px;border-radius:6px;background:#eef3f8;color:#53616c;font-size:12px}.service-chip-group input:disabled{opacity:.45;cursor:not-allowed}.service-chip-group:has(input:disabled){background:#f3f5f7}';document.head.appendChild(avatarStyle);
const openDetailWithEmailSettings=openDetail;openDetail=(id)=>{openDetailWithEmailSettings(id);const user=state.selected;const section=[...document.querySelectorAll('#detail .section')].find((item)=>item.querySelector('.section-title')?.textContent==='サービスごとのメール送信');if(!section||!user)return;section.innerHTML='<div class="section-title">サービスごとのメール送信</div>'+state.catalog.map((service)=>'<details class="mail-service"><summary><span class="mail-service-name"><span class="service-symbol">'+serviceIcons[service.id]+'</span>'+service.label+'</span><input class="toggle" type="checkbox" data-mail="'+service.id+'" '+(user.mail[service.id]?'checked':'')+'></summary><div class="mail-items">'+(state.emails[service.id]||[]).map((email)=>'<label class="mail-item"><input type="checkbox" data-mail-item="true" data-mail-service="'+service.id+'" data-mail-item-id="'+email.id+'" '+(user.mailDetails?.[service.id]?.[email.id]?'checked':'')+'>'+email.label+'</label>').join('')+'</div></details>').join('');};
const openDetailWithDelete=openDetail;openDetail=(id)=>{openDetailWithDelete(id);const user=state.selected;if(!user)return;const save=$('#detail .save');save.insertAdjacentHTML('afterend','<div class="delete-user-area"><div><strong>ユーザーの削除</strong><span>アカウントを完全に削除します。この操作は取り消せません。</span></div><button class="delete-user" type="button">ユーザーを削除</button></div>');$('#detail .delete-user').addEventListener('click',deleteUser);};
async function deleteUser(){const user=state.selected;if(!user)return;const confirmationName=user.username||user.displayName;if(!confirm(user.displayName+' を削除しますか？\\nこの操作は取り消せません。'))return;const typed=prompt('最終確認です。削除するには「'+confirmationName+'」と入力してください。','');if(typed===null)return;if(typed!==confirmationName)return showToast('確認用のユーザー名が一致しません');const button=$('#detail .delete-user');button.disabled=true;try{const response=await fetch('/admin/common/api/users/'+user.id,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmationName:typed})});const result=await response.json();if(!response.ok)throw new Error(result.error);state.users=state.users.filter((item)=>item.id!==user.id);state.selected=null;render();$('#detail').classList.remove('open');showToast(result.warning||'ユーザーを削除し、通知メールを送信しました');}catch(error){showToast(error.message);button.disabled=false;}}
const originalSaveDetail=saveDetail;saveDetail=async()=>{const originalFetch=window.fetch;window.fetch=(url,options)=>{if(String(url).startsWith('/admin/common/api/users/')&&options?.body){const body=JSON.parse(options.body);body.mailDetails={};document.querySelectorAll('[data-mail-item]').forEach((input)=>{body.mailDetails[input.dataset.mailService]??={};body.mailDetails[input.dataset.mailService][input.dataset.mailItemId]=input.checked;});options.body=JSON.stringify(body);}return originalFetch(url,options);};try{const result=await originalSaveDetail();$('#detail').classList.remove('open');return result;}finally{window.fetch=originalFetch;}};
const mailStyle=document.createElement('style');mailStyle.textContent='.mail-service{border:1px solid #e1e7ee;border-radius:8px;margin:7px 0;background:#fff}.mail-service summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;cursor:pointer;list-style:none}.mail-service summary::-webkit-details-marker{display:none}.mail-service-name{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px}.mail-items{padding:4px 12px 10px;border-top:1px solid #edf0f3}.mail-item{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:12px;color:#53616c}.mail-item input{accent-color:#087f73}.shell{padding:28px 38px 60px}.topbar{display:block;margin-bottom:22px}.brand{font-size:30px;font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;margin:5px 0}.status{display:none}.page-description{font-size:13px;color:#697586;margin:0}.toolbar{padding:14px}.search,.select{font-size:12px;padding:9px 11px}.summary{padding:12px 16px;font-size:12px}.user-table th{font-size:10px;padding:10px 16px}.user-table td{font-size:12px;padding:12px 16px}.name{font-size:12px}.sub{font-size:11px}.badge{font-size:10px;padding:4px 7px}.permission-box{display:flex;align-items:center;gap:6px;margin-top:8px;padding:5px 7px;background:#eef8ff;border:1px solid #c7e7fa;border-radius:5px;width:max-content;max-width:100%}.permission-icon{font-size:11px;margin-right:5px;white-space:nowrap}.permission-icon .symbol{width:24px;height:24px;font-size:15px}.permission-icon.on .symbol{background:#dff3ff;border-color:#9bd4f2;color:#087f73}.permission-icon.off .symbol{background:#f5f7f8}.service-name{font-size:11px;margin-right:7px}.service-symbol{width:19px;height:19px;font-size:12px}.detail{padding:18px}.detail h2{font-size:22px}.section-title{font-size:10px}.fact label,.fact div,.toggle-row{font-size:12px}.save{font-size:13px;padding:11px}.user-nav{display:flex!important;gap:8px!important;margin:0 0 20px!important}.user-nav a{padding:8px 12px!important;color:#53616c!important;text-decoration:none!important;border-radius:4px!important}.user-nav a.active{background:#eef1f4!important;color:#53616c!important}';mailStyle.textContent='@scope (.common-admin) {'+mailStyle.textContent+'}';document.head.appendChild(mailStyle);
const deleteUserStyle=document.createElement('style');deleteUserStyle.textContent='.delete-user-area{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:20px;padding:14px;border:1px solid #f0cccc;border-radius:7px;background:#fffafa}.delete-user-area strong,.delete-user-area span{display:block}.delete-user-area span{margin-top:4px;color:#697586;font-size:11px}.delete-user{flex:none;border:0;border-radius:5px;padding:10px 13px;background:#d94b4b;color:#fff;font-weight:700;cursor:pointer}.delete-user:disabled{opacity:.5;cursor:wait}@media(max-width:600px){.delete-user-area{align-items:stretch;flex-direction:column}.delete-user{width:100%}}';deleteUserStyle.textContent='@scope (.common-admin) {'+deleteUserStyle.textContent+'}';document.head.appendChild(deleteUserStyle);
const cleanPermissionDisplay=()=>{document.querySelectorAll('.permission-box').forEach((box)=>{box.querySelectorAll('.permission-icon.off').forEach((icon)=>icon.remove());if(!box.querySelector('.permission-icon'))box.remove();});};const permissionDisplayStyle=document.createElement('style');permissionDisplayStyle.textContent='.permission-box .permission-icon.off{display:none}.permission-box:not(:has(.permission-icon.on)){display:none}.permission-icon{font-size:10px}.permission-icon .symbol{width:21px;height:21px;font-size:13px}';permissionDisplayStyle.textContent='@scope (.common-admin) {'+permissionDisplayStyle.textContent+'}';document.head.appendChild(permissionDisplayStyle);$('#search').addEventListener('input',render);$('#role').addEventListener('change',render);$('#service').addEventListener('change',render);load();
</script><style>.layout{display:block}.detail{position:fixed;z-index:5;inset:24px auto 24px 50%;width:min(560px,calc(100% - 32px));max-height:calc(100vh - 48px);overflow:auto;transform:translate(-50%,12px);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;box-shadow:0 0 0 100vmax #17232266,0 18px 48px #17232230}.detail.open{transform:translate(-50%,0);opacity:1;pointer-events:auto}.user-table{min-width:0}.user-profile-trigger{border:0;background:transparent;padding:0;color:var(--teal);font:inherit;font-weight:700;text-align:left;cursor:pointer;overflow-wrap:anywhere}.user-profile-trigger:hover{text-decoration:underline}.user-profile-trigger:focus-visible{outline:2px solid var(--teal);outline-offset:3px;border-radius:2px}.permission-icon{display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-size:14px;font-weight:700}.permission-icon .symbol{display:grid;place-items:center;width:30px;height:30px;border:1px solid #d9e1dc;border-radius:5px;background:#f4f6f7;font-size:18px}.permission-icon.on .symbol{background:#e1f2ed;border-color:#9dd8ca;color:#087f73}.permission-icon.off{color:#9aa49f}.service-name{display:inline-flex;align-items:center;gap:5px;margin:2px 10px 2px 0;font-size:12px;white-space:nowrap}.service-name .service-dot{width:8px;height:8px}.service-symbol,.detail-service-icon{display:inline-grid;place-items:center;width:22px;height:22px;border:1px solid #d8e0e8;border-radius:5px;background:#f0f3f7;color:#4c5c70;font-size:14px;font-weight:700}.service-name.enabled .service-symbol{background:#e9f1ff;border-color:#8bb6ff;color:#1755bf}.service-name.disabled{color:#9199a1}.service-chip-group{background:#f8faff;border:1px solid #e6ebf2;border-radius:12px;padding:14px}.service-chip-group .toggle-row{display:inline-flex;gap:8px;margin:4px 5px 4px 0;padding:7px 10px;border:1px solid #dce4ef;border-radius:16px;background:#fff}.service-chip-group .toggle{order:-1}.detail .toggle-row{font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif}.detail h2,.brand,.title{font-family:ui-sans-serif,system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif}.modal-label{font-size:12px;color:#687572}@media(max-width:600px){.detail{inset:12px auto 12px 50%;max-height:calc(100vh - 24px)}} </style></body></html>`;


export default app;
