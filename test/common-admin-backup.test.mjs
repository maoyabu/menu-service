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
