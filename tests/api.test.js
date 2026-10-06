'use strict';

/* ============================================================
   /api 接口的实机测试（真实 HTTP 往返）
   ------------------------------------------------------------
   把 server.js 的 handleRequest 挂到自己的端口上跑，测的是
   「手机能不能拿到口令」「换口令后旧凭据还灵不灵」这类只有走完整
   路由才看得出来的事。

   LEDGER_FAKE_IP / LEDGER_FAKE_LAN 是 server.js 里专供测试的两个开关
   （见那边的注释）：单进程里轮流扮演「本机」和「局域网设备」。
   数据目录由 LEDGER_HOME 指到临时目录，绝不读写真实账目。

   单独一个文件的原因：本文件会写 data/ledger.json，
   而 server.test.js 里「文件不存在」的用例要求那个文件不存在。
   运行：node --test tests/api.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-api-test-'));
process.env.LEDGER_HOME = tmpHome;

const S = require('../server.js');

/* ---------- 实机接口（真实 HTTP 往返） ----------
   直接把 server.js 的 handleRequest 挂到自己的端口上跑，测的是
   「手机能不能拿到口令」「换口令后旧凭据还灵不灵」这类只有走完整
   路由才看得出来的事。
   LEDGER_FAKE_IP / LEDGER_FAKE_LAN 是 server.js 里专供测试的开关
   （见那边的注释）：单进程里轮流扮演「本机」和「局域网设备」。 */

const http = require('node:http');

let srv = null;
let port = 0;

/* 端口与服务在第一次需要时才起：node:test 会并发跑本文件里的用例，
   如果在 before 里起服务并写数据文件，会打乱前面「文件不存在」这类
   用例的前提。 */
async function ensureServer() {
  if (srv) { return; }
  srv = http.createServer(S.handleRequest);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  port = srv.address().port;
}

async function httpReq(method, urlPath, opts = {}) {
  await ensureServer();
  /* 用全局 fetch（Node 18+ 自带）：不用手拼请求对象，响应头转普通对象 */
  const res = await fetch('http://127.0.0.1:' + port + urlPath, {
    method: method,
    headers: opts.headers || {},
    body: opts.body
  });
  const text = await res.text();
  const headers = {};
  for (const [name, value] of res.headers.entries()) { headers[name] = value; }
  return { status: res.status, headers: headers, text: text };
}
const postJson = (urlPath, obj) => httpReq('POST', urlPath, {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});
const asLan = () => { process.env.LEDGER_FAKE_IP = '192.0.2.50'; process.env.LEDGER_FAKE_LAN = '1'; };
const asLocal = () => { delete process.env.LEDGER_FAKE_IP; process.env.LEDGER_FAKE_LAN = '1'; };

test.after(() => {
  delete process.env.LEDGER_FAKE_IP;
  delete process.env.LEDGER_FAKE_LAN;
  if (srv) { srv.close(); }
});

test('实机：本机看得到口令，未验证的局域网设备一个字都拿不到', async () => {
  /* 夹具口令：纯测试值，与任何真实使用过的口令无关 */
  S.rotatePin('864209');
  S.writeData(1, { version: 1, categories: [], transactions: [{ id: 'x', amount: 1, date: '2026-10-01' }] });
  asLocal();
  const local = await httpReq('GET', '/api/info');
  const jl = JSON.parse(local.text);
  assert.strictEqual(local.status, 200);
  assert.strictEqual(jl.pin, S.readSettings().pin);
  assert.strictEqual(jl.local, true);
  assert.strictEqual(jl.pinRequired, true);

  asLan();
  const remote = await httpReq('GET', '/api/info');
  assert.strictEqual(remote.status, 401, '没验证过就必须 401');
  assert.strictEqual(JSON.parse(remote.text).pin, undefined, '响应里不能带口令');

  const db = await httpReq('GET', '/api/db');
  assert.strictEqual(db.status, 401, '账目也读不到');
});

test('实机：改口令只能在本机，直接填新口令即可', async () => {
  asLan();
  const fromLan = await postJson('/api/pin', { pin: '111111' });
  assert.ok(fromLan.status === 401 || fromLan.status === 403,
    '局域网设备改不了口令，实得 ' + fromLan.status);

  asLocal();
  const badNew = await postJson('/api/pin', { pin: '123' });
  assert.strictEqual(badNew.status, 400, '新口令必须 6 位');

  const ok = await postJson('/api/pin', { pin: '246810' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.text).pin, '246810');
  assert.strictEqual(S.readSettings().pin, '246810', '新口令要落盘');
});

