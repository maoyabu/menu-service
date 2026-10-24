// Read the shared town association collections without registering their models.
export async function fetchNeighborhoodRoles(db, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric'
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const fiscalYear = Number(parts.year) - (Number(parts.month) < 4 ? 1 : 0);
  const [roles, associations, assignments, officers, leaders] = await Promise.all([
    db.collection('role_definitions').find({ active: true }).project({ name: 1 }).toArray(),
    db.collection('neighborhood_associations').find({ status: 'active', deletedAt: null }).project({ name: 1 }).toArray(),
    db.collection('role_assignments').find({ startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }).project({ user: 1, role: 1, association: 1 }).toArray(),
    db.collection('annual_officers').find({ fiscalYear, cancelledAt: null }).project({ user: 1, role: 1, association: 1 }).toArray(),
    db.collection('annual_leader_assignments').find({ fiscalYear, cancelledAt: null }).project({ representative: 1, association: 1 }).toArray()
  ]);
  const roleNames = new Map(roles.map(role => [String(role._id), role.name]));
  const associationNames = new Map(associations.map(item => [String(item._id), item.name]));
  const result = {};
  const add = (user, association, name) => {
    const associationName = associationNames.get(String(association));
    if (!user || !associationName || !name) return;
    const entries = result[String(user)] ??= [];
    if (!entries.some(entry => entry.associationId === String(association) && entry.name === name)) {
      entries.push({ associationId: String(association), associationName, name });
    }
  };
  for (const entry of [...assignments, ...officers]) add(entry.user, entry.association, roleNames.get(String(entry.role)));
  for (const entry of leaders) add(entry.representative, entry.association, '班長');
  return result;
}
