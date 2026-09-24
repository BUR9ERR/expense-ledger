'use strict';

/* ============================================================
   记账本 v0.1
   数据全部存在本机浏览器，不联网、不上传。
   ============================================================ */

var STORE_KEY = 'ledger.v1.db';
var BACKUP_KEY = 'ledger.v1.lastBackup';
var BACKUP_WARN_DAYS = 7;

var DEFAULT_CATEGORIES = [
  { id: 'food',     kind: 'expense', name: '餐饮', icon: '\uD83C\uDF5C', color: '#E8833A', soft: '#FBEEDF' },
  { id: 'traffic',  kind: 'expense', name: '交通', icon: '\uD83D\uDE8C', color: '#4A90D9', soft: '#E4EFFA' },
  { id: 'shop',     kind: 'expense', name: '购物', icon: '\uD83D\uDED2', color: '#DE5F8B', soft: '#FBE8EF' },
  { id: 'home',     kind: 'expense', name: '居住', icon: '\uD83C\uDFE0', color: '#8B6FC7', soft: '#EFEAF9' },
  { id: 'fun',      kind: 'expense', name: '娱乐', icon: '\uD83C\uDFAE', color: '#3FA98C', soft: '#E3F4EF' },
  { id: 'health',   kind: 'expense', name: '医疗', icon: '\uD83D\uDC8A', color: '#DE5E5E', soft: '#FBE9E9' },
  { id: 'social',   kind: 'expense', name: '人情', icon: '\uD83C\uDF81', color: '#D99A4E', soft: '#FAF0E1' },
  { id: 'study',    kind: 'expense', name: '学习', icon: '\uD83D\uDCDA', color: '#5B8DEF', soft: '#E7EEFC' },
  { id: 'daily',    kind: 'expense', name: '日用', icon: '\uD83E\uDDF4', color: '#6FA8A0', soft: '#E6F1EF' },
  { id: 'other_e',  kind: 'expense', name: '其他', icon: '\uD83D\uDCE6', color: '#9AA0A6', soft: '#EFEFEF' },
  { id: 'salary',   kind: 'income',  name: '工资', icon: '\uD83D\uDCB0', color: '#1D9E75', soft: '#E1F3EC' },
  { id: 'bonus',    kind: 'income',  name: '奖金', icon: '\uD83C\uDF89', color: '#3AAF8A', soft: '#E5F5EF' },
  { id: 'parttime', kind: 'income',  name: '兼职', icon: '\uD83D\uDCBC', color: '#4CAF93', soft: '#E7F5F1' },
  { id: 'invest',   kind: 'income',  name: '投资', icon: '\uD83D\uDCC8', color: '#2E9E7E', soft: '#E3F3EE' },
  { id: 'gift',     kind: 'income',  name: '红包', icon: '\uD83E\uDDE7', color: '#DE5E5E', soft: '#FBE9E9' },
  { id: 'other_i',  kind: 'income',  name: '其他', icon: '\uD83D\uDCE5', color: '#9AA0A6', soft: '#EFEFEF' }
];

/* ---------- DOM ---------- */
var $ = function (id) { return document.getElementById(id); };

var elTypeSwitch = $('typeSwitch');
var elAmount     = $('amountInput');
var elCatGrid    = $('catGrid');
var elDate       = $('dateInput');
var elQuickDates = $('quickDates');
var elNote       = $('noteInput');
var elBtnSave    = $('btnSave');
var elBtnDelete  = $('btnDelete');
var elBtnCancel  = $('btnCancelEdit');
var elMonthLabel = $('monthLabel');
var elFilterChips= $('filterChips');
var elListTotal  = $('listTotal');
var elTxList     = $('txList');
var elHeroLabel  = $('heroLabel');
var elHeroAmount = $('heroAmount');
var elSumIncome  = $('sumIncome');
var elSumBalance = $('sumBalance');
var elStatAvg    = $('statAvg');
var elStatMax    = $('statMax');
var elStatCount  = $('statCount');
var elRankList   = $('rankList');
var elTrendChart = $('trendChart');
var elTabbar     = $('tabbar');
var elMask       = $('mask');
var elSheetData  = $('sheetData');
var elSheetImport= $('sheetImport');
var elSheetBill  = $('sheetBill');
var elBillFile   = $('billFile');
var elBillResult = $('billResult');
var elBtnBillOk  = $('btnBillConfirm');
var elBackupNote = $('backupNotice');
var elToast      = $('toast');
var elFileInput  = $('fileInput');
var elImportText = $('importText');

/* ---------- 工具 ---------- */
function pad2(n) { return (n < 10 ? '0' : '') + n; }

function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function todayStr() { return ymd(new Date()); }

function parseYmd(s) {
  var p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 颜色只放行 #RGB / #RRGGBB / rgb() 这几种写法。
   导入的账本里如果夹带了奇怪的字符串，不会有机会写进 style 属性。 */
function safeColor(v, fallback) {
  var s = String(v == null ? '' : v).trim();
  if (/^#[0-9a-fA-F]{3}$/.test(s) ||
      /^#[0-9a-fA-F]{6}$/.test(s) ||
      /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/.test(s)) {
    return s;
  }
  return fallback;
}

/* 金额以「分」参与计算，避免小数累加误差 */
function toCents(n) { return Math.round(Number(n) * 100); }

function sumCents(list) {
  var s = 0;
  for (var i = 0; i < list.length; i++) { s += toCents(list[i].amount); }
  return s;
}

function fmtMoney(cents) {
  var neg = cents < 0;
  var v = Math.abs(cents) / 100;
  var s = v.toFixed(2);
  if (s.slice(-3) === '.00') { s = s.slice(0, -3); }
  var dot = s.indexOf('.');
  var intPart = dot >= 0 ? s.slice(0, dot) : s;
  var decPart = dot >= 0 ? s.slice(dot) : '';
  var intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '\u00A5' + intFmt + decPart;
}

function fmtShort(cents) {
  var v = Math.abs(cents) / 100;
  if (v >= 10000) { return (v / 10000).toFixed(1).replace(/\.0$/, '') + '\u4E07'; }
  if (v >= 1000) { return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'; }
  return String(Math.round(v));
}

/* 全程整数运算：先按字符串取到分，第三位小数四舍五入，避免浮点误差 */
function parseAmountToCents(raw) {
  var s = String(raw).replace(/[^\d.]/g, '');
  var parts = s.split('.');
  var yuan = parseInt(parts[0] || '', 10);
  if (isNaN(yuan)) { yuan = 0; }
  var dec = (parts[1] || '') + '00';
  var cents = parseInt(dec.slice(0, 2), 10);
  if (isNaN(cents)) { cents = 0; }
  var total = yuan * 100 + cents;
  if (parseInt(dec.charAt(2), 10) >= 5) { total += 1; }
  return total;
}

function dayHead(dateStr) {
  var d = parseYmd(dateStr);
  var week = ['\u65E5', '\u4E00', '\u4E8C', '\u4E09', '\u56DB', '\u4E94', '\u516D'][d.getDay()];
  var t = todayStr();
  var yest = ymd(new Date(Date.now() - 86400000));
  var label;
  if (dateStr === t) { label = '\u4ECA\u5929'; }
  else if (dateStr === yest) { label = '\u6628\u5929'; }
  else { label = (d.getMonth() + 1) + '\u6708' + d.getDate() + '\u65E5'; }
  return label + ' \u5468' + week;
}

var toastTimer = null;
function toast(msg, ms) {
  elToast.textContent = msg;
  elToast.classList.remove('is-hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { elToast.classList.add('is-hidden'); }, ms || 2200);
}

/* ---------- 存储 ---------- */
/*
 * 两种模式：
 *   server —— 数据存在电脑上的 data/ledger.json（跑 server.js 时）
 *   local  —— 退回浏览器本地存储（直接双击打开网页文件，或服务没启动时）
 */
var db = null;
var storageOK = true;
var mode = 'local';
var serverRev = 0;
var serverInfo = null;
var saveTimer = null;
var saving = false;
var savePending = false;
/* 上次成功写入电脑的时刻。用来分辨本地那条是「刚记的新账」还是「早被删掉的残留」 */
var lastPushAt = 0;
/* 已经在网页端把服务停掉了 */
var stopped = false;
var reconnectTimer = null;

function storageAvailable() {
  try {
    var k = '__ledger_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch (e) { return false; }
}

function freshDB() {
  return {
    version: 1,
    categories: DEFAULT_CATEGORIES.slice(),
    transactions: [],
    createdAt: Date.now()
  };
}

function sanitizeDB(raw) {
  var out = freshDB();
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.transactions)) { out.transactions = raw.transactions; }
    if (Array.isArray(raw.categories) && raw.categories.length) { out.categories = raw.categories; }
    if (raw.createdAt) { out.createdAt = Number(raw.createdAt) || Date.now(); }
  }
  return out;
}

function loadLocalDB() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) { return null; }
    var parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.transactions)) { return null; }
    return sanitizeDB(parsed);
  } catch (e) {
    return null;
  }
}

function saveLocalDB() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    return true;
  } catch (e) {
    toast('保存失败：浏览器存储空间可能已满', 4000);
    return false;
  }
}

function saveDB() {
  if (mode === 'server') {
    queueServerSave();
    return true;
  }
  return saveLocalDB();
}

/* ---------- 与本地服务通信 ---------- */

function api(method, url, body, cb) {
  var xhr = new XMLHttpRequest();
  try {
    xhr.open(method, url, true);
  } catch (e) {
    cb(e, 0, '');
    return;
  }
  xhr.timeout = 8000;
  if (body !== null && body !== undefined) {
    xhr.setRequestHeader('Content-Type', 'application/json');
  }
  xhr.onload = function () { cb(null, xhr.status, xhr.responseText); };
  xhr.onerror = function () { cb(new Error('network'), 0, ''); };
  xhr.ontimeout = function () { cb(new Error('timeout'), 0, ''); };
  try {
    xhr.send(body === null || body === undefined ? null : body);
  } catch (e) {
    cb(e, 0, '');
  }
}

function queueServerSave() {
  setSyncState('pending');
  if (saveTimer) { clearTimeout(saveTimer); }
  saveTimer = setTimeout(pushToServer, 220);
}

function pushToServer() {
  saveTimer = null;
  if (stopped) { return; }
  if (saving) { savePending = true; return; }
  saving = true;

  api('PUT', '/api/db', JSON.stringify({ rev: serverRev, data: db }), function (err, status, text) {
    saving = false;

    if (err) {
      setSyncState('offline');
      toast('连不上电脑上的记账本服务，这次改动还没存进去', 4000);
    } else if (status === 200) {
      try { serverRev = JSON.parse(text).rev; } catch (e) { serverRev++; }
      lastPushAt = Date.now();
      setSyncState('saved');
    } else if (status === 409) {
      resolveConflict(text);
    } else {
      setSyncState('offline');
      toast('保存到电脑失败', 3200);
    }

    if (savePending) { savePending = false; pushToServer(); }
  });
}

