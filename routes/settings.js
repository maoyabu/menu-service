import express from 'express';
import User from '../models/users.js';
import Group from '../models/groups.js';
import { isLoggedIn } from '../middleware.js';
import ejs from 'ejs';
import nodemailer from 'nodemailer';
import path from 'path';
import fs from 'fs';

import multer from 'multer';
import cloudinary from '../utils/cloudinary.js';

const upload = multer({ storage: multer.memoryStorage() });

const router = express.Router();

// --- mail helpers ---
const buildTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
  }
  return {
    // dev fallback: log only
    sendMail: async (opts) => {
      console.log('[DEV] sendMail mocked (settings):', opts);
    }
  };
};


const sendInviteMail = async ({ toEmail, inviterName, groupName, inviteUrl }) => {
  const transporter = buildTransporter();
  const from = process.env.MAIL_FROM || 'no-reply@example.com';
  const subject = 'グループ招待のご案内';

  const tplPath = path.resolve(process.cwd(), 'utils/templates/invite.ejs');
  const html = await ejs.renderFile(tplPath, {
    inviter: inviterName,
    inviterName,
    groupName,
    inviteUrl
  });

  await transporter.sendMail({ from, to: toEmail, subject, html });
};

// 招待受諾処理（メールの「参加する」ボタンから遷移）
router.get('/invite/accept', async (req, res, next) => {
  try {
    const groupId = String(req.query.group || '').trim();
    const emailRaw = String(req.query.email || '').trim();
    const email = emailRaw.toLowerCase();

    if (!groupId || !email) {
      req.flash('error', '招待リンクが不正です');
      return res.redirect('/user/login');
    }

    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', '対象のグループが見つかりませんでした');
      return res.redirect('/user/login');
    }

    const invited = (group.invitedUsers || []).some((addr) => addr === email);
    if (!invited) {
      // 既に承認済み or 取り消し後の可能性
      req.flash('error', 'この招待は無効か、すでに処理済みです');
      return res.redirect('/user/login');
    }

    const existing = await User.findOne({ email }).exec();

    if (existing) {
      // 1) 既存ユーザー：メンバーに追加、サービスを Menu のみに制限
      const alreadyMember = (group.members || []).some((m) => m.toString() === existing._id.toString());
      if (!alreadyMember) {
        group.members = group.members || [];
        group.members.push(existing._id);
      }
      // 招待リストから除外
      group.invitedUsers = (group.invitedUsers || []).filter((addr) => addr !== email);
      await group.save();

      // ユーザー側にもグループ追加
      await User.findByIdAndUpdate(existing._id, {
        $addToSet: { groups: group._id },
        $set: {
          services: {
            allaboutme: false,
            finance: false,
            assets: false,
            menu: true
          }
        }
      });

      req.flash('success', 'グループへの参加が完了しました。ログインしてください。');
      return res.redirect('/user/login');
    }

    // 2) 新規ユーザー：登録フローへ誘導。登録時に Menu のみ有効化するためのフラグを保存
    req.session.pendingInvite = {
      email,
      groupId: group._id.toString(),
      menuOnly: true
    };

    req.flash('success', '会員登録後ログインして利用を開始してください');
    return res.redirect(`/user/register?email=${encodeURIComponent(email)}&menuOnly=1`);
  } catch (err) {
    next(err);
  }
});


router.use(isLoggedIn);

const toBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === 'on' || normalized === '1';
  }
  return false;
};

const fetchSettingsContext = async (userId) => {
  const [user, groups] = await Promise.all([
    User.findById(userId).lean(),
    Group.find({
      $or: [
        { createdBy: userId },
        { members: userId }
      ]
    })
      .sort({ createdAt: 1 })
      .populate('createdBy', 'displayname username email avatar')
      .populate('members', 'displayname username email avatar')
      .lean({ virtuals: true })
  ]);

  return { user, groups: groups || [] };
};

