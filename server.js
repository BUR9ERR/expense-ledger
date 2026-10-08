'use strict';

/*
 * 记账本 - 本地服务
 *
 * 数据保存在 data/ledger.json，就是一个普通的 JSON 文件，
 * 可以用记事本打开、复制、丢进网盘备份。
 *
 * 同时提供网页静态服务和数据读写接口：
 *   电脑上访问  http://localhost:8765
 *   手机上访问  http://<电脑局域网IP>:8765   （需要手机连同一个 WiFi）
 *
 * 零依赖，只用 Node 内置模块。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
/* 复用前端的纯逻辑层做数据清洗，保证两端入库规则完全一致。
   （SEA 单文件 exe 打包态下，这一行由 tools/build-exe.js 在生成的
   入口里去掉、换成构建时拼接好的 LedgerCore——本文件不感知打包。） */
const LedgerCore = require('./assets/core.js');

/* ---------- 打包态（Node SEA 单文件 exe，构建见 tools/build-exe.bat）----------
   打包后整个程序（含全部网页文件）就是一个 exe：
   - 静态资源从 exe 内嵌读（见 serveStatic 里的 FROZEN 分支，纯数据、无动态代码）
   - 数据目录落在 exe 旁边的 data/——把 exe 拷到哪个文件夹，账本就住在哪
   普通 node server.js / 启动记账本.bat 启动时 FROZEN 恒为 false（Node 18
   连 node:sea 模块都没有，require 直接抛错被吃掉），行为与打包前一字不变。 */
const SEA = (function () {
  try { const sea = require('node:sea'); return sea.isSea() ? sea : null; }
  catch (e) { return null; }
})();
const FROZEN = !!SEA;

const ROOT = FROZEN ? path.dirname(process.execPath) : __dirname;

/* 数据目录：默认放在项目根的 data/；设 LEDGER_HOME 环境变量可指到别处
   （主要给自动化测试用，避免测试读写真实账目）。 */
const DATA_HOME = process.env.LEDGER_HOME ? path.resolve(process.env.LEDGER_HOME) : ROOT;
const DATA_DIR = path.join(DATA_HOME, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ledger.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
/* 备份份数默认 50，可用 LEDGER_BACKUP_KEEP 环境变量改（测试用小值） */
const BACKUP_KEEP = Number(process.env.LEDGER_BACKUP_KEEP) || 50;
const PORT = Number(process.env.PORT) || 8765;
/* 安全默认：只监听本机回环，局域网里的设备连不进来。
   要让手机等设备访问，在网页端「数据管理」里打开「允许手机访问」
   （设置存在 data/settings.json，重启后保持）。 */
const HOST_LOCAL = '127.0.0.1';
const HOST_LAN = '0.0.0.0';
const MAX_BODY = 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/* ---------- 目录与数据 ---------- */

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function emptyDB() {
  return { version: 1, categories: [], transactions: [], createdAt: Date.now() };
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { rev: 0, savedAt: null, data: emptyDB() };
    }
    return {
      rev: Number(parsed.rev) || 0,
      savedAt: parsed.savedAt || null,
      data: parsed.data && typeof parsed.data === 'object' ? parsed.data : emptyDB()
    };
  } catch (e) {
    /* 文件还没建过：正常情况 */
    if (e.code === 'ENOENT') {
      return { rev: 0, savedAt: null, data: emptyDB() };
    }
    /* 文件在、但读不出来（JSON 坏了 / 权限异常）。
       先把它改名留证据，否则下一次保存会直接覆盖掉，用户就找不回来了。 */
    try {
      const bad = DATA_FILE + '.corrupt-' + stamp();
      fs.renameSync(DATA_FILE, bad);
      console.error('');
      console.error('  ⚠ 账本文件读取失败，已改名保留：' + bad);
      console.error('    原因：' + (e && e.message ? e.message : e));
      console.error('    可以从 data/backups/ 里挑一份备份改名为 ledger.json 恢复。');
      console.error('');
    } catch (e2) { /* 改名也失败就没办法了 */ }
    return { rev: 0, savedAt: null, data: emptyDB() };
  }
}

function writeData(rev, data) {
  ensureDirs();
  const payload = JSON.stringify({ rev: rev, savedAt: new Date().toISOString(), data: data });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function stamp() {
  const d = new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
         String(d.getMilliseconds() + 1000).slice(1);
}

/* 同毫秒内连续备份时，时间戳只到毫秒会撞名，copyFileSync 会把第一份静默覆盖掉
   （CI 的 Linux runner 磁盘快，两次备份落在同一毫秒是常事，本地 Windows 反而难复现）。
   重名时追加字母后缀 a、b…、z、aa…。选字母而非数字：字母 ASCII 码大于 '.'，
   字典序恰好是「无后缀（首份）< a < b」，按文件名排序裁剪旧备份时顺序与创建顺序一致。 */
function backupSuffix(n) {
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
/* 字母后缀转回序号（a=1、z=26、aa=27），与 backupSuffix 互逆 */
function suffixToN(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 96);
  }
  return n;
}
function uniqueBackupName() {
  const base = 'ledger-' + stamp();
  /* 关键：取「现有同时间戳文件里的最大序号 +1」，而不是从空缺位置开始填。
     裁剪旧备份会删掉最早的无后缀文件，留下空缺；若新备份去填这个空缺，
     它在字典序里又排最旧，会被同一次裁剪立刻删掉（等于这份备份白做）。 */
  let max = -1;
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([a-z]*)\\.json$');
  fs.readdirSync(BACKUP_DIR).forEach(function (f) {
    const m = f.match(re);
    if (m) { max = Math.max(max, suffixToN(m[1])); }
  });
  const n = max + 1;
  return path.join(BACKUP_DIR, base + (n === 0 ? '' : backupSuffix(n)) + '.json');
}