function resolveConflict(text) {
  var res = null;
  try { res = JSON.parse(text); } catch (e) { res = null; }
  if (!res || !res.data) { setSyncState('offline'); return; }

  var remote = sanitizeDB(res.data);
  serverRev = Number(res.rev) || 0;

  /* 电脑上的文件是空的，而这边有账目：多半是数据文件被删了或重置了。
     这种情况以本地为准全部写回去，绝不能把用户的账目清掉。 */
  if (!remote.transactions.length && db.transactions.length) {
    toast('电脑上的账本文件是空的，正在把你这里的 ' + db.transactions.length + ' 笔写回去', 4500);
    setSyncState('pending');
    savePending = true;
    return;
  }

  /* 合并规则：
     1. 两边都有的 → 谁的 updatedAt 更新就用谁的
     2. 只有本地有的 → 看它是不是「上次成功保存之后才记的」
          · 是 → 本地刚记的新账，保留
          · 否 → 服务端早就删掉的残留，丢弃（否则删过的账目会自己冒回来） */
  var remoteById = {};
  remote.transactions.forEach(function (t) { remoteById[t.id] = t; });

  var merged = remote.transactions.slice();
  db.transactions.forEach(function (t) {
    var r = remoteById[t.id];
    if (r) {
      if ((t.updatedAt || 0) > (r.updatedAt || 0)) {
        var idx = merged.indexOf(r);
        if (idx >= 0) { merged[idx] = t; }
      }
      return;
    }
    if ((t.createdAt || 0) > lastPushAt) { merged.push(t); }
  });
  db.transactions = merged;

  renderCategories();
  renderList();
  renderSummary();
  setSyncState('pending');
  savePending = true;
}

function pullFromServer(notify) {
  api('GET', '/api/db', null, function (err, status, text) {
    if (err || status !== 200) {
      if (notify) { toast('读取失败，检查一下服务是不是还在运行'); }
      return;
    }
    try {
      var res = JSON.parse(text);
      serverRev = Number(res.rev) || 0;
      db = sanitizeDB(res.data);
      renderCategories();
      renderList();
      renderSummary();
      setSyncState('saved');
      if (notify) { toast('已从电脑重新加载'); }
    } catch (e) {
      if (notify) { toast('数据格式看不懂'); }
    }
  });
}

function setSyncState(s) {
  var el = $('syncState');
  if (!el) { return; }
  if (mode !== 'server') { el.classList.add('is-hidden'); return; }
  el.classList.remove('is-hidden');
  if (s === 'saved') {
    el.className = 'sync-badge is-saved';
    el.textContent = '已存到电脑';
  } else if (s === 'pending') {
    el.className = 'sync-badge is-pending';
    el.textContent = '保存中';
  } else {
    el.className = 'sync-badge is-offline';
    el.textContent = '未连上';
  }
}

function categoryById(id) {
  for (var i = 0; i < db.categories.length; i++) {
    if (db.categories[i].id === id) { return db.categories[i]; }
  }
  return { id: id, name: '\u672A\u77E5', icon: '\u2753', color: '#9AA0A6', soft: '#EFEFEF', kind: 'expense' };
}

/* ---------- 状态 ---------- */
var state = {
  page: 'record',
  type: 'expense',
  categoryId: 'food',
  editingId: null,
  /* 这次编辑是从哪儿进来的：'list' = 从流水点进来的，改完要回流水并滚到那条 */
  editFrom: 'record',
  listMonth: '',
  listFilter: 'all'
};

function currentMonthKey() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

/* ============================================================
   记一笔
   ============================================================ */

function renderCategories() {
  var list = db.categories.filter(function (c) { return c.kind === state.type; });
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var on = c.id === state.categoryId ? ' is-active' : '';
    html += '<button type="button" class="cat-item' + on + '" data-cat="' + esc(c.id) + '"' +
            ' style="--c:' + safeColor(c.color, '#9AA0A6') + ';--soft-c:' + safeColor(c.soft, '#EFEFEF') + '">' +
            '<span class="cat-ico">' + esc(c.icon) + '</span>' +
            '<span class="cat-name">' + esc(c.name) + '</span>' +
            '</button>';
  }
  elCatGrid.innerHTML = html;
}

function setType(type) {
  state.type = type;
  document.body.setAttribute('data-type', type);
  var btns = elTypeSwitch.querySelectorAll('.seg-item');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-active', btns[i].getAttribute('data-type') === type);
  }
  var cats = db.categories.filter(function (c) { return c.kind === type; });
  var belongs = cats.some(function (c) { return c.id === state.categoryId; });
  if (!belongs && cats.length) { state.categoryId = cats[0].id; }
  renderCategories();
}

function markQuickDate(offset) {
  var t = todayStr();
  var target = offset === 0 ? t : ymd(new Date(Date.now() + offset * 86400000));
  var btns = elQuickDates.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    var off = Number(b.getAttribute('data-offset'));
    var d = off === 0 ? t : ymd(new Date(Date.now() + off * 86400000));
    b.classList.toggle('is-active', d === target);
  }
}

function enterEdit(tx, from) {
  state.editingId = tx.id;
  state.editFrom = from === 'list' ? 'list' : 'record';
  setType(tx.type);
  state.categoryId = tx.categoryId;
  renderCategories();
  elAmount.value = String(tx.amount);
  elDate.value = tx.date;
  elNote.value = tx.note || '';
  elBtnSave.textContent = '\u4FDD\u5B58\u4FEE\u6539';
  elBtnDelete.classList.remove('is-hidden');
  elBtnCancel.classList.remove('is-hidden');
  markQuickDate(calcOffsetDays(tx.date));
  go('record');
  elAmount.focus();
}

function calcOffsetDays(dateStr) {
  var t = parseYmd(todayStr()).getTime();
  var d = parseYmd(dateStr).getTime();
  return Math.round((d - t) / 86400000);
}

function exitEdit() {
  state.editingId = null;
  elBtnSave.textContent = '\u8BB0\u4E0B\u6765';
  elBtnDelete.classList.add('is-hidden');
  elBtnCancel.classList.add('is-hidden');
  elAmount.value = '';
  elNote.value = '';
  elDate.value = todayStr();
  markQuickDate(0);
}

function saveEntry() {
  var cents = parseAmountToCents(elAmount.value);
  if (!cents || cents <= 0) {
    toast('\u8BF7\u5148\u8F93\u5165\u91D1\u989D');
    elAmount.focus();
    return;
  }
  if (!state.categoryId) {
    toast('\u8BF7\u9009\u4E00\u4E2A\u5206\u7C7B');
    return;
  }
  var date = elDate.value || todayStr();
  var note = elNote.value.trim().slice(0, 40);
  var now = Date.now();

  /* 这次编辑是不是从流水点进来的（是的话改完要回流水原位） */
  var editedId = state.editingId;
  var fromList = !!editedId && state.editFrom === 'list';

  if (editedId) {
    var tx = null;
    for (var i = 0; i < db.transactions.length; i++) {
      if (db.transactions[i].id === editedId) { tx = db.transactions[i]; break; }
    }
    if (!tx) {
      /* 编辑到一半被别的设备删掉了，别假装保存成功 */
      exitEdit();
      toast('这条记录已经不在了，可能被另一台设备删掉了', 4000);
      if (fromList) { backToList(null); } else { renderList(); }
      return;
    }
    tx.type = state.type;
    tx.amount = cents / 100;
    tx.categoryId = state.categoryId;
    tx.date = date;
    tx.note = note;
    tx.updatedAt = now;
    if (!saveDB()) { return; }
    exitEdit();
    toast('已保存修改');
    if (fromList) {
      /* 留在流水里，滚回刚改的那条 */
      renderSummary();
      backToList(editedId);
      return;
    }
  } else {
    db.transactions.push({
      id: uid(),
      type: state.type,
      amount: cents / 100,
      categoryId: state.categoryId,
      date: date,
      note: note,
      createdAt: now,
      updatedAt: now
    });
    if (!saveDB()) { return; }
    elAmount.value = '';
    elNote.value = '';
    toast(fmtMoney(cents) + '\u3000\u8BB0\u4E0B\u4E86');
  }

  elAmount.focus();
  renderList();
  renderSummary();
}

function deleteEntry() {
  if (!state.editingId) { return; }
  var id = state.editingId;
  var fromList = state.editFrom === 'list';
  var tx = null;
  for (var i = 0; i < db.transactions.length; i++) {
    if (db.transactions[i].id === id) { tx = db.transactions[i]; break; }
  }
  if (!tx) {
    exitEdit();
    toast('这条记录已经不在了');
    if (fromList) { backToList(null); } else { renderList(); }
    return;
  }
  if (!window.confirm('\u5220\u9664\u8FD9\u7B14\uFF1A' + categoryById(tx.categoryId).name + '\u3000' + fmtMoney(toCents(tx.amount)) + '\uFF1F')) {
    return;
  }
  db.transactions = db.transactions.filter(function (t) { return t.id !== id; });
  saveDB();
  exitEdit();
  toast('\u5DF2\u5220\u9664');
  renderSummary();
  if (fromList) {
    /* 删掉的这条已经不在列表里了，回到原来的滚动位置即可 */
    backToList(null, true);
  } else {
    renderList();
  }
}

/* ============================================================
   流水
   ============================================================ */

function monthTx(key) {
  var p = key.split('-');
  var y = Number(p[0]);
  var m = Number(p[1]);
  return db.transactions.filter(function (t) {
    var d = parseYmd(t.date);
    return d.getFullYear() === y && d.getMonth() === m - 1;
  });
}

function renderList() {
  var p = state.listMonth.split('-');
  elMonthLabel.textContent = p[0] + ' \u5E74 ' + Number(p[1]) + ' \u6708';

  var monthAll = monthTx(state.listMonth);
  var list = state.listFilter === 'all'
    ? monthAll
    : monthAll.filter(function (t) { return t.type === state.listFilter; });

  var expCents = sumCents(monthAll.filter(function (t) { return t.type === 'expense'; }));
  var incCents = sumCents(monthAll.filter(function (t) { return t.type === 'income'; }));
  elListTotal.innerHTML = '<span>\u652F\u51FA <b>' + fmtMoney(expCents) + '</b></span>' +
                          '<span>\u6536\u5165 <b>' + fmtMoney(incCents) + '</b></span>';

  if (!list.length) {
    elTxList.innerHTML = '<div class="empty"><div class="empty-ico">\uD83D\uDCD2</div>' +
      '\u8FD9\u4E2A\u6708\u8FD8\u6CA1\u6709\u8BB0\u8D26</div>';
    return;
  }

  var byDay = {};
  list.forEach(function (t) {
    if (!byDay[t.date]) { byDay[t.date] = []; }
    byDay[t.date].push(t);
  });

  var days = Object.keys(byDay).sort().reverse();
  var html = '';
  days.forEach(function (day) {
    var items = byDay[day].slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    var dayExp = sumCents(items.filter(function (t) { return t.type === 'expense'; }));
    var dayInc = sumCents(items.filter(function (t) { return t.type === 'income'; }));

    var sumParts = [];
    if (dayExp) { sumParts.push('\u652F ' + fmtMoney(dayExp)); }
    if (dayInc) { sumParts.push('\u6536 ' + fmtMoney(dayInc)); }

    html += '<div class="tx-day">' +
      '<div class="tx-day-head"><span>' + esc(dayHead(day)) + '</span><b>' + sumParts.join('\u3000') + '</b></div>' +
      '<div class="tx-group">';

    items.forEach(function (t) {
      var c = categoryById(t.categoryId);
      var sign = t.type === 'expense' ? '-' : '+';
      var cls = t.type === 'expense' ? 'is-expense' : 'is-income';
      var editing = t.id === state.editingId ? ' is-editing' : '';
      var noteLine = t.note
        ? '<div class="tx-note">' + esc(t.note) + '</div>'
        : '<div class="tx-note">' + esc(c.name) + '</div>';
      html += '<button type="button" class="tx-item' + editing + '" data-tx="' + esc(t.id) + '">' +
        '<span class="tx-ico">' + esc(c.icon) + '</span>' +
        '<span class="tx-main"><span class="tx-cat">' + esc(c.name) + '</span>' + noteLine + '</span>' +
        '<span class="tx-amt ' + cls + '">' + sign + fmtMoney(toCents(t.amount)) + '</span>' +
        '</button>';
    });

    html += '</div></div>';
  });

  elTxList.innerHTML = html;
}

