'use strict';

/* ============================================================
   server.js 内部函数测试
   ------------------------------------------------------------
   用 LEDGER_HOME 把数据目录指到临时目录，绝不读写真实账目。
   server.js 顶层常量在 require 时取环境变量，所以必须先设再 require。
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
process.env.LEDGER_HOME = tmpHome;
/* 备份上限压到 3，方便验证裁剪逻辑（const 在 require 时读环境变量） */
process.env.LEDGER_BACKUP_KEEP = '3';

const S = require('../server.js');

/* ---------- 读写 ---------- */

test('readData：文件不存在时空账本 rev=0', () => {
  const cur = S.readData();
  assert.strictEqual(cur.rev, 0);
  assert.strictEqual(cur.savedAt, null);
  assert.deepStrictEqual(cur.data.transactions, []);
});

test('writeData 写入后 readData 读回一致', () => {
  S.writeData(7, { version: 1, categories: [], transactions: [{ id: 'a', amount: 1 }], createdAt: 1 });
  const cur = S.readData();
  assert.strictEqual(cur.rev, 7);
  assert.strictEqual(cur.data.transactions.length, 1);
  assert.strictEqual(cur.data.transactions[0].id, 'a');
});

test('readData：JSON 损坏时改名留证并回到空账本', () => {
  fs.writeFileSync(path.join(tmpHome, 'data', 'ledger.json'), '{这是坏json');
  const cur = S.readData();
  assert.strictEqual(cur.rev, 0);
  const files = fs.readdirSync(path.join(tmpHome, 'data'));
  assert.ok(files.some(f => f.indexOf('.corrupt-') > 0), '损坏文件应被改名保留');
});

/* ---------- sanitize ---------- */

test('sanitize：分类上限 300，结构字段白名单', () => {
  const cats = Array.from({ length: 400 }, (_, i) => ({ id: 'c' + i, kind: 'expense', name: 'C' + i }));
  const out = S.sanitize({ categories: cats, transactions: [], extra: '不该出现的字段' });
  assert.strictEqual(out.categories.length, 300, '分类上限 300');
  assert.strictEqual(out.categories[0].id, 'c0', '顺序保持');
  assert.strictEqual(out.transactions.length, 0);
  assert.strictEqual(out.version, 1);
  assert.strictEqual(out.extra, undefined);
  /* 账本里有不计收支的账目、分类表里却没有这个分类时，服务端会把它补回来 */
  const withTransfer = S.sanitize({
    categories: [{ id: 'food', kind: 'expense', name: '餐饮' }],
    transactions: [{ id: 't', type: 'transfer', amount: 100, date: '2026-05-01' }]
  });
  assert.strictEqual(withTransfer.categories[0].id, 'transfer');
  assert.strictEqual(withTransfer.transactions[0].categoryId, 'transfer');
});

test('sanitize：逐笔清洗账目（坏账丢弃），缺分类回落默认分类', () => {
  const out = S.sanitize({
    transactions: [
      { id: 'a', amount: 5 },
      { amount: 1 },                    // 无 id → 丢
      { id: 'b', amount: '不是数字' }    // 金额非法 → 丢
    ]
  });
  assert.strictEqual(out.transactions.length, 1);
  assert.strictEqual(out.transactions[0].id, 'a');
  assert.ok(out.categories.length >= 16, '没有分类时给默认分类兜底');
});

/* ---------- 静态白名单 ---------- */

test('isServable 白名单：只放行 index.html 与 assets/', () => {
  const root = path.resolve(__dirname, '..');
  /* 一律用 path.join 逐段拼路径。直接写 'assets\\app.js' 只在 Windows 上成立：
     POSIX 的 path 不认反斜杠，整串会变成一个叫 "assets\app.js" 的**单段**文件名，
     于是落进「根目录白名单」分支被拒——断言假失败（CI 上就是这么红的）。 */
  const ok = (...segs) => S.isServable(path.join(root, ...segs));
  assert.ok(ok('index.html'));
  assert.ok(ok('assets', 'app.js'));
  assert.ok(ok('assets', 'core.js'));
  assert.ok(ok('manifest.webmanifest'), 'PWA manifest 放行');
  assert.ok(ok('sw.js'), 'Service Worker 放行');
  assert.ok(!ok('data', 'ledger.json'), 'data 目录不放行');
  assert.ok(!ok('DATA', 'ledger.json'), '大小写换个写法也拦得住（比较前统一转小写）');
  assert.ok(!ok('.git', 'config'), '隐藏文件不放行');
  assert.ok(!ok('README.md'), '根目录只放行 index.html');
  assert.ok(!ok('server.js'));
  assert.ok(!ok('..', 'outside.txt'), '越出根目录不放行');
});