function snapshotBackup() {
  try {
    ensureDirs();
    if (!fs.existsSync(DATA_FILE)) { return; }

    /* 内容哈希去重：内容没变的保存不再重复留档。
       没有去重时，连续记几笔账或导入一次账单就会把 50 份配额
       全部挤成「最近几分钟」，真正值钱的历史版本反而被顶掉。
       哈希清单存 backups/hashes.json（与备份文件同步裁剪）；
       清单丢失或损坏就从空白重建，最多多留几份重复，无害。 */
    const content = fs.readFileSync(DATA_FILE);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    let hashes = [];
    const hashFile = path.join(BACKUP_DIR, 'hashes.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(hashFile, 'utf8'));
      if (Array.isArray(parsed)) { hashes = parsed; }
    } catch (e) { /* 没有 / 坏了 → 从空开始 */ }

    if (hashes.indexOf(hash) >= 0) { return; }

    fs.copyFileSync(DATA_FILE, uniqueBackupName());
    hashes.push(hash);

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(function (f) { return /^ledger-.*\.json$/.test(f); })
      .sort();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
      hashes.shift();
    }
    while (hashes.length > BACKUP_KEEP) { hashes.shift(); }
    const tmp = hashFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hashes), 'utf8');
    fs.renameSync(tmp, hashFile);
  } catch (e) {
    console.warn('[warn] 备份失败：' + e.message);
  }
}

/* 入库前统一清洗：字段白名单 + 逐笔定形（core.sanitizeDB）。
   缺分类时回落默认分类；无 id、金额非法的坏账直接丢弃。 */
function sanitize(data) {
  return LedgerCore.sanitizeDB(
    data && typeof data === 'object' ? data : {},
    { maxCategories: 300, maxTransactions: 200000 });
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (info) {
      if (info.family !== 'IPv4' || info.internal) { return; }
      if (info.address.indexOf('169.254.') === 0) { return; }
      if (/^(vEthernet|Loopback|Bluetooth)/i.test(name)) { return; }
      out.push({ iface: name, address: info.address });
    });
  });
  out.sort(function (a, b) {
    const aPriv = /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 0 : 1;
    const bPriv = /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(b.address) ? 0 : 1;
    return aPriv - bPriv;
  });
  return out;
}

/* ---------- 局域网开关 ---------- */

/* 当前是否允许局域网访问。请求处理里随时读这个变量做拦截，
   启动时从设置文件读一次，网页端切换时更新。 */
let lanEnabled = false;

/* 读「局域网开关」的当前值。LEDGER_FAKE_LAN 是**只给自动化测试**用的
   开关（与 LEDGER_FAKE_IP 配套）：单进程里要分别验证「手机开着 / 关着」
   两条分支，而真正改这个变量要走 rebind 并重绑端口。正常启动不设它。 */
function lanIsOn() {
  const fake = process.env.LEDGER_FAKE_LAN;
  if (fake === '1') { return true; }
  if (fake === '0') { return false; }
  return lanEnabled;
}
/* 局域网访问口令：只在本机显示、也只能在本机修改；新设备首次连接输一次，
   之后浏览器里存的是下面 authToken() 派生的凭据（不是口令本身）。
   口令持久化在 settings.json 里，下次启动还是它。 */
let lanPin = '';

/* 口令格式：6 位数字。改口令接口与测试共用这一条判断 */
function isValidPin(v) {
  return /^[0-9]{6}$/.test(String(v == null ? '' : v));
}

/* 浏览器里存的凭据 = HMAC(口令)。刻意不把口令本身写进 Cookie：
   - 口令换了，旧凭据自动失效（换口令即踢掉所有已授权设备）
   - Cookie 万一泄露，拿到的也只是推导值，不是「能打开记账本的那个口令」
   同一口令每次算出来都一样（无随机盐），所以重启服务后设备不用重输。 */
function authToken() {
  if (!lanPin) { return ''; }
  return crypto.createHmac('sha256', String(lanPin)).update('ledger-auth-v1').digest('hex');
}