function shiftMonth(n) {
  var p = state.listMonth.split('-');
  var y = Number(p[0]);
  var m = Number(p[1]) + n;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  state.listMonth = y + '-' + pad2(m);
  renderList();
}

/* ---------- 从流水里改完一笔，回到原位 ---------- */

function findTxById(id) {
  for (var i = 0; i < db.transactions.length; i++) {
    if (db.transactions[i].id === id) { return db.transactions[i]; }
  }
  return null;
}

function syncFilterChips() {
  var chips = elFilterChips.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('is-active', chips[i].getAttribute('data-filter') === state.listFilter);
  }
}

/* 改完/取消/删除之后回到流水，并滚到那条账目所在的位置。
   日期被改到别的月份、或者类型被改到当前筛选之外时，
   先把月份和筛选切到能看见它的状态，否则会出现「回是回来了，但那条不在眼前」。 */
function backToList(id, keepScroll) {
  var tx = id ? findTxById(id) : null;
  if (tx) {
    var key = String(tx.date).slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(key) && key !== state.listMonth) {
      state.listMonth = key;
    }
    if (state.listFilter !== 'all' && state.listFilter !== tx.type) {
      state.listFilter = 'all';
      syncFilterChips();
    }
  }
  go('list', keepScroll);
  if (tx) {
    setTimeout(function () { flashTx(tx.id); }, 30);
  }
}

/* 把某一条滚到屏幕中间并闪一下底色，一眼就能看出刚改的是哪条。
   先试平滑滚动；有些环境（无头浏览器、禁用了动画的系统）它不生效，
   所以随后校验一次，没滚到位就直接跳过去，保证一定能看见。 */
function flashTx(id) {
  var items = elTxList.querySelectorAll('.tx-item');
  var target = null;
  for (var i = 0; i < items.length; i++) {
    if (items[i].getAttribute('data-tx') === id) { target = items[i]; break; }
  }
  if (!target) { return; }

  scrollTxIntoView(target, true);
  setTimeout(function () { scrollTxIntoView(target, false); }, 320);

  target.classList.add('is-flash');
  setTimeout(function () { target.classList.remove('is-flash'); }, 1400);
}

function scrollTxIntoView(target, smooth) {
  var r = target.getBoundingClientRect();
  if (!smooth && r.top >= 0 && r.bottom <= window.innerHeight) { return; }
  try {
    target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  } catch (e) {
    /* 老浏览器不认参数对象 */
    if (!smooth) {
      window.scrollTo(0, window.pageYOffset + target.getBoundingClientRect().top - 120);
    }
  }
}

/* ============================================================
   本月统计
   ============================================================ */

function renderSummary() {
  var d = new Date();
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var key = y + '-' + pad2(m);
  var list = monthTx(key);

  var expenseList = list.filter(function (t) { return t.type === 'expense'; });
  var incomeList  = list.filter(function (t) { return t.type === 'income'; });
  var expCents = sumCents(expenseList);
  var incCents = sumCents(incomeList);

  var isThisMonth = key === currentMonthKey();
  elHeroLabel.textContent = isThisMonth ? '\u672C\u6708\u652F\u51FA' : (m + ' \u6708\u652F\u51FA');
  elHeroAmount.textContent = fmtMoney(expCents);
  elSumIncome.textContent = fmtMoney(incCents);
  elSumBalance.textContent = fmtMoney(incCents - expCents);

  var daysElapsed = isThisMonth ? d.getDate() : new Date(y, m, 0).getDate();
  var avgCents = daysElapsed > 0 ? Math.round(expCents / daysElapsed) : 0;
  var maxCents = expenseList.reduce(function (mx, t) { return Math.max(mx, toCents(t.amount)); }, 0);

  elStatAvg.textContent = fmtMoney(avgCents);
  elStatMax.textContent = fmtMoney(maxCents);
  elStatCount.textContent = String(list.length);

  renderRank(expenseList, expCents);
  renderTrend();
}

function renderRank(expenseList, totalCents) {
  if (!expenseList.length) {
    elRankList.innerHTML = '<div class="empty" style="padding:24px 8px">\u8FD9\u4E2A\u6708\u8FD8\u6CA1\u6709\u652F\u51FA</div>';
    return;
  }
  var groups = {};
  expenseList.forEach(function (t) {
    groups[t.categoryId] = (groups[t.categoryId] || 0) + toCents(t.amount);
  });

  var rows = Object.keys(groups).map(function (id) {
    return { id: id, cents: groups[id] };
  }).sort(function (a, b) { return b.cents - a.cents; });

  var max = rows[0].cents || 1;
  var html = '';
  rows.forEach(function (r) {
    var c = categoryById(r.id);
    var pct = Math.max(2, Math.round(r.cents / max * 100));
    var share = totalCents > 0 ? Math.round(r.cents / totalCents * 100) : 0;
    html += '<div class="rank-item">' +
      '<div class="rank-top">' +
        '<span class="rank-name">' + esc(c.icon) + ' ' + esc(c.name) + '</span>' +
        '<span class="rank-val"><b>' + fmtMoney(r.cents) + '</b> \u00B7 ' + share + '%</span>' +
      '</div>' +
      '<div class="rank-bar"><i style="width:' + pct + '%;background:' + safeColor(c.color, '#9AA0A6') + '"></i></div>' +
      '</div>';
  });
  elRankList.innerHTML = html;
}

function renderTrend() {
  var now = new Date();
  var months = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }

  var values = months.map(function (mo) {
    return sumCents(monthTx(mo.y + '-' + pad2(mo.m)).filter(function (t) { return t.type === 'expense'; }));
  });

  var max = Math.max.apply(null, values.concat([1]));
  var curKey = currentMonthKey();

  var bars = '';
  var labels = '';
  months.forEach(function (mo, idx) {
    var key = mo.y + '-' + pad2(mo.m);
    var v = values[idx];
    var h = v > 0 ? Math.max(4, Math.round(v / max * 78)) : 2;
    var cls = key === curKey ? ' is-cur' : '';
    bars += '<div class="trend-col">' +
      '<span class="trend-val">' + (v > 0 ? fmtShort(v) : '') + '</span>' +
      '<div class="trend-bar' + cls + '" style="height:' + h + 'px"></div>' +
      '</div>';
    labels += '<span>' + mo.m + '\u6708</span>';
  });

  elTrendChart.innerHTML = '<div class="trend-bars">' + bars + '</div>' +
                           '<div class="trend-label">' + labels + '</div>';
}

/* ============================================================
   页面切换
   ============================================================ */

function go(page, keepScroll) {
  state.page = page;
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.toggle('is-active', pages[i].getAttribute('data-page') === page);
  }
  var tabs = elTabbar.querySelectorAll('.tab');
  for (var j = 0; j < tabs.length; j++) {
    tabs[j].classList.toggle('is-active', tabs[j].getAttribute('data-page') === page);
  }
  if (page === 'list') { renderList(); }
  if (page === 'summary') { renderSummary(); }
  /* 编辑完回流水时不能回到顶部，否则看不到刚改的那条 */
  if (!keepScroll) { window.scrollTo(0, 0); }
}

/* ============================================================
   数据管理
   ============================================================ */

function buildPayload() {
  return {
    app: 'ledger',
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: db.categories,
    transactions: db.transactions
  };
}

function markBackup() {
  try { localStorage.setItem(BACKUP_KEY, String(Date.now())); } catch (e) { /* ignore */ }
}

function refreshBackupNotice() {
  if (mode === 'server') {
    /* 数据已经落在电脑文件里，而且每次保存都自动留档，不用再催导出 */
    elBackupNote.classList.add('is-hidden');
    return;
  }
  elBackupNote.classList.remove('is-hidden');
  var count = db.transactions.length;
  if (!count) {
    elBackupNote.className = 'notice';
    elBackupNote.textContent = '\u73B0\u5728\u8FD8\u6CA1\u6709\u8BB0\u8D26\u3002\u6570\u636E\u53EA\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907\u7684\u6D4F\u89C8\u5668\u91CC\uFF0C\u6E05\u7406\u6D4F\u89C8\u5668\u6570\u636E\u4F1A\u4E22\u5931\u3002';
    return;
  }
  var last = Number(localStorage.getItem(BACKUP_KEY) || 0);
  if (!last) {
    elBackupNote.className = 'notice is-warn';
    elBackupNote.textContent = '\u26A0\uFE0F \u4F60\u8FD8\u4ECE\u6CA1\u5BFC\u51FA\u8FC7\u5907\u4EFD\u3002\u5EFA\u8BAE\u73B0\u5728\u5BFC\u51FA\u4E00\u4EFD\u5B58\u5230\u7F51\u76D8\u6216\u7535\u8111\u4E0A\uFF0C\u5C31\u7B97\u6362\u8BBE\u5907\u4E5F\u4E0D\u4F1A\u4E22\u3002';
    return;
  }
  var days = Math.floor((Date.now() - last) / 86400000);
  if (days >= BACKUP_WARN_DAYS) {
    elBackupNote.className = 'notice is-warn';
    elBackupNote.textContent = '\u26A0\uFE0F \u8DDD\u4E0A\u6B21\u5907\u4EFD\u5DF2\u7ECF ' + days + ' \u5929\u4E86\uFF0C\u5EFA\u8BAE\u518D\u5BFC\u51FA\u4E00\u6B21\u3002';
  } else {
    elBackupNote.className = 'notice is-ok';
    elBackupNote.textContent = '\u2705 \u4E0A\u6B21\u5907\u4EFD\uFF1A' + (days === 0 ? '\u4ECA\u5929' : days + ' \u5929\u524D') + '\uFF0C\u5171 ' + count + ' \u7B14\u8D26\u76EE\u3002';
  }
}

function downloadBackup() {
  if (!db.transactions.length) {
    toast('\u8FD8\u6CA1\u6709\u8D26\u76EE\uFF0C\u4E0D\u7528\u5BFC\u51FA');
    return;
  }
  var text = JSON.stringify(buildPayload());
  var blob = new Blob([text], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = '\u8BB0\u8D26\u672C-' + todayStr() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  markBackup();
  refreshBackupNotice();
  toast('\u5DF2\u5BFC\u51FA\u5907\u4EFD\u6587\u4EF6');
}

function copyText(text, cb) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { cb(true); })
      .catch(function () { cb(fallbackCopy(text)); });
  } else {
    cb(fallbackCopy(text));
  }
}

