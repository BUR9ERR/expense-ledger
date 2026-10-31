'use strict';

/* ============================================================
   记账本 · 自动更新（tools/auto-update.js）
   ------------------------------------------------------------
   检查 GitHub 上的仓库有没有新提交，有就更新到本机。
   零依赖，只用 Node 内置模块（http / https / net / tls / zlib / fs）。

   两条路径，脚本自己选：
     · 有 .git 且装了 git  → 走 git：fetch 后快进合并，本地改动一律不动
     · 没有 .git（解压 ZIP 装的）→ 下载源码包，按文件覆盖

   更新不会碰这些（它们不属于版本库，或者属于你自己的东西）：
     data/           你的账目（本来就在 .gitignore 里）
     _*              本机专属文件（_node_path.txt、_update-state.json …）
     dist/ .git/ .workbuddy/ node_modules/ .mimosa/  *.genie
   脚本也**从不删除文件**——远程删掉的东西只会被列出来提醒你，不会替你动手。

   用法：
     node tools/auto-update.js            检查；有更新就问一句要不要装
     node tools/auto-update.js --check    只看一眼，绝不改动（适合定时任务）
     node tools/auto-update.js --yes      有更新就直接装，不再问
     node tools/auto-update.js --force    git 工作区有本地改动时也强行对齐远程
     node tools/auto-update.js --branch dev        跟随别的分支（默认 main）
     node tools/auto-update.js --repo a/b          换仓库（默认从 git 远程读）
     node tools/auto-update.js --no-backup         覆盖前不留底（默认留）

   退出码：
     0   已是最新，或者更新成功
     1   出错（网络不通、git 报错、没有写权限……）
     2   有更新但没装（你拒绝了，或工作区有改动需要先处理）
     10  --check 模式下「有更新」
   ============================================================ */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* 默认跟这个仓库。git 模式下会优先用本仓库 remote 里配的地址，
   所以 fork 出去的人不用改代码，--repo 也能临时换。 */
const DEFAULT_SLUG = 'BUR9ERR/expense-ledger';
const DEFAULT_BRANCH = 'main';
const USER_AGENT = 'expense-ledger-updater';

/* 更新时一律不碰的顶层目录 */
const PROTECTED_TOP = new Set(['data', 'dist', '.git', '.workbuddy', 'node_modules', '.mimosa']);

/* 本机状态文件：记着上次更新到了哪个提交（非 git 安装靠它判断新旧）。
   以 _ 开头 → 自动落在 .gitignore 的 `_*` 规则里，不会被提交。 */
const STATE_FILE = path.join(ROOT, '_update-state.json');
const BACKUP_KEEP = 3;   /* 覆盖前留底保留几份，目录名 _update-backup */

/* ============================================================
   一、纯逻辑（不碰网络和磁盘，tests/auto-update.test.js 直接测这些）
   ============================================================ */

/* 从各种 git 远程地址里抠出 owner/repo。认不出来返回 null。
   https://github.com/o/r.git / git@github.com:o/r.git / ssh://git@github.com/o/r */
function parseRepoSlug(remoteUrl) {
  if (!remoteUrl) { return null; }
  let s = String(remoteUrl).trim();
  const scp = /^[^/@\s]+@([^:\s]+):(.+)$/.exec(s);
  if (scp) {
    s = scp[1] + '/' + scp[2];
  } else {
    const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/@\s]+@)?([^/\s]+)\/(.+)$/.exec(s);
    if (scheme) { s = scheme[1] + '/' + scheme[2]; }
  }
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 3) { return null; }
  const host = parts[0].toLowerCase();
  /* host 必须像个主机名。这样 Windows 盘符路径（C:\...）和 UNC 路径
     （\\server\share\...）不会被误当成 owner/repo。 */
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) { return null; }
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) { return null; }
  return { host: host, owner: owner, repo: repo, slug: owner + '/' + repo };
}

/* 把压缩包里的条目名洗成一个安全的相对路径。
   绝对路径、盘符、.. 回溯一律判死返回 null（防止解包时写到项目外面去）。 */
function normalizeRel(p) {
  if (typeof p !== 'string' || !p) { return null; }
  let s = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) { return null; }
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') { continue; }
    if (seg === '..') { return null; }
    parts.push(seg);
  }
  if (!parts.length) { return null; }
  return parts.join('/');
}

/* 判断某个相对路径是否属于「更新不许动」的范围。
   和 .gitignore 的 `_*` 规则对齐：任意一层以 _ 开头都算本机专属。 */