// 設定画面表示
router.get('/', async (req, res, next) => {
  try {
    const { user, groups } = await fetchSettingsContext(req.user._id);
    const defaultGroupId = user?.defaultGroup ? user.defaultGroup.toString() : null;
    const selectedGroupId = req.query.group
      ? String(req.query.group)
      : (defaultGroupId || (groups[0]?._id?.toString() ?? null));
    const selectedGroup = selectedGroupId
      ? (groups || []).find((group) => group._id.toString() === selectedGroupId)
      : null;
    const requestedView = req.query.view;
    let activeTab;
    if (requestedView === 'profile') {
      activeTab = 'profile';
    } else if (requestedView === 'groups') {
      activeTab = 'groups';
    } else if (requestedView === 'group-detail' && selectedGroup) {
      activeTab = 'group-detail';
    } else {
      activeTab = selectedGroup ? 'group-detail' : 'profile';
    }

    res.render('users/setting', {
      settingsUser: user,
      groups,
      selectedGroup,
      selectedGroupId,
      defaultGroupId,
      activeTab
    });
  } catch (err) {
    next(err);
  }
});

// プロフィール更新処理
router.post('/profile', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      req.flash('error', 'ユーザーが見つかりませんでした');
      return res.redirect('/settings');
    }

    const {
      displayname,
      email,
      birth_date,
      sex,
      blood,
      rh,
      avatar,
      isMail,
      services = {}
    } = req.body;

    const trimmedEmail = (email || '').trim().toLowerCase();
    if (!trimmedEmail) {
      req.flash('error', 'メールアドレスを入力してください');
      return res.redirect('/settings');
    }

    const emailConflict = await User.findOne({
      email: trimmedEmail,
      _id: { $ne: req.user._id }
    }).lean();
    if (emailConflict) {
      req.flash('error', 'このメールアドレスは既に使用されています');
      return res.redirect('/settings');
    }

    user.displayname = displayname?.trim() || '';
    user.email = trimmedEmail;
    user.birth_date = birth_date ? new Date(birth_date) : undefined;
    user.sex = sex || undefined;
    user.blood = blood || undefined;
    user.rh = rh || undefined;
    const newAvatar = (avatar || '').trim();
    if (newAvatar) {
      user.avatar = newAvatar;
    }
    user.isMail = toBoolean(isMail);
    user.services = {
      allaboutme: toBoolean(services.allaboutme),
      finance: toBoolean(services.finance),
      assets: toBoolean(services.assets),
      menu: toBoolean(services.menu)
    };
    user.update_date = new Date();

    await user.save();

    await new Promise((resolve, reject) => {
      req.logIn(user, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    req.flash('success', 'プロフィールを更新しました');
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

// パスワード変更処理
router.post('/password', async (req, res, next) => {
  const { currentPassword, newPassword, confirmNewPassword } = req.body;

  if (!currentPassword || !newPassword) {
    req.flash('error', '現在のパスワードと新しいパスワードを入力してください');
    return res.redirect('/settings');
  }

  if (newPassword !== confirmNewPassword) {
    req.flash('error', '新しいパスワードが一致しません');
    return res.redirect('/settings');
  }

  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      req.flash('error', 'ユーザーが見つかりませんでした');
      return res.redirect('/settings');
    }

    await new Promise((resolve, reject) => {
      user.changePassword(currentPassword, newPassword, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    req.flash('success', 'パスワードを更新しました');
    res.redirect('/settings');
  } catch (err) {
    if (err.name === 'IncorrectPasswordError') {
      req.flash('error', '現在のパスワードが正しくありません');
      return res.redirect('/settings');
    }
    next(err);
  }
});

// プロフィール画像アップロード
router.post('/upload-avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      req.flash('error', '画像ファイルがありません');
      return res.redirect('/settings?view=profile');
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'profile_avatars', resource_type: 'image' },
        (err, uploadResult) => {
          if (err) return reject(err);
          return resolve(uploadResult);
        }
      );
      stream.end(req.file.buffer);
    });

    await User.findByIdAndUpdate(req.user._id, { avatar: result.secure_url });

    req.flash('success', 'プロフィール画像を更新しました');
    res.redirect('/settings?view=profile');
  } catch (e) {
    console.error(e);
    req.flash('error', '画像アップロードに失敗しました');
    res.redirect('/settings?view=profile');
  }
});

// 退会処理
router.post('/deactivate', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      req.flash('error', 'ユーザーが見つかりませんでした');
      return res.redirect('/settings');
    }
    user.unsubscribe_date = new Date();
    user.services = {
      allaboutme: false,
      finance: false,
      assets: false,
      menu: false
    };
    await user.save();
    await Group.updateMany(
      { members: req.user._id },
      { $pull: { members: req.user._id } }
    );
    await Group.updateMany(
      { createdBy: req.user._id },
      { $pull: { members: req.user._id } }
    );
    await User.updateMany(
      { defaultGroup: { $exists: true, $ne: null } },
      { $unset: { defaultGroup: '' } }
    );
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.flash('success', '退会手続きを受け付けました');
      res.redirect('/user/login');
    });
  } catch (err) {
    next(err);
  }
});