/* 定长比较，别让「前几位对不对」从耗时上泄露出去。
   长度不同直接 false（长度是固定 64 位十六进制，不构成信息泄露）。 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length || x.length === 0) { return false; }
  return crypto.timingSafeEqual(x, y);
}

/* 猜口令的代价：错一次等 1 秒，连续错 5 次锁 5 分钟。
   内存里的表，重启即清空（本机服务，够用）。 */
const AUTH_FAIL_LIMIT = 5;
const AUTH_LOCK_MS = 5 * 60 * 1000;
const authFails = new Map();

function authLockLeft(req) {
  const rec = authFails.get(clientAddress(req));
  if (!rec || !rec.lockedUntil) { return 0; }
  const left = rec.lockedUntil - Date.now();
  return left > 0 ? left : 0;
}

function noteAuthFail(req) {
  const ip = clientAddress(req);
  const rec = authFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= AUTH_FAIL_LIMIT) {
    rec.lockedUntil = Date.now() + AUTH_LOCK_MS;
    rec.count = 0;
  }
  authFails.set(ip, rec);
}

function clearAuthFail(req) {
  authFails.delete(clientAddress(req));
}

/* 口令轮换：换掉口令本身、清掉旧的失败记录。
   已授权的设备下次请求会因为凭据对不上而重新要口令（这正是「换口令」该有的效果）。 */
function rotatePin(newPin) {
  if (!isValidPin(newPin)) { return false; }
  lanPin = String(newPin);
  writeSettings({ pin: lanPin });
  authFails.clear();
  return true;
}

let currentHost = HOST_LOCAL;

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return (s && typeof s === 'object') ? s : {};
  } catch (e) {
    return {}; /* 没有设置文件 = 默认关闭 */
  }
}

function readLanEnabled() {
  return readSettings().lanEnabled === true;
}

function writeSettings(patch) {
  ensureDirs();
  const settings = readSettings();
  Object.keys(patch).forEach(function (k) { settings[k] = patch[k]; });
  settings.savedAt = new Date().toISOString();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

function writeLanEnabled(enabled) {
  writeSettings({ lanEnabled: !!enabled });
}

/* 6 位数字口令，crypto 随机（不是给加密用的，是防同网邻居顺路看账）。
   注意必须补足 6 位：以前那一串三元运算在 n 落在 1000~9999 等区间时
   会漏补前导零，生成 4 位口令——而网页端的输入框只收 6 位，
   这种口令根本输不进去。 */
function genPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/* 回环地址判断：请求来自本机（含 IPv4-mapped 的 ::ffff:127.x 写法） */
function isLoopbackAddress(addr) {
  let a = String(addr || '');
  if (a.indexOf('::ffff:') === 0) { a = a.slice(7); }
  return a === '::1' || a.indexOf('127.') === 0;
}

function requesterIsLocal(req) {
  return isLoopbackAddress(clientAddress(req));
}

/* 请求方地址。LEDGER_FAKE_IP 是**只给自动化测试**用的开关：设了它，
   服务端就把每个请求都当成来自这个地址，用来在单进程里验证
   「手机 / 本机」两条分支（正常启动不设它，取值与从前完全一致）。
   这个开关只影响「看起来从哪来」，不改变任何鉴权判断的规则本身。 */
function clientAddress(req) {
  const fake = process.env.LEDGER_FAKE_IP;
  if (fake) { return fake; }
  return String((req.socket && req.socket.remoteAddress) || '');
}

/* 新设备的验证凭据存在 Cookie 里（输一次管 10 年）。
   注意：路由里的口令闸只有在 lanEnabled 时才会用到它，
   单纯开着的本地服务不需要验证。 */
function authedByPin(req) {
  const want = authToken();
  if (!want) { return false; }
  const pairs = (req.headers.cookie || '').split(';');
  for (let i = 0; i < pairs.length; i++) {
    const kv = pairs[i].split('=');
    if (kv.length >= 2 && kv[0].trim() === 'ledger_auth') {
      return safeEqual(kv[1].trim(), want);
    }
  }
  return false;
}

/* 已验证设备要用的 Cookie 头。HttpOnly：脚本读不到；
   SameSite=Strict：别的站点发起的请求不会带上它。 */
function authCookieHeader(token) {
  return 'ledger_auth=' + token + '; Path=/; Max-Age=315360000; SameSite=Strict; HttpOnly';
}

/* 关掉 / 重新打开监听端口。切换期间现有连接会被掐断（手机端会提示
   连不上，属预期），电脑上的页面不受影响（127.0.0.1 两种模式都通）。 */
function rebind(enableLan, cb) {
  const targetHost = enableLan ? HOST_LAN : HOST_LOCAL;
  if (targetHost === currentHost) { cb(null); return; }
  try {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } catch (e) { /* 没有这个 API 就等 keep-alive 自然超时 */ }
  let closeDone = false;
  server.close(function () {
    closeDone = true;
    server.listen(PORT, targetHost, function () {
      currentHost = targetHost;
      lanEnabled = enableLan;
      printLanState();
      cb(null);
    });
  });
  /* 兜底：close 的回调在极端情况下可能迟迟不触发，2.5 秒后还没完成
     就强行再听一次（close 还挂着时 listen 会同步抛错，这里接住）。 */
  setTimeout(function () {
    if (!closeDone && !server.listening && currentHost !== targetHost) {
      try {
        server.listen(PORT, targetHost, function () {
          currentHost = targetHost;
          lanEnabled = enableLan;
          printLanState();
          cb(null);
        });
      } catch (e) {
        cb(e);
      }
    }
  }, 2500);
}

function printLanState() {
  const line = '  ' + '-'.repeat(58);
  if (lanEnabled) {
    const addrs = lanAddresses();
    console.log(line);
    console.log('  局域网访问已打开，手机连同一 WiFi 后打开：');
    addrs.forEach(function (a, i) {
      console.log('  ' + (i ? '或：      ' : '    ') + 'http://' + a.address + ':' + PORT + '   (' + a.iface + ')');
    });
    console.log('  ⚠ 这意味着同一网络里的设备都能访问账本，公共 WiFi 下请关闭。');
    console.log(line);
  } else {
    console.log(line);
    console.log('  局域网访问已关闭：只有这台电脑能打开记账本。');
    console.log('  要在手机上用，请在网页端「数据管理」里打开「允许手机访问」。');
    console.log(line);
  }
}

/* ---------- HTTP 辅助 ---------- */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/* 读取请求体。超过上限时回 413 并带 Connection: close（Node 发完响应
   自动断开），而不是直接 req.destroy()——那样客户端只会看到「连接被
   掐断」，前端只能误报成「连不上服务」。 */
function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', function (c) {
    if (aborted) { return; }
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      chunks.length = 0;
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' });
      res.end('请求体过大（上限 32MB）');
      return;
    }
    chunks.push(c);
  });
  req.on('end', function () {
    if (aborted) { return; }
    cb(Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', function () {
    if (!aborted) { cb(null); }
  });
}