/* ---------- 同站校验 ---------- */

test('sameOrigin：无 Origin 放行，Host 对不上拒绝', () => {
  assert.strictEqual(S.sameOrigin({ headers: {} }), true);
  assert.strictEqual(S.sameOrigin({ headers: { origin: 'http://localhost:8765', host: 'localhost:8765' } }), true);
  assert.strictEqual(S.sameOrigin({ headers: { origin: 'http://evil.example', host: 'localhost:8765' } }), false);
  assert.strictEqual(S.sameOrigin({ headers: { origin: '::::not-a-url', host: 'x' } }), false);
});

/* ---------- 局域网口令 ---------- */

test('isValidPin：只认 6 位数字', () => {
  assert.ok(S.isValidPin('012345'));
  assert.ok(S.isValidPin('999999'));
  assert.ok(!S.isValidPin('12345'), '5 位不行');
  assert.ok(!S.isValidPin('1234567'), '7 位不行');
  assert.ok(!S.isValidPin('12345a'));
  assert.ok(!S.isValidPin(''), '空不行');
  assert.ok(!S.isValidPin(null));
  assert.ok(!S.isValidPin(' 123456'));
  /* 数字类型会被 String() 收下（接口那边统一 String(pin)，不折腾调用方），
     但 5 位数字号照样不行 */
  assert.ok(S.isValidPin(123456));
  assert.ok(!S.isValidPin(12345));
});

test('genPin：总是 6 位数字（前导零要补齐）', () => {
  for (let i = 0; i < 500; i++) {
    const pin = S.genPin();
    assert.strictEqual(pin.length, 6, '生成了 ' + pin);
    assert.ok(S.isValidPin(pin));
  }
});

test('authToken：口令决定凭据，换口令即失效', () => {
  S.rotatePin('111111');
  const a = S.authToken();
  assert.match(a, /^[0-9a-f]{64}$/, '凭据是 HMAC-SHA256 的十六进制');
  assert.strictEqual(S.authToken(), a, '同一口令每次算出来一样（重启后设备不用重输）');
  assert.ok(a.indexOf('111111') < 0, '凭据里不能出现口令本身');
  S.rotatePin('222222');
  assert.notStrictEqual(S.authToken(), a, '换口令后旧凭据必须失效');
});

test('safeEqual：相等才算过，长度不同直接拒', () => {
  assert.ok(S.safeEqual('abc123', 'abc123'));
  assert.ok(!S.safeEqual('abc123', 'abc124'));
  assert.ok(!S.safeEqual('abc123', 'abc12'));
  assert.ok(!S.safeEqual('', ''));
  assert.ok(!S.safeEqual(null, 'abc'));
});

test('rotatePin：写入设置文件，重启后能读回同一口令', () => {
  assert.ok(S.rotatePin('654321'));
  assert.ok(!S.rotatePin('12345'), '格式不对不落盘');
  assert.strictEqual(S.readSettings().pin, '654321');
});

test('口令失败限速：错 5 次锁住，成功一次清零', () => {
  const req = { socket: { remoteAddress: '192.0.2.99' } };
  S.clearAuthFail(req);
  for (let i = 0; i < 4; i++) {
    S.noteAuthFail(req);
    assert.strictEqual(S.authLockLeft(req), 0, '前 4 次还没到上限');
  }
  S.noteAuthFail(req);
  assert.ok(S.authLockLeft(req) > 0, '第 5 次后进入锁定');
  S.clearAuthFail(req);
  assert.strictEqual(S.authLockLeft(req), 0, '验证成功后立刻解锁');
});

/* ---------- 安全响应头 ---------- */

