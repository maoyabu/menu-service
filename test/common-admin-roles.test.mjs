import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNeighborhoodRoles } from '../utils/commonAdminRoles.js';

test('town roles combine active assignments, current officers and leaders without duplicate badges', async () => {
  const queries = {};
  const records = {
    role_definitions: [{ _id: 'r1', name: '町内会管理者' }],
    neighborhood_associations: [{ _id: 'a1', name: '第一町内会' }],
    role_assignments: [
      { user: 'u1', association: 'a1', role: 'r1' },
      { user: 'u1', association: 'deleted', role: 'r1' },
      { user: 'u2', association: 'a1', role: 'inactive-role' }
    ],
    annual_officers: [{ user: 'u1', association: 'a1', role: 'r1' }, { association: 'a1', role: 'r1' }],
    annual_leader_assignments: [{ representative: 'u1', association: 'a1' }]
  };
  const db = { collection: name => ({ find: query => {
    queries[name] = query;
    return { project: () => ({ toArray: async () => records[name] }) };
  } }) };
  // April 1 in Tokyo is already the new fiscal year, even on March 31 UTC.
  const now = new Date('2026-03-31T15:00:00Z');
  const result = await fetchNeighborhoodRoles(db, now);
  assert.deepEqual(result, { u1: [
    { associationId: 'a1', associationName: '第一町内会', name: '町内会管理者' },
    { associationId: 'a1', associationName: '第一町内会', name: '班長' }
  ] });
  assert.deepEqual(queries.role_definitions, { active: true });
  assert.deepEqual(queries.neighborhood_associations, { status: 'active', deletedAt: null });
  assert.deepEqual(queries.annual_officers, { fiscalYear: 2026, cancelledAt: null });
  assert.deepEqual(queries.annual_leader_assignments, { fiscalYear: 2026, cancelledAt: null });
  assert.deepEqual(queries.role_assignments, { startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gte: now } }] });
  await fetchNeighborhoodRoles(db, new Date('2026-03-31T14:59:59Z'));
  assert.equal(queries.annual_officers.fiscalYear, 2025);
});

test('installations without town association data return no role badges', async () => {
  const db = { collection: () => ({ find: () => ({ project: () => ({ toArray: async () => [] }) }) }) };
  assert.deepEqual(await fetchNeighborhoodRoles(db), {});
});