function isProtected(rel) {
  const segs = String(rel).split('/');
  if (PROTECTED_TOP.has(segs[0])) { return true; }
  for (const s of segs) { if (s.startsWith('_')) { return true; } }
  if (rel.endsWith('.genie')) { return true; }
  return false;
}

/* 读 tar 头里的 NUL 结尾字符串 */
function readCString(buf, start, len) {
  let end = start;
  const max = Math.min(start + len, buf.length);
  while (end < max && buf[end] !== 0) { end++; }
  return buf.toString('utf8', start, end);
}

/* 读 tar 头里的八进制数字段（GNU 的大数值会用 base-256，这里一并处理） */
function readOctal(buf, start, len) {
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = 0; i < len; i++) { n = n * 256 + buf[start + i]; }
    return n - Math.pow(2, len * 8);
  }
  const s = buf.toString('latin1', start, start + len).replace(/\0/g, ' ').trim();
  if (!s) { return 0; }
  const v = parseInt(s, 8);
  return Number.isFinite(v) ? v : 0;
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) { if (buf[i] !== 0) { return false; } }
  return true;
}

/* PAX 扩展头（typeflag x/g）里是一条条 "长度 key=value\n" 记录。
   GitHub 生成的源码包含长路径时会用它。 */
function parsePax(data) {
  const out = {};
  const s = data.toString('utf8');
  let i = 0;
  while (i < s.length) {
    const sp = s.indexOf(' ', i);
    if (sp === -1) { break; }
    const len = parseInt(s.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > s.length) { break; }
    const rec = s.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) { out[rec.slice(0, eq)] = rec.slice(eq + 1); }
    i += len;
  }
  return out;
}

/* 解开一个 tar 缓冲，返回 [{ path, type, data }]。
   type 只有 'file' 和 'dir' 两种，其余（软链、设备节点）归到 'other'。 */
function untar(buf) {
  const out = [];
  let off = 0;
  let pax = null;
  let gnuName = null;
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    if (isZeroBlock(head)) { break; }
    const typeflag = String.fromCharCode(head[156] || 0x30);
    let size = readOctal(head, 124, 12);
    const dataStart = off + 512;
    const dataEnd = Math.min(dataStart + size, buf.length);
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'x' || typeflag === 'g') { pax = parsePax(data); continue; }
    if (typeflag === 'L') { gnuName = readCString(data, 0, data.length); continue; }
    if (typeflag === 'K') { continue; }  /* 长软链名，用不上 */

    if (pax && pax.size !== undefined) {
      const v = parseInt(pax.size, 10);
      if (Number.isFinite(v)) { size = v; }
    }
    const nameField = readCString(head, 0, 100);
    const prefix = readCString(head, 345, 155);
    let name = gnuName || (prefix ? prefix + '/' + nameField : nameField);
    if (pax && pax.path) { name = pax.path; }

    const rel = normalizeRel(name);
    if (rel) {
      const kind = typeflag === '5' ? 'dir' : ((typeflag === '0' || typeflag === '7') ? 'file' : 'other');
      out.push({ path: rel, type: kind, data: data });
    }
    pax = null;
    gnuName = null;
  }
  return out;
}

/* GitHub 的源码包外面套了一层 `仓库名-分支名/`，把这个公共首层剥掉 */
function stripTopDir(entries) {
  const tops = new Set();
  for (const e of entries) { tops.add(e.path.split('/')[0]); }
  if (tops.size !== 1) { return entries; }
  const top = tops.values().next().value;
  const out = [];
  for (const e of entries) {
    const rest = e.path.slice(top.length + 1);
    if (!rest) { continue; }
    out.push({ path: rest, type: e.type, data: e.data });
  }
  return out;
}

function untarGz(buf) {
  return untar(zlib.gunzipSync(buf));
}

/* ============================================================
   二、HTTP（含 HTTPS_PROXY 支持——Node 默认不看系统代理，
       Clash / v2ray 这类只挂系统代理时，只能靠这个环境变量）
   ============================================================ */