/* 对外只提供 index.html 和 assets/ 下的文件，其余一律拒绝。
   这比「拉黑 data 目录」可靠：
   - Windows 文件系统不区分大小写，/DATA/ledger.json 能绕过 /data/ 的字符串判断
   - .git、.gitignore 这类隐藏文件同样不该被下载
   所以判断前统一转小写，且改成白名单。 */
function isServable(filePath) {
  const root = path.resolve(ROOT);
  const target = path.resolve(filePath);
  const rootLower = root.toLowerCase();
  const targetLower = target.toLowerCase();

  if (targetLower !== rootLower && targetLower.indexOf(rootLower + path.sep) !== 0) {
    return false;
  }

  const segs = path.relative(root, target).split(path.sep).filter(function (s) { return s; });

  /* 任何以点开头的文件或目录都不给 */
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].charAt(0) === '.') { return false; }
  }

  if (segs.length === 1) {
    /* 根目录只放行 index.html 和 PWA 的两个文件（manifest 与 Service Worker） */
    const name = segs[0].toLowerCase();
    return name === 'index.html' || name === 'manifest.webmanifest' || name === 'sw.js';
  }
  return segs[0].toLowerCase() === 'assets';
}

/* 写操作的「同站」校验，防「网页里偷偷 POST 到本机端口」这类 CSRF：
   1) 要求 Content-Type: application/json —— 跨站的简单请求（表单提交、no-cors fetch）
      只可能带 text/plain / form-urlencoded，直接 415 挡掉；带 JSON 类型的跨站请求
      会先发预检（OPTIONS），而这里不回应预检，也就过不来；
   2) 再核对 Origin —— 带了 Origin 且主机名跟请求的 Host 对不上的，一律 403。
   同源请求（本机浏览器、手机浏览器直接打开本服务）两项都天然满足，不受影响。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) { return true; }
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch (e) {
    return false;
  }
}

function requireSameSite(req, res) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.indexOf('application/json') !== 0) {
    res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unsupported Media Type');
    return false;
  }
  if (!sameOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return false;
  }
  return true;
}

/* ---------- 安全响应头 ----------
   页面本身不需要任何外部资源，也不该被嵌进别人的页面：
   - CSP：只允许同源脚本/样式/图片；禁止 object、禁止被 iframe 嵌套
     （人写的脚本都在 assets/*.js 里，页面里没有内联 script 标签，
     所以不给内联脚本开口子——这样即使有内容被注入成 HTML，
     也变不成可执行的脚本。以后改页面也别加内联脚本，tools/check-dom.js
     会直接报错）
   - X-Frame-Options / Referrer-Policy：防点击劫持、防地址外泄
   - nosniff：防浏览器把 .png 之类当脚本/样式猜着解析 */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

function applySecurityHeaders(res) {
  const names = Object.keys(SECURITY_HEADERS);
  for (let i = 0; i < names.length; i++) {
    res.setHeader(names[i], SECURITY_HEADERS[names[i]]);
  }
}

/* ---------- 历史版本（data/backups） ----------
   每次保存前都会留一份，但以前只能在界面上「导出」，不能在界面上恢复：
   想找回被误删的账，得自己进文件夹改名——README 教的就是这个。
   这里给它两个接口：列出、恢复。 */

