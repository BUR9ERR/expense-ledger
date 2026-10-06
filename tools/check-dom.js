'use strict';

/* ============================================================
   前端静态一致性检查（tools/check-dom.js）
   ------------------------------------------------------------
   这个项目不引 npm 依赖，也就没有 jsdom / 浏览器测试环境，
   界面改动只能靠肉眼。这个脚本把「肉眼能看出来的一半」变成
   机器检查：

     1. app.js 里每一个 $('id') / getElementById('id') 引用的元素，
        index.html 里都必须存在（少一个就是运行时报 null 崩溃）
     2. index.html 里 <script src> 引用的文件必须真实存在
     3. index.html 里不能出现内联 <script>（服务端 CSP 是
        script-src 'self'，内联脚本会被浏览器直接拦掉）
     4. app.js 里用到的 LedgerCore.xxx，core.js 必须真的导出
     5. 同一个 id 在 index.html 里不能重复

   跑法：node tools/check-dom.js   （退出码非 0 = 有问题）
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
/* 静态字面量路径：不给「按变量拼路径再加载」留口子，也省得扫描器误报 */
const core = require('../assets/core.js');

const problems = [];
const note = (msg) => problems.push(msg);

/* ---------- 1. html 里的 id ---------- */
const htmlIds = new Set();
const idRe = /\sid="([^"]+)"/g;
let m;
while ((m = idRe.exec(html))) {
  if (htmlIds.has(m[1])) { note('index.html 里 id 重复：' + m[1]); }
  htmlIds.add(m[1]);
}

/* ---------- 2. app.js 引用的 id ---------- */
const used = new Set();
const useRe = /\$\('([^']+)'\)|getElementById\('([^']+)'\)/g;
while ((m = useRe.exec(app))) {
  const id = m[1] || m[2];
  used.add(id);
  if (!htmlIds.has(id)) { note('app.js 引用了 index.html 里不存在的 id：' + id); }
}

/* ---------- 3. script src 存在、且没有内联脚本 ---------- */
const srcRe = /<script\b([^>]*)>/g;
while ((m = srcRe.exec(html))) {
  const attrs = m[1];
  if (/\ssrc="([^"]+)"/.test(attrs)) {
    const rel = /\ssrc="([^"]+)"/.exec(attrs)[1];
    if (!fs.existsSync(path.join(ROOT, rel))) { note('index.html 引用的脚本不存在：' + rel); }
    continue;
  }
  /* 没有 src 的 <script> = 内联脚本，会被 CSP 拦掉 */
  note('index.html 里有内联 <script>（CSP script-src \'self\' 会拦掉它）');
}

/* ---------- 4. LedgerCore.xxx 都真的导出 ---------- */
const coreRe = /LedgerCore\.([A-Za-z_$][\w$]*)/g;
while ((m = coreRe.exec(app))) {
  if (!(m[1] in core)) { note('app.js 用了 LedgerCore.' + m[1] + '，但 core.js 没有导出它'); }
}

/* ---------- 5. 设置面板（数据管理）的分组顺序 ----------
   面板里的东西是按「先设置、再操作、最后危险操作」排的，
   这几条断言把顺序钉住：以后加东西排错位置、或者又把危险操作
   挪到中间，这里会直接报错，不用靠肉眼盯。 */
const SHEET_ORDER = [
  'storageBox',        /* 数据存在哪 */
  'themeSeg',          /* 一、外观 */
  'lanRow',            /* 局域网开关 */
  'pinLine',           /* 口令显示 */
  'pinEditBox',        /* 改口令 */
  'mobileBox',         /* 手机地址 */
  'btnExport',         /* 二、备份 */
  'btnExportText',
  'btnExportCsv',
  'btnImport',
  'btnImportBill',
  'btnReload',
  'btnRecur',          /* 常用工具 */
  'btnHealth',
  'btnTrash',
  'btnShutdown',       /* 三、危险操作，永远在最后 */
  'btnClear'
];
let lastAt = -1;
SHEET_ORDER.forEach((id) => {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) { note('设置面板里找不到 ' + id); return; }
  if (at < lastAt) { note('设置面板里的顺序不对：' + id + ' 排在了它该在的位置之后'); }
  lastAt = at;
});

