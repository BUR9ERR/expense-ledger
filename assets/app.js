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

function enterEdit(tx) {
  state.editingId = tx.id;
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

  if (state.editingId) {
    var tx = null;
    for (var i = 0; i < db.transactions.length; i++) {
      if (db.transactions[i].id === state.editingId) { tx = db.transactions[i]; break; }
    }
    if (!tx) {
      /* 编辑到一半被别的设备删掉了，别假装保存成功 */
      exitEdit();
      renderList();
      toast('这条记录已经不在了，可能被另一台设备删掉了', 4000);
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
  var tx = null;
  for (var i = 0; i < db.transactions.length; i++) {
    if (db.transactions[i].id === state.editingId) { tx = db.transactions[i]; break; }
  }
  if (!tx) {
    exitEdit();
    renderList();
    toast('这条记录已经不在了');
    return;
  }
  if (!window.confirm('\u5220\u9664\u8FD9\u7B14\uFF1A' + categoryById(tx.categoryId).name + '\u3000' + fmtMoney(toCents(tx.amount)) + '\uFF1F')) {
    return;
  }
  db.transactions = db.transactions.filter(function (t) { return t.id !== state.editingId; });
  saveDB();
  exitEdit();
  toast('\u5DF2\u5220\u9664');
  renderList();
  renderSummary();
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

function go(page) {
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
  window.scrollTo(0, 0);
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
  exitEdit();
  renderList();
  toast('\u5DF2\u53D6\u6D88\u7F16\u8F91');
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
  if (tx) { enterEdit(tx); }
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