// グループ作成処理
router.post('/groups', async (req, res, next) => {
  const { group_name: rawGroupName } = req.body;
  if (!rawGroupName?.trim()) {
    req.flash('error', 'グループ名を入力してください');
    return res.redirect('/settings');
  }

  const groupName = rawGroupName.trim();

  try {
    const group = new Group({
      group_name: groupName,
      createdBy: req.user._id,
      members: [req.user._id],
      invitedUsers: []
    });
    await group.save();

    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { groups: group._id }
    });

    if (Array.isArray(req.user.groups)) {
      const hasGroup = req.user.groups.some((id) => id.toString() === group._id.toString());
      if (!hasGroup) {
        req.user.groups.push(group._id);
      }
    } else {
      req.user.groups = [group._id];
    }

    if (!req.user.defaultGroup) {
      await User.findByIdAndUpdate(req.user._id, {
        $set: { defaultGroup: group._id }
      });
      req.user.defaultGroup = group._id;
    }

    req.flash('success', 'グループを作成しました');
    res.redirect(`/settings?group=${group._id.toString()}`);
  } catch (err) {
    if (err.code === 11000) {
      req.flash('error', 'このグループ名は既に使用されています');
      return res.redirect('/settings');
    }
    next(err);
  }
});

// グループ情報更新処理
router.post('/groups/:groupId/update', async (req, res, next) => {
  const { groupId } = req.params;
  const { group_name: rawGroupName } = req.body;

  const groupName = rawGroupName?.trim();
  if (!groupName) {
    req.flash('error', 'グループ名を入力してください');
    return res.redirect(`/settings?group=${groupId}`);
  }

  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }

    if (!group.createdBy.equals(req.user._id)) {
      req.flash('error', 'グループを編集できるのはオーナーのみです');
      return res.redirect(`/settings?group=${groupId}`);
    }

    group.group_name = groupName;
    await group.save();

    req.flash('success', 'グループ情報を更新しました');
    res.redirect(`/settings?group=${groupId}`);
  } catch (err) {
    if (err.code === 11000) {
      req.flash('error', 'このグループ名は既に使用されています');
      return res.redirect(`/settings?group=${groupId}`);
    }
    next(err);
  }
});


// グループ削除処理
router.post('/groups/:groupId/delete', async (req, res, next) => {
  const { groupId } = req.params;
  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }

    if (!group.createdBy.equals(req.user._id)) {
      req.flash('error', 'グループを削除できるのはオーナーのみです');
      return res.redirect(`/settings?group=${groupId}`);
    }

    await Group.deleteOne({ _id: groupId });

    await User.updateMany(
      { groups: groupId },
      { $pull: { groups: groupId } }
    );
    await User.updateMany(
      { defaultGroup: groupId },
      { $unset: { defaultGroup: '' } }
    );

    if (Array.isArray(req.user.groups)) {
      req.user.groups = req.user.groups.filter((id) => id.toString() !== groupId);
    }
    if (req.user.defaultGroup && req.user.defaultGroup.toString() === groupId) {
      req.user.defaultGroup = null;
    }

    req.flash('success', 'グループを削除しました');
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

// グループ招待処理
router.post('/groups/:groupId/invite', async (req, res, next) => {
  const { groupId } = req.params;
  const { email } = req.body;
  const normalizedEmail = email?.trim().toLowerCase();

  if (!normalizedEmail) {
    req.flash('error', '招待するメールアドレスを入力してください');
    return res.redirect(`/settings?group=${groupId}`);
  }

  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }

    if (!group.createdBy.equals(req.user._id)) {
      req.flash('error', '招待を送信できるのはオーナーのみです');
      return res.redirect(`/settings?group=${groupId}`);
    }

    const userExists = await User.findOne({ email: normalizedEmail }).lean();
    const userIdString = userExists?._id?.toString();
    const ownerIdString = group.createdBy?.toString();
    const isExistingMember = userIdString
      ? (group.members || []).some((memberId) => memberId?.toString() === userIdString)
      : false;

    if (userIdString && (ownerIdString === userIdString || isExistingMember)) {
      req.flash('error', 'このユーザーはすでにグループに参加しています');
      return res.redirect(`/settings?group=${groupId}`);
    }

    const alreadyInvited = (group.invitedUsers || []).some((inviteEmail) =>
      inviteEmail === normalizedEmail
    );
    if (alreadyInvited) {
      req.flash('error', 'このメールアドレスにはすでに招待を送信しています');
      return res.redirect(`/settings?group=${groupId}`);
    }

    group.invitedUsers = group.invitedUsers || [];
    group.invitedUsers.push(normalizedEmail);

    await group.save();

    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const inviteUrl = `${baseUrl}/settings/invite/accept?group=${group._id.toString()}&email=${encodeURIComponent(normalizedEmail)}`;
      const inviterName = req.user.displayname || req.user.username || req.user.email;
      await sendInviteMail({
        toEmail: normalizedEmail,
        inviterName,
        groupName: group.group_name,
        inviteUrl
      });
    } catch (mailErr) {
      console.error('invite mail error:', mailErr);
      req.flash('error', '招待メールの送信に失敗しました（後でもう一度お試しください）');
      return res.redirect(`/settings?group=${groupId}`);
    }

    req.flash('success', '招待を送信しました');
    res.redirect(`/settings?group=${groupId}`);
  } catch (err) {
    next(err);
  }
});