/* ---------- 6. 流水页的筛选行顺序：搜索 → 类型 → 来源 → 分类 ---------- */
const LIST_ORDER = ['searchInput', 'filterChips', 'sourceChips', 'categoryChips'];
lastAt = -1;
LIST_ORDER.forEach((id) => {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) { note('流水页里找不到 ' + id); return; }
  if (at < lastAt) { note('流水页的筛选行顺序不对：' + id + ' 排在了它该在的位置之后'); }
  lastAt = at;
});

/* ---------- 7. 被缓存的静态文件清单要对得上 ---------- */const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const hashList = /const SW_HASH_FILES = \[([\s\S]*?)\];/.exec(server);
if (!hashList) {
  note('server.js 里找不到 SW_HASH_FILES');
} else {
  const files = hashList[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const precache = /var PRECACHE = \[([\s\S]*?)\];/.exec(sw);
  /* PRECACHE 里写的是 URL 路径（前面带 /），SW_HASH_FILES 是仓库相对路径。
     只认「看起来像文件」的字符串，避开 .test() 这类方法名 */
  const cached = (precache ? precache[1].match(/'([^']+\.[a-z]+)'/g) || [] : [])
    .map((s) => s.slice(1, -1).replace(/^\//, ''));
  files.forEach((f) => {
    if (!fs.existsSync(path.join(ROOT, f))) { note('SW_HASH_FILES 里的文件不存在：' + f); }
    /* sw.js 自己不预缓存（它在被请求时现算），词库文件有意不缓存（改了要立刻生效） */
    if (f === 'sw.js' || f.indexOf('分类词库') >= 0) { return; }
    if (cached.indexOf(f) < 0) { note('SW_HASH_FILES 有、sw.js 的 PRECACHE 没有（手机端会拿旧代码）：' + f); }
  });
}

/* ---------- 7b. 表单控件的字号必须 ≥16px ----------
   iOS Safari 在聚焦 font-size < 16px 的输入框时会把整个页面放大，
   而且不会自动缩回去（用户得手动双指捏回来）。历史上「流水搜索框」
   就踩过：搜索一次页面就变大一圈。字号看着大就调颜色，别调字号。 */
const css = fs.readFileSync(path.join(ROOT, 'assets', 'styles.css'), 'utf8');
[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].forEach((r) => {
  const sel = r[1].trim();
  if (!/(input|select|textarea)/i.test(sel)) { return; }
  const m = /font-size:\s*([\d.]+)px/.exec(r[2]);
  if (m && Number(m[1]) < 16) {
    note('表单控件字号 <16px（iOS 聚焦会自动放大整页）：' + sel.slice(0, 60) + ' = ' + m[1] + 'px');
  }
});

/* ---------- 8. exe 打包清单要覆盖页面用到的文件 ----------
   SEA 打包态静态资源是从 exe 内嵌 blob 里取的（server.js 的 FROZEN 分支），
   清单漏一个文件，exe 版就是 404 + 白屏，而开发态一切正常——最难发现的一类 bug。
   所以这里对着 index.html 真正引用到的 .js/.css 逐个核对。 */
const sea = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'sea-config.json'), 'utf8'));
const seaAssets = Object.keys(sea.assets || {});
const referenced = new Set();
const refRe = /(?:src|href)="([^":]+\.(?:js|css))"/g;
while ((m = refRe.exec(html))) { referenced.add(m[1].replace(/^\.?\//, '')); }
referenced.forEach((rel) => {
  if (seaAssets.indexOf(rel) < 0) {
    note('index.html 引用了 ' + rel + '，但 tools/sea-config.json 的打包清单里没有（exe 版会 404）');
  }
});

/* ---------- 结果 ---------- */
if (problems.length) {
  console.error('前端静态检查发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('前端静态检查通过：id 引用 ' + used.size + ' 个、html id ' + htmlIds.size +
            ' 个、设置面板与筛选行顺序正确、SW 与 exe 打包清单一致。');