/* 备份文件名形如 ledger-20261006-061020988.json（时间戳是人能读的本地时间） */
function parseBackupStamp(name) {
  const m = String(name).match(/^ledger-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})\.json$/);
  if (!m) { return null; }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                     Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
  return isFinite(d.getTime()) ? d.getTime() : null;
}

/* 列出全部历史版本，新的在前。损坏/读不出来的文件也列出来（标 broken），
   但不让用户恢复它——比默默藏起来强。 */
function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR); }
  catch (e) { return []; }                       /* 还没留过档：空列表 */
  const out = [];
  for (const name of names) {
    if (!/^ledger-.*\.json$/.test(name)) { continue; }
    const at = parseBackupStamp(name);
    const item = {
      file: name,
      at: at,                                    /* 文件名里的时间（本地） */
      mtime: null,
      size: 0,
      count: 0,
      rev: null,
      savedAt: null,
      broken: false
    };
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      item.mtime = st.mtimeMs;
      item.size = st.size;
      const parsed = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.data) { throw new Error('结构不对'); }
      item.rev = Number(parsed.rev) || 0;
      item.savedAt = parsed.savedAt || null;
      item.count = Array.isArray(parsed.data.transactions) ? parsed.data.transactions.length : 0;
      /* 恢复要用这份内容。挂成不可枚举：JSON.stringify 不会把它
         带进 /api/backups 的响应里，接口返回仍然只有元数据 */
      Object.defineProperty(item, 'raw', { value: parsed, enumerable: false });
    } catch (e) {
      item.broken = true;
    }
    out.push(item);
  }
  out.sort(function (a, b) {
    const av = a.at || a.mtime || 0;
    const bv = b.at || b.mtime || 0;
    return bv - av;
  });
  return out;
}

/* 从某个历史版本恢复：先把「现在」的这一份另存为一次留档（别把当前状态
   弄丢），再把备份内容写回 ledger.json，rev 继续往上加。
   外部传进来的名字只用来和 listBackups() 的清单做「等值比较」；
   备份内容直接用清单里已经读好的那份（listBackups 挂在条目上的 raw），
   这里不做任何第二次文件读取——外部字符串碰不到文件系统。 */
function restoreBackup(file) {
  const want = String(file == null ? '' : file);
  const found = listBackups().filter(function (b) { return b.file === want; })[0];
  if (!found) { return { ok: false, error: '找不到这个历史版本' }; }
  if (found.broken || !found.raw) {
    return { ok: false, error: '这个历史版本读不出来，换一个' };
  }
  const data = found.raw.data ? sanitize(found.raw.data) : null;
  if (!data) { return { ok: false, error: '这个历史版本里没有可用的账目' }; }

  ensureDirs();
  snapshotBackup();                    /* 动手之前先把当前状态留一份 */
  const cur = readData();
  const nextRev = cur.rev + 1;
  try {
    writeData(nextRev, data);
  } catch (e) {
    return { ok: false, error: '写入失败：' + e.message };
  }
  return { ok: true, rev: nextRev, count: data.transactions.length, file: found.file };
}

/* ---------- /sw.js 的缓存版本注入 ----------
   SW 对静态资源缓存优先，手机端想拿到新代码，必须让 sw.js 本身
   变化（浏览器按字节对比决定要不要换新 SW）。以前靠手动 bump
   CACHE_VERSION，忘了改手机端就一直跑旧代码。现在发 /sw.js 时
   注入被缓存文件的内容哈希：文件一变，sw.js 字节就变，浏览器
   自动换新 SW、清旧缓存。每次请求现算——文件都很小，而且这样
   开发时改完文件刷新页面就能拿到新代码，不用重启服务。 */
const SW_HASH_FILES = [
  'index.html', 'manifest.webmanifest', 'sw.js',
  'assets/theme-init.js', 'assets/app.js', 'assets/pwa.js', 'assets/core.js',
  'assets/styles.css', 'assets/分类词库.js'
];

function readSwTemplate() {
  if (FROZEN) {
    try { return SEA.getAsset('sw.js', 'utf8'); } catch (e) { return null; }
  }
  try { return fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'); } catch (e) { return null; }
}

function readHashSource(rel) {
  if (FROZEN) {
    try { return SEA.getAsset(rel, 'utf8'); } catch (e) { return ''; }
  }
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; }
}