function copyBackupText() {
  if (!db.transactions.length) {
    toast('还没有账目');
    return;
  }
  copyText(JSON.stringify(buildPayload()), function (ok) {
    if (ok) {
      markBackup();
      refreshBackupNotice();
      toast('已复制，发到另一台设备再导入');
    } else {
      toast('复制失败，请改用导出文件', 3200);
    }
  });
}

function fallbackCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

function normalizeImport(input) {
  var raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!raw || typeof raw !== 'object') { return null; }

  var list = null;
  if (Array.isArray(raw)) { list = raw; }
  else if (Array.isArray(raw.transactions)) { list = raw.transactions; }
  if (!list) { return null; }

  var incomingCats = Array.isArray(raw.categories) ? raw.categories : [];
  var out = [];

  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || typeof item !== 'object') { continue; }

    var date = typeof item.date === 'string' ? item.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { continue; }

    var type = item.type === 'income' ? 'income' : 'expense';

    var cents = 0;
    if (typeof item.amountCents === 'number') { cents = Math.round(item.amountCents); }
    else if (typeof item.amount === 'number') { cents = Math.round(item.amount * 100); }
    else if (typeof item.amount === 'string') { cents = parseAmountToCents(item.amount); }
    if (!(cents > 0)) { continue; }

    out.push({
      id: String(item.id || uid()),
      type: type,
      amount: cents / 100,
      categoryId: String(item.categoryId || (type === 'income' ? 'other_i' : 'other_e')),
      date: date,
      note: String(item.note || '').slice(0, 40),
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now()
    });
  }

  return { transactions: out, categories: incomingCats };
}

function mergeImport(input) {
  var parsed = normalizeImport(input);
  if (!parsed) {
    toast('\u770B\u4E0D\u61C2\u8FD9\u4EFD\u5185\u5BB9\uFF0C\u786E\u8BA4\u662F\u672C\u7A0B\u5E8F\u5BFC\u51FA\u7684\u5417');
    return false;
  }
  if (!parsed.transactions.length) {
    toast('\u91CC\u9762\u6CA1\u6709\u53EF\u7528\u7684\u8D26\u76EE');
    return false;
  }

  var localCats = {};
  db.categories.forEach(function (c) { localCats[c.id] = true; });
  parsed.categories.forEach(function (c) {
    if (c && c.id && !localCats[c.id]) {
      db.categories.push({
        id: String(c.id),
        kind: c.kind === 'income' ? 'income' : 'expense',
        name: String(c.name || '\u81EA\u5B9A\u4E49').slice(0, 8),
        icon: Array.from(String(c.icon || '\uD83D\uDCCC')).slice(0, 2).join(''),
        color: String(c.color || '#9AA0A6'),
        soft: String(c.soft || '#EFEFEF')
      });
    }
  });

  var map = {};
  db.transactions.forEach(function (t) { map[t.id] = t; });

  var added = 0;
  var updated = 0;
  parsed.transactions.forEach(function (t) {
    var cur = map[t.id];
    if (!cur) { map[t.id] = t; added++; }
    else if ((t.updatedAt || 0) > (cur.updatedAt || 0)) { map[t.id] = t; updated++; }
  });

  db.transactions = Object.keys(map).map(function (k) { return map[k]; });
  saveDB();
  renderCategories();
  renderList();
  renderSummary();
  refreshBackupNotice();

  if (added || updated) {
    toast('\u5408\u5E76\u5B8C\u6210\uFF1A\u65B0\u589E ' + added + ' \u7B14' + (updated ? '\uFF0C\u66F4\u65B0 ' + updated + ' \u7B14' : ''));
  } else {
    toast('\u6CA1\u6709\u65B0\u5185\u5BB9\uFF0C\u4E24\u8FB9\u5DF2\u7ECF\u4E00\u6837\u4E86');
  }
  return true;
}

function clearAll() {
  if (!db.transactions.length) {
    toast('\u672C\u6765\u5C31\u662F\u7A7A\u7684');
    return;
  }
  if (!window.confirm('\u8981\u5220\u6389\u672C\u673A\u5168\u90E8 ' + db.transactions.length + ' \u7B14\u8D26\u76EE\u5417\uFF1F\u8FD9\u4E2A\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002')) { return; }
  if (!window.confirm('\u518D\u786E\u8BA4\u4E00\u6B21\uFF1A\u5220\u9664\u540E\u5C31\u627E\u4E0D\u56DE\u6765\u4E86\uFF0C\u5EFA\u8BAE\u5148\u5BFC\u51FA\u5907\u4EFD\u3002\u786E\u5B9A\u7EE7\u7EED\u5417\uFF1F')) { return; }
  db.transactions = [];
  saveDB();
  renderList();
  renderSummary();
  refreshBackupNotice();
  toast('\u5DF2\u6E05\u7A7A');
}

function openSheet(el) {
  elMask.classList.remove('is-hidden');
  el.classList.remove('is-hidden');
}

function closeSheets() {
  elMask.classList.add('is-hidden');
  elSheetData.classList.add('is-hidden');
  elSheetImport.classList.add('is-hidden');
  elSheetBill.classList.add('is-hidden');
}

/* ============================================================
   xlsx 读取
   ------------------------------------------------------------
   微信下载账单给的是 .xlsx，而浏览器不能直接把 xlsx 当表格读。
   xlsx 的本质是一个 zip，里面装着 XML，所以这里只用两样东西
   把它还原成 CSV：
     1) 自己解 zip（只看中央目录，deflate / store 两种方式就够）；
     2) 自己解 deflate（浏览器只有 DecompressionStream，
        Safari 支持得晚，索性手写一个，几 KB 而已）。
   不为了一个导入功能去引第三方库——这项目至今零依赖。
   ============================================================ */

/* ---------- zip ---------- */

var ZIP_EOCD = 0x06054b50;
var ZIP_CDIR = 0x02014b50;
var ZIP_LOCAL = 0x04034b50;

function zipRead(buf) {
  var u8 = new Uint8Array(buf);
  var dv = new DataView(buf);
  /* EOCD 在文件末尾，但后面可能跟着最长 64KB 的注释，所以往前扫 */
  var eocd = -1;
  var floor = Math.max(0, u8.length - 22 - 65535);
  for (var i = u8.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) { throw new Error('不是 zip 容器'); }

  var count = dv.getUint16(eocd + 10, true);
  var at = dv.getUint32(eocd + 16, true);
  var index = {};
  for (var n = 0; n < count; n++) {
    if (dv.getUint32(at, true) !== ZIP_CDIR) { break; }
    var nlen = dv.getUint16(at + 28, true);
    var elen = dv.getUint16(at + 30, true);
    var clen = dv.getUint16(at + 32, true);
    var name = '';
    for (var k = 0; k < nlen; k++) { name += String.fromCharCode(u8[at + 46 + k]); }
    index[name] = {
      method: dv.getUint16(at + 10, true),
      csize: dv.getUint32(at + 20, true),
      usize: dv.getUint32(at + 24, true),
      at: dv.getUint32(at + 42, true)
    };
    at += 46 + nlen + elen + clen;
  }
  return { raw: u8, dv: dv, index: index };
}

function zipEntry(zip, name) {
  var e = zip.index[name];
  if (!e) { return null; }
  var dv = zip.dv;
  if (dv.getUint32(e.at, true) !== ZIP_LOCAL) { throw new Error('zip 局部头损坏：' + name); }
  var nlen = dv.getUint16(e.at + 26, true);
  var elen = dv.getUint16(e.at + 28, true);
  var from = e.at + 30 + nlen + elen;
  var comp = zip.raw.subarray(from, from + e.csize);
  if (e.method === 0) { return comp; }
  if (e.method !== 8) { throw new Error('不支持的压缩方式 ' + e.method); }
  return inflateDeflate(comp, e.usize);
}

function zipNeed(zip, name) {
  var raw = zipEntry(zip, name);
  if (!raw) { throw new Error('xlsx 里缺少 ' + name); }
  return new TextDecoder('utf-8').decode(raw);
}

/* ---------- deflate（RFC1951，raw 流） ---------- */

var DF_LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var DF_LEN_EXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
var DF_DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var DF_DIST_EXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
var DF_CLEN_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

/* 哈夫曼表：计数 + 按码长排好的符号表，解码时逐位走 */
function dfTree(lengths) {
  var max = 0;
  var i;
  for (i = 0; i < lengths.length; i++) { if (lengths[i] > max) { max = lengths[i]; } }
  var count = new Array(max + 1);
  for (i = 0; i <= max; i++) { count[i] = 0; }
  for (i = 0; i < lengths.length; i++) { if (lengths[i]) { count[lengths[i]]++; } }
  var offs = new Array(max + 2);
  offs[0] = 0; offs[1] = 0;
  for (i = 1; i <= max; i++) { offs[i + 1] = offs[i] + count[i]; }
  var sym = new Array(lengths.length);
  for (i = 0; i < lengths.length; i++) { if (lengths[i]) { sym[offs[lengths[i]]++] = i; } }
  return { max: max, count: count, sym: sym };
}

