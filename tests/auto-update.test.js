'use strict';

/* ============================================================
   tools/auto-update.js 的纯逻辑测试
   ------------------------------------------------------------
   只测不需要网络、不需要真实仓库的那部分：远程地址解析、
   路径安全、tar / gzip 解包、保护名单、状态文件与覆盖写入。

   跑法：node --test tests/auto-update.test.js
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const U = require('../tools/auto-update.js');

/* ---------- 造 tar 的小工具（只在测试里用） ---------- */

function header(name, size, typeflag, opts) {
  const o = opts || {};
  const head = Buffer.alloc(512);
  head.write(o.paxPath ? o.paxPath : name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
  head.write('0000644\0', 100, 'latin1');
  head.write('0000000\0', 108, 'latin1');
  head.write('0000000\0', 116, 'latin1');
  head.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  head.write('00000000000\0', 136, 'latin1');
  head.write('        ', 148, 'latin1');
  head.write(typeflag, 156, 'latin1');
  head.write('ustar\0', 257, 'latin1');
  head.write('00', 263, 'latin1');
  if (o.prefix) { head.write(o.prefix, 345, 'latin1'); }
  let sum = 0;
  for (const b of head) { sum += b; }
  head.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return head;
}

function pad(data) {
  const rest = data.length % 512;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rest);
}

function tarFile(name, content, opts) {
  const data = Buffer.from(content, 'utf8');
  return Buffer.concat([header(name, data.length, '0', opts), data, pad(data)]);
}

function tarDir(name) {
  return header(name, 0, '5', {});
}

const TAR_END = Buffer.alloc(1024);

/* PAX 记录：`总长 key=value\n`（长度和 key 之间有一个空格），
   总长要把自己那几位数字算进去，所以要迭代着凑 */
function paxRecord(key, value) {
  const body = ' ' + key + '=' + value + '\n';
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(len)) + Buffer.byteLength(body) !== len) {
    len = Buffer.byteLength(String(len)) + Buffer.byteLength(body);
  }
  return Buffer.from(String(len) + body, 'utf8');
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-update-test-'));
}

/* ---------- 1. 远程地址解析 ---------- */

test('parseRepoSlug：认得 https / scp / ssh 三种写法', () => {
  const cases = [
    ['https://github.com/BUR9ERR/expense-ledger.git', 'BUR9ERR/expense-ledger', 'github.com'],
    ['https://github.com/BUR9ERR/expense-ledger', 'BUR9ERR/expense-ledger', 'github.com'],
    ['git@github.com:BUR9ERR/expense-ledger.git', 'BUR9ERR/expense-ledger', 'github.com'],
    ['ssh://git@github.com/BUR9ERR/expense-ledger.git', 'BUR9ERR/expense-ledger', 'github.com'],
    ['https://gitee.com/some/one.git', 'some/one', 'gitee.com'],
    ['  https://github.com/a/b.git  ', 'a/b', 'github.com'],
  ];
  for (const [input, slug, host] of cases) {
    const r = U.parseRepoSlug(input);
    assert.ok(r, '应该能解析：' + input);
    assert.strictEqual(r.slug, slug, input);
    assert.strictEqual(r.host, host, input);
  }
});

test('parseRepoSlug：认不出来的一律返回 null', () => {
  for (const bad of ['', null, undefined, 'not-a-url', 'https://github.com/onlyowner', 'main']) {
    assert.strictEqual(U.parseRepoSlug(bad), null, String(bad));
  }
});

/* ---------- 2. 路径安全 ---------- */

test('normalizeRel：正常路径洗成统一的相对路径', () => {
  assert.strictEqual(U.normalizeRel('a/b/c.js'), 'a/b/c.js');
  assert.strictEqual(U.normalizeRel('./a/b'), 'a/b');
  assert.strictEqual(U.normalizeRel('a//b///c'), 'a/b/c');
  assert.strictEqual(U.normalizeRel('a\\b\\c'), 'a/b/c');
  assert.strictEqual(U.normalizeRel('a/./b'), 'a/b');
});

test('normalizeRel：越界的路径一律判死', () => {
  for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/x', '..', '', null, 'a/..']) {
    assert.strictEqual(U.normalizeRel(bad), null, String(bad));
  }
});

test('isProtected：账目与本机专属文件都在保护名单里', () => {
  const must = [
    'data/ledger.json', 'data/backups/x.json', 'dist/记账本.exe',
    '.git/config', '.workbuddy/memory/2026-10-13.md', 'node_modules/x/y.js',
    '.mimosa/reports/a.json',
    '_node_path.txt', '_update-state.json', '_update-backup/1/index.html',
    'sub/_anything.txt', 'assets/x.genie',
  ];
  for (const p of must) { assert.strictEqual(U.isProtected(p), true, p); }

  const mustNot = [
    'index.html', 'server.js', 'assets/app.js', 'tools/auto-update.js',
    'tests/core.test.js', 'README.md', '.gitignore', '.gitattributes',
    'docs/preview-list.png',
  ];
  for (const p of mustNot) { assert.strictEqual(U.isProtected(p), false, p); }
});