function computeAssetHash() {
  let h = 0x811c9dc5;
  function feed(str) {
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  for (let i = 0; i < SW_HASH_FILES.length; i++) {
    feed(readHashSource(SW_HASH_FILES[i]));
    feed('\u0000');
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT, path.normalize(rel));
  if (!isServable(filePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  /* 打包态：从 exe 内嵌资源读（键 = 仓库相对路径，清单见 tools/sea-config.json）。
     isServable 白名单照常把关；文件没打进 blob 就 404。 */
  if (pathname === '/sw.js') {
    const raw = readSwTemplate();
    if (raw == null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const out = raw.split('__ASSET_HASH__').join(computeAssetHash());
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Length': Buffer.byteLength(out)
    });
    res.end(out);
    return;
  }
  if (FROZEN) {
    let buf = null;
    try {
      buf = SEA.getAsset(path.relative(ROOT, filePath).split(path.sep).join('/'));
    } catch (e) { buf = null; }
    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': buf.byteLength
    });
    res.end(Buffer.from(buf));
    return;
  }
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': st.size
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------- 路由 ---------- */

/* 一个请求从头到尾的处理：安全响应头 → 来源闸 → 口令闸 → 各接口。
   抽成具名函数是为了让测试能拿到它、在自己的端口上跑真实的
   HTTP 往返（见 server.test.js 的「实机接口」一组）。 */
function handleRequest(req, res) {
  applySecurityHeaders(res);
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    pathname = '/';
  }

  /* 静态文件由 serveStatic 里的白名单把关（data 目录、隐藏文件都进不去） */

  const lanOn = lanIsOn();

  /* 安全默认：局域网访问关闭时，非本机来源一律拒绝。
     正常情况下端口根本没绑在 0.0.0.0 上（连接会被拒绝），
     这道闸是纵深防御——比如绑定状态被人动过时兜底。 */
  if (!lanOn && !requesterIsLocal(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  /* 局域网访问的口令闸：静态页面放行（手机得能加载出输口令的界面），
     数据接口一律要求「本机，或 Cookie 里带着对口令」。手机第一次输完，
     Cookie 存 10 年，以后不用再输。 */
  if (lanOn && lanPin && pathname.indexOf('/api/') === 0 &&
      pathname !== '/api/auth' &&
      !requesterIsLocal(req) && !authedByPin(req)) {
    sendJSON(res, 401, { needPin: true });
    return;
  }

  if (pathname === '/api/info') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET, HEAD' });
      res.end();
      return;
    }
    const cur = readData();
    const local = requesterIsLocal(req);
    sendJSON(res, 200, {
      mode: 'server',
      port: PORT,
      lanEnabled: lanOn,
      addresses: lanOn ? lanAddresses() : [],
      /* 「要不要输口令」是公开的（没验证的设备靠它决定弹不弹口令闸），
         口令本身一个字都不给——手机上取不到，只能到电脑上看。
         本机则另外给 pin，抽屉里才显示得出来。 */
      pinRequired: !!(lanOn && lanPin),
      pin: local ? lanPin : null,
      /* true = 这台设备就是电脑本身：能改访问设置、改口令、停服务 */
      local: local,
      dataFile: DATA_FILE,
      backupDir: path.join(DATA_DIR, 'backups'),
      backupKeep: BACKUP_KEEP,
      rev: cur.rev,
      savedAt: cur.savedAt,
      count: Array.isArray(cur.data.transactions) ? cur.data.transactions.length : 0
    });
    return;
  }

  /* 历史版本：列出与恢复。都只能在本机操作——恢复会把整本账换掉，
     绝不能让它从局域网被触发。 */
  if (pathname === '/api/backups') {
    if (!requesterIsLocal(req)) {
      sendJSON(res, 403, { error: '历史版本只能在运行记账本的那台电脑上操作' });
      return;
    }
    if (req.method === 'GET') {
      sendJSON(res, 200, { backups: listBackups(), keep: BACKUP_KEEP });
      return;
    }
    if (req.method === 'POST') {
      if (!requireSameSite(req, res)) { return; }
      readBody(req, res, function (text) {
        if (text === null) { sendJSON(res, 400, { error: '读取失败' }); return; }
        let payload;
        try { payload = JSON.parse(text); }
        catch (e) { sendJSON(res, 400, { error: '不是合法的 JSON' }); return; }
        const r = restoreBackup(payload && payload.file);
        if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
        console.log('  已从历史版本恢复：' + r.file + '（' + r.count + ' 笔）');
        sendJSON(res, 200, {
          ok: true, rev: r.rev, count: r.count, file: r.file,
          backups: listBackups()
        });
      });
      return;
    }
    res.writeHead(405, { 'Allow': 'GET, POST' });
    res.end();
    return;
  }

  /* 网页端「允许手机访问」开关。只有本机能改——哪怕局域网已打开，
     手机也不能关掉或再改它，避免网络里的其他设备动安全设置。 */
  if (pathname === '/api/auth') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      res.end();
      return;
    }
    if (!requireSameSite(req, res)) { return; }
    /* 本机或未启用口令的场景：无需验证 */
    if (!lanOn || !lanPin || requesterIsLocal(req)) {
      sendJSON(res, 200, { ok: true });
      return;
    }
    const lockLeft = authLockLeft(req);
    if (lockLeft > 0) {
      sendJSON(res, 429, {
        error: '试太多次了，请等 ' + Math.ceil(lockLeft / 60000) + ' 分钟再试',
        retryAfterMs: lockLeft
      });
      return;
    }
    readBody(req, res, function (text) {
      let pin = '';
      try { pin = String(JSON.parse(text).pin || ''); } catch (e) { pin = ''; }
      if (isValidPin(pin) && safeEqual(pin, lanPin)) {
        clearAuthFail(req);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': authCookieHeader(authToken())
        });
        res.end(JSON.stringify({ ok: true }));
        console.log('  一台新设备通过了口令验证（' +
          clientAddress(req) + '），以后不用再输');
      } else {
        /* 猜口令的代价：错一次多等 1 秒；连续错 5 次锁 5 分钟 */
        noteAuthFail(req);
        setTimeout(function () { sendJSON(res, 403, { error: '口令不对' }); }, 1000);
      }
    });
    return;
  }

  /* 改访问口令：只能在本机改（手机、局域网里的设备一律 403），
     直接填新口令即可——这是用户明确的取舍：这台电脑前坐的就是主人，
     不需要「先答对旧口令」这层摩擦。口令本身只在本机显示，
     没通过验证的设备在任何接口里都拿不到它。 */
  if (pathname === '/api/pin') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      res.end();
      return;
    }
    if (!requireSameSite(req, res)) { return; }
    if (!requesterIsLocal(req)) {
      sendJSON(res, 403, { error: '口令只能在运行记账本的那台电脑上修改' });
      return;
    }
    readBody(req, res, function (text) {
      if (text === null) { sendJSON(res, 400, { error: '读取失败' }); return; }
      let payload;
      try { payload = JSON.parse(text); }
      catch (e) { sendJSON(res, 400, { error: '不是合法的 JSON' }); return; }

      const next = String((payload && payload.pin) || '');
      if (!isValidPin(next)) {
        sendJSON(res, 400, { error: '口令要 6 位数字' });
        return;
      }
      if (!rotatePin(next)) { sendJSON(res, 500, { error: '口令没能保存' }); return; }
      console.log('  访问口令已更新（在电脑上改的），已连接的设备需要重新输入');
      sendJSON(res, 200, { ok: true, pin: lanPin });
    });
    return;
  }

  if (pathname === '/api/lan') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      res.end();
      return;
    }
    if (!requireSameSite(req, res)) { return; }
    if (!requesterIsLocal(req)) {
      sendJSON(res, 403, { error: '这个开关只能在电脑上更改' });
      return;
    }
    readBody(req, res, function (text) {
      if (text === null) { sendJSON(res, 400, { error: '读取失败' }); return; }
      let payload;
      try { payload = JSON.parse(text); }
      catch (e) { sendJSON(res, 400, { error: '不是合法的 JSON' }); return; }
      const enable = !!(payload && payload.enabled);
      let newPin = null;
      /* 开局域网但还没有口令 → 自动生成一个；regen → 换一个（都会踢掉旧凭据） */
      if (payload && payload.regen) {
        rotatePin(genPin());
        newPin = lanPin;
      } else if (enable && !lanPin) {
        rotatePin(genPin());
        newPin = lanPin;
      }
      if (enable === lanIsOn() && !newPin) {
        sendJSON(res, 200, {
          ok: true, lanEnabled: lanIsOn(),
          addresses: lanIsOn() ? lanAddresses() : [],
          pin: requesterIsLocal(req) ? lanPin : null
        });
        return;
      }
      writeLanEnabled(enable);
      /* 先应答再切端口：rebind 会掐断现有连接，要是先切，这个请求
         自己的响应就发不出去了，网页端只会看到「连接失败」 */
      sendJSON(res, 200, {
        ok: true, lanEnabled: enable,
        addresses: enable ? lanAddresses() : [],
        /* 本机请求一直都能拿到口令（regen 时尤其要拿到新的）；
           非本机从未放行过这个接口，不存在泄露面 */
        pin: requesterIsLocal(req) ? lanPin : null
      });
      setTimeout(function () {
        rebind(enable, function (err) {
          if (err) { console.error('  [warn] 端口切换失败：' + err.message); }
        });
      }, 150);
    });
    return;
  }

  if (pathname === '/api/db') {
    if (req.method === 'GET') {
      const cur = readData();
      sendJSON(res, 200, { rev: cur.rev, savedAt: cur.savedAt, data: cur.data });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!requireSameSite(req, res)) { return; }
      readBody(req, res, function (text) {
        if (text === null) { sendJSON(res, 400, { error: '请求体过大或读取失败' }); return; }
        let payload;
        try { payload = JSON.parse(text); }
        catch (e) { sendJSON(res, 400, { error: '不是合法的 JSON' }); return; }
        if (!payload || typeof payload !== 'object' || !payload.data) {
          sendJSON(res, 400, { error: '缺少 data 字段' });
          return;
        }

        const cur = readData();
        const clientRev = Number(payload.rev);

        if (Number.isFinite(clientRev) && clientRev !== cur.rev) {
          sendJSON(res, 409, { conflict: true, rev: cur.rev, savedAt: cur.savedAt, data: cur.data });
          return;
        }

        snapshotBackup();
        const nextRev = cur.rev + 1;
        const data = sanitize(payload.data);
        try {
          writeData(nextRev, data);
        } catch (e) {
          sendJSON(res, 500, { error: '写入失败：' + e.message });
          return;
        }
        sendJSON(res, 200, { ok: true, rev: nextRev, savedAt: new Date().toISOString() });
      });
      return;
    }
    res.writeHead(405, { 'Allow': 'GET, PUT' });
    res.end();
    return;
  }

  /* 网页端点了「停止服务」 */
  if (pathname === '/api/shutdown') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      res.end();
      return;
    }
    /* 同 /api/db：不允许别的网页隔空把服务停掉 */
    if (!requireSameSite(req, res)) { return; }
    sendJSON(res, 200, { ok: true });
    stopServer('网页端点了「停止服务」');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }

  serveStatic(pathname, res);
}