// 招待再送処理
router.post('/groups/:groupId/resend-invite', async (req, res, next) => {
  const { groupId } = req.params;
  const { email } = req.body;
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    req.flash('error', '再送するメールアドレスを入力してください');
    return res.redirect(`/settings?group=${groupId}`);
  }
  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }
    if (!group.createdBy.equals(req.user._id)) {
      req.flash('error', '再送できるのはオーナーのみです');
      return res.redirect(`/settings?group=${groupId}`);
    }
    const isInvited = (group.invitedUsers || []).some((addr) => addr === normalizedEmail);
    if (!isInvited) {
      req.flash('error', 'このメールアドレスには招待が登録されていません');
      return res.redirect(`/settings?group=${groupId}`);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const inviteUrl = `${baseUrl}/settings/invite/accept?group=${group._id.toString()}&email=${encodeURIComponent(normalizedEmail)}`;
    const inviterName = req.user.displayname || req.user.username || req.user.email;
    await sendInviteMail({
      toEmail: normalizedEmail,
      inviterName,
      groupName: group.group_name,
      inviteUrl
    });

    req.flash('success', '招待メールを再送しました');
    res.redirect(`/settings?group=${groupId}`);
  } catch (err) {
    next(err);
  }
});


// グループメンバー削除・退会処理
router.post('/groups/:groupId/remove-member', async (req, res, next) => {
  const { groupId } = req.params;
  const { memberId } = req.body;

  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }

    const memberIdString = memberId ? memberId.toString() : '';
    if (!memberIdString) {
      req.flash('error', '対象のメンバーが指定されていません');
      return res.redirect(`/settings?group=${groupId}`);
    }
    const isOwner = group.createdBy?.toString() === req.user._id.toString();
    const isSelf = req.user._id.toString() === memberIdString;

    if (!isOwner && !isSelf) {
      req.flash('error', 'この操作を実行する権限がありません');
      return res.redirect(`/settings?group=${groupId}`);
    }

    if (group.createdBy?.toString() === memberIdString) {
      req.flash('error', 'オーナーはグループから削除できません');
      return res.redirect(`/settings?group=${groupId}`);
    }

    group.members = (group.members || []).filter(
      (member) => member.toString() !== memberIdString
    );
    await group.save();

    await User.findByIdAndUpdate(memberIdString, {
      $pull: { groups: groupId }
    });
    await User.updateOne(
      { _id: memberIdString, defaultGroup: groupId },
      { $unset: { defaultGroup: '' } }
    );

    if (isSelf) {
      if (Array.isArray(req.user.groups)) {
        req.user.groups = req.user.groups.filter((id) => id.toString() !== groupId);
      }
      if (req.user.defaultGroup && req.user.defaultGroup.toString() === groupId) {
        req.user.defaultGroup = null;
      }
    }

    req.flash('success', isSelf ? 'グループから退会しました' : 'メンバーを削除しました');
    const redirectTarget = (isSelf && !isOwner) ? '/settings' : `/settings?group=${groupId}`;
    res.redirect(redirectTarget);
  } catch (err) {
    next(err);
  }
});