function proxyFor(target) {
  const isHttps = target.protocol === 'https:';
  const raw = (isHttps
    ? (process.env.HTTPS_PROXY || process.env.https_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy))
    || process.env.ALL_PROXY || process.env.all_proxy || '';
  if (!raw) { return null; }
  let u;
  try { u = new URL(/^\w+:\/\//.test(raw) ? raw : 'http://' + raw); } catch (e) { return null; }
  if (u.protocol !== 'http:') { return null; }  /* socks 不自己实现，交给系统代理 */

  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '');
  if (noProxy) {
    for (const item of noProxy.split(',')) {
      const host = item.trim().replace(/^\./, '').toLowerCase();
      if (!host) { continue; }
      const t = target.hostname.toLowerCase();
      if (t === host || t.endsWith('.' + host)) { return null; }
    }
  }
  return u;
}

/* 通过 HTTP 代理开一条到目标站点的隧道（CONNECT），返回裸 socket */
function connectViaProxy(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
    let buf = Buffer.alloc(0);
    socket.setTimeout(timeout, () => { socket.destroy(new Error('连代理超时')); });
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 65536) { socket.destroy(new Error('代理响应异常')); }
        return;
      }
      socket.removeListener('data', onData);
      const status = Number((buf.subarray(0, idx).toString('latin1').split('\r\n')[0] || '').split(' ')[1]);
      if (status !== 200) {
        socket.destroy();
        reject(new Error('代理拒绝建立隧道（HTTP ' + status + '）'));
        return;
      }
      const rest = buf.subarray(idx + 4);
      if (rest.length) { socket.unshift(rest); }
      socket.setTimeout(0);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('connect', () => {
      const auth = proxy.username
        ? 'Proxy-Authorization: Basic ' + Buffer.from(
          decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password || '')).toString('base64') + '\r\n'
        : '';
      socket.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\n'
        + 'Host: ' + host + ':' + port + '\r\n'
        + auth
        + 'Proxy-Connection: keep-alive\r\n\r\n');
    });
  });
}

/* 一次 GET，不跟重定向 */
function rawGet(urlStr, headers, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const proxy = proxyFor(u);

    const send = (socket) => {
      const mod = isHttps ? https : http;
      const opts = {
        method: 'GET',
        path: u.pathname + u.search,
        host: u.hostname,
        port: port,
        headers: headers,
        agent: false,
      };
      if (socket) { opts.createConnection = () => socket; }
      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(timeout, () => { req.destroy(new Error('请求超时')); });
      req.on('error', reject);
      req.end();
    };

    if (proxy && isHttps) {
      connectViaProxy(proxy, u.hostname, port, timeout).then((raw) => {
        const secured = tls.connect({ socket: raw, servername: u.hostname });
        secured.setTimeout(timeout, () => { secured.destroy(new Error('TLS 握手超时')); });
        secured.on('secureConnect', () => { secured.setTimeout(0); send(secured); });
        secured.on('error', reject);
      }).catch(reject);
      return;
    }

    send(null);
  });
}

