import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../routes/commonAdmin.js', import.meta.url), 'utf8');
const jobSource = source.slice(source.indexOf('let manualBackupJob ='), source.indexOf("app.get('/api/backups/:filename/download'"));
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  set() { return this; },
  json(body) { this.body = structuredClone(body); return this; }
});
const fixture = createBackup => {
  const routes = {};
  vm.runInNewContext(jobSource, {
    app: { post: (url, fn) => { routes.post = fn; }, get: (url, fn) => { routes.get = fn; } },
    dataOperationRunning: false, randomUUID: () => 'test-job', createBackup,
    writeBackupLog: async () => {}, console: { error() {} }
  });
  return routes;
};
test('backup returns 202 before completion, rejects duplicate starts and exposes completion', async () => {
  let finish;
  const routes = fixture(() => new Promise(resolve => { finish = resolve; }));
  const started = response(); routes.post({}, started);
  assert.equal(started.statusCode, 202);
  assert.equal(started.body.status, 'running');
  const duplicate = response(); routes.post({}, duplicate);
  assert.equal(duplicate.statusCode, 409);
  finish({ filename: 'backup-test.zip' });
  await new Promise(resolve => setImmediate(resolve));
  const completed = response(); routes.get({ params: { id: 'test-job' } }, completed);
  assert.equal(completed.body.status, 'success');
  assert.equal(completed.body.result.filename, 'backup-test.zip');
});
test('backup failure and unknown jobs return actionable JSON', async () => {
  const routes = fixture(async () => { throw new Error('disk full'); });
  routes.post({}, response());
  await new Promise(resolve => setImmediate(resolve));
  const failed = response(); routes.get({ params: { id: 'test-job' } }, failed);
  assert.equal(failed.body.status, 'failed');
  assert.match(failed.body.error, /空き容量/);
  const missing = response(); routes.get({ params: { id: 'missing' } }, missing);
  assert.equal(missing.statusCode, 404);
});

const createBackupSource = source.slice(source.indexOf('const createBackup ='), source.indexOf('const sessionCollectionNames ='));
const retentionFixture = ({ fail = false } = {}) => {
  const removed = [];
  const events = [];
  let finish;
  const context = {
    fs: {
      mkdir: async () => {},
      readdir: async () => ['backup-old.zip', 'backup-older.zip', 'backup-new.zip', 'backup-log.json'],
      unlink: async filename => { removed.push(filename); }
    },
    path: { join: (...parts) => parts.join('/') },
    backupDir: '/backups', backupName: () => 'backup-new.zip',
    withDataOperation: operation => operation(),
    mongoose: { connection: { name: 'test', db: { listCollections: () => ({ toArray: async () => [] }) } } },
    archiver: () => ({
      on() {}, pipe() {}, append() {},
      finalize: async () => { if (fail) throw new Error('archive failed'); }
    }),
    EJSON: { stringify: JSON.stringify },
    writeBackupLog: async () => { events.push('success-log'); },
  };
  // Replace only stream construction so the actual completion/deletion ordering runs.
  const executable = createBackupSource.replace("(await import('node:fs')).createWriteStream(target)", 'makeOutput()');
  context.makeOutput = () => ({ on(event, callback) { if (event === 'close') finish = callback; } });
  vm.runInNewContext(`${executable}\nthis.runBackup = createBackup;`, context);
  return { run: () => context.runBackup('automatic'), removed, events, finish: () => finish() };
};

test('automatic backup deletes old ZIPs only after the new ZIP closes and success is recorded', async () => {
  const fixture = retentionFixture();
  const running = fixture.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.removed, []);
  assert.deepEqual(fixture.events, []);
  fixture.finish();
  const result = await running;
  assert.equal(result.filename, 'backup-new.zip');
  assert.deepEqual(fixture.events, ['success-log']);
  assert.deepEqual(fixture.removed.sort(), ['/backups/backup-old.zip', '/backups/backup-older.zip']);
});

test('failed automatic backup preserves previous ZIPs', async () => {
  const fixture = retentionFixture({ fail: true });
  await assert.rejects(fixture.run(), /archive failed/);
  assert.deepEqual(fixture.removed, []);
  assert.deepEqual(fixture.events, []);
});