/* ---------- 3. tar / gzip ---------- */

test('untar：普通文件与目录都能解出来', () => {
  const tar = Buffer.concat([
    tarDir('repo-main/'),
    tarDir('repo-main/assets/'),
    tarFile('repo-main/index.html', '<html></html>'),
    tarFile('repo-main/assets/app.js', 'console.log(1)'),
    TAR_END,
  ]);
  const got = U.untar(tar);
  const byPath = new Map(got.map((e) => [e.path, e]));
  assert.strictEqual(byPath.get('repo-main/index.html').type, 'file');
  assert.strictEqual(byPath.get('repo-main/index.html').data.toString('utf8'), '<html></html>');
  /* 目录条目统一去掉结尾斜杠，方便和远程文件清单一起比对 */
  assert.strictEqual(byPath.get('repo-main/assets').type, 'dir');
  assert.strictEqual(byPath.get('repo-main/assets/app.js').data.toString('utf8'), 'console.log(1)');
});

test('untar：512 字节对齐——跨块的文件内容不能串位', () => {
  const big = 'x'.repeat(1000);            /* 跨两个数据块 */
  const tar = Buffer.concat([
    tarFile('a/big.txt', big),
    tarFile('a/small.txt', 'ok'),
    TAR_END,
  ]);
  const got = U.untar(tar);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].data.toString('utf8'), big);
  assert.strictEqual(got[1].path, 'a/small.txt');
  assert.strictEqual(got[1].data.toString('utf8'), 'ok');
});

test('untar：PAX 扩展头里的长路径能认出来', () => {
  const long = 'repo-main/' + 'deep/'.repeat(40) + 'file.js';
  const rec = paxRecord('path', long);
  const tar = Buffer.concat([
    header('pax', rec.length, 'x', {}), rec, pad(rec),
    tarFile('fallback-name', 'body'),
    TAR_END,
  ]);
  const got = U.untar(tar);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].path, long);
  assert.strictEqual(got[0].data.toString('utf8'), 'body');
});

test('untar：GNU 长文件名（typeflag L）也能认出来', () => {
  const long = 'repo-main/' + 'x'.repeat(120) + '.js';
  const nameBuf = Buffer.from(long + '\0', 'utf8');
  const tar = Buffer.concat([
    header('././@LongLink', nameBuf.length, 'L', {}), nameBuf, pad(nameBuf),
    tarFile('truncated', 'body'),
    TAR_END,
  ]);
  const got = U.untar(tar);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].path, long);
});

test('untar：压缩包里塞越界路径会被丢掉，不会带出来', () => {
  const tar = Buffer.concat([
    tarFile('repo-main/ok.txt', 'ok'),
    tarFile('../../evil.txt', 'nope'),
    tarFile('/tmp/evil2.txt', 'nope'),
    TAR_END,
  ]);
  const got = U.untar(tar);
  assert.deepStrictEqual(got.map((e) => e.path), ['repo-main/ok.txt']);
});

test('untarGz：gzip 包解开后和裸 tar 一致', () => {
  const tar = Buffer.concat([tarFile('repo-main/a.txt', 'hi'), TAR_END]);
  const gz = zlib.gzipSync(tar);
  const got = U.untarGz(gz);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].data.toString('utf8'), 'hi');
});

test('stripTopDir：只有一层公共首层时才剥掉', () => {
  const one = U.stripTopDir([
    { path: 'repo-main/a.txt', type: 'file', data: Buffer.from('a') },
    { path: 'repo-main/deep/b.txt', type: 'file', data: Buffer.from('b') },
  ]);
  assert.deepStrictEqual(one.map((e) => e.path), ['a.txt', 'deep/b.txt']);

  const mixed = U.stripTopDir([
    { path: 'a/x.txt', type: 'file', data: Buffer.alloc(0) },
    { path: 'b/y.txt', type: 'file', data: Buffer.alloc(0) },
  ]);
  assert.deepStrictEqual(mixed.map((e) => e.path), ['a/x.txt', 'b/y.txt']);

  const onlyRoot = U.stripTopDir([{ path: 'repo-main', type: 'dir', data: Buffer.alloc(0) }]);
  assert.deepStrictEqual(onlyRoot, []);
});

/* ---------- 4. 参数解析 ---------- */