/* GET + 自动跟重定向 */
async function get(urlStr, opts) {
  const o = opts || {};
  const headers = Object.assign({ 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' }, o.headers);
  const timeout = o.timeout || 25000;
  let current = urlStr;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await rawGet(current, headers, timeout);
    if ([301, 302, 303, 307, 308].indexOf(res.status) !== -1 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return Object.assign(res, { finalUrl: current });
  }
  throw new Error('重定向次数过多');
}

function apiHeaders() {
  const h = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Accept-Encoding': 'identity',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) { h.Authorization = 'Bearer ' + token; }
  return h;
}

/* 查仓库某个分支上最新的一个提交 */
async function fetchRemoteCommit(slug, ref) {
  const url = 'https://api.github.com/repos/' + slug + '/commits/' + encodeURIComponent(ref);
  const res = await get(url, { headers: apiHeaders() });
  if (res.status === 404) {
    throw new Error('接口说这个仓库/分支不存在：' + slug + ' @ ' + ref
      + '（私有仓库在未登录时也是这个结果，设 GITHUB_TOKEN 再试）');
  }
  if (res.status === 401) { throw new Error('GITHUB_TOKEN 无效或已过期'); }
  if (res.status === 422) {
    throw new Error('这个分支上没有提交（分支名对不对？）：' + ref + '，试试 --branch 换一个');
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub 接口限流了（未登录每小时 60 次）。设一个 GITHUB_TOKEN 环境变量就能提到 5000 次。');
  }
  if (res.status !== 200) { throw new Error('GitHub 接口返回 HTTP ' + res.status); }
  let j;
  try { j = JSON.parse(res.body.toString('utf8')); } catch (e) { throw new Error('GitHub 接口返回的不是 JSON'); }
  return {
    sha: j.sha || '',
    message: (j.commit && j.commit.message) || '',
    date: (j.commit && j.commit.author && j.commit.author.date) || '',
    url: j.html_url || '',
  };
}

/* 下载源码包。地址直接打 codeload，不占 API 的额度。
   ref 是 40 位 sha 时按 commit 下，否则按分支下。 */
async function downloadTarball(slug, ref) {
  const tail = /^[0-9a-f]{40}$/i.test(ref)
    ? ref
    : 'refs/heads/' + ref.split('/').map(encodeURIComponent).join('/');
  const url = 'https://codeload.github.com/' + slug + '/tar.gz/' + tail;
  const res = await get(url, { timeout: 180000 });
  if (res.status !== 200) { throw new Error('下载源码包失败：HTTP ' + res.status); }
  return res.body;
}

/* ============================================================
   三、git 模式
   ============================================================ */

/* 一律带上 safe.directory=本目录 的单次豁免。
   这本机仓库目录的属主 SID 和当前用户不一致（从别处拷来的盘/D盘挂载常见），
   git 默认会以「dubious ownership」拒绝干活。这里只对本项目路径放行一次，
   不动 --global 配置。 */
function git(args) {
  return spawnSync('git', ['-c', 'safe.directory=' + ROOT.replace(/\\/g, '/')].concat(args), {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

function gitOut(args) {
  const r = git(args);
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

function gitAvailable() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

function hasGitRepo() {
  if (!gitAvailable()) { return false; }
  return gitOut(['rev-parse', '--is-inside-work-tree']) === 'true';
}

/* 工作区里有没有「跟版本库有关」的本地改动（untracked 不算，它们不被覆盖） */
function gitDirty() {
  const out = gitOut(['status', '--porcelain']);
  if (!out) { return []; }
  return out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('??'));
}

/* ============================================================
   四、本机状态（非 git 安装靠它判断自己停在哪个版本）
   ============================================================ */

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}

function writeState(obj) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (e) { /* 写不了就算了，不影响主流程 */ }
}

/* ============================================================
   五、两种更新方式
   ============================================================ */

async function updateViaGit(ctx, remote) {
  const branch = ctx.branch;
  if (ctx.verbose) { console.log('  · git fetch origin ' + branch); }
  const fetch = git(['fetch', '--prune', 'origin', branch]);
  if (fetch.status !== 0) {
    return { ok: false, error: 'git fetch 失败：' + String(fetch.stderr || '').trim().split('\n').slice(-1)[0] };
  }

  const target = 'origin/' + branch;
  const behind = Number(gitOut(['rev-list', '--count', 'HEAD..' + target]) || 0);
  const ahead = Number(gitOut(['rev-list', '--count', target + '..HEAD']) || 0);

  const dirty = gitDirty();
  if (dirty.length && !ctx.force) {
    return {
      ok: false,
      needForce: true,
      error: '工作区有 ' + dirty.length + ' 处本地改动没提交，快进合并会被 git 拦下',
      detail: dirty,
    };
  }
  if (dirty.length && ctx.force) {
    const stash = git(['stash', 'push', '-m', 'auto-update-before-pull']);
    if (stash.status !== 0) {
      return { ok: false, error: 'git stash 失败，本地改动没能腾开，先不更新了' };
    }
  }

  const cur = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur && cur !== branch && !ctx.force) {
    return { ok: false, error: '当前在 ' + cur + ' 分支，不是要更新的 ' + branch + '。加 --force 会切过去' };
  }
  if (cur && cur !== branch && ctx.force) {
    git(['checkout', '-B', branch, target]);
  }

  const merge = git(['merge', '--ff-only', target]);
  if (merge.status !== 0) {
    if (!ctx.force) {
      return { ok: false, error: '快进合并不了（本地和远程分叉了）。加 --force 会以远程为准覆盖，本地提交留在 stash 里' };
    }
    const reset = git(['reset', '--hard', target]);
    if (reset.status !== 0) { return { ok: false, error: 'git reset 失败，更新没做成' }; }
  }

  return {
    ok: true,
    behind: behind,
    ahead: ahead,
    stashed: dirty.length > 0,
    sha: gitOut(['rev-parse', 'HEAD']),
    newCommits: String(gitOut(['log', '--oneline', 'HEAD~' + Math.max(behind, 1) + '..HEAD']) || '').split('\n').filter(Boolean),
  };
}

/* 把源码包里的文件覆盖到项目里。
   只写不删；内容一样的跳过；覆盖前把原件留一份底（默认开）。
   ctx.root 可以换目标目录，测试就靠它避免写到真实项目里。 */
function applyEntries(entries, ctx) {
  const root = ctx.root || ROOT;
  const files = entries.filter((e) => e.type === 'file' && !isProtected(e.path));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = ctx.backup ? path.join(root, '_update-backup', stamp) : null;

  const result = { added: [], modified: [], unchanged: 0, backedUp: 0, failed: [] };

  for (const f of files) {
    const abs = path.join(root, f.path);
    const rel = path.relative(root, abs);
    /* 兜底：解出来的路径必须还落在项目目录里 */
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      result.failed.push(f.path + '（路径越出项目目录，已跳过）');
      continue;
    }
    let exists = false;
    try { exists = fs.statSync(abs).isFile(); } catch (e) { exists = false; }

    if (exists) {
      let same = false;
      try { same = fs.readFileSync(abs).equals(f.data); } catch (e) { same = false; }
      if (same) { result.unchanged++; continue; }
      if (backupDir) {
        try {
          const bp = path.join(backupDir, f.path);
          fs.mkdirSync(path.dirname(bp), { recursive: true });
          fs.copyFileSync(abs, bp);
          result.backedUp++;
        } catch (e) { /* 留底失败不拦住更新 */ }
      }
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.data);
      (exists ? result.modified : result.added).push(f.path);
    } catch (e) {
      result.failed.push(f.path + '（' + e.message + '）');
    }
  }
  return Object.assign(result, { backupDir: backupDir });
}

