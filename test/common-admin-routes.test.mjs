import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ejs from 'ejs';
import router from '../routes/commonAdmin.js';

const auth = router.stack[0].handle;
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  redirect(url) { this.redirectUrl = url; },
  render(view, locals) { this.body = ejs.render(fs.readFileSync(new URL(`../views/${view}.ejs`, import.meta.url), 'utf8'), locals); },
  type() { return this; },
  send(body) { this.body = body; },
  sendStatus(code) { this.statusCode = code; }
});
test('all common admin routes require an authenticated administrator', () => {
  for (const user of [null, { isAdmin: false }, { isAdmin: true }]) {
    const res = response(); let allowed = false;
    auth({ path: '/api/users', user, isAuthenticated: () => Boolean(user), method: 'GET' }, res, () => { allowed = true; });
    assert.equal(allowed, user?.isAdmin === true);
    if (!allowed) assert.equal(res.statusCode, 403);
  }
  const res = response();
  auth({ path: '/', isAuthenticated: () => false }, res, () => assert.fail());
  assert.equal(res.redirectUrl, '/user/login');
});
test('cross origin writes are rejected before upload or database access', () => {
  for (const headers of [{ origin: 'https://evil.example', host: 'localhost' }, { 'sec-fetch-site': 'cross-site' }]) {
    const res = response();
    auth({ path: '/api/backups/restore', user: { isAdmin: true }, isAuthenticated: () => true, method: 'POST', protocol: 'http', get: name => headers[name] }, res, () => assert.fail());
    assert.equal(res.statusCode, 403);
  }
});
const pageHandler = router.stack.find(layer => layer.route?.path === '*').route.stack[0].handle;
for (const path of ['/', '/users', '/groups', '/data']) {
  test(`migrated page ${path} has valid browser scripts and scoped links`, () => {
    const res = response(); pageHandler({ path }, res);
    assert.match(res.body, /href="\/admin\/admin-top"/);
    assert.doesNotMatch(res.body, /fetch\(['"]\/api\//);
    assert.doesNotMatch(res.body, /href="\/api\//);
    assert.doesNotMatch(res.body, /href="\/(?:users|groups|data)?"/);
    const scripts = [...res.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length);
    for (const [, script] of scripts) new vm.Script(script);
  });
}
test('unknown pages return 404', () => {
  const res = response(); pageHandler({ path: '/missing' }, res);
  assert.equal(res.statusCode, 404);
});