test('实机：口令验证发的是派生凭据，换口令后旧凭据立刻失效', async () => {
  asLocal();
  await postJson('/api/pin', { pin: '135790' });

  asLan();
  const good = await postJson('/api/auth', { pin: '135790' });
  assert.strictEqual(good.status, 200);
  const cookie = String(good.headers['set-cookie'] || '');
  assert.ok(cookie.indexOf('135790') < 0, 'Cookie 里不能有明文口令');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const token = cookie.match(/ledger_auth=([^;]+)/)[1];

  const withCookie = await httpReq('GET', '/api/db', { headers: { Cookie: 'ledger_auth=' + token } });
  assert.strictEqual(withCookie.status, 200, '带凭据就能读账目');

  /* 换口令 = 踢掉所有已授权设备（这是「换口令」该有的效果） */
  asLocal();
  const again = await postJson('/api/pin', { pin: '112233' });
  assert.strictEqual(again.status, 200);

  asLan();
  const stale = await httpReq('GET', '/api/db', { headers: { Cookie: 'ledger_auth=' + token } });
  assert.strictEqual(stale.status, 401, '旧凭据必须失效');

  const oldPin = await postJson('/api/auth', { pin: '135790' });
  assert.strictEqual(oldPin.status, 403, '旧口令不再有效');
  const newPin = await postJson('/api/auth', { pin: '112233' });
  assert.strictEqual(newPin.status, 200, '新口令可以验证');
});

test('实机：历史版本只在本机可列可恢复，恢复会把账本换回去', async () => {
  /* 造两份历史版本：先写 2 笔并存档，再写 5 笔并存档 */
  asLocal();
  S.writeData(1, {
    version: 1, categories: [],
    transactions: [{ id: 'a', amount: 1, date: '2026-05-01' }, { id: 'b', amount: 2, date: '2026-05-02' }]
  });
  S.snapshotBackup();
  S.writeData(2, {
    version: 1, categories: [],
    transactions: [
      { id: 'a', amount: 1, date: '2026-05-01' }, { id: 'b', amount: 2, date: '2026-05-02' },
      { id: 'c', amount: 3, date: '2026-05-03' }, { id: 'd', amount: 4, date: '2026-05-04' },
      { id: 'e', amount: 5, date: '2026-05-05' }
    ]
  });
  S.snapshotBackup();

  /* 列出：新的在前，能看出各有多少笔 */
  const listed = await httpReq('GET', '/api/backups');
  assert.strictEqual(listed.status, 200);
  const list = JSON.parse(listed.text).backups;
  assert.ok(list.length >= 2, '至少两份历史版本，实得 ' + list.length);
  assert.ok(list[0].at >= list[list.length - 1].at, '新的排前面');
  assert.ok(list.some((b) => b.count === 2), '能看出那份是 2 笔');
  assert.ok(list.every((b) => b.file.indexOf('ledger-') === 0), '文件名来自服务端清单');

  /* 恢复那份 2 笔的：账本变回 2 笔，rev 继续往上加 */
  const old = list.filter((b) => b.count === 2)[0];
  const before = S.readData();
  const restored = await httpReq('POST', '/api/backups', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: old.file })
  });
  assert.strictEqual(restored.status, 200, restored.text);
  const body = JSON.parse(restored.text);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.count, 2);
  const after = S.readData();
  assert.strictEqual(after.data.transactions.length, 2, '账本换回那一刻的样子');
  assert.ok(after.rev > before.rev, 'rev 继续递增，别的设备能看出来变了');
  assert.ok(body.backups.length > list.length - 1, '恢复前把当前状态也留了一份档');

  /* 路径不能从外面传：只认清单里的文件名 */
  const evil = await httpReq('POST', '/api/backups', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: '../../ledger.json' })
  });
  assert.strictEqual(evil.status, 400, '不认的文件名一律拒绝');

  /* 局域网上的设备连列都不给列 */
  asLan();
  const remote = await httpReq('GET', '/api/backups');
  assert.strictEqual(remote.status, 401, '没验证的设备先被口令闸挡下');
  process.env.LEDGER_FAKE_LAN = '0';
  const remote2 = await httpReq('GET', '/api/backups');
  assert.strictEqual(remote2.status, 403, '就算关了局域网开关，非本机也一律 403');
  process.env.LEDGER_FAKE_LAN = '1';
  const remote3 = await httpReq('POST', '/api/backups', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: old.file })
  });
  assert.ok(remote3.status === 401 || remote3.status === 403, '别想把整本账换掉');
});

test('实机：静态页面只放白名单，且带安全响应头', async () => {
  asLocal();
  const page = await httpReq('GET', '/index.html');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.strictEqual(page.headers['x-frame-options'], 'DENY');
  assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');

  for (const bad of ['/data/settings.json', '/server.js', '/assets/../data/ledger.json', '/.git/config']) {
    const res = await httpReq('GET', bad);
    assert.ok(res.status === 403 || res.status === 404, bad + ' 不该能下载（实得 ' + res.status + '）');
  }
});