async function updateViaFiles(ctx, remote) {
  const buf = await downloadTarball(ctx.slug, ctx.branch);
  let entries;
  try { entries = stripTopDir(untarGz(buf)); } catch (e) {
    return { ok: false, error: '源码包解不开：' + e.message };
  }
  const files = entries.filter((e) => e.type === 'file');
  if (!files.length) { return { ok: false, error: '源码包里一个文件都没有，包可能坏了' }; }

  const r = applyEntries(entries, ctx);

  /* 远程有、本地没有（或者本地有、远程没有）的东西，只报告不动手 */
  const remotePaths = new Set(files.map((e) => e.path));
  const stale = [];
  for (const rel of walkFiles(ctx.root || ROOT)) {
    if (isProtected(rel) || remotePaths.has(rel)) { continue; }
    stale.push(rel);
  }

  writeState({
    repo: ctx.slug, branch: ctx.branch, sha: remote.sha || '',
    updatedAt: new Date().toISOString(), mode: 'files',
  });

  return {
    ok: true,
    added: r.added, modified: r.modified, unchanged: r.unchanged,
    backedUp: r.backedUp, backupDir: r.backupDir, failed: r.failed,
    stale: stale, sha: remote.sha,
  };
}

/* 遍历项目里的文件，跳过不该看的目录 */
function walkFiles(dir, base, acc) {
  const root = base === undefined ? dir : base;
  const out = acc || [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (rel === '.git' || rel.startsWith('.git/')) { continue; }
    if (it.isDirectory()) { walkFiles(abs, root, out); continue; }
    if (it.isFile()) { out.push(rel); }
  }
  return out;
}

/* 清掉太老的留底，只留最近 BACKUP_KEEP 份 */
function pruneBackups(root) {
  const dir = path.join(root || ROOT, '_update-backup');
  let dirs;
  try { dirs = fs.readdirSync(dir).sort(); } catch (e) { return; }
  while (dirs.length > BACKUP_KEEP) {
    const victim = dirs.shift();
    try { fs.rmSync(path.join(dir, victim), { recursive: true, force: true }); } catch (e) { /* 删不掉就算了 */ }
  }
}

/* ============================================================
   六、主流程
   ============================================================ */

function parseArgs(argv) {
  const o = {
    check: false, yes: false, force: false, verbose: false, help: false,
    branch: '', repo: '', backup: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' || a === '-c') { o.check = true; }
    else if (a === '--yes' || a === '-y') { o.yes = true; }
    else if (a === '--force' || a === '-f') { o.force = true; }
    else if (a === '--verbose' || a === '-v') { o.verbose = true; }
    else if (a === '--no-backup') { o.backup = false; }
    else if (a === '--help' || a === '-h') { o.help = true; }
    else if (a === '--branch' || a === '-b') { o.branch = String(argv[++i] || ''); }
    else if (a === '--repo' || a === '-r') { o.repo = String(argv[++i] || ''); }
    else if (a.startsWith('--branch=')) { o.branch = a.slice(9); }
    else if (a.startsWith('--repo=')) { o.repo = a.slice(7); }
  }
  return o;
}

