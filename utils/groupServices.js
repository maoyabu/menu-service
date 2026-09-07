export const GROUP_SERVICE_IDS = ['plan', 'stock', 'packing', 'board'];

export const GROUP_SERVICE_LABELS = Object.freeze({
  plan: '7 DAYS PLAN',
  stock: 'ストック管理',
  packing: 'パッキングプラン',
  board: '掲示板'
});

// Members without an explicit permission entry keep full access so existing
// groups continue to work without a data migration.
export const normalizeGroupServices = (services) => Object.fromEntries(
  GROUP_SERVICE_IDS.map((serviceId) => [serviceId, services?.[serviceId] !== false])
);

export const servicesForGroupMember = (group, memberId) => {
  if (!group || !memberId) return normalizeGroupServices();
  if (String(group.createdBy?._id || group.createdBy || '') === String(memberId)) {
    return normalizeGroupServices();
  }
  const permission = (group.memberServicePermissions || []).find(
    (entry) => String(entry?.member?._id || entry?.member || '') === String(memberId)
  );
  return normalizeGroupServices(permission?.services);
};

export const enabledGroupServiceIds = (services) => {
  const normalized = normalizeGroupServices(services);
  return GROUP_SERVICE_IDS.filter((serviceId) => normalized[serviceId]);
};

export const GROUP_SERVICE_HOME = Object.freeze({
  plan: '/users/my-top',
  stock: '/users/stock-top',
  packing: '/users/packing',
  board: '/users/board'
});

export const serviceIdForPath = (path = '') => {
  if (/^\/users\/week-menu\/public(?:\/|$)/.test(path)) return null;
  if (/^\/users\/(?:stock-top|my-stock|my-equipment|purchase-reminder)(?:\/|$)/.test(path)) return 'stock';
  if (/^\/users\/packing(?:\/|$)/.test(path)) return 'packing';
  if (/^\/users\/board(?:\/|$)/.test(path)) return 'board';
  if (/^\/users\/(?:my-top|week-menu|week-menu2|shopping-list|my-menu|menu-list|seasonal-ingredients|menu-ranking)(?:\/|$)/.test(path)) return 'plan';
  return null;
};