test('parseArgs：短横线、长横线、--k=v 三种都认', () => {
  assert.deepStrictEqual(U.parseArgs([]), {
    check: false, yes: false, force: false, verbose: false, help: false,
    branch: '', repo: '', backup: true,
  });
  const a = U.parseArgs(['--check', '--yes', '-f', '-v', '--no-backup']);
  assert.strictEqual(a.check, true);
  assert.strictEqual(a.yes, true);
  assert.strictEqual(a.force, true);
  assert.strictEqual(a.verbose, true);
  assert.strictEqual(a.backup, false);

  assert.strictEqual(U.parseArgs(['--branch', 'dev']).branch, 'dev');
  assert.strictEqual(U.parseArgs(['--branch=dev']).branch, 'dev');
  assert.strictEqual(U.parseArgs(['-b', 'dev']).branch, 'dev');
  assert.strictEqual(U.parseArgs(['--repo', 'a/b']).repo, 'a/b');
  assert.strictEqual(U.parseArgs(['--repo=a/b']).repo, 'a/b');
});

/* ---------- 5. 覆盖写入 ---------- */

test('applyEntries：新增 / 覆盖 / 内容没变跳过，保护名单一律不动', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'ledger.json'), '{"mine":true}');
    fs.writeFileSync(path.join(dir, '_node_path.txt'), 'D:\\node.exe');
    fs.writeFileSync(path.join(dir, 'index.html'), '旧内容');

    const before = fs.readFileSync(path.join(dir, 'data', 'ledger.json'), 'utf8');
    const nodePath = fs.readFileSync(path.join(dir, '_node_path.txt'), 'utf8');

    const entries = [
      { path: 'index.html', type: 'file', data: Buffer.from('新内容') },
      { path: 'server.js', type: 'file', data: Buffer.from('新增的') },
      { path: 'README.md', type: 'file', data: Buffer.from('没变') },
      { path: 'data/ledger.json', type: 'file', data: Buffer.from('{"bad":true}') },
      { path: '_node_path.txt', type: 'file', data: Buffer.from('C:\\别的') },
      { path: 'dist/x.exe', type: 'file', data: Buffer.from('bin') },
    ];
    fs.writeFileSync(path.join(dir, 'README.md'), '没变');

    const r = U.applyEntries(entries, { root: dir, backup: true });

    assert.deepStrictEqual(r.added, ['server.js']);
    assert.deepStrictEqual(r.modified, ['index.html']);
    assert.strictEqual(r.unchanged, 1);

    assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '新内容');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), '新增的');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'data', 'ledger.json'), 'utf8'), before);
    assert.strictEqual(fs.readFileSync(path.join(dir, '_node_path.txt'), 'utf8'), nodePath);
    assert.strictEqual(fs.existsSync(path.join(dir, 'dist', 'x.exe')), false);

    /* 被覆盖的那个原件应该有一份留底 */
    assert.ok(r.backupDir, '应该建了留底目录');
    assert.strictEqual(fs.readFileSync(path.join(r.backupDir, 'index.html'), 'utf8'), '旧内容');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyEntries：同一个文件写两遍，第二遍算「没变」', () => {
  const dir = tmpDir();
  try {
    const e = [{ path: 'a.txt', type: 'file', data: Buffer.from('v1') }];
    const first = U.applyEntries(e, { root: dir, backup: false });
    assert.deepStrictEqual(first.added, ['a.txt']);

    const second = U.applyEntries(e, { root: dir, backup: false });
    assert.deepStrictEqual(second.added, []);
    assert.deepStrictEqual(second.modified, []);
    assert.strictEqual(second.unchanged, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyEntries：--no-backup 时不建留底目录', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), '旧');
    const r = U.applyEntries(
      [{ path: 'a.txt', type: 'file', data: Buffer.from('新') }],
      { root: dir, backup: false });
    assert.strictEqual(r.backedUp, 0);
    assert.strictEqual(r.backupDir, null);
    assert.strictEqual(fs.existsSync(path.join(dir, '_update-backup')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 6. 遍历 ---------- */

test('walkFiles：列出文件、跳过 .git、路径统一用正斜杠', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), 'x');
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'x');
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'x');

    const got = U.walkFiles(dir).sort();
    assert.deepStrictEqual(got, ['assets/app.js', 'index.html']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneBackups：留底超过上限时裁掉最旧的', () => {
  const dir = tmpDir();
  try {
    const root = path.join(dir, '_update-backup');
    for (const name of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'x.txt'), 'x');
    }
    U.pruneBackups(dir);
    const left = fs.readdirSync(root).sort();
    assert.strictEqual(left.length, 3);
    assert.deepStrictEqual(left, ['2026-01-03', '2026-01-04', '2026-01-05']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 7. 离线冒烟：脚本本身能被 require 且不发请求 ---------- */

test('脚本能被 require，导出的东西齐备（require 阶段不碰网络）', () => {
  for (const k of ['parseRepoSlug', 'normalizeRel', 'isProtected', 'untar', 'untarGz',
    'stripTopDir', 'walkFiles', 'parseArgs', 'applyEntries', 'pruneBackups']) {
    assert.strictEqual(typeof U[k], 'function', k);
  }
  assert.strictEqual(U.DEFAULT_BRANCH, 'main');
  assert.match(U.DEFAULT_SLUG, /^[^/]+\/[^/]+$/);
  assert.strictEqual(path.basename(U.ROOT), 'expense-ledger');
});
