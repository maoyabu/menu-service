import express from 'express';
import User from '../models/users.js';
import Group from '../models/groups.js';
import { isLoggedIn } from '../middleware.js';

const router = express.Router();

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
    const activeTab = requestedView === 'groups'
      ? 'groups'
      : (selectedGroup ? 'group-detail' : 'profile');

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
    user.avatar = avatar?.trim() || undefined;
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

router.post('/deactivate', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      req.flash('error', 'ユーザーが見つかりませんでした');
      return res.redirect('/settings');
    }
    user.unsubscribe_date = new Date();
    await user.save();
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.flash('success', '退会手続きを受け付けました');
      res.redirect('/login');
    });
  } catch (err) {
    next(err);
  }
});

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
    req.flash('success', '招待を送信しました');
    res.redirect(`/settings?group=${groupId}`);
  } catch (err) {
    next(err);
  }
});

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

export default router;