function line(char) { console.log('  ' + (char || '-').repeat(56)); }

function help() {
  console.log('');
  console.log('  记账本 · 自动更新');
  console.log('');
  console.log('  用法： node tools/auto-update.js [选项]');
  console.log('');
  console.log('    --check, -c     只检查有没有更新，什么都不改（定时任务用）');
  console.log('    --yes,   -y     有更新就直接装，不再问');
  console.log('    --force, -f     git 工作区有本地改动时也强行对齐远程');
  console.log('    --branch, -b    要跟随的分支，默认 main');
  console.log('    --repo,   -r    owner/repo，默认从本仓库 remote 读');
  console.log('    --no-backup     覆盖文件前不留底（默认留最近 3 份）');
  console.log('    --verbose, -v   多打印点过程');
  console.log('');
  console.log('  退出码： 0 最新/成功   1 出错   2 有更新没装   10 有更新(--check)');
  console.log('');
  console.log('  私有仓库要带令牌（不放仓库里，只放环境变量）：');
  console.log('    set GITHUB_TOKEN=ghp_xxxxxxxx            （macOS/Linux 用 export）');
  console.log('  Node 不看系统代理，走代理要手动告诉它：');
  console.log('    set HTTPS_PROXY=http://127.0.0.1:7890');
  console.log('');
}

function short(sha) { return sha ? String(sha).slice(0, 7) : '?'; }

function firstLine(text) {
  const s = String(text || '').trim().split('\n')[0];
  return s.length > 58 ? s.slice(0, 57) + '…' : s;
}