test('页面响应带 CSP 等安全头，且不允许内联脚本与嵌套', () => {
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverJs, /Content-Security-Policy/, '要有 CSP');
  assert.match(serverJs, /applySecurityHeaders\(res\)/, '每个请求都要挂上');
  assert.match(serverJs, /frame-ancestors 'none'/);
  assert.ok(!/'unsafe-inline'/.test(serverJs), 'CSP 不能放行内联脚本');
  assert.match(serverJs, /X-Content-Type-Options/);
});

/* ---------- 静态检查脚本能跑通（前端 id 引用 / 文件清单） ---------- */

test('tools/check-dom.js：index.html 与 app.js 的 id、缓存清单一致', async () => {
  const { execFile } = require('node:child_process');
  /* 异步 execFile，不是 execFileSync：本机上「同步」spawn 同一个 node.exe 会稳定拿到
     EBUSY（Windows 的进程/文件锁），异步方式没有这个问题；Linux 上两者一样。 */
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'tools', 'check-dom.js')],
      { encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout)));
  });
  assert.match(out, /前端静态检查通过/);
});

test('snapshotBackup：文件不存在时不生成备份', () => {
  const dir = path.join(tmpHome, 'data', 'backups');
  fs.rmSync(dir, { recursive: true, force: true });
  S.snapshotBackup();
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).filter(f => f.indexOf('ledger-') === 0).length === 0);
});

test('snapshotBackup：内容变化后再次保存会新增一份留档', () => {
  const dataFile = path.join(tmpHome, 'data', 'ledger.json');
  const backupDir = path.join(tmpHome, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  fs.writeFileSync(dataFile, '内容一');
  S.snapshotBackup();
  fs.writeFileSync(dataFile, '内容二');
  S.snapshotBackup();
  const backups = fs.readdirSync(backupDir).filter(f => /^ledger-.*\.json$/.test(f));
  assert.ok(backups.length >= 2, '两次不同内容的保存都应留档');
});

test('snapshotBackup：内容不变不重复留档（哈希去重）', () => {
  const dataFile = path.join(tmpHome, 'data', 'ledger.json');
  const backupDir = path.join(tmpHome, 'data', 'backups');
  fs.rmSync(backupDir, { recursive: true, force: true });   // 清掉前一个用例的备份
  fs.mkdirSync(backupDir, { recursive: true });

  fs.writeFileSync(dataFile, '去重测试-相同内容');
  S.snapshotBackup();
  S.snapshotBackup();
  S.snapshotBackup();
  const count = (dir) => fs.readdirSync(dir).filter(f => /^ledger-.*\.json$/.test(f)).length;
  assert.strictEqual(count(backupDir), 1, '相同内容只留一份');

  fs.writeFileSync(dataFile, '去重测试-改了内容');
  S.snapshotBackup();
  assert.strictEqual(count(backupDir), 2, '内容变了要留新档');

  const hashes = JSON.parse(fs.readFileSync(path.join(backupDir, 'hashes.json'), 'utf8'));
  assert.strictEqual(hashes.length, 2, '哈希清单与备份份数一致');
});

test('snapshotBackup：超过上限时裁掉最旧的', () => {
  const dataFile = path.join(tmpHome, 'data', 'ledger.json');
  const backupDir = path.join(tmpHome, 'data', 'backups');
  fs.rmSync(backupDir, { recursive: true, force: true });   // 清掉前一个用例的备份
  fs.mkdirSync(backupDir, { recursive: true });

  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(dataFile, '裁剪测试-' + i);
    S.snapshotBackup();
  }
  const backups = fs.readdirSync(backupDir).filter(f => /^ledger-.*\.json$/.test(f));
  assert.strictEqual(backups.length, 3, '上限 3 份（本文件进程的 LEDGER_BACKUP_KEEP）');
  const hashes = JSON.parse(fs.readFileSync(path.join(backupDir, 'hashes.json'), 'utf8'));
  assert.strictEqual(hashes.length, 3, '哈希清单同步裁剪');
  /* 留下的应是最新三份：文件名含时间戳，字典序即时间序 */
  assert.ok(backups.every((f, i, arr) => i === 0 || arr[i - 1] <= f));
});