function inflateDeflate(comp, usize) {
  var out = new Uint8Array(usize > 0 ? usize : Math.max(comp.length * 4, 4096));
  var bitBuf = 0;
  var bitCnt = 0;
  var src = 0;
  var dst = 0;
  var i;

  function fill() {
    while (bitCnt < 16 && src < comp.length) {
      bitBuf |= comp[src++] << bitCnt;
      bitCnt += 8;
    }
  }
  function bits(n) {
    fill();
    var v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  }
  function grow(n) {
    if (dst + n <= out.length) { return; }
    var size = out.length;
    while (size < dst + n) { size *= 2; }
    var bigger = new Uint8Array(size);
    bigger.set(out);
    out = bigger;
  }
  function decode(tree) {
    if (!tree.max) { throw new Error('空的哈夫曼表'); }
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= tree.max; len++) {
      code |= bits(1);
      var c = tree.count[len];
      if (code - first < c) { return tree.sym[index + (code - first)]; }
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('哈夫曼码非法');
  }

  var fixedL = null, fixedD = null;
  var last = 0;
  do {
    last = bits(1);
    var type = bits(2);
    var hLit = null, hDist = null;

    if (type === 0) {
      /* 未压缩块：先丢掉当前字节里剩下的位 */
      bitBuf = 0; bitCnt = 0;
      var len = comp[src] | (comp[src + 1] << 8);
      src += 4;
      grow(len);
      out.set(comp.subarray(src, src + len), dst);
      src += len;
      dst += len;
      continue;
    }
    if (type === 1) {
      if (!fixedL) {
        var fl = new Array(288), fd = new Array(30);
        for (i = 0; i < 144; i++) { fl[i] = 8; }
        for (i = 144; i < 256; i++) { fl[i] = 9; }
        for (i = 256; i < 280; i++) { fl[i] = 7; }
        for (i = 280; i < 288; i++) { fl[i] = 8; }
        for (i = 0; i < 30; i++) { fd[i] = 5; }
        fixedL = dfTree(fl);
        fixedD = dfTree(fd);
      }
      hLit = fixedL; hDist = fixedD;
    } else if (type === 2) {
      var hlc = bits(5) + 257;
      var hdc = bits(5) + 1;
      var hclc = bits(4) + 4;
      var clens = new Array(19);
      for (i = 0; i < 19; i++) { clens[i] = 0; }
      for (i = 0; i < hclc; i++) { clens[DF_CLEN_ORDER[i]] = bits(3); }
      var hc = dfTree(clens);
      var all = new Array(hlc + hdc);
      var at = 0;
      while (at < hlc + hdc) {
        var s = decode(hc);
        if (s < 16) {
          all[at++] = s;
        } else {
          var rep, val = 0;
          if (s === 16) { val = all[at - 1]; rep = 3 + bits(2); }
          else if (s === 17) { rep = 3 + bits(3); }
          else { rep = 11 + bits(7); }
          while (rep-- > 0 && at < hlc + hdc) { all[at++] = val; }
        }
      }
      hLit = dfTree(all.slice(0, hlc));
      hDist = dfTree(all.slice(hlc, hlc + hdc));
    } else {
      throw new Error('deflate 块类型非法');
    }

    for (;;) {
      var sym = decode(hLit);
      if (sym < 256) {
        grow(1);
        out[dst++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        sym -= 257;
        if (sym >= DF_LEN_BASE.length) { throw new Error('deflate 长度码非法'); }
        var copyLen = DF_LEN_BASE[sym] + bits(DF_LEN_EXT[sym]);
        var ds = decode(hDist);
        var dist = DF_DIST_BASE[ds] + bits(DF_DIST_EXT[ds]);
        grow(copyLen);
        var back = dst - dist;
        for (var j = 0; j < copyLen; j++) { out[dst++] = out[back + j]; }
      }
    }
  } while (!last);

  return out.subarray(0, dst);
}

/* ---------- xlsx → 行数组 ---------- */

function xmlUnescape(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* 列引用 A1 / BC12 → 列号（0 起） */
function xlsxColNum(ref) {
  var n = 0;
  for (var i = 0; i < ref.length; i++) {
    var c = ref.charCodeAt(i);
    if (c < 65 || c > 90) { break; }
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/* sharedStrings.xml 里每个 <si> 可能被拆成好几个 <t>（富文本），拼起来 */
function xlsxSharedStrings(xml) {
  var out = [];
  var re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  var m;
  while ((m = re.exec(xml))) {
    var body = m[1] || '';
    var tre = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    var text = '';
    var tm;
    while ((tm = tre.exec(body))) { text += tm[1] || ''; }
    out.push(xmlUnescape(text));
  }
  return out;
}

/* 把第一个工作表读成「二维数组」，单元格值都还原成字符串。
   日期先原样留着——Excel 里它就是个数字，不知道该列是不是日期，
   换算放在知道列含义之后做（见 wxSerialToStamp）。 */
function xlsxToRows(buf) {
  var zip = zipRead(buf);
  var week = zipEntry(zip, 'xl/sharedStrings.xml');
  var strings = week ? xlsxSharedStrings(new TextDecoder('utf-8').decode(week)) : [];
  var sheet = zipNeed(zip, 'xl/worksheets/sheet1.xml');

  var rows = [];
  var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  var rm;
  while ((rm = rowRe.exec(sheet))) {
    var rowXml = rm[1] || '';
    var cells = [];
    var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    var cm;
    while ((cm = cellRe.exec(rowXml))) {
      var attr = cm[1] || '';
      var body = cm[2] || '';
      var refM = /r="([A-Z]+)\d+"/.exec(attr);
      var col = refM ? xlsxColNum(refM[1]) : cells.length;
      var tM = /t="([^"]+)"/.exec(attr);
      var t = tM ? tM[1] : '';
      var val = '';

      if (t === 'inlineStr') {
        var ire = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        var im;
        var acc = '';
        while ((im = ire.exec(body))) { acc += im[1]; }
        val = xmlUnescape(acc);
      } else {
        var vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        var raw = vM ? xmlUnescape(vM[1]) : '';
        if (t === 's') { val = strings[Number(raw)] || ''; }
        else { val = raw; }
      }
      while (cells.length < col) { cells.push(''); }
      cells[col] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/* Excel 日期序列号 → 本地时间戳。
   1900 纪元，且 Excel 把 1900 当闰年（序列号 60 是那个不存在的 2/29），
   所以 >= 60 的要先减掉一天。 */
function xlsxSerialToMs(serial) {
  var n = Number(serial);
  if (!isFinite(n) || n <= 0) { return null; }
  var days = Math.floor(n);
  var frac = n - days;
  if (days >= 60) { days -= 1; }
  var utc = Date.UTC(1899, 11, 31) + days * 86400000 + Math.round(frac * 86400000);
  var d = new Date(utc);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
                  d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
}

/* 时间列：可能是序列号（微信），也可能是 '2026-09-24 12:00:00' 这种文本（支付宝/CSV 版） */
function xlsxTimeCell(v) {
  var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
  if (!s) { return null; }
  if (/^\d+(\.\d+)?$/.test(s)) { return xlsxSerialToMs(s); }
  return parseBillTime(s);
}

/* ============================================================
   导入微信 / 支付宝账单
   ------------------------------------------------------------
   两家都不提供个人消费接口，只能从 App 里导出账单文件。
   文件都是「前面几行说明 + 一张表」，所以这里做三件事：
   认格式（CSV / xlsx）→ 找到表头 → 按列名取字段。
   账目 id 直接用「交易单号」，重复导入自然就不会重复记账。
   ============================================================ */

/* 猜分类用的关键词表。
   ------------------------------------------------------------
   匹配范围是「交易对方 + 商品 + 交易类型 + 备注」拼成的一整串，
   从上往下试，命中第一条就返回——**所以顺序就是优先级**。

   顺序遵循一个原则：**越具体、越不会误伤的排前面**。
   比如「话费充值」必须盖过「充值」，「外卖」必须盖过「餐饮」，
   否则「中国移动 话费充值」会被宽泛的「移动」抓去居住、
   「肯德基宅急送外卖」也会先撞上别的词。

   写法上的两点注意：
   - 中文没有词边界，`/咖啡/` 能匹配「星巴克咖啡」也能匹配「咖啡豆」，
     这是我们要的；但反过来 `/包/` 会匹配「面包」和「书包」，
     这类过于宽泛的单字不要单独放，要带上限定词（`/面包/`、`/书包/`）。
   - 品牌名优先于品类名。用户账单里出现什么店名，就往对应分类里加，
     这是让词库越用越准的唯一办法。
   ============================================================ */

/* 餐饮：外卖平台 / 连锁快餐 / 中式正餐 / 小吃 / 饮品烘焙 / 个人小店。
   凡是「一份一份吃进肚子里的」都归这里，不区分堂食外卖。
   末尾那几个是常去的个人小店（老板收款码直接显示人名），
   账单里只留一个名字、没有任何品类词，只能按人去认——这类名字
   每家都不一样，用的人自己往这里加就行。 */
var RULE_FOOD = /美团|饿了么|口碑|外卖|闪购|宅急送|点餐|堂食|快餐|小吃|早餐|午餐|晚餐|夜宵|食堂|档口|餐车|食品|生鲜|买菜|蔬菜|水果|果切|餐饮|餐厅|饭店|酒楼|菜馆|饭馆|大排档|烧烤|烤肉|火锅|串串|麻辣烫|冒菜|香锅|米线|米粉|螺蛳粉||面条|面馆|拉面|牛肉面|兰州|刀削面|炸酱面|热干面|快餐店|米饭|盖饭|拌饭|石锅|捞饭|焖肉|猪脚饭|煲仔饭|黄焖|鸡米饭|水饺|饺子|馄饨|云吞|包子|馒头|巴比|煎饼|手抓饼|烧饼|肉夹馍|凉皮|河粉|肠粉|粥|汤包|生煎|小笼|粤菜|川菜|湘菜|东北菜|家常菜|西餐|披萨|汉堡|华莱士|肯德基|麦当劳|德克士|塔斯汀|必胜客|赛百味|沙县|杨国福|张亮|老乡鸡|真功夫|米村|陈香贵|和府|海底捞|太二|蜜雪|喜茶|奈雪|茶百道|古茗|沪上阿姨|书亦|益禾堂|coco|一点点|1点点|茶颜|星巴克|瑞幸|库迪|manner|mstand|挪瓦|太平洋咖啡|咖啡|奶茶|果茶|豆花|甜品|蛋糕|面包|烘焙|面包店|零食|便利店食品||早餐1\+1||/i;

/* 交通：打车 / 公共交通 / 铁路航空 / 自驾 / 共享出行 / 交通罚款 */
var RULE_TRAFFIC = /滴滴|青桔|哈啰|美团单车|摩拜|共享单车|共享电单车|单车|电单车|打车|出租车|网约车|专车|快车|顺风车|高德|百度地图|曹操出行|t3出行|享道|花小猪|首汽|神州|租车|自驾|加油|中石化|中石油|壳牌|充电桩|充电站|换电|停车|泊车|过路|高速|etc|etc充值|地铁|metro|公交|巴士|轻轨|有轨电车|磁悬浮|轮渡|船票|客运|长途汽车|火车站|高铁|动车|铁路|12306|中铁|车票|火车票|汽车票|机票|航班|航空|登机|机场|行李|机建|燃油附加|智能交通|交通卡|公交卡|一卡通|交警|交管|交通违法|违章|罚款|罚金|车管所|驾驶证换证|年检/i;

/* 购物：电商平台 / 服饰鞋包 / 数码家电 / 美妆 / 大件商品 */
var RULE_SHOP = /淘宝|天猫|淘特|京东|拼多多|唯品会|苏宁|国美|当当|抖音电商|快手小店|小红书|得物|考拉|网易严选|小米有品|商城|购物|旗舰店|专营店|百货|奥特莱斯|outlets|专柜|服饰|服装|衣裤|上衣|裤子|裙子|外套|羽绒|毛衣|卫衣|内衣|袜子|鞋|运动鞋|球鞋|靴|拖鞋|帽|围巾|手套|箱包|背包|书包|双肩包|行李箱|单肩包|钱包|皮带|眼镜|太阳镜|手表|首饰|项链|耳环|戒指|珠宝|黄金|手机|平板|电脑|笔记本|显示器|键盘|鼠标|耳机|音箱|相机|镜头|游戏机|switch|ps5|xbox|手柄|数据线|充电器|充电宝|u盘|硬盘|路由器|打印机|耗材|内存卡|智能手表|手环|扫地机器人|家电|冰箱|洗衣机|空调|电视|微波炉|电磁炉|电饭煲|空气炸锅|吹风机|剃须刀|电动牙刷|吸尘器|风扇|加湿器|净化器|热水器|油烟机|燃气灶|家具|沙发|床垫|桌椅|衣柜|收纳|床品|四件套|被芯|枕头|窗帘|地毯|灯具|美妆|护肤|面膜|口红|粉底|香水|洗面奶|精华|眼霜|防晒|彩妆|化妆品|点券|游戏点券|无畏点券|皮肤|道具|装备|月卡|充值卡|点卡|礼品卡|购物卡/i;

/* 居住：房租房贷 / 水电燃气 / 通讯宽带 / 物业家政 / 日常维修 */
var RULE_HOME = /房租|租金|押金|房贷|月供|房租水电|物业|物业管理||水费|电费|水控|电控|水控充值|电控充值|热水|供暖|取暖|燃气|天然气|煤气|有线电视|电视费|宽带|光纤|网费|电信|中国移动|移动通信|联通|中国联通|话费|话费充值|手机充值|流量包|套餐费|安装费|家政|保洁|钟点工|保姆|月嫂|搬家|维修|上门维修|疏通|开锁|换锁|装修|建材|五金|垃圾处理|电梯费|维修基金|宿舍费|住宿费/i;

/* 娱乐：影音游戏 / 会员订阅 / 出游门票 / 运动健身 / 休闲玩乐 */
var RULE_FUN = /电影|影院|影城|万达影城|cgv|观影|话剧|歌剧|音乐会|演唱会|livehouse|脱口秀|相声|剧本杀|密室|桌游|ktv|酒吧|清吧|夜店|网吧|电玩|游戏|steam|epic|腾讯视频|爱奇艺|优酷|芒果tv|哔哩哔哩|b站|bilibili|网易云音乐|qq音乐|酷狗|spotify|会员|订阅|超级会员|视频会员|音乐会员|网盘会员|景区|景点|门票|公园|动物园|植物园|博物馆|展览|展会|游乐园|乐园|水上乐园|温泉|滑雪|露营|旅行|旅游|跟团|自由行|民宿|酒店|旅馆|青旅|机票旅游|健身|健身房|游泳|瑜伽|球馆|羽毛球|篮球|桌球|台球|保龄球|溜冰|滑板|攀岩|钓鱼|按摩|足疗|spa|洗浴|美甲|美发|理发|美容|剪发|烫发|染发|宠物|猫粮|狗粮|宠物用品/i;

/* 医疗：医院诊所 / 药店 / 体检 / 口腔眼科 / 医保 */
var RULE_HEALTH = /医院|医院挂号|门诊|急诊|住院|诊所|社区卫生|卫生院|疾控|防疫|疫苗|接种|体检|健康|保健|药房|药店|大药房||医药|药品|处方|西药|中药|医疗器械|血压计|血糖仪|体温计|口罩|消毒|酒精|创可贴|口腔|牙科|牙医|种植牙|洗牙|正畸|眼科|眼镜店|配镜|隐形眼镜|验光|视光|心理|精神|康复|理疗|针灸|推拿|挂号|诊疗|医保|医保缴费|平安好医生|微医|阿里健康|京东健康|叮当快药/i;

/* 人情：红包转账 / 礼金 / 请客 / 孝敬 / 慈善。
   注意：个人转账在两家账单里经常只留一个名字（可能是昵称也可能是全名），
   没有任何品类词，本来会落到「其他」。但转账这个动作在备注里有痕迹
   （微信写「转账备注:微信转账」，支付宝写付款方留言），
   所以把转账相关的措辞都收进来，尽量少让纯人际往来掉进「其他」。 */
var RULE_SOCIAL = /红包|微信红包|转账|微信转账|收款方备注|付款方留言|二维码收款|收钱码|收款|转账备注|礼金|随礼|份子|份子钱|彩礼|贺礼|白包|孝敬|赡养|给父母|生活费|给家里|代付|请客|aa|爱心|捐赠|捐款|慈善|水滴筹|爱心筹|公益|工会费|党费|团费/i;

/* 学习：书 / 课程培训 / 考试报名 / 文具 / 软件授权 / 云服务 */
var RULE_STUDY = /书店|书城|图书|书籍|当当书|京东图书|教材|课本|教辅|杂志|报刊|文具|笔|笔记本本|纸张|打印|复印|立印|印刷|快递打印|培训|培训班|补习|辅导|家教|课程|网课|线上课|直播课|录播|学费|学杂费|报名费|考试费|考证|驾校|驾驶证|科目|考研|四六级|雅思|托福|gre|计算机等级|资格证|证书|技能培训|职业教育|在线教育|知识付费|得到|樊登|混沌|三节课|慕课|mooc|coursera|udemy|网易云课堂|腾讯课堂|腾讯会议|zoom|软件|软件授权|license|序列号|激活码|会员授权|云服务|服务器|域名|主机|vps|阿里云|腾讯云|华为云|aws|azure|存储空间|数码荔枝|connectify|热点共享|办公软件|设计工具|开发工具|字体|素材|模板|插件/i;

/* 日用：超市便利 / 洗护清洁 / 纸品 / 生活杂货 / 理发外的日常 */
var RULE_DAILY = /超市|便利|便利店|全家|罗森|711|7-11|seven|美宜佳|喜士多|十足|之上|左邻右舍||社区店|小卖部|杂货|杂货店|日用|日用品|百货店|生活用品|洗护|洗衣液|洗衣粉|柔顺剂|皂|香皂|洗手液|沐浴露|洗发水|护发素|牙膏|牙刷|漱口水|毛巾|浴巾|纸巾|抽纸|卷纸|湿巾|卫生纸|卫生巾|垃圾袋|保鲜膜|保鲜袋|铝箔|一次性|清洁|清洁剂|消毒液|洗洁精|洁厕|去污|拖把|扫把|抹布|海绵|钢丝球|衣架|晾衣|收纳箱|置物架|五金件|电池|电灯泡|灯泡|插座|插排|转换器|打火机|雨伞|雨衣|水杯|保温杯|餐具|碗筷|锅|刀具|砧板|保鲜盒|水壶|饮水机|桶装水|矿泉水|纯净水|饮料|可乐|百事|矿泉水|货柜|售货机|智能货柜|自动售货|先购后付|快递袋|包装|气柱|气泡膜|胶带|剪刀|针线|鞋带|鞋油|樟脑|驱蚊|杀虫|灭蚊|蚊香|花露水/i;

/* 其它常见但归不进上面几类的，放到「其他」，避免误判。
   这里故意留空不写规则——猜不出来时才落到其他，比乱猜好。 */

/* 政务与行政：缴罚款、证件办理、税费、社保公积金。
   没有任何消费场景词，不收进来就会一直掉在「其他」里。
   归到哪一类是个取舍：罚款和证件跟出行有关，但税费社保又不像消费，
   所以统一放「其他」不太合适、硬塞进某个支出分类也牵强——
   这里挂在居住（跑腿办事的固定开销）下面，用的人觉得不对可以改。 */
var RULE_GOV = /财政厅|财政局|税务局|税务局|税务|税费|缴税|契税|车船税|罚款|罚没|缴款单号|执收单位|非税收入|行政事业性收费|交警支队|交管所|车管所|出入境|办证|证件办理|身份证|护照|签证|公证|社保|社会保险|医保缴费|养老|公积金|住房公积金|住房维修基金|不动产|房产交易|民政局|婚姻登记|街道办事处|社区服务|市政|公用事业/i;

var BILL_RULES = [
  /* 说明：跨分类之间，把最容易误伤的排前面。
     最容易撞车的几组：
     - 话费/宽带属于居住，必须排在日用之前（否则「充值卡」会先命中）
     - 罚款/证件属于政务，必须排在交通之前（否则「交警支队」会先命中交通）
     - 药店/医院必须排在日用之前（否则「口罩」会被日用抓走）
     - 打印属于学习，必须排在日用之前（否则「纸张」会先命中日用） */
  ['expense', RULE_HEALTH,  'health'],
  ['expense', RULE_STUDY,   'study'],
  ['expense', RULE_GOV,     'home'],
  ['expense', RULE_HOME,    'home'],
  ['expense', RULE_TRAFFIC, 'traffic'],
  ['expense', RULE_FOOD,    'food'],
  ['expense', RULE_FUN,     'fun'],
  ['expense', RULE_SHOP,    'shop'],
  ['expense', RULE_SOCIAL,  'social'],
  ['expense', RULE_DAILY,   'daily'],

  ['income',  /工资|薪资|薪水|月薪|底薪|基本工资|代发工资|薪资发放|劳务|报酬|课时费/i, 'salary'],
  ['income',  /奖金|绩效|年终奖|年终|提成|佣金|分红奖|优秀员工|全勤|补贴|津贴|餐补|交通补贴|高温补贴|过节费/i, 'bonus'],
  ['income',  /兼职|稿费|稿酬|设计费|接单|私活|外快|副业|翻译费|咨询费|课时|家教费|劳务费|跑腿|代练/i, 'parttime'],
  ['income',  /利息|理财|基金|股票|分红|收益|证券|余额宝|零钱通|国债|债券|黄金|定期|存款利息|分红派息|买入返售|赎回|基金收益/i, 'invest'],
  ['income',  /红包|转账|微信红包|收款|礼金|退款|退货退款|赔付|理赔|报销|补偿|返现|返利|佣金收入|中奖|奖金红包|压岁钱/i, 'gift']
];

function guessCategory(text, type) {
  var t = String(text || '');
  for (var i = 0; i < BILL_RULES.length; i++) {
    if (BILL_RULES[i][0] === type && BILL_RULES[i][1].test(t)) { return BILL_RULES[i][2]; }
  }
  return type === 'income' ? 'other_i' : 'other_e';
}

/* 账单是 GBK 编码，直接按 UTF-8 读会全是乱码。
   先看有没有 BOM，再用「严格 UTF-8 解码失败就转 GBK」来判断。 */
function decodeBillBytes(buf) {
  var bytes = new Uint8Array(buf);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    try { return new TextDecoder('gbk').decode(bytes); } catch (e2) { /* 退回去 */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function pickCol(cols, names) {
  for (var n = 0; n < names.length; n++) {
    for (var i = 0; i < cols.length; i++) {
      if (cols[i] === names[n] || cols[i].indexOf(names[n]) === 0) { return i; }
    }
  }
  return -1;
}

function fieldOf(row, idx) {
  return idx >= 0 && idx < row.length ? row[idx] : '';
}

function parseBillTime(s) {
  var m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s));
  if (!m) { return null; }
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  if (!y || !mo || !d || mo > 12 || d > 31) { return null; }
  return new Date(y, mo - 1, d, Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)).getTime();
}

function pad2n(n) { return (n < 10 ? '0' : '') + n; }

/* CSV 文本 → 行数组（空行丢掉）。
   支付宝导出时会在「交易订单号」和「商家订单号」后面各粘一个制表符
   （`...4718\t,39202...\t,,\n`）。那个 Tab 是导出程序留下的排版垃圾，
   如果把它也当分隔符，后面所有列都会整体错位一格（金额会跑到支付方式上）。
   所以这里只做一件事：把紧贴在逗号前的 Tab 去掉，列序保持和表头一致。 */
function splitCsvLine(line) {
  var out = [];
  var cur = '';
  var q = false;
  var src = line;
  for (var i = 0; i < src.length; i++) {
    var ch = src.charAt(i);
    if (q) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') { cur += '"'; i++; }
        else { q = false; }
      } else { cur += ch; }
    } else if (ch === '"') {
      q = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  var res = [];
  for (var j = 0; j < out.length; j++) {
    /* 除空白外还要清掉零宽字符，否则同样的订单号比不出相等、去重会失效 */
    res.push(out[j].replace(/[\t\u200B-\u200D\uFEFF\u2060]/g, '').replace(/^\s+|\s+$/g, ''));
  }
  return res;
}

function csvToRows(text) {
  var lines = String(text).split(/\r\n|\n|\r/);
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || !line.replace(/[,\s"]/g, '')) { continue; }
    rows.push(splitCsvLine(line));
  }
  return rows;
}

/* 不管来的是一张二维表（xlsx）还是一段 CSV 文本，都归成同一个结构再往下走。
   两个来源的差别只有一处：xlsx 的时间是序列号，要换算。 */
function parseBillTable(rows, serialTime) {
  var head = null;
  var limit = Math.min(rows.length, 60);
  for (var i = 0; i < limit; i++) {
    var joined = rows[i].join('|');
    /* 先认支付宝：「交易订单号 + 收/支」是它独有的。注意支付宝的列名是
       「交易订单号」而不是「交易号」，用「交易号」去 indexOf 永远找不到。
       顺序也不能反过来——支付宝表头里同时有「交易时间」和「交易对方」，
       先认微信的话会把支付宝当微信，列名全部对歪。 */
    if (joined.indexOf('交易订单号') >= 0 && joined.indexOf('收/支') >= 0) {
      head = { kind: 'ali', at: i, cols: rows[i] };
      break;
    }
    if (joined.indexOf('交易时间') >= 0 && joined.indexOf('交易对方') >= 0) {
      head = { kind: 'wx', at: i, cols: rows[i] };
      break;
    }
  }
  if (!head) { return { ok: false, reason: 'noHeader' }; }

  var isWx = head.kind === 'wx';
  var cTime   = pickCol(head.cols, isWx ? ['交易时间'] : ['付款时间', '交易创建时间', '交易时间']);
  var cDir    = pickCol(head.cols, ['收/支']);
  /* 金额列要认全「金额（元）」「金额(元)」，否则会落到「成功退款（元）」上 */
  var cAmt    = pickCol(head.cols, isWx ? ['金额(元)', '金额（元）', '金额']
                                        : ['金额（元）', '金额(元)', '金额']);
  var cPeer   = pickCol(head.cols, ['交易对方']);
  var cGoods  = pickCol(head.cols, isWx ? ['商品'] : ['商品说明', '商品名称', '商品']);
  var cStatus = pickCol(head.cols, isWx ? ['当前状态'] : ['交易状态']);
  var cKind   = pickCol(head.cols, isWx ? ['交易类型'] : ['交易分类', '类型']);
  /* 支付宝叫「交易订单号」，微信叫「交易单号」，两边都列上 */
  var cOrder  = pickCol(head.cols, isWx ? ['交易单号'] : ['交易订单号', '交易号']);
  var cNote   = pickCol(head.cols, ['备注']);

  var out = [];
  var skip = { noCount: 0, refund: 0, closed: 0, invalid: 0 };

  for (var r = head.at + 1; r < rows.length; r++) {
    var f = rows[r];
    if (!f || f.length < 3) { continue; }
    if (!f.join('').replace(/\s/g, '')) { continue; }

    var ts = serialTime ? xlsxTimeCell(fieldOf(f, cTime)) : parseBillTime(fieldOf(f, cTime));
    var dir = fieldOf(f, cDir);
    var amtCents = parseAmountToCents(String(fieldOf(f, cAmt)).replace(/[¥￥,\s]/g, ''));
    if (!ts || !amtCents) { skip.invalid++; continue; }

    /* 「不计收支」= 转账、理财、还款这类，不是消费，直接不要 */
    if (dir !== '支出' && dir !== '收入') { skip.noCount++; continue; }

    var status = fieldOf(f, cStatus);
    var kind = fieldOf(f, cKind);
    if (/退款|退票/.test(status) || /退款|退票/.test(kind)) { skip.refund++; continue; }
    if (/未支付|已关闭|交易关闭|已撤销|失败|已取消/.test(status)) { skip.closed++; continue; }

    var peer = fieldOf(f, cPeer);
    var goods = fieldOf(f, cGoods);
    var extra = fieldOf(f, cNote);
    var noteParts = [];
    if (peer && peer !== '/') { noteParts.push(peer); }
    if (goods && goods !== '/' && goods !== peer) { noteParts.push(goods); }
    if (!noteParts.length && extra) { noteParts.push(extra); }

    var d = new Date(ts);
    var dateStr = d.getFullYear() + '-' + pad2n(d.getMonth() + 1) + '-' + pad2n(d.getDate());
    var type = dir === '收入' ? 'income' : 'expense';
    var orderNo = fieldOf(f, cOrder);

    /* 猜分类分两步。
       第一步只看「交易对方 + 商品说明」——这两列才真正描述钱花在什么上。
       第二步（兜底）才用账单自己的「交易分类 / 交易类型」列：
       支付宝会写「转账红包」，这类纯人际往来在对方和商品里可能只留个
       人名（昵称或全名），没有任何品类词，不兜底就会掉进「其他」。
       **不能把分类列放进第一步**——「服饰装扮」「日用百货」这种词会命中
       我们自己词库里的「服饰」「日用」，把无名小店冤枉成购物。 */
    var guessText = peer + ' ' + goods + ' ' + extra;
    var categoryId = guessCategory(guessText, type);
    if (categoryId === 'other_e' || categoryId === 'other_i') {
      if (/转账|红包|礼金|收款/.test(kind)) {
        categoryId = type === 'income' ? 'gift' : 'social';
      }
    }

    out.push({
      id: (isWx ? 'wx:' : 'ali:') + (orderNo || (ts + '-' + amtCents)),
      type: type,
      amount: amtCents / 100,
      categoryId: categoryId,
      date: dateStr,
      note: noteParts.join(' · ').slice(0, 40),
      createdAt: ts,
      updatedAt: ts
    });
  }

  return { ok: true, kind: head.kind, rows: out, skip: skip, total: rows.length };
}

function parseBillText(text) {
  return parseBillTable(csvToRows(text), false);
}

/* 微信给的是 xlsx：先还原成二维表，再走同一套解析 */
function parseBillXlsx(buf) {
  return parseBillTable(xlsxToRows(buf), true);
}

/* 待用户确认的导入结果 */
var billPending = null;

function showBillResult(html) {
  elBillResult.innerHTML = html;
}

function previewBillFile(buf) {
  /* 微信给的是 .xlsx（zip 容器），先看文件头；不是 zip 才当文本解 */
  var bytes = new Uint8Array(buf);
  var isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4B &&
              (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);

  var res;
  try {
    res = isZip ? parseBillXlsx(buf) : parseBillText(decodeBillBytes(buf));
  } catch (e) {
    showBillResult('<div class="notice is-warn">' + (isZip ? 'xlsx 解析出错：' : '解析出错：') +
      esc(e.message) + '</div>');
    elBtnBillOk.classList.add('is-hidden');
    billPending = null;
    return;
  }

  if (!res.ok) {
    showBillResult('<div class="notice is-warn">没找到账单表头。请确认选的是<strong>对账用的账单文件</strong>——' +
      '微信要「用于个人对账」的账单（下载下来是 xlsx），支付宝要「开具交易流水证明」的 CSV。' +
      '如果你手上的 Excel 里已经看不到「交易时间 / 交易对方」这些列，那多半是截图或汇总表，不是明细。</div>');
    elBtnBillOk.classList.add('is-hidden');
    billPending = null;
    return;
  }

  var have = {};
  db.transactions.forEach(function (t) { have[t.id] = true; });

  var fresh = [];
  var dup = 0;
  var expCents = 0;
  var incCents = 0;
  res.rows.forEach(function (t) {
    if (have[t.id]) { dup++; return; }
    fresh.push(t);
    if (t.type === 'income') { incCents += toCents(t.amount); } else { expCents += toCents(t.amount); }
  });

  billPending = fresh;

  var label = res.kind === 'wx' ? '微信支付账单' : '支付宝账单';
  var html = '<div class="notice' + (fresh.length ? ' is-ok' : '') + '">' +
    '认出来了：<b>' + label + '</b>，共 ' + res.rows.length + ' 笔可用记录。<br>' +
    '其中 <b>' + fresh.length + '</b> 笔是要新增的' +
    (dup ? '，<b>' + dup + '</b> 笔已经记过、会跳过' : '') + '。<br>' +
    '新增的合计：支出 <b>' + fmtMoney(expCents) + '</b>　收入 <b>' + fmtMoney(incCents) + '</b>' +
    '</div>';

  var skipped = [];
  if (res.skip.noCount) { skipped.push('转账/理财等不计收支 ' + res.skip.noCount + ' 笔'); }
  if (res.skip.refund) { skipped.push('退款 ' + res.skip.refund + ' 笔'); }
  if (res.skip.closed) { skipped.push('未成功 ' + res.skip.closed + ' 笔'); }
  if (res.skip.invalid) { skipped.push('格式不完整 ' + res.skip.invalid + ' 笔'); }
  if (skipped.length) {
    html += '<div class="notice">已忽略：' + skipped.join('、') + '。这些不是消费，或原交易已经记过。</div>';
  }

  /* 手工记过的账没有交易单号，和账单对不上，所以按「日期 + 金额」提示一下。
     只提示不自动跳过——万一是两笔真的同价消费，替你删了反而更糟。 */
  var sameKey = {};
  db.transactions.forEach(function (t) { sameKey[t.date + '|' + toCents(t.amount)] = true; });
  var maybeDup = fresh.filter(function (t) { return sameKey[t.date + '|' + toCents(t.amount)]; });
  if (maybeDup.length) {
    var eg = maybeDup.slice(0, 3).map(function (t) {
      return t.date.slice(5) + ' ' + fmtMoney(toCents(t.amount));
    }).join('、');
    html += '<div class="notice is-warn">注意：其中 <b>' + maybeDup.length + '</b> 笔的日期和金额，与已记录的完全相同（' +
      esc(eg) + (maybeDup.length > 3 ? ' 等' : '') + '），可能是你之前手工记过的。' +
      '程序判断不了是不是同一笔，所以照常导入——导完核对一下，重复的删掉就行。</div>';
  }

  if (fresh.length) {
    var show = fresh.slice(0, 8);
    html += '<div class="bill-preview"><div class="bill-head">前 ' + show.length + ' 笔预览</div>';
    show.forEach(function (t) {
      var c = categoryById(t.categoryId);
      html += '<div class="bill-row">' +
        '<span>' + esc(t.date.slice(5)) + ' ' + esc(c.icon + ' ' + c.name) + '</span>' +
        '<span class="bill-note">' + esc(t.note || '（无说明）') + '</span>' +
        '<b class="' + (t.type === 'income' ? 'is-income' : 'is-expense') + '">' +
        (t.type === 'income' ? '+' : '-') + fmtMoney(toCents(t.amount)) + '</b></div>';
    });
    html += '<div class="bill-foot">分类是按「交易对方 / 商品」猜的，导入后可以点开逐条改。</div></div>';
  }

  showBillResult(html);
  if (fresh.length) { elBtnBillOk.classList.remove('is-hidden'); }
  else { elBtnBillOk.classList.add('is-hidden'); }
}

function applyBillImport() {
  if (!billPending || !billPending.length) { return; }
  var n = 0;
  billPending.forEach(function (t) {
    db.transactions.push(t);
    n++;
  });
  billPending = null;
  saveDB();
  renderCategories();
  renderList();
  renderSummary();
  refreshBackupNotice();
  elBtnBillOk.classList.add('is-hidden');
  showBillResult('<div class="notice is-ok">已导入 ' + n + ' 笔。到「流水」页就能看到，分类不对的点开改一下就行。</div>');
  toast('已导入 ' + n + ' 笔账单');
}

/* 网页端把服务停掉之后：锁住界面、提示怎么办，并盯着服务什么时候回来 */
function showStopped() {
  stopped = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  savePending = false;
  setSyncState('offline');

  var box = $('stoppedBox');
  if (box) { box.classList.remove('is-hidden'); }

  if (!reconnectTimer) {
    reconnectTimer = setInterval(function () {
      api('GET', '/api/info', null, function (err, status) {
        if (!err && status === 200) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
          location.reload();
        }
      });
    }, 2500);
  }
}

/* ============================================================
   事件绑定
   ============================================================ */

elTypeSwitch.addEventListener('click', function (e) {
  var btn = e.target.closest('.seg-item');
  if (!btn) { return; }
  setType(btn.getAttribute('data-type'));
});

elCatGrid.addEventListener('click', function (e) {
  var btn = e.target.closest('.cat-item');
  if (!btn) { return; }
  state.categoryId = btn.getAttribute('data-cat');
  renderCategories();
});

elAmount.addEventListener('input', function () {
  var v = elAmount.value.replace(/[^\d.]/g, '');
  var dot = v.indexOf('.');
  if (dot >= 0) {
    v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
    v = v.slice(0, dot + 3);
  }
  if (v.length > 10) { v = v.slice(0, 10); }
  elAmount.value = v;
});

elDate.addEventListener('change', function () {
  markQuickDate(calcOffsetDays(elDate.value || todayStr()));
});

elQuickDates.addEventListener('click', function (e) {
  var btn = e.target.closest('button');
  if (!btn) { return; }
  var off = Number(btn.getAttribute('data-offset'));
  elDate.value = off === 0 ? todayStr() : ymd(new Date(Date.now() + off * 86400000));
  markQuickDate(off);
});

elBtnSave.addEventListener('click', saveEntry);

elBtnDelete.addEventListener('click', deleteEntry);

elBtnCancel.addEventListener('click', function () {
  var id = state.editingId;
  var fromList = state.editFrom === 'list';
  exitEdit();
  toast('\u5DF2\u53D6\u6D88\u7F16\u8F91');
  if (fromList) { backToList(id, true); } else { renderList(); }
});

elAmount.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); saveEntry(); }
});