// グループ招待キャンセル処理
router.post('/groups/:groupId/cancel-invite', async (req, res, next) => {
  const { groupId } = req.params;
  const { email } = req.body;
  const normalizedEmail = email?.trim().toLowerCase();

  if (!normalizedEmail) {
    req.flash('error', 'キャンセルする招待が指定されていません');
    return res.redirect(`/settings?group=${groupId}`);
  }

  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }

    if (!group.createdBy.equals(req.user._id)) {
      req.flash('error', 'この操作を実行する権限がありません');
      return res.redirect(`/settings?group=${groupId}`);
    }

    group.invitedUsers = (group.invitedUsers || []).filter(
      (inviteEmail) => inviteEmail !== normalizedEmail
    );

    await group.save();
    req.flash('success', '招待をキャンセルしました');
    res.redirect(`/settings?group=${groupId}`);
  } catch (err) {
    next(err);
  }
});

// デフォルトグループ設定処理
router.post('/groups/:groupId/default', async (req, res, next) => {
  const { groupId } = req.params;

  try {
    const group = await Group.findById(groupId).lean();
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }

    const userId = req.user._id.toString();
    const isMember = group.createdBy?.toString() === userId ||
      (group.members || []).some((member) => member?.toString() === userId);
    if (!isMember) {
      req.flash('error', 'このグループのメンバーではありません');
      return res.redirect('/settings');
    }

    await User.findByIdAndUpdate(req.user._id, {
      $set: { defaultGroup: groupId }
    });
    req.user.defaultGroup = groupId;

    if (req.accepts('json') || req.xhr) {
      return res.json({ success: true, defaultGroup: groupId });
    }

    req.flash('success', 'デフォルトのグループを更新しました');
    res.redirect(`/settings?group=${groupId}`);
  } catch (err) {
    if (req.accepts('json') || req.xhr) {
      return res.status(400).json({ success: false, message: err.message || '更新に失敗しました' });
    }
    next(err);
  }
});

// グループ基本設定：マイストック棚卸し設定の保存
router.post('/groups/:groupId/inventory', async (req, res, next) => {
  const { groupId } = req.params;
  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }
    // 参加メンバーのみ許可
    const userId = req.user._id.toString();
    const isMember = group.createdBy?.toString() === userId || (group.members || []).some((m) => String(m) === userId);
    if (!isMember) {
      req.flash('error', 'このグループのメンバーではありません');
      return res.redirect(`/settings?group=${groupId}`);
    }

    const enabled = toBoolean(req.body?.enabled);
    const mode = (req.body?.mode === 'nthWeekday') ? 'nthWeekday' : 'monthlyDay';
    const day = Math.max(1, Math.min(31, Number(req.body?.day) || 1));
    const nth = Math.max(1, Math.min(5, Number(req.body?.nth) || 1));
    const weekday = Math.max(0, Math.min(6, Number(req.body?.weekday) || 0));
    const sendHour = Math.max(0, Math.min(23, Number(req.body?.sendHour) || 8));
    const windowDays = Math.max(1, Math.min(31, Number(req.body?.windowDays) || 7));

    group.stockInventory = {
      enabled,
      mode,
      day,
      nth,
      weekday,
      sendHour,
      windowDays
    };

    await group.save();
    req.flash('success', 'グループの棚卸し設定を更新しました');
    res.redirect(`/settings?group=${groupId}&view=group-detail`);
  } catch (err) {
    next(err);
  }
});

// グループ基本設定：備品棚卸しサイクルの保存
router.post('/groups/:groupId/equipment-inventory', async (req, res, next) => {
  const { groupId } = req.params;
  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/settings');
    }
    const userId = req.user._id.toString();
    const isMember = group.createdBy?.toString() === userId || (group.members || []).some((m) => String(m) === userId);
    if (!isMember) {
      req.flash('error', 'このグループのメンバーではありません');
      return res.redirect(`/settings?group=${groupId}`);
    }

    const cadence = ['monthly', 'quarter', 'half'].includes(String(req.body?.cadence)) ? String(req.body.cadence) : 'monthly';
    const enabled = toBoolean(req.body?.enabled);
    group.equipmentInventory = { enabled, cadence };
    await group.save();

    req.flash('success', '備品の棚卸し設定を更新しました');
    res.redirect(`/settings?group=${groupId}&view=group-detail`);
  } catch (err) { next(err); }
});

export default router;