function ask(question, defYes) {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = String(answer || '').trim().toLowerCase();
      if (!a) { resolve(!!defYes); return; }
      resolve(a === 'y' || a === 'yes');
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return 0; }

  console.log('');
  console.log('  记账本 · 自动更新');
  line();

  /* ---- 认仓库和分支 ----
     接口只对 GitHub 有意义，所以分三种情况定「要不要问接口」：
       --repo 明确给了        → 按给的问
       远程是 github.com      → 按远程问
       远程不是 GitHub        → 别白问，直接走 git ls-remote
       本机没有 git           → 只能用内置默认仓库 + 接口（ZIP 安装的情况） */
  const gitMode = hasGitRepo();
  const remoteUrl = gitMode ? (gitOut(['remote', 'get-url', 'origin']) || '') : '';
  const parsedRemote = parseRepoSlug(remoteUrl);

  let apiSlug = '';
  let slug = opts.repo;
  if (slug) {
    apiSlug = slug;
  } else if (parsedRemote && parsedRemote.host === 'github.com') {
    apiSlug = parsedRemote.slug;
    slug = parsedRemote.slug;
  } else if (!gitMode) {
    apiSlug = DEFAULT_SLUG;
    slug = DEFAULT_SLUG;
  } else {
    slug = parsedRemote ? parsedRemote.slug : DEFAULT_SLUG;
  }

  let branch = opts.branch;
  if (!branch) {
    branch = (gitMode && gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])) || DEFAULT_BRANCH;
    if (branch === 'HEAD') { branch = DEFAULT_BRANCH; }  /* detached 时回默认分支 */
  }

  const ctx = Object.assign({}, opts, { slug: slug, branch: branch, gitMode: gitMode, verbose: opts.verbose });

  /* --repo 是手输的，格式不对就别往下走了 */
  if (apiSlug && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(apiSlug)) {
    console.log('  仓库名不对：' + apiSlug + '，应该长这样 owner/repo');
    return 1;
  }

  console.log('  仓库      ' + slug);
  console.log('  分支      ' + branch);
  console.log('  方式      ' + (gitMode ? 'git（fetch + 快进合并）' : '源码包覆盖（本机没有 .git）'));
  if (gitMode && !apiSlug) {
    console.log('  自查      ' + remoteUrl + '（不是 GitHub，直接问 git）');
  }

  /* 代理提示：只在「配了但可能是 socks」时提醒一句，不啰嗦 */
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (opts.verbose) {
    console.log('  代理      ' + (httpsProxy ? httpsProxy : '（没设 HTTPS_PROXY，直连）'));
  }

  /* ---- 本地当前版本 ---- */
  let localSha = '';
  if (gitMode) {
    localSha = gitOut(['rev-parse', 'HEAD']) || '';
  } else {
    const st = readState();
    if (st && st.sha) { localSha = st.sha; }
  }
  console.log('  本地版本  ' + (localSha ? short(localSha) : '（本机没有版本记录，不确定落后多少）'));
  line();

  /* ---- 问远程 ----
     先问 GitHub 接口（能顺便拿到提交说明）；接口用不了、
     而本机又是 git 仓库，就退回 git ls-remote——私有仓库+本机存了凭据时
     走的正是这条路。 */
  let remote = null;
  if (apiSlug) {
    try {
      remote = await fetchRemoteCommit(apiSlug, branch);
    } catch (apiErr) {
      if (gitMode) {
        const out = gitOut(['ls-remote', 'origin', 'refs/heads/' + branch]);
        if (out) {
          remote = { sha: out.split(/\s+/)[0], message: '', date: '', url: '', source: 'git' };
          console.log('  （GitHub 接口没能用上：' + apiErr.message + '）');
          console.log('  （改用 git 问远程，提交说明这次看不到）');
          line();
        }
      }
      if (!remote) {
        console.log('  检查失败：' + apiErr.message);
        console.log('');
        console.log('  常见原因和对策：');
        console.log('    · 私有仓库 → 未登录时接口一律回 404，给个令牌就行（Windows）：');
        console.log('        set GITHUB_TOKEN=ghp_xxxxxxxx        （macOS/Linux 用 export）');
        console.log('      或者用 git 模式——本机 git 里存了凭据的话，脚本会自动改走 git 问远程。');
        console.log('    · 只是没联网 / 走了代理但没告诉脚本：');
        console.log('        set HTTPS_PROXY=http://127.0.0.1:7890');
        console.log('    · 接口被限流：过一会儿再试，或者用上面的令牌（额度 60 → 5000/小时）。');
        return 1;
      }
    }
  } else {
    const out = gitOut(['ls-remote', 'origin', 'refs/heads/' + branch]);
    if (out) { remote = { sha: out.split(/\s+/)[0], message: '', date: '', url: '', source: 'git' }; }
    if (!remote) {
      console.log('  检查失败：问不到远程（git ls-remote origin ' + branch + ' 没结果）。');
      console.log('  看看 origin 还在不在、凭据有没有过期：git ls-remote origin');
      return 1;
    }
  }

  /* ---- 比一下 ---- */
  const same = localSha && remote.sha && localSha === remote.sha;

  if (same) {
    console.log('  已经是最新的（' + short(remote.sha) + '）');
    console.log('');
    return 0;
  }

  console.log('  发现更新');
  console.log('  远程最新  ' + short(remote.sha) + (remote.date ? '   ' + remote.date : ''));
  if (remote.message) { console.log('            ' + firstLine(remote.message)); }
  if (remote.url) { console.log('  详情      ' + remote.url); }
  line();

  if (opts.check) {
    console.log('  --check 模式：只报告，不做任何改动。');
    console.log('  想更新就去掉 --check 再跑一次。');
    console.log('');
    return 10;
  }

  /* ---- git 模式下先摸清落后多少 ---- */
  if (gitMode) {
    const fetch = git(['fetch', '--quiet', 'origin', branch]);
    if (fetch.status !== 0) {
      console.log('  git fetch 失败：' + String(fetch.stderr || '').trim().split('\n').slice(-1)[0]);
      return 1;
    }
    const behind = Number(gitOut(['rev-list', '--count', 'HEAD..origin/' + branch]) || 0);
    const list = String(gitOut(['log', '--oneline', 'HEAD..origin/' + branch]) || '').split('\n').filter(Boolean);
    if (behind === 0) {
      /* 远程 sha 和 HEAD 不同、但 HEAD 已经领先或分叉 */
      console.log('  本机不在远程后面的位置（可能是本地领先或分叉了），不自动动它。');
      console.log('');
      return 0;
    }
    console.log('  落后 ' + behind + ' 个提交：');
    for (const l of list.slice(0, 12)) { console.log('    ' + l); }
    if (list.length > 12) { console.log('    …还有 ' + (list.length - 12) + ' 条'); }
    line();

    const dirty = gitDirty();
    if (dirty.length) {
      console.log('  注意：工作区有 ' + dirty.length + ' 处本地改动没提交');
      for (const d of dirty.slice(0, 8)) { console.log('    ' + d); }
      if (!opts.force) {
        console.log('');
        console.log('  为了不弄丢你的改动，这次不更新。两个办法：');
        console.log('    · 先自己提交或 stash 掉，再跑一次本脚本');
        console.log('    · 加 --force：脚本会先 stash 再以远程为准对齐');
        console.log('');
        return 2;
      }
      console.log('  --force 已开：先把这些改动 stash 起来，再对齐远程。');
      line();
    }
  }

  /* ---- 确认 ---- */
  let go = opts.yes;
  if (!go) {
    if (!process.stdin.isTTY) {
      console.log('  当前不是交互终端，没敢自己动手。想自动装就加 --yes。');
      console.log('');
      return 2;
    }
    go = await ask('  现在更新吗？(Y/n) ', true);
  }
  if (!go) {
    console.log('  好，这次什么都没改。');
    console.log('');
    return 2;
  }

  /* ---- 动手 ---- */
  console.log('  正在更新…');
  let r;
  try {
    r = gitMode ? await updateViaGit(ctx, remote) : await updateViaFiles(ctx, remote);
  } catch (e) {
    console.log('  更新失败：' + e.message);
    return 1;
  }
  if (!r.ok) {
    console.log('  更新没做成：' + r.error);
    if (r.detail) { for (const d of r.detail.slice(0, 8)) { console.log('    ' + d); } }
    if (r.needForce) {
      console.log('');
      console.log('  加 --force 可以强行对齐远程（本地改动会被 stash 保留，不会丢）。');
    }
    console.log('');
    return r.needForce ? 2 : 1;
  }

  line();
  if (gitMode) {
    console.log('  已更新到 ' + short(r.sha) + (r.behind ? '（跟上了 ' + r.behind + ' 个提交）' : ''));
    if (r.stashed) {
      console.log('  你原来的本地改动还在 stash 里：git stash list 能看到，');
      console.log('  确认没问题后 git stash drop 清掉。');
    }
  } else {
    console.log('  已更新到 ' + short(r.sha));
    console.log('  改动文件 ' + r.modified.length + ' 个，新增 ' + r.added.length + ' 个，'
      + '内容没变跳过 ' + r.unchanged + ' 个');
    if (r.backedUp) { console.log('  覆盖前的原件留底在 ' + path.relative(ROOT, r.backupDir).replace(/\\/g, '/')); }
    if (r.failed.length) {
      console.log('  这几个没写成功：');
      for (const f of r.failed.slice(0, 10)) { console.log('    ' + f); }
    }
    if (r.stale && r.stale.length) {
      console.log('');
      console.log('  这些文件本地有、远程已经没有了（脚本不删文件，你自己看着办）：');
      for (const f of r.stale.slice(0, 10)) { console.log('    ' + f); }
      if (r.stale.length > 10) { console.log('    …还有 ' + (r.stale.length - 10) + ' 个'); }
    }
    pruneBackups(ROOT);
  }

  line();
  console.log('  你的账目和本机设置一点没动：data/、_node_path.txt 这些都不在更新范围里。');
  console.log(gitMode
    ? '  （git 模式下它们本来就不在版本库里，更新只挪代码。）'
    : '  （覆盖前会跳过 data/ 和所有以 _ 开头的文件。）');
  console.log('');
  console.log('  如果记账本正开着，重启一次新代码才生效：');
  console.log('    先双击「停止记账本.bat」，再双击「启动记账本.bat」。');
  console.log('');
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exit(code); }).catch((e) => {
    console.error('  出了点意外：' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

module.exports = {
  ROOT: ROOT,
  DEFAULT_SLUG: DEFAULT_SLUG,
  DEFAULT_BRANCH: DEFAULT_BRANCH,
  parseRepoSlug: parseRepoSlug,
  normalizeRel: normalizeRel,
  isProtected: isProtected,
  readOctal: readOctal,
  parsePax: parsePax,
  untar: untar,
  untarGz: untarGz,
  stripTopDir: stripTopDir,
  walkFiles: walkFiles,
  parseArgs: parseArgs,
  applyEntries: applyEntries,
  pruneBackups: pruneBackups,
  /* 下面这几个要联网，测试文件里不碰；留着是为了手工排查和 E2E 冒烟 */
  proxyFor: proxyFor,
  get: get,
  apiHeaders: apiHeaders,
  fetchRemoteCommit: fetchRemoteCommit,
  downloadTarball: downloadTarball,
};