elNote.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); saveEntry(); }
});

elTabbar.addEventListener('click', function (e) {
  var tab = e.target.closest('.tab');
  if (!tab) { return; }
  go(tab.getAttribute('data-page'));
});

$('btnPrevMonth').addEventListener('click', function () { shiftMonth(-1); });
$('btnNextMonth').addEventListener('click', function () { shiftMonth(1); });

elFilterChips.addEventListener('click', function (e) {
  var chip = e.target.closest('.chip');
  if (!chip) { return; }
  state.listFilter = chip.getAttribute('data-filter');
  var chips = elFilterChips.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('is-active', chips[i] === chip);
  }
  renderList();
});

elTxList.addEventListener('click', function (e) {
  var btn = e.target.closest('.tx-item');
  if (!btn) { return; }
  var id = btn.getAttribute('data-tx');
  var tx = null;
  for (var i = 0; i < db.transactions.length; i++) {
    if (db.transactions[i].id === id) { tx = db.transactions[i]; break; }
  }
  if (tx) { enterEdit(tx, 'list'); }
});

$('btnData').addEventListener('click', function () {
  refreshBackupNotice();
  openSheet(elSheetData);
});

$('btnCloseSheet').addEventListener('click', closeSheets);
$('btnCloseImport').addEventListener('click', closeSheets);
elMask.addEventListener('click', closeSheets);

