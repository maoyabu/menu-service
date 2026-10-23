import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { EJSON, ObjectId, Long } from 'bson';
import unzipper from 'unzipper';
import AdmZip from 'adm-zip';
import os from 'node:os';

// Evaluate only the restore routine: never start the server or connect to a DB.
const source = await fs.readFile(new URL('../routes/commonAdmin.js', import.meta.url), 'utf8');
const restoreSource = source.slice(source.indexOf('const sessionCollectionNames ='), source.indexOf("app.get('/api/backups'"));
const sessions = ['sessions', 'chounaikai_sessions'];
const fixture = (contents, { failInsert = false, actualZip = false } = {}) => {
	const data = new Map([...sessions.map(name => [name, [{ oldSession: true }]]), ['users', [{ oldUser: true }]]]);
	const writes = [];
	const context = vm.createContext({ path, EJSON, withDataOperation: async operation => operation(),
		unzipper: actualZip ? unzipper : { Open: { file: async () => ({ files: Object.entries(contents).map(([name, docs]) => ({
			path: `${name}.json`, buffer: async () => Buffer.from(EJSON.stringify(docs))
		})) }) } },
		mongoose: { connection: { db: { collection: name => ({
			deleteMany: async () => { writes.push(name); data.set(name, []); },
			insertMany: async docs => { if (failInsert) throw new Error('insert failed'); data.set(name, docs); }
		}) } } }
	});
	return { data, writes, restore: vm.runInContext(`${restoreSource}\nrestoreBackup`, context) };
};

test('default restore excludes both session collections and clears destination sessions', async () => {
	const { data, restore } = fixture({ users: [{ restored: true }], ...Object.fromEntries(sessions.map(name => [name, [{ productionSession: true }]])) });
	const result = await restore('unused.zip');
	for (const name of sessions) assert.equal(data.get(name).length, 0);
	assert.equal(data.get('users')[0].restored, true);
	assert.deepEqual(Array.from(result, item => item.collection), ['users']);
});

test('destination sessions are cleared even when absent from ZIP', async () => {
	const { data, restore } = fixture({ users: [] });
	await restore('unused.zip');
	for (const name of sessions) assert.equal(data.get(name).length, 0);
});

test('explicit opt-in restores both session collections', async () => {
	const { data, restore } = fixture(Object.fromEntries(sessions.map(name => [name, [{ productionSession: true }]])));
	await restore('unused.zip', { includeSessions: true });
	for (const name of sessions) assert.equal(data.get(name)[0].productionSession, true);
});

test('invalid backup does not delete existing data or sessions', async () => {
	const { writes, restore } = fixture({ users: { invalid: true } });
	await assert.rejects(restore('unused.zip'), /配列ではありません/);
	assert.deepEqual(writes, []);
});

test('session invalidation precedes user replacement even if insertion fails', async () => {
	const { data, writes, restore } = fixture({ users: [{ restored: true }] }, { failInsert: true });
	await assert.rejects(restore('unused.zip'), /insert failed/);
	assert.deepEqual(writes.slice(0, 2), sessions);
	for (const name of sessions) assert.equal(data.get(name).length, 0);
});

for (const entryName of ['../users.json', 'system.users.json', 'users.json/users.json']) {
  test(`unsafe archive entry ${entryName} does not write data`, async () => {
    const name = entryName.slice(0, -5);
    const { writes, restore } = fixture({ [name]: [] });
    await assert.rejects(restore('unused.zip'), /不正なコレクション名/);
    assert.deepEqual(writes, []);
  });
}

test('actual EJSON ZIP restores ObjectId, Date and 64-bit integer types', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'common-admin-test-'));
  try {
    const zip = new AdmZip();
    const doc = { _id: new ObjectId(), createdAt: new Date('2026-10-23T00:00:00Z'), amount: Long.fromString('9223372036854775807') };
    zip.addFile('users.json', Buffer.from(EJSON.stringify([doc], { relaxed: false })));
    zip.addFile('BACKUP_META.json', Buffer.from('{"format":"mongo-ejson-v1"}'));
    const file = path.join(dir, 'backup.zip');
    zip.writeZip(file);
    const { data, restore } = fixture({}, { actualZip: true });
    await restore(file);
    const restored = data.get('users')[0];
    assert.ok(restored._id.equals(doc._id));
    assert.equal(restored.createdAt.toISOString(), doc.createdAt.toISOString());
    assert.ok(Long.isLong(restored.amount));
    assert.equal(restored.amount.toString(), doc.amount.toString());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