const server = http.createServer(handleRequest);

/* ---------- 启动 ---------- */

/* 收尾退出：响应/提示发出后先关监听再退进程；keep-alive 连接挂着时
   close 不会立刻回调，1.5 秒后兜底强退。网页端「停止服务」和
   终端里按 q 共用这一条路，保证都是干净的退出。 */
function stopServer(byWhat) {
  console.log('');
  console.log('  ' + byWhat + '，正在退出。');
  console.log('');
  setTimeout(function () {
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 1500);
  }, 150);
}

function main() {
  ensureDirs();
  lanEnabled = readLanEnabled();
  lanPin = String(readSettings().pin || '');
  /* 老设置里局域网开着但没有口令：自动补一个，不让 LAN 裸奔。
     口令不打印到控制台——窗口可能被人看到，要看请开网页端「数据管理」。 */
  if (lanEnabled && !lanPin) {
    rotatePin(genPin());
    console.log('  检测到局域网访问开着但还没有口令，已自动生成一个。');
    console.log('  打开网页端 → 右上角「⋯」→ 数据管理，可以看到或修改它。');
  }
  currentHost = lanEnabled ? HOST_LAN : HOST_LOCAL;

  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('');
      console.error('  端口 ' + PORT + ' 已被占用。');
      console.error('  可能已经有一个记账本在运行了——先看看是不是已经开着一个窗口。');
      console.error('  想换端口的话，用：set PORT=9000 && node server.js');
      console.error('');
    } else {
      console.error('启动失败：' + (err && err.message ? err.message : err));
    }
    process.exit(1);
  });

  server.listen(PORT, currentHost, function () {
    const line = '  ' + '-'.repeat(58);
    console.log('');
    console.log('  记账本已经启动');
    console.log(line);
    console.log('  在这台电脑上打开：  http://localhost:' + PORT);
    console.log(line);
    console.log('  数据文件：' + DATA_FILE);
    console.log('  历史版本：' + BACKUP_DIR + '  （每次保存自动留档，最多 ' + BACKUP_KEEP + ' 份）');
    console.log(line);
    console.log('  这个窗口关掉，服务就停了，手机也会跟着断。');
    console.log('');
    printLanState();
    /* 交互退出：在真终端里跑（双击 bat、手动命令行）时，输入 q 回车
       停止服务。终端自带行缓冲，回车确认能防误触，半路反悔清掉重打
       就行；Ctrl+C 保持系统原生行为。管道 / 测试 / CI（非 TTY）不挂
       监听，行为与从前完全一致。不在 Node 里自动开浏览器：启动外部
       程序交给 启动记账本.bat 做，服务本身保持零子进程。 */
    if (process.stdin.isTTY) {
      console.log('  输入 q 回车，停止服务。');
      console.log('');
      process.stdin.on('data', function (chunk) {
        const s = String(chunk).trim().toLowerCase();
        if (s === 'q') { stopServer('输入了 q'); }
      });
    }
  });
}

/* 直接运行时才启动服务；被 require（测试）时只导出内部函数 */
if (require.main === module) {
  main();
}

module.exports = {
  readData: readData,
  writeData: writeData,
  sanitize: sanitize,
  snapshotBackup: snapshotBackup,
  isServable: isServable,
  sameOrigin: sameOrigin,
  requireSameSite: requireSameSite,
  lanAddresses: lanAddresses,
  isLoopbackAddress: isLoopbackAddress,
  readLanEnabled: readLanEnabled,
  writeLanEnabled: writeLanEnabled,
  stamp: stamp,
  /* 口令：格式判断、凭据派生、定长比较、轮换与失败限速 */
  isValidPin: isValidPin,
  genPin: genPin,
  authToken: authToken,
  safeEqual: safeEqual,
  rotatePin: rotatePin,
  authLockLeft: authLockLeft,
  noteAuthFail: noteAuthFail,
  clearAuthFail: clearAuthFail,
  readSettings: readSettings,
  /* 历史版本 */
  parseBackupStamp: parseBackupStamp,
  listBackups: listBackups,
  restoreBackup: restoreBackup,
  /* 请求处理函数本体：测试拿它起一个自己的端口，跑真实 HTTP 往返 */
  handleRequest: handleRequest
};
