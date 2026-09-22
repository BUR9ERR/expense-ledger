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
const { exec } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ledger.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 30;
const PORT = Number(process.env.PORT) || 8765;
const HOST = '0.0.0.0';
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

function snapshotBackup() {
  try {
    ensureDirs();
    if (!fs.existsSync(DATA_FILE)) { return; }
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, 'ledger-' + stamp() + '.json'));
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(function (f) { return /^ledger-.*\.json$/.test(f); })
      .sort();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) {
    console.warn('[warn] 备份失败：' + e.message);
  }
}

function sanitize(data) {
  const src = data && typeof data === 'object' ? data : {};
  return {
    version: 1,
    categories: Array.isArray(src.categories) ? src.categories.slice(0, 300) : [],
    transactions: Array.isArray(src.transactions) ? src.transactions.slice(0, 200000) : [],
    createdAt: Number(src.createdAt) || Date.now()
  };
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

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { aborted = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (aborted) { return; }
    cb(Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', function () { cb(null); });
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
    return segs[0].toLowerCase() === 'index.html';
  }
  return segs[0].toLowerCase() === 'assets';
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT, path.normalize(rel));
  if (!isServable(filePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
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

const server = http.createServer(function (req, res) {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    pathname = '/';
  }

  /* 静态文件由 serveStatic 里的白名单把关（data 目录、隐藏文件都进不去） */

  if (pathname === '/api/info') {
    const cur = readData();
    sendJSON(res, 200, {
      mode: 'server',
      port: PORT,
      addresses: lanAddresses(),
      dataFile: DATA_FILE,
      backupDir: path.join(DATA_DIR, 'backups'),
      backupKeep: BACKUP_KEEP,
      rev: cur.rev,
      savedAt: cur.savedAt,
      count: Array.isArray(cur.data.transactions) ? cur.data.transactions.length : 0
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
      readBody(req, function (text) {
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
    sendJSON(res, 200, { ok: true });
    console.log('');
    console.log('  网页端点了「停止服务」，正在退出。');
    console.log('');
    setTimeout(function () {
      server.close(function () { process.exit(0); });
      /* 还有 keep-alive 连接挂着时 close 不会立刻回调，兜个底 */
      setTimeout(function () { process.exit(0); }, 1500);
    }, 150);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }

  serveStatic(pathname, res);
});

/* ---------- 启动 ---------- */

ensureDirs();

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

server.listen(PORT, HOST, function () {
  const addrs = lanAddresses();
  const line = '  ' + '-'.repeat(58);
  console.log('');
  console.log('  记账本已经启动');
  console.log(line);
  console.log('  在这台电脑上打开：  http://localhost:' + PORT);
  if (addrs.length) {
    console.log('  在手机上打开：      http://' + addrs[0].address + ':' + PORT);
    if (addrs.length > 1) {
      addrs.slice(1).forEach(function (a) {
        console.log('                或：  http://' + a.address + ':' + PORT + '   (' + a.iface + ')');
      });
    }
    console.log('');
    console.log('  ⚠ 手机需要连同一个 WiFi，首次打开时 Windows 可能会弹出防火墙提示，');
    console.log('    选择「允许访问」手机才能连上。');
  } else {
    console.log('  没有检测到局域网地址，手机可能连不上。');
  }
  console.log(line);
  console.log('  数据文件：' + DATA_FILE);
  console.log('  历史版本：' + BACKUP_DIR + '  （每次保存自动留档，最多 ' + BACKUP_KEEP + ' 份）');
  console.log(line);
  console.log('  这个窗口关掉，服务就停了，手机也会跟着断。');
  console.log('');

  /* 双击 .bat 启动时顺手把浏览器打开，省得再找地址 */
  if (process.platform === 'win32' && !process.env.LEDGER_NO_BROWSER) {
    try {
      exec('explorer "http://localhost:' + PORT + '/"');
    } catch (e) { /* 打不开就算了，地址已经打印在上面 */ }
  }
});