$('btnExport').addEventListener('click', downloadBackup);
$('btnExportText').addEventListener('click', copyBackupText);

$('btnImport').addEventListener('click', function () {
  closeSheets();
  openSheet(elSheetImport);
});

$('btnClear').addEventListener('click', clearAll);

/* 导入账单 */
$('btnImportBill').addEventListener('click', function () {
  closeSheets();
  billPending = null;
  elBillResult.innerHTML = '';
  elBtnBillOk.classList.add('is-hidden');
  elBillFile.value = '';
  openSheet(elSheetBill);
});

$('btnCloseBill').addEventListener('click', closeSheets);
$('btnBillConfirm').addEventListener('click', applyBillImport);

elBillFile.addEventListener('change', function () {
  var file = elBillFile.files && elBillFile.files[0];
  if (!file) { return; }
  billPending = null;
  elBtnBillOk.classList.add('is-hidden');
  showBillResult('<div class="notice">正在读 ' + esc(file.name) + ' …</div>');
  var reader = new FileReader();
  reader.onload = function () { previewBillFile(reader.result); };
  reader.onerror = function () { showBillResult('<div class="notice is-warn">文件读取失败</div>'); };
  reader.readAsArrayBuffer(file);
  elBillFile.value = '';
});

elFileInput.addEventListener('change', function () {
  var file = elFileInput.files && elFileInput.files[0];
  if (!file) { return; }
  var reader = new FileReader();
  reader.onload = function () {
    if (mergeImport(String(reader.result))) { closeSheets(); }
  };
  reader.onerror = function () { toast('\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25'); };
  reader.readAsText(file);
  elFileInput.value = '';
});

$('btnImportText').addEventListener('click', function () {
  var text = elImportText.value.trim();
  if (!text) { toast('\u5148\u7C98\u8D34\u5185\u5BB9'); return; }
  if (mergeImport(text)) {
    elImportText.value = '';
    closeSheets();
  }
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeSheets(); }
});

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && mode === 'server' &&
      !saving && !saveTimer && !savePending && !stopped) {
    pullFromServer(false);
  }
});

$('btnReload').addEventListener('click', function () {
  if (mode !== 'server') { toast('现在是浏览器存储模式，没有可重新加载的来源'); return; }
  pullFromServer(true);
});

/* 关服务之前先把还没落盘的改动推一次，免得刚记的一笔跟着一起没了 */
function flushPendingSave(cb) {
  if (!saveTimer && !saving && !savePending) { cb(); return; }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  pushToServer();
  var ticks = 0;
  var timer = setInterval(function () {
    ticks++;
    if ((!saving && !saveTimer && !savePending) || ticks > 30) {
      clearInterval(timer);
      cb();
    }
  }, 100);
}

$('btnShutdown').addEventListener('click', function () {
  if (mode !== 'server') {
    toast('现在没有运行中的服务可以停止');
    return;
  }
  if (!window.confirm('要停止电脑上的记账本服务吗？\n\n' +
      '停掉之后手机和浏览器都会断开，想再用需要到电脑上双击「启动记账本.bat」。\n\n' +
      '已经记的账一笔都不会丢。')) {
    return;
  }
  closeSheets();
  flushPendingSave(function () {
    api('POST', '/api/shutdown', null, function (err, status) {
      if (err || status !== 200) {
        toast('没能停掉，可以到电脑上双击「停止记账本.bat」', 4500);
        return;
      }
      showStopped();
    });
  });
});

$('btnReconnect').addEventListener('click', function () {
  var btn = this;
  btn.textContent = '检查中...';
  api('GET', '/api/info', null, function (err, status) {
    if (!err && status === 200) { location.reload(); return; }
    btn.textContent = '还没起来，再试一次';
    setTimeout(function () { btn.textContent = '立即检查'; }, 2200);
  });
});

$('btnCopyUrl').addEventListener('click', function () {
  var url = this.getAttribute('data-url') || '';
  if (!url) { return; }
  copyText(url, function (ok) {
    toast(ok ? '地址已复制，发到手机上点开就能用' : '复制失败，手动输入一下吧', 3000);
  });
});

/* ============================================================
   启动
   ============================================================ */

function init() {
  storageOK = storageAvailable();
  /* 先垫一个空账本，否则 setType 里的分类渲染会碰到 null */
  db = freshDB();
  state.listMonth = currentMonthKey();

  elDate.value = todayStr();
  markQuickDate(0);
  setType('expense');

  detectStorage(function () {
    setType(state.type);
    renderList();
    renderSummary();
    refreshBackupNotice();

    if (!storageOK && mode === 'local') {
      toast('浏览器禁用了本地存储，记的账无法保存', 6000);
    }
    if (window.matchMedia && window.matchMedia('(min-width: 720px)').matches) {
      elAmount.focus();
    }
  });
}

/* 先试着连电脑上的本地服务，连不上就退回浏览器存储 */
function detectStorage(cb) {
  if (location.protocol === 'file:') {
    startLocalMode();
    cb();
    return;
  }
  api('GET', '/api/db', null, function (err, status, text) {
    if (!err && status === 200) {
      try {
        var res = JSON.parse(text);
        mode = 'server';
        serverRev = Number(res.rev) || 0;
        db = sanitizeDB(res.data);
        setSyncState('saved');
        loadServerInfo();
        offerLegacyImport();
        cb();
        return;
      } catch (e) { /* 解析失败，落到本地模式 */ }
    }
    startLocalMode();
    cb();
  });
}

function startLocalMode() {
  mode = 'local';
  db = loadLocalDB() || freshDB();

  var badge = $('syncState');
  if (badge) { badge.classList.add('is-hidden'); }

  var box = $('storageBox');
  if (box) {
    box.className = 'notice';
    box.innerHTML = '当前数据存在<b>这个浏览器</b>里，没有连上电脑上的记账本服务。' +
      '清理浏览器数据会丢失，记得定期导出备份。';
  }
}

function loadServerInfo() {
  api('GET', '/api/info', null, function (err, status, text) {
    if (err || status !== 200) { return; }
    try { serverInfo = JSON.parse(text); } catch (e) { return; }
    renderStorageBox();
    renderMobileBox();
  });
}

function renderStorageBox() {
  var box = $('storageBox');
  if (!box || mode !== 'server' || !serverInfo) { return; }
  box.className = 'notice is-ok';
  box.innerHTML = '数据存在电脑上的这个文件里：<br><code>' + esc(serverInfo.dataFile) + '</code>' +
    '<br>每次保存都会在 <code>' + esc(serverInfo.backupDir) + '</code> 留一份历史版本。';
}

function renderMobileBox() {
  var wrap = $('mobileBox');
  if (!wrap || mode !== 'server' || !serverInfo) { return; }
  var addrs = serverInfo.addresses || [];
  if (!addrs.length) { wrap.classList.add('is-hidden'); return; }
  var url = 'http://' + addrs[0].address + ':' + serverInfo.port + '/';
  wrap.classList.remove('is-hidden');
  $('mobileUrl').textContent = url;
  $('btnCopyUrl').setAttribute('data-url', url);
}

/* 服务模式下，如果浏览器里还留着以前记的账，问一句要不要搬过来 */
function offerLegacyImport() {
  if (db.transactions.length) { return; }
  var legacy = loadLocalDB();
  if (!legacy || !legacy.transactions.length) { return; }
  if (!window.confirm('这台浏览器里还存着 ' + legacy.transactions.length +
      ' 笔以前记的账。要导入到电脑上的数据文件里吗？')) {
    return;
  }
  db.transactions = legacy.transactions.slice();
  if (legacy.categories && legacy.categories.length) { db.categories = legacy.categories; }
  saveDB();
  renderCategories();
  renderList();
  renderSummary();
  toast('已导入 ' + db.transactions.length + ' 笔');
}

init();
