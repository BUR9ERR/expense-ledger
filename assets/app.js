'use strict';

/* ============================================================
   记账本 v0.1
   数据全部存在本机浏览器，不联网、不上传。
   ============================================================ */

var STORE_KEY = 'ledger.v1.db';
var BACKUP_KEY = 'ledger.v1.lastBackup';
var BACKUP_WARN_DAYS = 7;

/* 分类定义与纯逻辑都在 assets/core.js（LedgerCore），
   这里取引用即可；其余见文件内各处注释。 */
var DEFAULT_CATEGORIES = LedgerCore.DEFAULT_CATEGORIES;

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
var elMonthText  = $('monthText');
var elMonthPicker= $('monthPicker');
var elMpYearSel  = $('mpYearSel');
var elMpGrid     = $('mpGrid');
var elFilterChips= $('filterChips');
var elSourceChips= $('sourceChips');
var elCategoryChips = $('categoryChips');
var elBtnClearFilters = $('btnClearFilters');
var elSourceSwitch= $('sourceSwitch');
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
var elSheetTrash = $('sheetTrash');
var elSheetRecur = $('sheetRecur');
var elSheetHealth = $('sheetHealth');
var elSheetRules = $('sheetRules');
var elSheetCats = $('sheetCats');
var elSheetSuspects = $('sheetSuspects');
var elSheetHistory = $('sheetHistory');
/* 最近一次从服务端拉到的历史版本列表（恢复时要用它查文件名与笔数） */
var historyData = null;
var elSheetBudget= $('sheetBudget');
var elSheetYear  = $('sheetYear');
var elBillFile   = $('billFile');
var elBillResult = $('billResult');
var elBtnBillOk  = $('btnBillConfirm');
var elBackupNote = $('backupNotice');
var elThemeSeg   = $('themeSeg');
var elToast      = $('toast');
var elFileInput  = $('fileInput');
var elImportText = $('importText');
var elLanRow     = $('lanRow');
var elLanSwitch  = $('lanSwitch');

/* ---------- 工具 ----------
   日期、金额、id 等纯函数已迁到 assets/core.js（LedgerCore，可用
   node --test 直接测），这里保留两个「渲染安全」函数，其余取引用。 */
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

var pad2    = LedgerCore.pad2;
var ymd     = LedgerCore.ymd;
var parseYmd  = LedgerCore.parseYmd;
var todayStr  = LedgerCore.todayStr;
var dayHead   = LedgerCore.dayHead;
var uid     = LedgerCore.uid;
var toCents   = LedgerCore.toCents;
var sumCents  = LedgerCore.sumCents;
var fmtMoney  = LedgerCore.fmtMoney;
var fmtShort  = LedgerCore.fmtShort;
var parseAmountToCents = LedgerCore.parseAmountToCents;
/* 账单来源（手动 / 微信 / 支付宝）：判断逻辑在 core.js，可用 node --test 直接测 */
var SOURCE_LABEL = LedgerCore.SOURCE_LABEL;
var srcOf = LedgerCore.srcOf;
var normSource = LedgerCore.normSource;

/* 记账页 / 编辑页的三种类型：支出 / 收入 / 不计收支。
   不计收支（转账、信用卡还款、借还款）在流水里照常显示，但不进任何汇总。 */
var TYPES = ['expense', 'income', 'transfer'];
var isTransfer = function (t) { return t === 'transfer'; };
/* 流水列表一页渲染多少条（触底再加一页，见 watchListMore） */
var LIST_PAGE = 200;

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

var freshDB = LedgerCore.freshDB;
var sanitizeDB = LedgerCore.sanitizeDB;

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

/* ---------- 浏览器存储：IndexedDB 为主，localStorage 只当迁移源 ----------
   localStorage 上限约 5MB，账目多了会写失败；IndexedDB 配额大得多。
   读：IDB 优先，空则尝试 localStorage（首次升级迁移，localStorage
   原样保留当备份），再退空库。写：IDB 异步落盘，失败 toast。
   IDB 打不开（老浏览器/极端隐私模式）时整体退回旧的同步路径。 */
var idbPromise = null;

function idb() {
  if (!idbPromise) {
    idbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open('ledger', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    idbPromise.catch(function () { idbPromise = null; });
  }
  return idbPromise;
}

function idbGet(key) {
  return idb().then(function (conn) {
    return new Promise(function (resolve, reject) {
      var req = conn.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function idbPut(key, val) {
  return idb().then(function (conn) {
    return new Promise(function (resolve, reject) {
      var req = conn.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function loadLocalDBAsync(cb) {
  var legacy = loadLocalDB() ? JSON.parse(localStorage.getItem(STORE_KEY)) : null;
  var done = function (v) { cb(v ? sanitizeDB(v) : freshDB()); };
  if (!('indexedDB' in window)) { done(legacy); return; }
  idbGet('db').then(function (v) {
    if (v && Array.isArray(v.transactions)) { done(v); return; }
    if (legacy) {
      /* 首次升级迁移：localStorage 的账搬进 IDB；localStorage 原样留着当备份 */
      idbPut('db', legacy).catch(function () { /* 落盘失败下次再试 */ });
      done(legacy);
      return;
    }
    done(null);
  }).catch(function () { done(legacy); });
}

function saveLocalDB() {
  if (!('indexedDB' in window)) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
      return true;
    } catch (e) {
      toast('保存失败：浏览器存储空间可能已满', 4000);
      return false;
    }
  }
  /* 异步落盘；配额比 localStorage 大得多，失败时提示 */
  idbPut('db', db).catch(function (e) {
    toast('保存失败：浏览器存储写入出错（' + ((e && e.name) || '未知') + '）', 4000);
  });
  return true;
}

function saveDB() {
  if (mode === 'server') {
    /* 返回 true 只表示「已进入保存队列」，不代表已落盘；
       真正的结果由 pushToServer 的回调通过角标和 toast 反馈。
       调用方不要拿这个返回值当「保存成功」用。 */
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
  if (method !== 'GET' && method !== 'HEAD') {
    /* 写请求一律带 JSON 头：服务的同站校验以它区分「表单/脚本发出的
       跨站简单请求」。空体也要补一个 '{}' —— 浏览器对无请求体的请求
       不发 Content-Type 头，会被 415 挡掉（停止服务按钮踩过这个坑：
       当时的修法是在调用处逐个补，这里改成在唯一出口统一补，新写
       接口不可能再踩）。 */
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (body === null || body === undefined) { body = '{}'; }
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
    } else if (status === 401) {
      /* 口令验证过期了（比如清了浏览器数据）：弹口令，验证成功重新排队保存 */
      setSyncState('offline');
      showPinGate(function () { queueServerSave(); });
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

  /* 合并规则（updatedAt 取新、新账保留、残留丢弃）在 core.js 的
     mergeTransactions 里，含已知局限的说明；这里只管界面反馈。 */
  var mergedRes = LedgerCore.mergeTransactions(db.transactions, remote.transactions, lastPushAt);
  db.transactions = mergedRes.transactions;

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
  if (mode !== 'server') {
    /* 服务没启用：红色提醒——数据只在这个浏览器里，没存到电脑 */
    el.className = 'sync-badge is-local';
    el.textContent = '浏览器存储';
    el.title = '没有连上电脑上的记账本服务，数据只存在这个浏览器里，清理浏览器数据会丢失';
    return;
  }
  el.title = '';
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
  /* 从流水进编辑时记下的列表滚动位置（backToList 里消费后清空） */
  listScroll: null,
  listMonth: '',
  listFilter: 'all',
  /* 流水页的「来源」筛选：all / manual / wechat / alipay */
  listSource: 'all',
  /* 流水页的「分类」筛选：**可多选**，空数组 = 全部分类 */
  listCategories: [],
  /* 记一笔/编辑时的来源 */
  source: 'manual',
  /* 「本月」页正在看的月份（空 = 跟着真实的今天） */
  sumMonth: '',
  /* 流水搜索关键词（空 = 按月浏览）；showAll = 本次渲染不截断 */
  search: '',
  showAll: false,
  /* 单次渲染多少条；触底自动加一页（长列表增量渲染） */
  listLimit: 0,
  /* 内部用：这次渲染是「继续往下看」而不是从头刷新 */
  keepPaging: false,
  /* 批量删除模式：batchSel 是「已勾选 id → true」的集合，跨翻页保留 */
  batchMode: false,
  batchSel: {}
};

function currentMonthKey() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

/* ============================================================
   记一笔
   ============================================================ */

function renderCategories() {
  var list = LedgerCore.activeCategories(db.categories, state.type);
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
  state.type = (type === 'income' || type === 'transfer') ? type : 'expense';
  document.body.setAttribute('data-type', state.type);
  var btns = elTypeSwitch.querySelectorAll('.seg-item');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-active', btns[i].getAttribute('data-type') === state.type);
  }
  /* 分类宫格按类型筛：支出/收入各有自己的一套；不计收支固定用「转账」这一类 */
  var cats = LedgerCore.activeCategories(db.categories, state.type);
  var belongs = cats.some(function (c) { return c.id === state.categoryId; });
  if (!belongs) { state.categoryId = cats.length ? cats[0].id : defaultCategoryId(state.type); }
  renderCategories();
  updateTransferNote();
}

/* 某个类型的兜底分类（分类表里没有这个类型时的安全选择） */
function defaultCategoryId(type) {
  return type === 'income' ? 'other_i' : (type === 'transfer' ? 'transfer' : 'other_e');
}

/* 选了「不计收支」时给一句话解释，免得用户以为这笔账丢了。
   顺带说明它去哪了：流水里能看到，但所有汇总都不算它。 */
function updateTransferNote() {
  var box = $('transferNote');
  if (!box) { return; }
  box.classList.toggle('is-hidden', !isTransfer(state.type));
}

/* 金额框的算式：23+18、35*2、100-12.5 都能算。
   求值在 core.js（纯函数、有测试），这里只负责显示与结算。 */
function amountExprResult() {
  var raw = String(elAmount.value || '').trim();
  if (!raw) { return null; }
  /* 纯数字（没有运算符）不需要提示，直接按普通金额走 */
  if (!/[+\-*/×÷]/.test(raw)) { return null; }
  var cents = LedgerCore.evalAmountToCents(raw);
  return cents == null ? { bad: true } : { cents: cents };
}

function renderAmountHint() {
  var box = $('amountHint');
  if (!box) { return; }
  var res = amountExprResult();
  if (!res) { box.classList.add('is-hidden'); box.textContent = ''; return; }
  box.classList.remove('is-hidden');
  if (res.bad) {
    box.textContent = '这个算式算不出来，检查一下运算符';
    box.classList.add('is-bad');
  } else {
    box.textContent = '= ' + fmtMoney(res.cents) + '（按「记下来」就记这个数）';
    box.classList.remove('is-bad');
  }
}

/* 记一笔 / 编辑页的「来源」分段控件 */
function setSource(v) {
  state.source = normSource(v);
  if (!elSourceSwitch) { return; }
  var btns = elSourceSwitch.querySelectorAll('.seg-item');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-active', btns[i].getAttribute('data-src') === state.source);
  }
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
  /* 从流水进编辑：记下列表的滚动位置。go('record') 会把页面顶到 0，
     删除返回时没有可滚到的目标，只能靠这个位置接回来
     （保存路径有 flashTx 滚到那条，用不上它） */
  if (from === 'list') { state.listScroll = window.pageYOffset; }
  setType(tx.type);
  state.categoryId = tx.categoryId;
  renderCategories();
  elAmount.value = String(tx.amount);
  elDate.value = tx.date;
  elNote.value = tx.note || '';
  setSource(srcOf(tx));
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
  setSource('manual');
  renderAmountHint();   /* 算式提示跟着清掉 */
}

function saveEntry() {
  /* 金额框可以直接写算式：23+18 / 35*2 / 100-12.5。
     evalAmountToCents 认得算式，也认得单个数字（老行为不变）。 */
  var cents = LedgerCore.evalAmountToCents(elAmount.value);
  if (cents == null) {
    var looksLikeExpr = /[+\-*/×÷]/.test(String(elAmount.value || ''));
    toast(looksLikeExpr ? '这个算式算不出来，检查一下运算符' : '请先输入金额');
    elAmount.focus();
    return;
  }
  if (cents <= 0) {
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
      if (fromList) { backToList(null, true); } else { renderList(); }
      return;
    }
    tx.type = state.type;
    tx.amount = cents / 100;
    var oldCat = tx.categoryId;
    tx.categoryId = state.categoryId;
    tx.date = date;
    tx.note = note;
    tx.source = normSource(state.source);
    tx.updatedAt = now;
    /* 改了导入账目的分类 → 学一条规则，下次同一家店自动归到这一类
       （和 Actual Budget 的自动学习一个思路，只是简化为「关键词包含」） */
    var learned = (oldCat !== state.categoryId) ? learnFromEdit(tx) : '';
    if (!saveDB()) { return; }
    exitEdit();
    toast(learned ? ('已保存修改，并记住「' + learned + '」归到这一类') : '已保存修改');
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
      source: normSource(state.source),
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

/* 从一次「改分类」里学一条导入规则，返回学到的关键词（没学到返回 ''）。
   只学导入来的账：手动记的往往是一次性消费（「和同事吃饭」），
   学成规则只会让以后导入的账被误分类。 */
function learnFromEdit(tx) {
  if (!tx || srcOf(tx) === 'manual') { return ''; }
  var kw = LedgerCore.learnableKeyword(tx.note);
  if (!kw) { return ''; }
  var existed = null;
  (db.rules || []).forEach(function (r) {
    if (r.keywords && r.keywords.indexOf(kw) >= 0) { existed = r; }
  });
  if (existed && existed.categoryId === tx.categoryId) { return ''; }
  db.rules = LedgerCore.learnRule(db.rules || [], kw, tx.categoryId, Date.now());
  return kw;
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
  /* 软删除：打墓碑不真删。删除随同步走（别的设备不会再把它变回来），
     30 天内可在「数据管理 → 回收站」找回，过期自动清理 */
  tx.deletedAt = Date.now();
  tx.updatedAt = Date.now();
  saveDB();
  exitEdit();
  toast('已删除，30 天内可在回收站找回');
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
    if (t.deletedAt) { return false; }
    var d = parseYmd(t.date);
    return d.getFullYear() === y && d.getMonth() === m - 1;
  });
}

/* ---------- 日历热力图（按月） ----------
   纯逻辑在 core.monthCalendar：每格是一天的支出与笔数、再加一个 0~4 的色阶。
   窄屏上每格只有 ~44px，金额塞进去必然溢出——所以用颜色表达多少，
   点某一天才把当天的账目筛出来看。 */
function renderCalendar() {
  var box = $('calendarBox');
  var grid = $('calGrid');
  if (!box || !grid) { return; }
  if (box.classList.contains('is-hidden')) { return; }

  var cal = LedgerCore.monthCalendar(db.transactions, state.listMonth);
  var html = '';
  cal.weeks.forEach(function (week) {
    week.forEach(function (cell) {
      if (!cell.date) {
        html += '<span class="cal-cell is-blank"></span>';
        return;
      }
      var cls = 'cal-cell lv' + cell.level + (cell.day === Number(todayStr().slice(8, 10)) &&
        state.listMonth === currentMonthKey() ? ' is-today' : '');
      var label = cell.cents
        ? (cell.date + '：' + cell.count + ' 笔 ' + fmtMoney(cell.cents))
        : (cell.date + '：没有支出');
      html += '<button type="button" class="' + cls + '" data-day="' + esc(cell.date) + '"' +
        ' title="' + esc(label) + '" aria-label="' + esc(label) + '">' +
        '<span class="cal-day">' + cell.day + '</span>' +
        (cell.cents ? '<span class="cal-amt">' + fmtShort(cell.cents) + '</span>' : '') +
        '</button>';
    });
  });
  grid.innerHTML = html;

  var hint = $('calHint');
  if (hint) {
    hint.textContent = cal.days
      ? ('这个月有 ' + cal.days + ' 天记过支出，最多的一天 ' + fmtMoney(cal.maxCents) +
         '　·　点某天看那天的账')
      : '这个月还没有支出记录';
  }
}

function toggleCalendar(force) {
  var box = $('calendarBox');
  var btn = $('btnCalendar');
  if (!box) { return; }
  var show = force === undefined ? box.classList.contains('is-hidden') : !!force;
  box.classList.toggle('is-hidden', !show);
  if (btn) { btn.classList.toggle('is-active', show); }
  if (show) { renderCalendar(); }
}

/* 分类筛选 chips：可多选。第一颗「全部分类」= 清空选择（不是 id），   后面按「支出在前、收入在后」列出账本里的分类，选中的实心显示。
   每次出列表时重建（分类可能因为导入而变），选中态用 state.listCategories。 */
function renderCategoryChips() {
  if (!elCategoryChips) { return; }
  var cats = db.categories || [];
  /* 账本换过分类时，清掉已经不存在的 id，别让筛选器指着空气 */
  state.listCategories = LedgerCore.cleanCategoryFilter(state.listCategories, cats);
  var html = '<button type="button" class="chip is-reset' +
             (state.listCategories.length ? '' : ' is-active') +
             '" data-cat="all">全部分类</button>';
  var kinds = ['expense', 'income'];
  for (var k = 0; k < kinds.length; k++) {
    /* 归档的分类不再出现在筛选里（历史账目仍然照常显示） */
    var group = LedgerCore.activeCategories(cats, kinds[k]);
    for (var i = 0; i < group.length; i++) {
      var c = group[i];
      var on = state.listCategories.indexOf(String(c.id)) >= 0 ? ' is-active' : '';
      html += '<button type="button" class="chip' + on + '" data-cat="' + esc(c.id) + '"' +
              ' title="' + esc(c.name) + (kinds[k] === 'income' ? '（收入）' : '') + '">' +
              esc(c.icon + ' ' + c.name) + '</button>';
    }
  }
  elCategoryChips.innerHTML = html;

  /* 选中的那颗滚进可见范围，别让用户选完了看不见自己选了什么。
     只动这一条横向滚动条的 scrollLeft——用 scrollIntoView 会把整个页面
     也滚一下（用户正在看列表中部时尤其烦）。 */
  var active = elCategoryChips.querySelector('.chip.is-active');
  if (active && active.offsetLeft != null) {
    var left = active.offsetLeft;
    var right = left + active.offsetWidth;
    var viewL = elCategoryChips.scrollLeft;
    var viewR = viewL + elCategoryChips.clientWidth;
    if (left < viewL) { elCategoryChips.scrollLeft = Math.max(0, left - 8); }
    else if (right > viewR) { elCategoryChips.scrollLeft = right - elCategoryChips.clientWidth + 8; }
  }
}

/* 金额 / 日期范围的当前值（读输入框本身，空 = 不生效） */
function rangeConditions() {
  var c = {};
  var min = parseAmountToCents($('amountMin').value);
  if (min > 0) { c.minAmount = min / 100; }
  var max = parseAmountToCents($('amountMax').value);
  if (max > 0) { c.maxAmount = max / 100; }
  var from = $('dateFrom').value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { c.dateFrom = from; }
  var to = $('dateTo').value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { c.dateTo = to; }
  return c;
}

function clearRangeInputs() {
  $('amountMin').value = '';
  $('amountMax').value = '';
  $('dateFrom').value = '';
  $('dateTo').value = '';
}

/* 有没有「额外筛选」在起作用（类型 / 来源 / 分类 / 搜索词 / 金额日期范围）：
   决定要不要显示「清除筛选」和空列表里的那颗按钮 */
function refreshFilterTools() {
  var on = LedgerCore.hasExtraFilter(Object.assign({
    keyword: state.search,
    type: state.listFilter,
    source: state.listSource,
    category: state.listCategories
  }, rangeConditions()));
  if (elBtnClearFilters) { elBtnClearFilters.classList.toggle('is-hidden', !on); }
  return on;
}

function renderList() {
  var searching = !!(state.search || '').trim();
  /* 每页一律从第一页开始画：翻月、切筛选、回到列表都调 renderList，
     而这时用户的注意力在列表顶部，不该被上一轮的「已经滚了几页」影响 */
  if (!state.keepPaging) { state.listLimit = LIST_PAGE; }
  state.keepPaging = false;
  var p = state.listMonth.split('-');
  /* 只改文字那一段：整个按钮一起改会把里面「可点开选择器」的小箭头也清掉 */
  (elMonthText || elMonthLabel).textContent = searching
    ? '\u641C\u7D22\uFF1A' + state.search
    : p[0] + ' \u5E74 ' + Number(p[1]) + ' \u6708';

  /* 四种筛选（类型 / 来源 / 分类 / 关键词）+ 金额日期范围的规则在
     core.filterTx 里，搜索模式与按月浏览走的是同一套——以前是两段
     几乎一样的 if，加一个筛选条件要改两处，漏一处就出「搜索时筛选
     失灵」这类 bug。 */
  renderCategoryChips();
  var hasExtra = refreshFilterTools();
  renderCalendar();
  var list = LedgerCore.sortTxDesc(LedgerCore.filterTx(db.transactions, Object.assign({
    /* 搜索时跨全部月份找；不搜索就只看当前月 */
    month: searching ? '' : state.listMonth,
    keyword: state.search,
    type: state.listFilter,
    source: state.listSource,
    category: state.listCategories
  }, rangeConditions()), function (id) { return categoryById(id).name; }));

  /* 单次渲染上限：大月份/大搜索先画一批（默认 200 条），
     滑到底部自动再画 200 条——这是「增量渲染」，
     配合 CSS 的 content-visibility，屏幕外的行连布局和绘制都跳过。
     以前是「先画 300 条，点一下显示全部」，几百笔的月份点下去会一次性
     建出上万个 DOM 节点，手机上会卡住好几秒。 */
  var capped = false;
  var totalCount = list.length;
  var limit = state.showAll ? list.length : (state.listLimit || LIST_PAGE);
  /* 从流水点进来的那条可能在很后面：把它所在的页也算进上限，
     否则「改完回流水」会滚不到那一行（那一行压根没画出来）。 */
  if (!state.showAll && state.editingId && list.length > limit) {
    for (var ei = 0; ei < list.length; ei++) {
      if (list[ei].id === state.editingId) {
        limit = Math.ceil((ei + 1) / LIST_PAGE) * LIST_PAGE;
        break;
      }
    }
  }
  if (list.length > limit) {
    list = list.slice(0, limit);
    capped = true;
  }

  /* 合计口径走 core.countStats：只有支出与收入进合计，
     不计收支（转账）单独显示一行，不混进支出/收入里。 */
  var stat = LedgerCore.countStats(list);
  elListTotal.innerHTML = '<span>\u652F\u51FA <b>' + fmtMoney(stat.expenseCents) + '</b></span>' +
                          '<span>\u6536\u5165 <b>' + fmtMoney(stat.incomeCents) + '</b></span>' +
                          (stat.transferCount
                            ? '<span class="is-faint">\u4E0D\u8BA1\u6536\u652F <b>' + stat.transferCount + ' \u7B14</b></span>'
                            : '');

  if (!list.length) {
    elTxList.innerHTML = '<div class="empty"><div class="empty-ico">\uD83D\uDCD2</div>' +
      (searching ? '\u6CA1\u627E\u5230\u5339\u914D\u7684\u8D26\u76EE' : '\u8FD9\u4E2A\u6708\u8FD8\u6CA1\u6709\u8BB0\u8D26') +
      (hasExtra ? '<button type="button" class="empty-reset">清除筛选，看全部</button>' : '') +
      '</div>';
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
    var dayExp = sumCents(LedgerCore.expenseTx(items));
    var dayInc = sumCents(LedgerCore.incomeTx(items));
    var dayTr = LedgerCore.transferTx(items).length;

    var sumParts = [];
    if (dayExp) { sumParts.push('\u652F ' + fmtMoney(dayExp)); }
    if (dayInc) { sumParts.push('\u6536 ' + fmtMoney(dayInc)); }
    if (dayTr) { sumParts.push('\u4E0D\u8BA1\u6536\u652F ' + dayTr + ' \u7B14'); }

    html += '<div class="tx-day" data-day="' + esc(day) + '">' +
      '<div class="tx-day-head"><span>' + esc(dayHead(day)) + '</span><b>' + sumParts.join('\u3000') + '</b></div>' +
      '<div class="tx-group">';

    items.forEach(function (t) {
      var c = categoryById(t.categoryId);
      /* 不计收支的金额不加正负号，用中性色，一眼区分「这笔不算花掉」 */
      var tr = t.type === 'transfer';
      var sign = tr ? '' : (t.type === 'expense' ? '-' : '+');
      var cls = tr ? 'is-transfer' : (t.type === 'expense' ? 'is-expense' : 'is-income');
      var editing = t.id === state.editingId ? ' is-editing' : '';
      var sel = state.batchMode && state.batchSel[t.id] ? ' is-selected' : '';
      var noteLine = t.note
        ? '<div class="tx-note">' + esc(t.note) + '</div>'
        : '<div class="tx-note">' + esc(c.name) + '</div>';
      html += '<button type="button" class="tx-item' + editing + sel + '" data-tx="' + esc(t.id) + '">' +
        (state.batchMode ? '<span class="tx-check" aria-hidden="true"></span>' : '') +
        '<span class="tx-ico">' + esc(c.icon) + '</span>' +
        '<span class="tx-main"><span class="tx-cat">' + esc(tr ? '不计收支' : c.name) +
          '<span class="tx-src">' + SOURCE_LABEL[srcOf(t)] + '</span></span>' + noteLine + '</span>' +
        '<span class="tx-amt ' + cls + '">' + sign + fmtMoney(toCents(t.amount)) + '</span>' +
        '</button>';
    });

    html += '</div></div>';
  });

  if (capped) {
    /* 触底会自动追加；这颗按钮留给「不想滚到底、直接全画出来」的人 */
    html += '<button type="button" class="list-more">已显示最近 ' + list.length +
            ' / 共 ' + totalCount + ' 笔　·　点这里一次显示全部</button>';
  }

  elTxList.innerHTML = html;
  /* 画完再挂观察器：DOM 已经换掉，旧的观察器跟着旧的哨兵一起没了 */
  watchListMore();
  renderBatchBar();
}

/* ---------- 批量删除：勾选模式 ----------
   选中的是 id 集合（跨翻页/筛选保留），删除走软删除进回收站。 */

function toggleBatch(force) {
  var want = force === undefined ? !state.batchMode : !!force;
  if (want === state.batchMode) { return; }
  state.batchMode = want;
  state.batchSel = {};
  var btn = $('btnBatch');
  if (btn) { btn.classList.toggle('is-active', want); }
  var bar = $('batchBar');
  if (bar) { bar.classList.toggle('is-hidden', !want); }
  renderList();
  if (want) {
    toast('批量删除：点行勾选；按住一笔往下拖可连选', 3500);
  }
}

/* 与 renderList 同一套筛选（但不截断分页）：「全选」选的就是全部命中项 */
function batchFilteredIds() {
  var searching = !!(state.search || '').trim();
  return LedgerCore.sortTxDesc(LedgerCore.filterTx(db.transactions, Object.assign({
    month: searching ? '' : state.listMonth,
    keyword: state.search,
    type: state.listFilter,
    source: state.listSource,
    category: state.listCategories
  }, rangeConditions()), function (id) { return categoryById(id).name; })).map(function (t) { return t.id; });
}

function renderBatchBar() {
  if (!state.batchMode) { return; }
  var n = Object.keys(state.batchSel).length;
  var count = $('batchCount');
  if (count) { count.textContent = '已选 ' + n + ' 笔'; }
  var del = $('btnBatchDelete');
  if (del) { del.disabled = !n; }
}

/* ---------- 批量删除的「按住往下拖连选」 ----------
   鼠标：按住一笔拖动，扫过的行都按第一笔按下后的状态刷选。
   触屏：长按一笔（350ms）进入连选——拖动时要阻止列表滚动
   （touchmove preventDefault），松手结束；之前的移动算正常滚动。
   点一下（没有拖动）仍然是普通的勾选/取消。 */
var batchDrag = { painting: false, paint: true, lastId: '', suppressClick: false,
                  painted: false, timer: null };

function batchApplySel(id, val) {
  if (val) { state.batchSel[id] = true; } else { delete state.batchSel[id]; }
  var row = elTxList.querySelector('.tx-item[data-tx="' + id.replace(/"/g, '') + '"]');
  if (row) { row.classList.toggle('is-selected', !!val); }
  renderBatchBar();
}

/* 指针落在哪一行上：按 Y 坐标遍历已渲染行的矩形。
   不用 elementFromPoint——.tx-day 开了 content-visibility:auto，
   浏览器跳过渲染的分组连命中测试都会跳过，只会返回分组容器本身。 */
function batchPaintAt(x, y) {
  var rows = elTxList.querySelectorAll('.tx-item');
  var row = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i].getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) { row = rows[i]; break; }
  }
  if (!row) { return; }
  var id = row.getAttribute('data-tx');
  if (!id || id === batchDrag.lastId) { return; }
  batchDrag.lastId = id;
  batchDrag.painted = true;
  batchApplySel(id, batchDrag.paint);
}

function batchDragStop() {
  clearTimeout(batchDrag.timer);
  if (batchDrag.painting || batchDrag.painted) { batchDrag.suppressClick = true; }
  batchDrag.painting = false;
  elTxList.classList.remove('is-painting');
}

elTxList.addEventListener('pointerdown', function (e) {
  if (!state.batchMode) { return; }
  var row = e.target.closest('.tx-item');
  if (!row) { return; }
  var id = row.getAttribute('data-tx');
  if (!id) { return; }
  batchDrag.suppressClick = false;
  batchDrag.paint = !state.batchSel[id];
  batchDrag.lastId = id;
  batchDrag.painted = false;
  if (e.pointerType === 'touch') {
    /* 触屏：长按 350ms 进入连选；之前挪开手指算正常滚动 */
    batchDrag.painting = false;
    clearTimeout(batchDrag.timer);
    batchDrag.timer = setTimeout(function () {
      batchDrag.painting = true;
      elTxList.classList.add('is-painting');
      batchDrag.painted = true;
      batchApplySel(batchDrag.lastId, batchDrag.paint);
    }, 350);
  } else {
    /* 鼠标：按住立刻开始刷选 */
    batchDrag.painting = true;
    batchDrag.suppressClick = true;   /* pointerdown 已经刷过这笔，click 不再翻一次 */
    batchApplySel(id, batchDrag.paint);
  }
});

elTxList.addEventListener('pointermove', function (e) {
  if (!state.batchMode || !batchDrag.painting) { return; }
  if (e.pointerType === 'touch') { return; }   /* 触屏走 touchmove（才能阻止滚动） */
  batchPaintAt(e.clientX, e.clientY);
});

/* 连选中阻止列表滚动，并把手指经过的行刷上选中态 */
elTxList.addEventListener('touchmove', function (e) {
  if (!state.batchMode || !batchDrag.painting) { return; }
  e.preventDefault();
  var t = e.touches && e.touches[0];
  if (t) { batchPaintAt(t.clientX, t.clientY); }
}, { passive: false });

elTxList.addEventListener('pointerup', batchDragStop);
elTxList.addEventListener('pointercancel', batchDragStop);

function batchDeleteSelected() {
  var ids = Object.keys(state.batchSel);
  if (!ids.length) { return; }
  if (!window.confirm('把选中的 ' + ids.length + ' 笔移入回收站？\n30 天内可在 数据管理 → 回收站 找回。')) { return; }
  var now = Date.now();
  var n = 0;
  db.transactions.forEach(function (t) {
    if (state.batchSel[t.id] && !t.deletedAt) { t.deletedAt = now; t.updatedAt = now; n++; }
  });
  saveDB();
  toggleBatch(false);
  renderSummary();
  renderCalendar();
  toast('已删除 ' + n + ' 笔，30 天内可在回收站找回');
}

/* 点日历上的某一天：把那天的账目滚到眼前。
   那天不在当前筛选里时，先清掉筛选——用户点日历就是想看那天。 */
function jumpToDay(day) {
  var has = db.transactions.some(function (t) {
    return !t.deletedAt && t.date === day;
  });
  if (!has) { toast('这天没有记录'); return; }

  var ranges = rangeConditions();
  var needClear = state.listFilter !== 'all' || state.listSource !== 'all' ||
                  state.listCategories.length || state.search ||
                  ranges.minAmount != null || ranges.maxAmount != null ||
                  ranges.dateFrom || ranges.dateTo;
  /* 先把筛选/分页复位，再按复位后的状态决定要画到第几页 */
  if (needClear) { clearListFilters(); } else { renderList(); }

  /* 那天的分组可能在还没画出来的后几页里：把上限提到该天所在的位置之后 */
  var sorted = LedgerCore.sortTxDesc(LedgerCore.filterTx(db.transactions, {
    month: state.listMonth,
    keyword: state.search,
    type: state.listFilter,
    source: state.listSource,
    category: state.listCategories
  }, function (id) { return categoryById(id).name; }));
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].date === day) {
      var need = Math.ceil((i + 1) / LIST_PAGE) * LIST_PAGE;
      if (need > (state.listLimit || LIST_PAGE)) {
        state.listLimit = need;
        state.keepPaging = true;      /* 别让 renderList 把分页重置回第一页 */
        renderList();
      }
      break;
    }
  }

  var target = elTxList.querySelector('.tx-day[data-day="' + day + '"]');
  if (target) {
    scrollTxIntoView(target, true);
    target.classList.add('is-flash');
    setTimeout(function () { target.classList.remove('is-flash'); }, 1400);
  }
}

/* ---------- 长列表：触底自动追加 ----------
   renderList 每次都会重建列表，所以观察器也每次重建。
   不引虚拟滚动库：记账列表行高可变（有无备注、有无金额标签），
   手写虚拟滚动的复杂度远超收益，而 content-visibility + 增量渲染
   已经能把几百上千条的列表按住。 */
var listObserver = null;

function watchListMore() {
  var more = elTxList.querySelector('.list-more');
  if (listObserver) { listObserver.disconnect(); listObserver = null; }
  if (!more || !('IntersectionObserver' in window)) { return; }
  listObserver = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) { continue; }
      listObserver.disconnect();
      listObserver = null;
      state.listLimit = (state.listLimit || LIST_PAGE) + LIST_PAGE;
      state.keepPaging = true;      /* 这一页是「继续往下看」，别从头再来 */
      renderList();
      return;
    }
  }, { rootMargin: '400px 0px' });   /* 提前 400px 就开始画，滚到底不会白一下 */
  listObserver.observe(more);
}

function shiftMonth(n) {
  var p = state.listMonth.split('-');
  var y = Number(p[0]);
  var m = Number(p[1]) + n;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  state.listMonth = y + '-' + pad2(m);
  clearListSearch();
  renderList();
}

/* ---------- 年月快速选择（点流水页顶部的「2026 年 9 月」直接挑月份） ---------- */

/* 选择器里正在翻看的年份，跟 state.listMonth 分开：
   用户可以来回翻年看哪个月有账，选中了才改 listMonth。 */
var mpYear = 0;

function renderMonthPicker() {
  if (!elMpGrid) { return; }

  /* 年份下拉：可选范围 = 有账目的年份 ∪ 今年 ∪ 正在看的年份，新的排上面。
     要看哪年直接选，不用一下一下翻。 */
  var nowY = new Date().getFullYear();
  var minY = nowY, maxY = nowY;
  db.transactions.forEach(function (t) {
    var m = String(t.date || '').match(/^(\d{4})-/);
    if (!m) { return; }
    var y = Number(m[1]);
    if (y < minY) { minY = y; }
    if (y > maxY) { maxY = y; }
  });
  var viewY = Number(state.listMonth.split('-')[0]);
  if (viewY < minY) { minY = viewY; }
  if (viewY > maxY) { maxY = viewY; }
  if (mpYear < minY) { minY = mpYear; }
  if (mpYear > maxY) { maxY = mpYear; }

  var opts = '';
  for (var y = maxY; y >= minY; y--) {
    opts += '<option value="' + y + '"' + (y === mpYear ? ' selected' : '') + '>' +
            y + ' \u5E74</option>';
  }
  elMpYearSel.innerHTML = opts;

  /* 哪几个月记过账？有账的格子加个小圆点，一眼看出该往哪跳 */
  var hasData = {};
  db.transactions.forEach(function (t) {
    var k = String(t.date).slice(0, 7);
    if (k.slice(0, 4) === String(mpYear)) { hasData[Number(k.slice(5, 7))] = true; }
  });

  var nowKey = currentMonthKey();
  var html = '';
  for (var m = 1; m <= 12; m++) {
    var key = mpYear + '-' + pad2(m);
    var cls = 'mp-cell';
    if (hasData[m]) { cls += ' has-data'; }
    if (key === nowKey) { cls += ' is-now'; }
    if (key === state.listMonth) { cls += ' is-active'; }
    html += '<button type="button" class="' + cls + '" data-ym="' + key + '">' +
            m + ' \u6708</button>';
  }
  elMpGrid.innerHTML = html;
}

function openMonthPicker() {
  if (!elMonthPicker) { return; }
  mpYear = Number(state.listMonth.split('-')[0]);
  renderMonthPicker();
  /* 开场：先撤掉 display:none，回流后再挂 is-open，
     让透明度/缩放的过渡真正跑起来（display 切换是不会触发过渡的） */
  if (elMonthPicker.classList.contains('is-hidden')) {
    elMonthPicker.classList.remove('is-hidden');
    void elMonthPicker.offsetWidth;
  }
  elMonthPicker.classList.add('is-open');
  elMonthLabel.setAttribute('aria-expanded', 'true');
}

function closeMonthPicker() {
  if (!elMonthPicker) { return; }
  /* 收场：只摘 is-open，面板自己淡出缩回（CSS 过渡），不再闪回 display:none */
  elMonthPicker.classList.remove('is-open');
  elMonthLabel.setAttribute('aria-expanded', 'false');
}

function pickMonth(key) {
  if (!/^\d{4}-\d{2}$/.test(key)) { return; }
  state.listMonth = key;
  clearListSearch();
  closeMonthPicker();
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

function syncSourceChips() {
  if (!elSourceChips) { return; }
  var chips = elSourceChips.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('is-active', chips[i].getAttribute('data-src') === state.listSource);
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
    if (state.listSource !== 'all' && srcOf(tx) !== state.listSource) {
      state.listSource = 'all';
      syncSourceChips();
    }
    /* 分类是多选：改完的那条如果不在选中的分类里，就把它所在的分类补进去，
       免得出现「保存成功却看不见这条」。 */
    if (state.listCategories.length &&
        state.listCategories.indexOf(String(tx.categoryId)) < 0) {
      state.listCategories = [];
    }
  }
  go('list', keepScroll);
  /* 没有可滚到的目标（删除、记录消失）时，把进编辑前的位置接回来。
     列表少了一条，超出的部分会被夹回最大滚动值，正好停在同批内容上。 */
  if (keepScroll && !tx && state.listScroll != null) {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.max(0, Math.min(state.listScroll, max)));
  }
  state.listScroll = null;
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

/* ---------- 回收站 ---------- */

function deletedTxs() {
  return db.transactions.filter(function (t) { return t.deletedAt; })
    .sort(function (a, b) { return b.deletedAt - a.deletedAt; });
}

function renderTrash() {
  var list = deletedTxs();
  var box = $('trashList');
  $('btnEmptyTrash').classList.toggle('is-hidden', !list.length);
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding:24px 8px">回收站是空的</div>';
    return;
  }
  var html = '';
  list.forEach(function (t) {
    var c = categoryById(t.categoryId);
    html += '<div class="trash-item">' +
      '<span class="trash-main">' +
        '<span class="trash-line">' + esc(c.icon + ' ' + c.name) +
          '<b>' + (t.type === 'expense' ? '-' : '+') + fmtMoney(toCents(t.amount)) + '</b></span>' +
        '<span class="trash-sub">' + esc(t.date) +
          (t.note ? ' · ' + esc(t.note) : '') + '</span>' +
      '</span>' +
      '<button class="btn-mini" type="button" data-restore="' + esc(t.id) + '">恢复</button>' +
      '</div>';
  });
  box.innerHTML = html;
}

/* 加载后清理超过 30 天的墓碑（两边都调）；有清理就存回去同步掉 */
function purgeOldDeleted() {
  var res = LedgerCore.purgeDeleted(db.transactions, Date.now());
  if (!res.purged) { return; }
  db.transactions = res.kept;
  saveDB();
  toast('回收站清理了 ' + res.purged + ' 条超过 30 天的删除');
}

/* ---------- 疑似转账（批量标为不计收支） ----------
   导入的账单里，转账/还款只留一个名字或「转账备注:微信转账」这样的备注，
   词库认不出品类，就掉进「其他」被算成支出。这里把疑似的一次列出来，
   用户勾选后一键改类型——绝不自动改（猜错比不改更糟）。 */

var suspectSelected = null;   /* id 集合，null = 默认全选 */

function renderSuspects() {
  var box = $('suspectsList');
  if (!box) { return; }
  var list = LedgerCore.findTransferSuspects(db.transactions).sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });
  var actions = $('suspectsActions');
  if (!list.length) {
    if (actions) { actions.classList.add('is-hidden'); }
    box.innerHTML = '<div class="empty" style="padding:20px 8px">没找到疑似的转账。<br>' +
      '如果还有该跳过的（比如朋友间借还），在流水里点开那笔改成「不计收支」就行。</div>';
    return;
  }
  if (!suspectSelected) {
    suspectSelected = {};
    list.forEach(function (t) { suspectSelected[t.id] = true; });
  }
  var totalCents = sumCents(list);
  var html = '<div class="notice is-ok">找到 <b>' + list.length + '</b> 笔，合计 ' +
    fmtMoney(totalCents) + '。勾选后点下面的按钮一次改掉。</div>';
  list.forEach(function (t) {
    var c = categoryById(t.categoryId);
    var on = suspectSelected[t.id] ? ' checked' : '';
    html += '<label class="suspect-row">' +
      '<input type="checkbox" data-suspect="' + esc(t.id) + '"' + on + '>' +
      '<span class="suspect-main">' +
        '<span class="suspect-line"><b>' + fmtMoney(toCents(t.amount)) + '</b>' +
          '<span>' + esc(t.date) + '</span></span>' +
        '<span class="suspect-sub">' + esc(c.icon + ' ' + c.name) + ' · ' +
          esc(t.note || '（无备注）') + '</span>' +
      '</span>' +
      '</label>';
  });
  box.innerHTML = html;
  if (actions) { actions.classList.remove('is-hidden'); }
}

function openSuspects() {
  suspectSelected = null;
  renderSuspects();
  openSheet(elSheetSuspects);
}

function markSelectedSuspects() {
  var ids = Object.keys(suspectSelected || {}).filter(function (id) { return suspectSelected[id]; });
  if (!ids.length) { toast('先勾几笔'); return; }
  if (!window.confirm('把这 ' + ids.length + ' 笔标成「不计收支」吗？\n\n' +
      '它们会继续留在流水里，但不再算进支出、日均、预算和年度报告。\n' +
      '之后想改回来，点开那一笔改类型即可。')) {
    return;
  }
  db.transactions = LedgerCore.markAsTransfer(db.transactions, ids);
  saveDB();
  suspectSelected = null;
  renderSuspects();
  renderList();
  renderSummary();
  renderCalendar();
  toast('已把 ' + ids.length + ' 笔标为不计收支');
}

/* ---------- 分类管理（增删改 / 归档） ----------
   增删改的纯函数都在 core（addCategory / updateCategory / removeCategory /
   archiveCategory），这里只管界面：列出、编辑、确认。
   内置的「转账」分类不给删也不给改类型（不计收支的账目要用它）。 */

var catEditId = null;

function renderCats() {
  var box = $('catsList');
  if (!box) { return; }
  var html = '';
  ['expense', 'income'].forEach(function (kind) {
    var list = (db.categories || []).filter(function (c) { return c.kind === kind; });
    if (!list.length) { return; }
    html += '<div class="block-title">' + (kind === 'income' ? '收入分类' : '支出分类') + '</div>';
    list.forEach(function (c) {
      var n = LedgerCore.countTxInCategory(db.transactions, c.id);
      html += '<div class="cat-row' + (c.archived ? ' is-archived' : '') + '">' +
        '<span class="cat-row-ico" style="--c:' + safeColor(c.color, '#9AA0A6') + '">' +
          esc(c.icon) + '</span>' +
        '<span class="cat-row-main">' +
          '<span class="cat-row-name">' + esc(c.name) + '</span>' +
          '<span class="cat-row-sub">' + (n ? n + ' 笔' : '还没用过') +
            (c.archived ? ' · 已归档' : '') + '</span>' +
        '</span>' +
        '<button class="btn-mini" type="button" data-catedit="' + esc(c.id) + '">改</button>' +
        '<button class="btn-mini" type="button" data-catarch="' + esc(c.id) + '">' +
          (c.archived ? '恢复' : '归档') + '</button>' +
        (n ? '' : '<button class="btn-mini is-danger" type="button" data-catdel="' + esc(c.id) + '">删</button>') +
        '</div>';
    });
  });
  /* 转账分类单独列出（它不属于支出也不属于收入） */
  var tr = (db.categories || []).filter(function (c) { return c.kind === 'transfer'; });
  if (tr.length) {
    html += '<div class="block-title">不计收支</div>';
    tr.forEach(function (c) {
      var n = LedgerCore.countTxInCategory(db.transactions, c.id);
      html += '<div class="cat-row">' +
        '<span class="cat-row-ico" style="--c:' + safeColor(c.color, '#9AA0A6') + '">' + esc(c.icon) + '</span>' +
        '<span class="cat-row-main"><span class="cat-row-name">' + esc(c.name) + '</span>' +
          '<span class="cat-row-sub">' + n + ' 笔 · 内置，不能删</span></span>' +
        '<button class="btn-mini" type="button" data-catedit="' + esc(c.id) + '">改</button>' +
        '</div>';
    });
  }
  box.innerHTML = html;

  /* 正在编辑的那条：把名字/图标填进下面的表单 */
  if (catEditId) {
    var cur = null;
    (db.categories || []).forEach(function (c) { if (c.id === catEditId) { cur = c; } });
    if (cur) {
      $('catName').value = cur.name;
      $('catIcon').value = cur.icon;
      setCatKind(cur.kind);
      $('btnCatAdd').textContent = '保存修改';
      return;
    }
    catEditId = null;
  }
  $('btnCatAdd').textContent = '添加分类';
}

var catKind = 'expense';
function setCatKind(kind) {
  catKind = kind === 'income' ? 'income' : 'expense';
  var btns = $('catKind').querySelectorAll('.seg-item');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-active', btns[i].getAttribute('data-kind') === catKind);
  }
  /* 转账分类不给从界面创建：它由「不计收支」类型自动使用 */
}

function openCats() {
  catEditId = null;
  $('catName').value = '';
  $('catIcon').value = '';
  setCatKind('expense');
  renderCats();
  openSheet(elSheetCats);
}

function saveCatForm() {
  var name = String($('catName').value || '').trim().slice(0, 12);
  var icon = String($('catIcon').value || '').trim();
  if (!name) { toast('先填分类名'); return; }
  if (catEditId) {
    db.categories = LedgerCore.updateCategory(db.categories, catEditId, { name: name, icon: icon || '📌' });
    saveDB();
    catEditId = null;
    toast('分类已更新');
  } else {
    var before = (db.categories || []).length;
    var next = LedgerCore.addCategory(db.categories, { name: name, icon: icon || '📌', kind: catKind });
    if (next.length === before) { toast('已经有同名分类了'); return; }
    db.categories = next;
    saveDB();
    toast('分类已添加');
  }
  $('catName').value = '';
  $('catIcon').value = '';
  renderCats();
  renderCategories();
  renderList();
  renderSummary();
}

/* ---------- 历史版本（data/backups） ----------
   服务端在每次保存前会留一份档。以前只能「导出」，想恢复得自己进文件夹
   改名；这里把 listBackups / restoreBackup 接到界面上。
   恢复只能在本机做（服务端会挡），因为它是「整本账换掉」这种级别的操作。 */

function fmtBackupTime(ms) {
  if (!ms) { return '时间不明'; }
  var d = new Date(ms);
  var today = todayStr();
  var day = ymd(d);
  var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (day === today) { return '今天 ' + hm; }
  if (day === ymd(new Date(Date.now() - 86400000))) { return '昨天 ' + hm; }
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + hm;
}

function renderHistory(data) {
  var box = $('historyList');
  if (!box) { return; }
  var list = (data && data.backups) || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding:20px 8px">还没有历史版本。<br>' +
      '电脑上每保存一次账本就会留一份，记几笔账再回来看。</div>';
    return;
  }
  var html = '';
  list.forEach(function (b, i) {
    var when = fmtBackupTime(b.at || b.mtime);
    var meta = b.broken
      ? '这个文件读不出来（可能是硬盘问题留下的残缺档）'
      : (b.count + ' 笔 · ' + (b.size ? (b.size / 1024).toFixed(0) + ' KB' : '') +
         (b.savedAt ? ' · 存档于 ' + esc(String(b.savedAt).slice(0, 19).replace('T', ' ')) : ''));
    html += '<div class="trash-item">' +
      '<span class="trash-main">' +
        '<span class="trash-line"><span>' + esc(when) + (i === 0 ? ' · 最近一次' : '') + '</span>' +
          '<b>' + (b.broken ? '—' : b.count + ' 笔') + '</b></span>' +
        '<span class="trash-sub">' + meta + '</span>' +
      '</span>' +
      (b.broken ? ''
        : '<button class="btn-mini" type="button" data-restore="' + esc(b.file) + '">恢复</button>') +
      '</div>';
  });
  box.innerHTML = html;
}

function openHistory() {
  if (mode !== 'server') {
    toast('历史版本存在电脑上，要先连上电脑的服务', 3500);
    return;
  }
  var box = $('historyList');
  if (box) { box.innerHTML = '<div class="empty" style="padding:20px 8px">正在读取…</div>'; }
  openSheet(elSheetHistory);
  api('GET', '/api/backups', null, function (err, status, text) {
    if (err || status !== 200) {
      if (box) {
        box.innerHTML = '<div class="notice is-warn">读不到历史版本：' +
          (status === 403 ? '这个操作只能在电脑上做' : '检查一下服务是不是还在运行') + '</div>';
      }
      return;
    }
    var data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    /* 服务器上那份留在服务端，恢复时还要用它刷新列表 */
    if (data) { historyData = data; }
    renderHistory(data);
  });
}

/* 恢复某个历史版本。会先把当前状态留档（服务端做的），所以可逆。 */
function restoreFromHistory(file) {
  var item = null;
  ((historyData && historyData.backups) || []).forEach(function (b) {
    if (b.file === file) { item = b; }
  });
  if (!window.confirm('要恢复到「' + fmtBackupTime(item && (item.at || item.mtime)) + '」那一刻的账本吗？\n\n' +
      '现在的账本会被换成那一份（' + (item ? item.count : '?') + ' 笔）。\n' +
      '恢复前程序会先把当前这份留档，所以万一恢复错了还能再退回来。')) {
    return;
  }
  api('POST', '/api/backups', JSON.stringify({ file: file }), function (err, status, text) {
    if (err) { toast('连不上服务，没有恢复', 3500); return; }
    var res = null;
    try { res = JSON.parse(text); } catch (e) { res = null; }
    if (status !== 200 || !res || !res.ok) {
      toast((res && res.error) || '恢复失败', 4000);
      return;
    }
    historyData = res;
    renderHistory(res);
    toast('已恢复到该版本（' + res.count + ' 笔），正在重新加载', 3500);
    /* 页面内存里的 db 还是旧的，整页重载最干净 */
    setTimeout(function () { location.reload(); }, 900);
  });
}

/* ---------- 导入规则（关键词 → 分类） ---------- */

function renderRules() {
  var box = $('rulesList');
  if (!box) { return; }
  var list = db.rules || [];
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding:16px 8px">' +
      '还没有自己的规则。<br>在流水里点开一笔导入的账、改个分类，这里就会自动多一条。</div>';
    return;
  }
  var html = '';
  list.forEach(function (r) {
    var c = categoryById(r.categoryId);
    html += '<div class="trash-item">' +
      '<span class="trash-main">' +
        '<span class="trash-line"><span>' + esc(r.keywords.join(' / ')) + '</span>' +
          '<b>' + esc(c.icon + ' ' + c.name) + '</b></span>' +
        '<span class="trash-sub">命中 ' + (r.hits || 0) + ' 次' +
          (r.updatedAt ? ' · ' + esc(ymd(new Date(r.updatedAt))) : '') + '</span>' +
      '</span>' +
      '<button class="btn-mini" type="button" data-delrule="' + esc(r.id) + '">删除</button>' +
      '</div>';
  });
  box.innerHTML = html;
}

function fillRuleCats() {
  var sel = $('ruleCat');
  if (!sel) { return; }
  var html = '';
  LedgerCore.activeCategories(db.categories).filter(function (c) { return c.kind !== 'transfer'; }).forEach(function (c) {
    html += '<option value="' + esc(c.id) + '">' + esc(c.icon + ' ' + c.name) +
            (c.kind === 'income' ? '（收入）' : '') + '</option>';
  });
  sel.innerHTML = html;
}

/* ---------- 周期记账 ---------- */

function applyDueRecurring() {
  if (!db.recur || !db.recur.length) { return; }
  var created = LedgerCore.applyRecurring(db.recur, db.transactions, todayStr(), Date.now());
  if (!created.length) { return; }
  created.forEach(function (t) { db.transactions.push(t); });
  saveDB();
  renderList();
  renderSummary();
  toast('周期记账帮你补了 ' + created.length + ' 笔（可在流水里改分类备注）');
}

var recurType = 'expense';

function renderRecur() {
  var list = db.recur || [];
  var box = $('recurList');
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding:16px 8px">还没有模板，下面加一个</div>';
    return;
  }
  var month = currentMonthKey();
  var today = Number(todayStr().slice(8, 10));
  var html = '';
  list.forEach(function (r) {
    var c = categoryById(r.categoryId);
    var tr = r.type === 'transfer';
    /* 这个月实际落在哪天 + 是否已经补过了（同月幂等键在不在） */
    var onDay = LedgerCore.recurDayInMonth(r.day, month);
    var done = false;
    for (var i = 0; i < db.transactions.length; i++) {
      if (db.transactions[i].recurId === 'recur:' + r.id + ':' + month) { done = true; break; }
    }
    var when = '每月 ' + r.day + ' 号';
    if (onDay !== Number(r.day)) { when += '（本月落在 ' + onDay + ' 号）'; }
    if (done) { when += ' · 本月已补记'; }
    else if (today >= onDay) { when += ' · 本月待补记'; }
    html += '<div class="trash-item">' +
      '<span class="trash-main">' +
        '<span class="trash-line">' + esc(tr ? '不计收支' : (c.icon + ' ' + c.name)) +
          '<b' + (tr ? ' class="is-faint"' : '') + '>' + (tr ? '' : (r.type === 'income' ? '+' : '-')) +
          fmtMoney(toCents(r.amount)) + '</b></span>' +
        '<span class="trash-sub">' + esc(when) + (r.note ? ' · ' + esc(r.note) : '') + '</span>' +
      '</span>' +
      '<button class="btn-mini" type="button" data-delrec="' + esc(r.id) + '">删除</button>' +
      '</div>';
  });
  box.innerHTML = html;
}

function fillRecurCats() {
  var sel = $('recurCat');
  var html = '';
  LedgerCore.activeCategories(db.categories, recurType).forEach(function (c) {
    html += '<option value="' + esc(c.id) + '">' + esc(c.icon + ' ' + c.name) + '</option>';
  });
  sel.innerHTML = html;
}

function addRecurTemplate() {
  var cents = parseAmountToCents($('recurAmount').value);
  if (!cents || cents <= 0) { toast('先填金额'); return; }
  var day = Math.round(Number($('recurDay').value));
  if (!(day >= 1 && day <= 31)) { toast('每月几号要填 1~31'); return; }
  db.recur = db.recur || [];
  db.recur.push({
    id: uid(),
    type: recurType,
    amount: cents / 100,
    categoryId: $('recurCat').value,
    note: $('recurNote').value.trim().slice(0, 40),
    day: day
  });
  saveDB();
  $('recurAmount').value = '';
  $('recurNote').value = '';
  $('recurDay').value = '';
  /* 新模板可能今天就该补记（比如 1 号加一个 1 号的房租） */
  applyDueRecurring();
  renderRecur();
  toast('模板已添加，到日子自动补记');
}

/* ============================================================
   本月统计
   ============================================================ */

/* ---------- 预算 ---------- */

function budgetOfMonth(key) {
  return (db.budgets && db.budgets[key]) || null;
}

function renderBudget() {
  var body = $('budgetBody');
  if (!body) { return; }
  /* 「本月」页现在能翻月：预算跟着正在看的那个月走 */
  var key = state.sumMonth || currentMonthKey();
  var b = budgetOfMonth(key);
  /* 预算与已花都走 core.budgetOf：它负责跨月结转（rollover），
     返回的单位是「元」，所以这里 ×100 变分再格式化 */
  var ctx = LedgerCore.budgetOf(db.transactions, db.budgets || {}, key);
  var isThisMonth = key === currentMonthKey();

  if (!b || (!b.total && !ctx.carried)) {
    body.innerHTML = '<div class="budget-none">' +
      (isThisMonth ? '还没设本月预算，点右上角「编辑」设一个'
                   : '这个月没设预算（预算按月设，要看本月请点标题回到本月）') + '</div>';
    return;
  }
  var totalCents = toCents(ctx.available);
  var spentCents = toCents(ctx.spent);
  var pct = totalCents > 0 ? Math.min(100, Math.round(spentCents / totalCents * 100)) : 0;
  var over = spentCents > totalCents;
  var leftCents = totalCents - spentCents;
  /* 按剩下几天算日均还能花多少；历史月份按整月天数算 */
  var now = new Date();
  var daysInMonth = LedgerCore.daysInMonth(key);
  var remainDays = isThisMonth ? Math.max(1, daysInMonth - now.getDate() + 1) : daysInMonth;
  var dailyLeft = Math.max(0, Math.floor(leftCents / remainDays / 100));

  var carryLine = '';
  if (ctx.rollover && ctx.carried) {
    carryLine = '<div class="budget-text' + (ctx.carried < 0 ? ' is-over' : '') + '">' +
      (ctx.carried > 0 ? '上月结余带过来 ' : '上月超支要扣掉 ') +
      fmtMoney(Math.abs(toCents(ctx.carried))) + '</div>';
  }

  body.innerHTML =
    '<div class="budget-bar"><i class="' + (over ? 'is-over' : '') + '" style="width:' + pct + '%"></i></div>' +
    '<div class="budget-text' + (over ? ' is-over' : '') + '">已用 ' + fmtMoney(spentCents) +
    ' / ' + fmtMoney(totalCents) + '（' + pct + '%）' +
    (over ? '，已超支 ' + fmtMoney(-leftCents)
          : '，还剩 ' + fmtMoney(leftCents) + '，日均可用约 ' + fmtMoney(dailyLeft * 100)) +
    '</div>' + carryLine;
}

function openBudgetSheet() {
  var key = state.sumMonth || currentMonthKey();
  var prev = LedgerCore.monthBefore(key);
  var b = budgetOfMonth(key) || budgetOfMonth(prev) || {};
  $('budgetTotal').value = b.total ? String(b.total) : '';
  var roll = $('budgetRollover');
  if (roll) { roll.checked = b.rollover === true; }
  /* 开了结转时，把「上个月结余带过来」的额度显示出来，用户才知道自己在调什么 */
  var hint = $('budgetRolloverHint');
  if (hint) { hint.textContent = ''; }
  var html = '';
  LedgerCore.activeCategories(db.categories, 'expense').forEach(function (c) {
    html += '<div class="budget-cat"><span>' + esc(c.icon + ' ' + c.name) + '</span>' +
      '<input type="text" class="input" inputmode="decimal" data-bcat="' + esc(c.id) + '"' +
      ' value="' + (b[c.id] ? esc(String(b[c.id])) : '') + '" placeholder="0" autocomplete="off"></div>';
  });
  $('budgetCats').innerHTML = html;
  updateRolloverHint();
  openSheet(elSheetBudget);
}

/* 勾了「结转上月结余」时，实时算出会带过来多少（用当前输入的值试算） */
function updateRolloverHint() {
  var hint = $('budgetRolloverHint');
  var roll = $('budgetRollover');
  if (!hint || !roll) { return; }
  if (!roll.checked) {
    hint.textContent = '不结转：每个月从零开始算。';
    hint.className = 'pin-edit-hint';
    return;
  }
  var key = state.sumMonth || currentMonthKey();
  var budgets = {};
  Object.keys(db.budgets || {}).forEach(function (k) { budgets[k] = db.budgets[k]; });
  /* 用界面上刚填的金额试算（还没保存也能看到效果） */
  var draft = {};
  Object.keys(budgets[key] || {}).forEach(function (k) { draft[k] = budgets[key][k]; });
  var total = parseAmountToCents($('budgetTotal').value);
  if (total > 0) { draft.total = total / 100; }
  var inputs = $('budgetCats').querySelectorAll('input[data-bcat]');
  for (var i = 0; i < inputs.length; i++) {
    var id = inputs[i].getAttribute('data-bcat');
    var cents = parseAmountToCents(inputs[i].value);
    if (cents > 0) { draft[id] = cents / 100; } else { delete draft[id]; }
  }
  draft.rollover = true;
  budgets[key] = draft;
  var ctx = LedgerCore.budgetOf(db.transactions, budgets, key);
  var prevCtx = LedgerCore.budgetOf(db.transactions, budgets, LedgerCore.monthBefore(key));
  hint.textContent = prevCtx.left >= 0
    ? ('会把上个月剩下的 ' + fmtMoney(toCents(prevCtx.left)) + ' 带进本月（本月可用 ' +
       fmtMoney(toCents(ctx.available)) + '）')
    : ('上个月超支了 ' + fmtMoney(toCents(-prevCtx.left)) + '，会从本月扣掉（本月可用 ' +
       fmtMoney(toCents(ctx.available)) + '）');
  hint.className = 'pin-edit-hint' + (prevCtx.left < 0 ? ' is-warn' : ' is-ok');
}

function saveBudgetSheet() {
  var key = state.sumMonth || currentMonthKey();
  var out = {};
  var total = parseAmountToCents($('budgetTotal').value);
  if (total > 0) { out.total = total / 100; }
  var inputs = $('budgetCats').querySelectorAll('input[data-bcat]');
  for (var i = 0; i < inputs.length; i++) {
    var cents = parseAmountToCents(inputs[i].value);
    if (cents > 0) { out[inputs[i].getAttribute('data-bcat')] = cents / 100; }
  }
  /* 「结转上月结余」开关：只留 true，不勾就不写这个字段（老账本干干净净） */
  var roll = $('budgetRollover');
  if (roll && roll.checked) { out.rollover = true; }
  if (Object.keys(out).length) { db.budgets[key] = out; }
  else { delete db.budgets[key]; }
  saveDB();
  closeSheets();
  renderSummary();
  toast('本月预算已保存');
}

/* ---------- 「本月」页翻月 ----------
   以前这一页写死看当月，2 月想看 1 月的汇总只能去流水里搜。现在标题两边
   能翻月：预算卡、6 个月趋势都跟着走；点标题回到本月。 */
function shiftSummaryMonth(n) {
  var base = state.sumMonth || currentMonthKey();
  var p = base.split('-');
  var y = Number(p[0]);
  var m = Number(p[1]) + n;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  state.sumMonth = y + '-' + pad2(m);
  closeSheets();          /* 翻月时把打开的面板收起来，免得改错月份 */
  renderSummary();
}

$('btnSumPrev').addEventListener('click', function () { shiftSummaryMonth(-1); });
$('btnSumNext').addEventListener('click', function () { shiftSummaryMonth(1); });
$('btnSumMonth').addEventListener('click', function () {
  if (state.sumMonth === currentMonthKey()) { return; }
  state.sumMonth = currentMonthKey();
  closeSheets();
  renderSummary();
});

/* ---------- 年度报告 ---------- */

function renderYearReport() {
  var year = Number($('yearSel').value) || new Date().getFullYear();
  var r = LedgerCore.yearReport(db.transactions, year);
  var html = '';

  html += '<div class="stat-grid">' +
    '<div class="stat"><b>' + fmtMoney(r.expenseCents) + '</b><span>年支出</span></div>' +
    '<div class="stat"><b>' + fmtMoney(r.incomeCents) + '</b><span>年收入</span></div>' +
    '<div class="stat"><b>' + fmtMoney(r.incomeCents - r.expenseCents) + '</b><span>结余</span></div>' +
    '</div>';

  if (r.transferCount) {
    html += '<div class="notice">这一年还有 <b>' + r.transferCount + '</b> 笔不计收支（转账 / 还款 ' +
      fmtMoney(r.transferCents) + '），没算进上面的年支出与年收入。</div>';
  }

  var max = Math.max.apply(null, r.byMonth.concat([1]));
  var bars = '', labels = '';
  for (var m = 0; m < 12; m++) {
    var v = r.byMonth[m];
    var h = v > 0 ? Math.max(4, Math.round(v / max * 78)) : 2;
    bars += '<div class="trend-col"><span class="trend-val">' + (v > 0 ? fmtShort(v) : '') + '</span>' +
      '<div class="trend-bar" style="height:' + h + 'px"></div></div>';
    labels += '<span>' + (m + 1) + '月</span>';
  }
  html += '<div class="trend"><div class="trend-bars">' + bars + '</div><div class="trend-label">' + labels + '</div></div>';

  if (r.maxTx) {
    var mc = categoryById(r.maxTx.categoryId);
    html += '<div class="notice"><b>最大单笔</b>　' + esc(r.maxTx.date) + '　' + esc(mc.icon + ' ' + mc.name) +
      '　' + fmtMoney(toCents(r.maxTx.amount)) +
      (r.maxTx.note ? '<br>' + esc(r.maxTx.note) : '') + '</div>';
  }

  if (r.topPeers.length) {
    html += '<div class="block-title">花得最多的对方</div>';
    var maxPeer = r.topPeers[0].cents || 1;
    r.topPeers.forEach(function (p) {
      var pct = Math.max(2, Math.round(p.cents / maxPeer * 100));
      html += '<div class="rank-item"><div class="rank-top">' +
        '<span class="rank-name">' + esc(p.name) + '</span>' +
        '<span class="rank-val"><b>' + fmtMoney(p.cents) + '</b></span></div>' +
        '<div class="rank-bar"><i style="width:' + pct + '%"></i></div></div>';
    });
  }

  var catRows = Object.keys(r.byCategory).map(function (id) {
    return { id: id, cents: r.byCategory[id] };
  }).sort(function (a, b) { return b.cents - a.cents; });
  if (catRows.length) {
    html += '<div class="block-title">分类排行</div>';
    var maxCat = catRows[0].cents || 1;
    catRows.forEach(function (row) {
      var c = categoryById(row.id);
      var pct = Math.max(2, Math.round(row.cents / maxCat * 100));
      html += '<div class="rank-item"><div class="rank-top">' +
        '<span class="rank-name">' + esc(c.icon + ' ' + c.name) + '</span>' +
        '<span class="rank-val"><b>' + fmtMoney(row.cents) + '</b></span></div>' +
        '<div class="rank-bar"><i style="width:' + pct + '%;background:' + safeColor(c.color, '#9AA0A6') + '"></i></div></div>';
    });
  }

  $('yearBody').innerHTML = html;
}

function openYearReport() {
  var years = {};
  years[String(new Date().getFullYear())] = true;
  db.transactions.forEach(function (t) {
    if (!t.deletedAt) { years[String(t.date).slice(0, 4)] = true; }
  });
  var list = Object.keys(years).sort().reverse();
  var sel = $('yearSel');
  sel.innerHTML = list.map(function (y) {
    return '<option value="' + esc(y) + '">' + esc(y) + ' 年</option>';
  }).join('');
  renderYearReport();
  openSheet(elSheetYear);
}

/* ---------- 数据体检 ---------- */

function healthRow(t) {
  var c = categoryById(t.categoryId);
  return '<div class="trash-item"><span class="trash-main">' +
    '<span class="trash-line"><span>' + esc(t.date) + '</span>' +
      '<b>' + fmtMoney(toCents(t.amount)) + '</b></span>' +
    '<span class="trash-sub">' + esc(c.icon + ' ' + c.name) +
      (t.note ? ' · ' + esc(t.note) : '') + '</span></span></div>';
}

function renderHealth() {
  var box = $('healthList');
  if (!box) { return; }
  var issues = LedgerCore.findDataIssues(db.transactions, db.categories, todayStr());
  var total = issues.duplicates.length + issues.future.length +
              issues.zero.length + issues.orphan.length;
  if (!total) {
    box.innerHTML = '<div class="notice is-ok">体检通过：没发现可疑的账目。</div>';
    return;
  }

  var html = '<div class="notice is-warn">发现 <b>' + total + '</b> 笔可疑账目。' +
    '程序不会自动改——在流水里点开对应的那笔确认处理即可。</div>';

  if (issues.duplicates.length) {
    html += '<div class="block-title">疑似重复 · 同一天同类型同金额</div>' +
      '<div class="notice">可能是重复记账，也可能真是两笔一样的消费，自己判断；' +
      '多的话可在流水里用金额筛选后批量处理。</div>';
    issues.duplicates.forEach(function (group) {
      html += '<div class="health-group">';
      group.forEach(function (t) { html += healthRow(t); });
      html += '</div>';
    });
  }
  if (issues.future.length) {
    html += '<div class="block-title">日期在今天之后</div>';
    issues.future.forEach(function (t) { html += healthRow(t); });
  }
  if (issues.zero.length) {
    html += '<div class="block-title">零金额</div>';
    issues.zero.forEach(function (t) { html += healthRow(t); });
  }
  if (issues.orphan.length) {
    html += '<div class="block-title">分类已失效（流水里会显示为未知）</div>' +
      '<div class="notice">多半是导入的账本带了别处的分类。可在「分类管理」里建一个同名分类，或在流水里改分类。</div>';
    issues.orphan.forEach(function (t) { html += healthRow(t); });
  }
  box.innerHTML = html;
}

function renderSummary() {
  var key = state.sumMonth || currentMonthKey();
  var month = LedgerCore.monthStats(db.transactions, key);
  var list = monthTx(key);
  var p = key.split('-');
  var m = Number(p[1]);

  /* 口径统一走 core.countStats / monthStats：不计收支的转账不进支出/收入 */
  var stat = month;
  var expenseList = LedgerCore.expenseTx(list);

  var isThisMonth = key === currentMonthKey();
  if ($('sumMonthText')) {
    $('sumMonthText').textContent = p[0] + ' 年 ' + m + ' 月' + (isThisMonth ? '（本月）' : '');
  }
  elHeroLabel.textContent = isThisMonth ? '\u672C\u6708\u652F\u51FA' : (m + ' \u6708\u652F\u51FA');
  elHeroAmount.textContent = fmtMoney(stat.expenseCents);
  elSumIncome.textContent = fmtMoney(stat.incomeCents);
  elSumBalance.textContent = fmtMoney(stat.incomeCents - stat.expenseCents);

  renderDelta(key);

  var daysElapsed = isThisMonth ? new Date().getDate() : LedgerCore.daysInMonth(key);
  var avgCents = daysElapsed > 0 ? Math.round(stat.expenseCents / daysElapsed) : 0;
  var maxCents = expenseList.reduce(function (mx, t) { return Math.max(mx, toCents(t.amount)); }, 0);

  elStatAvg.textContent = fmtMoney(avgCents);
  elStatMax.textContent = fmtMoney(maxCents);
  elStatCount.textContent = String(stat.count);

  /* 有这个月有转账时说明一句，免得用户对不上账单笔数 */
  var note = $('transferSummaryNote');
  if (note) {
    note.classList.toggle('is-hidden', !stat.transferCount);
    if (stat.transferCount) {
      note.textContent = '另有 ' + stat.transferCount + ' 笔不计收支（转账 / 还款 ' +
        fmtMoney(stat.transferCents) + '），没算进上面的支出和收入。';
    }
  }

  renderBudget();
  renderRank(expenseList, stat.expenseCents,
             LedgerCore.budgetOf(db.transactions, db.budgets || {}, key));
  renderTrend();
  renderSafeToSpend(key);
}

/* ---------- 环比：本月支出比上月多了还是少了 ----------
   刻意不做成图：一行「较上月 ↑12.4%（+¥357）」比任何图表都好读。
   颜色按语义来——支出涨是坏消息（红），降是好消息（绿）。 */
function renderDelta(key) {
  var box = $('sumDelta');
  if (!box) { return; }
  var cmp = LedgerCore.compareMonths(db.transactions, key);
  /* 上月一分钱都没记过 → 不显示环比，免得出现「↑∞%」这种鬼话 */
  if (!cmp.prevCents) {
    box.className = 'hero-delta is-hidden';
    box.textContent = '';
    return;
  }
  var arrow = cmp.direction === 'up' ? '↑' : (cmp.direction === 'down' ? '↓' : '→');
  var abs = fmtMoney(Math.abs(cmp.diffCents));
  var text;
  if (cmp.direction === 'same') {
    text = '和上月一样（' + fmtMoney(cmp.curCents) + '）';
  } else if (cmp.pct == null) {
    text = '较上月 ' + arrow + ' ' + abs;
  } else {
    text = '较上月 ' + arrow + ' ' + Math.abs(cmp.pct).toFixed(1) + '%（' +
      (cmp.direction === 'up' ? '+' : '-') + abs + '）';
  }
  box.textContent = text;
  /* 支出涨=不良（红），降=良好（绿） */
  box.className = 'hero-delta is-' + (cmp.direction === 'up' ? 'bad' : (cmp.direction === 'down' ? 'good' : 'same'));
  box.setAttribute('aria-label', text);
}

/* ---------- 今天还能花 ----------
   (本月预算可用额 − 本月已花) / 剩下几天（含今天）。
   调研与产品实践里，这一条信息的价值都高于任何图表。只在看本月、
   且设了预算时显示——历史月份的「今天还能花」没有意义。 */
function renderSafeToSpend(key) {
  var card = $('safeCard');
  if (!card) { return; }
  if (key !== currentMonthKey()) { card.classList.add('is-hidden'); return; }

  var ctx = LedgerCore.budgetOf(db.transactions, db.budgets || {}, key);
  if (!ctx.available) { card.classList.add('is-hidden'); return; }

  var now = new Date();
  var daysInMonth = LedgerCore.daysInMonth(key);
  var remainDays = Math.max(1, daysInMonth - now.getDate() + 1);
  var leftCents = toCents(ctx.left);
  var perDay = Math.floor(leftCents / remainDays / 100);

  card.classList.remove('is-hidden');
  var over = leftCents < 0;
  $('safeAmount').textContent = over ? ('已超支 ' + fmtMoney(-leftCents)) : fmtMoney(Math.max(0, perDay) * 100);
  $('safeHint').textContent = over
    ? ('本月可用 ' + fmtMoney(toCents(ctx.available)) + ' 已经用完，剩 ' +
       remainDays + ' 天要克制一下')
    : ('本月还剩 ' + fmtMoney(leftCents) + '，除以剩下 ' + remainDays + ' 天' +
       (ctx.carried ? '（含上月结余 ' + fmtMoney(toCents(ctx.carried)) + '）' : ''));
  card.className = 'safe-card' + (over ? ' is-over' : (perDay * 100 < 5000 ? ' is-tight' : ''));
}

function renderRank(expenseList, totalCents, budCtx) {
  if (!expenseList.length) {
    elRankList.classList.remove('is-in');
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
  /* 分类预算也走 core 的结转结果（budCtx.cats[id]），单位是元 */
  var catBud = (budCtx && budCtx.cats) || {};
  var html = '';
  rows.forEach(function (r) {
    var c = categoryById(r.id);
    var pct = Math.max(2, Math.round(r.cents / max * 100));
    var share = totalCents > 0 ? Math.round(r.cents / totalCents * 100) : 0;
    var budLine = '';
    var bc = catBud[r.id];
    if (bc && (bc.budget || bc.carried)) {
      var leftC = toCents(bc.left);
      budLine = '<div class="rank-budget' + (leftC < 0 ? ' is-over' : '') + '">预算 ' +
        fmtMoney(toCents(bc.available)) +
        (bc.carried ? '（含上月结余 ' + fmtMoney(toCents(bc.carried)) + '）' : '') +
        ' · ' + (leftC < 0 ? '已超支 ' + fmtMoney(-leftC) : '剩 ' + fmtMoney(leftC)) + '</div>';
    }
    html += '<div class="rank-item" data-jumpcat="' + esc(r.id) + '" role="button" tabindex="0" title="按「' + esc(c.name) + '」筛选流水">' +
      '<div class="rank-top">' +
        '<span class="rank-name">' + esc(c.icon) + ' ' + esc(c.name) + '</span>' +
        '<span class="rank-val"><b>' + fmtMoney(r.cents) + '</b> \u00B7 ' + share + '%</span>' +
      '</div>' +
      '<div class="rank-bar"><i style="width:' + pct + '%;background:' + safeColor(c.color, '#9AA0A6') + '"></i></div>' +
      budLine +
      '</div>';
  });
  elRankList.innerHTML = html;
  /* 条形「生长」入场：先归零（scaleX(0)），强制回流后再加 is-in 放行过渡。
     直接建好就加类的话，浏览器会把初始态和终态合并成一次绘制，动画就没了。 */
  elRankList.classList.remove('is-in');
  void elRankList.offsetWidth;
  elRankList.classList.add('is-in');
}

function renderTrend() {
  /* 窗口跟着正在看的月份走：看 3 月时，柱子是去年 10 月到今年 3 月，
     而不是永远「最近 6 个月」——否则看历史月份时图上的月份对不上。 */
  var key = state.sumMonth || currentMonthKey();
  var kp = key.split('-');
  var baseY = Number(kp[0]);
  var baseM = Number(kp[1]);
  var months = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(baseY, baseM - 1 - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth() + 1 });
  }

  var values = months.map(function (mo) {
    return sumCents(LedgerCore.expenseTx(monthTx(mo.y + '-' + pad2(mo.m))));
  });

  var max = Math.max.apply(null, values.concat([1]));
  var curKey = currentMonthKey();

  var bars = '';
  var labels = '';
  months.forEach(function (mo, idx) {
    var mKey = mo.y + '-' + pad2(mo.m);
    var v = values[idx];
    var h = v > 0 ? Math.max(4, Math.round(v / max * 78)) : 2;
    /* 正在看的月份和「真实的今天所在月」分别标出来 */
    var cls = mKey === key ? ' is-cur' : (mKey === curKey ? ' is-now' : '');
    bars += '<div class="trend-col">' +
      '<span class="trend-val">' + (v > 0 ? fmtShort(v) : '') + '</span>' +
      '<div class="trend-bar' + cls + '" style="height:' + h + 'px"></div>' +
      '</div>';
    labels += '<span>' + (mo.m === 1 ? mo.y + '年1月' : mo.m + '\u6708') + '</span>';
  });

  elTrendChart.innerHTML = '<div class="trend-bars">' + bars + '</div>' +
                           '<div class="trend-label">' + labels + '</div>';
  elTrendChart.classList.remove('is-in');
  void elTrendChart.offsetWidth;
  elTrendChart.classList.add('is-in');
}

/* ============================================================
   页面切换
   ============================================================ */

function go(page, keepScroll) {
  state.page = page;
  closeMonthPicker();
  try { localStorage.setItem('ledger.v1.page', page); } catch (e) { /* 隐私模式忽略 */ }
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
    transactions: db.transactions,
    /* 预算、周期模板、导入规则也是用户数据，备份要一起带上 */
    budgets: db.budgets || {},
    recur: db.recur || [],
    rules: db.rules || []
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

var normalizeImport = LedgerCore.normalizeImport;

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

  /* 预算与周期模板跟着合并（v0.8 起备份文件里才有）：
     预算——本机没有的月份才收，已有月份保持本机设置不动；
     周期模板——id 不重复才收。 */
  var budAdded = 0;
  db.budgets = db.budgets || {};
  Object.keys(parsed.budgets || {}).forEach(function (month) {
    if (!db.budgets[month]) { db.budgets[month] = parsed.budgets[month]; budAdded++; }
  });
  var recAdded = 0;
  db.recur = db.recur || [];
  var haveRec = {};
  db.recur.forEach(function (r) { haveRec[r.id] = true; });
  (parsed.recur || []).forEach(function (r) {
    if (!haveRec[r.id]) { db.recur.push(r); recAdded++; }
  });

  /* 导入规则也合并：本机没有的规则才收（已有的不覆盖，
     免得把你在本机调过的分类又按对方的偏好改回去） */
  var ruleAdded = 0;
  db.rules = db.rules || [];
  var haveRule = {};
  db.rules.forEach(function (r) { haveRule[r.id] = true; });
  (parsed.rules || []).forEach(function (r) {
    if (!haveRule[r.id]) { db.rules.push(r); ruleAdded++; }
  });

  saveDB();
  renderCategories();
  renderList();
  renderSummary();
  refreshBackupNotice();

  var extra = (budAdded ? '，预算 ' + budAdded + ' 个月' : '') +
              (recAdded ? '，周期模板 ' + recAdded + ' 个' : '') +
              (ruleAdded ? '，分类规则 ' + ruleAdded + ' 条' : '');
  if (added || updated || extra) {
    toast('合并完成：新增 ' + added + ' 笔' + (updated ? '，更新 ' + updated + ' 笔' : '') + extra);
  } else {
    toast('没有新内容，两边已经一样了');
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

var sheetCloseTimer = null;

/* ---------- 主题（跟随系统 / 浅色 / 深色） ----------
   选择存在 localStorage.theme，实际生效方式是给 <html> 挂 data-theme，
   深色令牌全部挂在 html[data-theme="dark"] 下（见 styles.css 末尾）。 */
var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function applyTheme(t) {
  try { localStorage.setItem('theme', t); } catch (e) { /* ignore */ }
  var dark = t === 'dark' || (t === 'auto' && mqDark && mqDark.matches);
  if (dark) { document.documentElement.setAttribute('data-theme', 'dark'); }
  else { document.documentElement.removeAttribute('data-theme'); }
  syncThemeSeg();
}

function syncThemeSeg() {
  if (!elThemeSeg) { return; }
  var cur = 'auto';
  try { cur = localStorage.getItem('theme') || 'auto'; } catch (e) { /* ignore */ }
  var items = elThemeSeg.querySelectorAll('.seg-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('is-active', items[i].getAttribute('data-theme') === cur);
  }
}

/* 系统深浅切换时，「跟随系统」要实时跟着变 */
if (mqDark && mqDark.addEventListener) {
  mqDark.addEventListener('change', function () {
    var t = 'auto';
    try { t = localStorage.getItem('theme') || 'auto'; } catch (e) { /* ignore */ }
    if (t === 'auto') { applyTheme('auto'); }
  });
}

/* 所有弹层（数据抽屉 + 各自面板）的唯一清单。
   加新面板只改这里：开关动画的撤销、closeSheets、遮罩/Esc 都跟着走。
   （教训：面板是逐个加出来的，closeSheets 的数组忘同步过一次——
   预算和年度报告面板点 ✕、点遮罩、按 Esc 全都关不掉，只能刷新页面。） */
function allSheets() {
  return [elSheetData, elSheetImport, elSheetBill, elSheetTrash,
          elSheetSuspects, elSheetCats, elSheetRules, elSheetHistory,
          elSheetHealth, elSheetRecur, elSheetBudget, elSheetYear]
    .filter(function (s) { return !!s; });
}

function openSheet(el) {
  /* 快速「关了又开」时：撤销收场动画，别让面板半路被藏起来 */
  if (sheetCloseTimer) {
    clearTimeout(sheetCloseTimer);
    sheetCloseTimer = null;
  }
  elMask.classList.remove('is-closing');
  allSheets().forEach(function (s) { s.classList.remove('is-closing'); });
  elMask.classList.remove('is-hidden');
  el.classList.remove('is-hidden');
  syncThemeSeg();
}

function closeSheets() {
  /* 退出动画：从哪进来就往哪出去（底部滑回），收完再真正隐藏。
     进场稍慢、退场更快（210ms < 240ms），重复触发直接忽略。 */
  if (sheetCloseTimer) { return; }
  var closing = [elMask].concat(allSheets()).filter(function (s) {
    return !s.classList.contains('is-hidden');
  });
  if (!closing.length) { return; }
  closing.forEach(function (s) { s.classList.add('is-closing'); });
  sheetCloseTimer = setTimeout(function () {
    closing.forEach(function (s) {
      s.classList.add('is-hidden');
      s.classList.remove('is-closing');
    });
    sheetCloseTimer = null;
  }, 210);
}

/* 子面板（导入账本 / 导入账单 / 回收站 / 周期记账）只收自己，回到数据管理
   抽屉。子面板是叠在数据抽屉上的，抽屉和遮罩根本没关过——把子面板收走就行。
   子面板的 × / 遮罩点击 / Esc / 导入成功后的自动收起都走这里；
   没有子面板开着时回落到 closeSheets（预算、年度报告是从「本月」页
   直接开的独立面板，不在这个清单里，走的就是这条回落路）。 */
function closeSubToData() {
  var subs = [elSheetImport, elSheetBill, elSheetTrash, elSheetRecur, elSheetHealth];
  var sub = null;
  for (var i = 0; i < subs.length; i++) {
    if (subs[i] && !subs[i].classList.contains('is-hidden')) { sub = subs[i]; break; }
  }
  if (!sub) { closeSheets(); return; }
  if (sheetCloseTimer) { return; }
  sub.classList.add('is-closing');
  sheetCloseTimer = setTimeout(function () {
    sub.classList.add('is-hidden');
    sub.classList.remove('is-closing');
    sheetCloseTimer = null;
  }, 210);
}

/* ============================================================
   导入微信 / 支付宝账单
   ------------------------------------------------------------
   解析引擎（CSV/xlsx 解压、表头识别、金额与时间提取、按词库猜
   分类）全部在 assets/core.js（LedgerCore），可以用 node --test
   直接测试；这里只负责界面：文件读入、结果预览、确认入库。
   词表在 assets/分类词库.js（window.MY_RULES），编译规则见 core.js。
   ============================================================ */

/* 词表 → 可匹配的规则。词库文件缺失或写坏时退回内置的简易规则，
   保证页面照常能开。 */
var __ruleRes = null;
try { __ruleRes = LedgerCore.compileRules(window.MY_RULES); } catch (e) { __ruleRes = null; }

var BILL_RULES = (__ruleRes && __ruleRes.list.length) ? __ruleRes.list : LedgerCore.fallbackRules();
window.__RULE_INFO__ = __ruleRes
  ? __ruleRes.info
  : { total: 0, missing: [], loaded: 0 };

/* 词库的加载情况，给界面提示用。
   正常时 quiet=true（不打扰）；缺分类或退回兜底时 quiet=false，
   由 showRuleNotice() 在界面上说一句。 */
var RULE_NOTICE = (function () {
  var info = window.__RULE_INFO__ || { total: 0, missing: [], loaded: 0 };
  if (!info.loaded) {
    return { level: 'error', text: '没读到「分类词库.js」，已用内置的简易规则顶上。' +
      '导入账单的分类可能不准，请检查 assets/分类词库.js 还在不在。' };
  }
  if (info.total === 0) {
    return { level: 'error', text: '「分类词库.js」里没读到任何词，已用内置的简易规则顶上，请检查文件内容。' };
  }
  if (info.missing.length) {
    return { level: 'warn', text: '「分类词库.js」里这几组是空的：' + info.missing.join('、') +
      '，碰到相关账单会归到「其他」。空着没问题，不加词就行。' };
  }
  return { quiet: true, text: '' };
})();

function guessCategory(text, type) {
  var rule = LedgerCore.matchRule(db.rules || [], text);
  if (rule) { return rule; }
  return LedgerCore.guessCategory(BILL_RULES, text, type);
}

function decodeBillBytes(buf) { return LedgerCore.decodeBillBytes(buf); }
function parseBillText(text) { return LedgerCore.parseBillText(text, BILL_RULES, db.rules || []); }
function parseBillXlsx(buf) { return LedgerCore.parseBillXlsx(buf, BILL_RULES, db.rules || []); }

/* 待用户确认的导入结果 */
var billPending = null;
/* 本次导入里各条用户规则挑中了多少笔（导入确认后写回规则的命中计数） */
var billRuleHits = null;

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
  /* 统计这次导入里每条用户规则挑中了多少笔（导入确认后写回 hits） */
  var ruleHits = {};
  res.rows.forEach(function (t) {
    if (have[t.id]) { dup++; return; }
    fresh.push(t);
    var hit = LedgerCore.matchRuleEntry(db.rules || [], t.note || '');
    if (hit) { ruleHits[hit.id] = (ruleHits[hit.id] || 0) + 1; }
  });
  billRuleHits = ruleHits;
  /* 合计口径：只算支出与收入；转账类的账目单独提示（见下面 transferHint） */
  var freshStat = LedgerCore.countStats(fresh);
  var expCents = freshStat.expenseCents;
  var incCents = freshStat.incomeCents;

  billPending = fresh;

  var label = res.kind === 'wx' ? '微信支付账单' : '支付宝账单';
  var html = '<div class="notice' + (fresh.length ? ' is-ok' : '') + '">' +
    '认出来了：<b>' + label + '</b>，共 ' + res.rows.length + ' 笔可用记录。<br>' +
    '其中 <b>' + fresh.length + '</b> 笔是要新增的' +
    (dup ? '，<b>' + dup + '</b> 笔已经记过、会跳过' : '') + '。<br>' +
    '新增的合计：支出 <b>' + fmtMoney(expCents) + '</b>　收入 <b>' + fmtMoney(incCents) + '</b>' +
    '<br><span class="is-faint">账单里已经跳过转账/理财这类不计收支的记录；' +
    '如果还有该跳过的（比如信用卡还款、朋友间转账被记成了支出），导完在流水里点开改成「不计收支」。</span>' +
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
      var tr = t.type === 'transfer';
      html += '<div class="bill-row">' +
        '<span>' + esc(t.date.slice(5)) + ' ' + esc(c.icon + ' ' + c.name) + '</span>' +
        '<span class="bill-note">' + esc(t.note || '（无说明）') + '</span>' +
        '<b class="' + (tr ? 'is-faint' : (t.type === 'income' ? 'is-income' : 'is-expense')) + '">' +
        (tr ? '' : (t.type === 'income' ? '+' : '-')) + fmtMoney(toCents(t.amount)) + '</b></div>';
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
  /* 哪条规则挑中了多少笔，记到规则的「命中 N 次」里 */
  if (billRuleHits && Object.keys(billRuleHits).length) {
    db.rules = LedgerCore.bumpRuleHits(db.rules || [], billRuleHits);
  }
  billRuleHits = null;
  billPending = null;
  saveDB();
  renderCategories();
  renderList();
  renderSummary();
  refreshBackupNotice();
  elBtnBillOk.classList.add('is-hidden');
  showBillResult('<div class="notice is-ok">已导入 ' + n + ' 笔' +
    (mode === 'server' ? '（正在同步到电脑，右上角角标会显示同步结果）' : '') +
    '。到「流水」页就能看到，分类不对的点开改一下就行。</div>');
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
  /* 允许算式：数字、一个小数点、+ - * / 与全角 × ÷。
     其余字符直接滤掉（包括中文、字母），免得算出看不懂的东西。
     ——金额框是 type=text，不是 type=number：number 会让滚轮误改值、
     允许 e/+/-、还拿不到用户输入的原始串（1.10 会变成 1.1）。 */
  var v = String(this.value || '')
    .replace(/[＋]/g, '+').replace(/[－—–−]/g, '-')
    .replace(/[×✕✖]/g, '*').replace(/[÷／]/g, '/')
    .replace(/[^\d.+*/-]/g, '');
  if (v.length > 40) { v = v.slice(0, 40); }
  this.value = v;
  renderAmountHint();
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

/* 点月份标题 → 展开年月选择器；再点一下收起来 */
elMonthLabel.addEventListener('click', function (e) {
  e.stopPropagation();                 /* 别冒泡到「点别处关闭」那条 */
  if (!elMonthPicker.classList.contains('is-open')) { openMonthPicker(); }
  else { closeMonthPicker(); }
});

elMonthPicker.addEventListener('click', function (e) { e.stopPropagation(); });

/* 年份下拉：选哪年就翻到哪年 */
elMpYearSel.addEventListener('change', function () {
  mpYear = Number(elMpYearSel.value);
  renderMonthPicker();
});

elMpGrid.addEventListener('click', function (e) {
  var cell = e.target.closest('.mp-cell');
  if (!cell) { return; }
  pickMonth(cell.getAttribute('data-ym'));
});

$('mpToday').addEventListener('click', function () { pickMonth(currentMonthKey()); });

/* 点页面别处、按 Esc 都关掉选择器（点它自己和点标题时已经在上面拦住了） */
document.addEventListener('click', function () { closeMonthPicker(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeMonthPicker(); }
});

elFilterChips.addEventListener('click', function (e) {
  var chip = e.target.closest('.chip');
  if (!chip) { return; }
  state.listFilter = chip.getAttribute('data-filter');
  state.showAll = false;
  var chips = elFilterChips.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('is-active', chips[i] === chip);
  }
  renderList();
});

/* 分类筛选 chips：**多选**。点一颗加进去（再点一下拿掉），
   点「全部分类」清空。每次点完重画 chips，选中态与 state 始终一致。 */
if (elCategoryChips) {
  elCategoryChips.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) { return; }
    var id = chip.getAttribute('data-cat');
    state.listCategories = (id === 'all')
      ? []
      : LedgerCore.toggleCategoryFilter(state.listCategories, id, db.categories);
    state.showAll = false;
    renderList();
  });
}

if (elBtnClearFilters) {
  elBtnClearFilters.addEventListener('click', clearListFilters);
}

/* 日历热力图：展开/收起，点某一天就在列表里定位那天 */
if ($('btnCalendar')) {
  $('btnCalendar').addEventListener('click', function () { toggleCalendar(); });
}

/* 批量删除 */
if ($('btnBatch')) {
  $('btnBatch').addEventListener('click', function () { toggleBatch(); });
}
if ($('btnBatchAll')) {
  $('btnBatchAll').addEventListener('click', function () {
    var ids = batchFilteredIds();
    var allOn = ids.length > 0 && ids.every(function (id) { return state.batchSel[id]; });
    state.batchSel = {};
    if (!allOn) {
      ids.forEach(function (id) { state.batchSel[id] = true; });
    }
    state.keepPaging = true;   /* 全选别把已经画出来的页数跳回第一页 */
    renderList();
    toast(allOn ? '已取消全选' : '已全选 ' + ids.length + ' 笔（按当前筛选）');
  });
}
if ($('btnBatchDelete')) { $('btnBatchDelete').addEventListener('click', batchDeleteSelected); }
if ($('btnBatchExit')) { $('btnBatchExit').addEventListener('click', function () { toggleBatch(false); }); }

if ($('calGrid')) {
  $('calGrid').addEventListener('click', function (e) {
    var cell = e.target.closest('.cal-cell');
    if (!cell) { return; }
    var day = cell.getAttribute('data-day');
    if (!day) { return; }
    jumpToDay(day);
  });
}

/* 来源筛选 chips。页面上没有这个元素时（浏览器缓存了旧版 index.html）跳过，
   别让后面的绑定全崩 */
if (elSourceChips) {
  elSourceChips.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) { return; }
    state.listSource = chip.getAttribute('data-src');
    state.showAll = false;
    var chips = elSourceChips.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('is-active', chips[i] === chip);
    }
    renderList();
  });
}

/* 流水搜索：回车生效；翻月/选月会清掉搜索回到按月浏览 */
$('searchInput').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') { return; }
  state.search = this.value.trim();
  state.showAll = false;
  renderList();
  this.blur();
});

/* 金额 / 日期范围：金额输完即筛，日期选中即筛 */
['amountMin', 'amountMax'].forEach(function (id) {
  var el = $(id);
  if (!el) { return; }
  el.addEventListener('input', function () { state.showAll = false; renderList(); });
  el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { el.blur(); } });
});
['dateFrom', 'dateTo'].forEach(function (id) {
  var el = $(id);
  if (!el) { return; }
  el.addEventListener('change', function () { state.showAll = false; renderList(); });
});

function clearListSearch() {
  state.search = '';
  state.showAll = false;
  var input = $('searchInput');
  if (input) { input.value = ''; }
}

if (elSourceSwitch) {
  elSourceSwitch.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-item');
    if (!btn) { return; }
    setSource(btn.getAttribute('data-src'));
  });
}

elTxList.addEventListener('click', function (e) {
  /* 「显示全部」按钮：一次把剩下的一次画完（不追加，直接画） */
  if (e.target.closest('.list-more')) {
    state.showAll = true;
    renderList();
    return;
  }
  /* 空列表里的「清除筛选，看全部」 */
  if (e.target.closest('.empty-reset')) {
    clearListFilters();
    return;
  }
  /* 批量删除模式：点行 = 勾选/取消勾选，不进编辑。
     刚结束的「按住拖动连选」也会产生一次 click——不能让它把
     第一笔的状态又翻回去。 */
  if (state.batchMode) {
    if (batchDrag.suppressClick) { batchDrag.suppressClick = false; return; }
    var row = e.target.closest('.tx-item');
    if (row) {
      var rid = row.getAttribute('data-tx');
      if (rid) {
        if (state.batchSel[rid]) { delete state.batchSel[rid]; } else { state.batchSel[rid] = true; }
        row.classList.toggle('is-selected', !!state.batchSel[rid]);
        renderBatchBar();
      }
    }
    return;
  }
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

$('btnTrash').addEventListener('click', function () {
  renderTrash();
  openSheet(elSheetTrash);
});

/* 数据体检 */
$('btnHealth').addEventListener('click', function () {
  renderHealth();
  openSheet(elSheetHealth);
});
$('btnCloseHealth').addEventListener('click', closeSubToData);

/* 分类排行 → 跳到按该分类筛选的流水 */
elRankList.addEventListener('click', function (e) {
  var item = e.target.closest('[data-jumpcat]');
  if (!item) { return; }
  jumpToCategory(item.getAttribute('data-jumpcat'));
});

function jumpToCategory(catId) {
  var key = state.sumMonth || currentMonthKey();
  state.listMonth = key;
  state.listFilter = 'all';
  state.listSource = 'all';
  state.listCategories = [catId];
  state.search = '';
  state.showAll = false;
  state.listLimit = 0;
  clearRangeInputs();
  syncFilterChips();
  syncSourceChips();
  if ($('searchInput')) { $('searchInput').value = ''; }
  go('list');
  renderList();
  toast('已按「' + categoryById(catId).name + '」筛选' +
    (key === currentMonthKey() ? '' : '（' + key + '）'));
}

/* 周期记账 */
$('btnSuspects').addEventListener('click', openSuspects);
$('btnCloseSuspects').addEventListener('click', closeSubToData);
$('suspectsList').addEventListener('change', function (e) {
  var cb = e.target.closest('[data-suspect]');
  if (!cb || !suspectSelected) { return; }
  suspectSelected[cb.getAttribute('data-suspect')] = cb.checked;
});
$('btnSuspectsAll').addEventListener('click', function () {
  var list = LedgerCore.findTransferSuspects(db.transactions);
  var allOn = list.every(function (t) { return suspectSelected && suspectSelected[t.id]; });
  suspectSelected = {};
  list.forEach(function (t) { suspectSelected[t.id] = !allOn; });
  renderSuspects();
  this.textContent = allOn ? '全选' : '全不选';
});
$('btnSuspectsMark').addEventListener('click', markSelectedSuspects);

$('btnCats').addEventListener('click', openCats);
$('btnCloseCats').addEventListener('click', closeSubToData);
$('btnCatAdd').addEventListener('click', saveCatForm);
$('catKind').addEventListener('click', function (e) {
  var btn = e.target.closest('.seg-item');
  if (!btn) { return; }
  setCatKind(btn.getAttribute('data-kind'));
});
$('catsList').addEventListener('click', function (e) {
  var editBtn = e.target.closest('[data-catedit]');
  if (editBtn) {
    catEditId = editBtn.getAttribute('data-catedit');
    renderCats();
    $('catName').focus();
    return;
  }
  var archBtn = e.target.closest('[data-catarch]');
  if (archBtn) {
    var aid = archBtn.getAttribute('data-catarch');
    var willArchive = archBtn.textContent === '归档';
    db.categories = LedgerCore.archiveCategory(db.categories, aid, willArchive);
    saveDB();
    renderCats();
    renderCategories();
    renderList();
    renderSummary();
    toast(willArchive ? '已归档：不再出现在记一笔里，历史账目照旧' : '已恢复到记一笔里');
    return;
  }
  var delBtn = e.target.closest('[data-catdel]');
  if (delBtn) {
    var did = delBtn.getAttribute('data-catdel');
    var n = LedgerCore.countTxInCategory(db.transactions, did);
    /* 还有账目时不给删（按钮也不显示），这里是二次兜底 */
    if (n) { toast('这个分类下还有 ' + n + ' 笔账，建议「归档」而不是删除'); return; }
    if (!window.confirm('删除这个分类？它下面没有账目，删了就没了。')) { return; }
    db.categories = LedgerCore.removeCategory(db.categories, did);
    if (catEditId === did) { catEditId = null; }
    saveDB();
    renderCats();
    renderCategories();
    renderList();
    renderSummary();
    toast('分类已删除');
  }
});

$('btnHistory').addEventListener('click', openHistory);
$('btnCloseHistory').addEventListener('click', closeSubToData);
$('historyList').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-restore]');
  if (!btn) { return; }
  restoreFromHistory(btn.getAttribute('data-restore'));
});

$('btnRules').addEventListener('click', function () {
  renderRules();
  fillRuleCats();
  openSheet(elSheetRules);
});
$('btnCloseRules').addEventListener('click', closeSubToData);
$('btnRuleAdd').addEventListener('click', function () {
  var kw = String($('ruleKeyword').value || '').trim().slice(0, 24);
  var cat = $('ruleCat').value;
  if (!kw) { toast('先填一个关键词'); return; }
  if (!cat) { toast('先选一个分类'); return; }
  db.rules = LedgerCore.learnRule(db.rules || [], kw, cat, Date.now());
  saveDB();
  $('ruleKeyword').value = '';
  renderRules();
  toast('规则已添加：包含「' + kw + '」的账目归到 ' + categoryById(cat).name);
});
$('rulesList').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-delrule]');
  if (!btn) { return; }
  var id = btn.getAttribute('data-delrule');
  db.rules = (db.rules || []).filter(function (r) { return r.id !== id; });
  saveDB();
  renderRules();
  toast('规则已删除');
});
$('btnRecur').addEventListener('click', function () {
  renderRecur();
  fillRecurCats();
  openSheet(elSheetRecur);
});
$('btnCloseRecur').addEventListener('click', closeSubToData);
$('recurType').addEventListener('click', function (e) {
  var btn = e.target.closest('.seg-item');
  if (!btn) { return; }
  recurType = btn.getAttribute('data-type');
  var btns = $('recurType').querySelectorAll('.seg-item');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('is-active', btns[i] === btn);
  }
  fillRecurCats();
});
$('btnRecurAdd').addEventListener('click', addRecurTemplate);
$('recurList').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-delrec]');
  if (!btn) { return; }
  var id = btn.getAttribute('data-delrec');
  if (!window.confirm('删除这个周期模板？已经补记的账不受影响')) { return; }
  db.recur = (db.recur || []).filter(function (r) { return r.id !== id; });
  saveDB();
  renderRecur();
  toast('模板已删除');
});

$('btnCloseTrash').addEventListener('click', closeSubToData);

$('trashList').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-restore]');
  if (!btn) { return; }
  var tx = findTxById(btn.getAttribute('data-restore'));
  if (!tx || !tx.deletedAt) { return; }
  delete tx.deletedAt;
  tx.updatedAt = Date.now();
  saveDB();
  renderTrash();
  renderList();
  renderSummary();
  toast('已恢复');
});

$('btnEmptyTrash').addEventListener('click', function () {
  var n = deletedTxs().length;
  if (!n) { return; }
  if (!window.confirm('彻底删掉回收站里的 ' + n + ' 条？无法恢复')) { return; }
  db.transactions = db.transactions.filter(function (t) { return !t.deletedAt; });
  saveDB();
  renderTrash();
  renderList();
  renderSummary();
  toast('回收站已清空');
});

/* 编辑预算 */
$('btnBudgetEdit').addEventListener('click', openBudgetSheet);
$('btnCloseBudget').addEventListener('click', closeSheets);
$('btnBudgetSave').addEventListener('click', saveBudgetSheet);
/* 勾/取消「结转上月结余」，以及改金额时，实时更新那句试算提示 */
if ($('budgetRollover')) {
  $('budgetRollover').addEventListener('change', updateRolloverHint);
  $('budgetTotal').addEventListener('input', updateRolloverHint);
  $('budgetCats').addEventListener('input', updateRolloverHint);
}

/* 年度报告 */
$('btnYearReport').addEventListener('click', openYearReport);
$('btnCloseYear').addEventListener('click', closeSheets);
$('yearSel').addEventListener('change', renderYearReport);
$('btnBudgetCopy').addEventListener('click', function () {
  /* 「用上个月的」= 正在看的那个月的上一个月（本月页能翻月了） */
  var key = state.sumMonth || currentMonthKey();
  var prev = LedgerCore.monthBefore(key);
  var b = budgetOfMonth(prev);
  if (!b) { toast('上个月没设过预算'); return; }
  $('budgetTotal').value = b.total ? String(b.total) : '';
  var inputs = $('budgetCats').querySelectorAll('input[data-bcat]');
  for (var i = 0; i < inputs.length; i++) {
    var v = b[inputs[i].getAttribute('data-bcat')];
    inputs[i].value = v ? String(v) : '';
  }
  toast('已填入上个月的预算，改完点保存');
});

$('btnCloseSheet').addEventListener('click', closeSheets);
$('btnCloseImport').addEventListener('click', closeSubToData);
elMask.addEventListener('click', closeSubToData);

/* 外观三段开关：跟随系统 / 浅色 / 深色
   （万一页面上没有这个元素——比如浏览器缓存了旧版 index.html——跳过，别让后面的绑定全崩） */
if (elThemeSeg) {
  elThemeSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-item');
    if (!btn) { return; }
    applyTheme(btn.getAttribute('data-theme'));
  });
}

$('btnExport').addEventListener('click', downloadBackup);
$('btnExportText').addEventListener('click', copyBackupText);

/* 导出流水 CSV（Excel 友好；软删除的不导） */
$('btnExportCsv').addEventListener('click', function () {
  var csv = LedgerCore.txsToCsv(db.transactions, function (id) {
    return categoryById(id).name;
  });
  if (csv.split('\n').length < 2) {
    toast('还没有账目，不用导出');
    return;
  }
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = '记账本流水-' + todayStr() + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  toast('CSV 已导出');
});

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

$('btnCloseBill').addEventListener('click', closeSubToData);
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
    if (mergeImport(String(reader.result))) { closeSubToData(); }
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
    closeSubToData();
  }
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeSubToData(); }
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
    /* 空体即可：api() 会对写请求统一带 JSON 头并补 '{}'（见其注释） */
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
  /* 账本主存是 IndexedDB；localStorage 只是迁移源与（IDB 不可用时的）兜底，
     所以「能不能存」优先看 IDB */
  storageOK = ('indexedDB' in window) || storageAvailable();
  /* 先垫一个空账本，否则 setType 里的分类渲染会碰到 null */
  db = freshDB();
  state.listMonth = currentMonthKey();
  state.sumMonth = currentMonthKey();

  elDate.value = todayStr();
  markQuickDate(0);
  setType('expense');
  restoreLastPage();

  detectStorage(function () {
    setType(state.type);
    renderList();
    renderSummary();
    refreshBackupNotice();

    if (!storageOK && mode === 'local') {
      toast('浏览器禁用了本地存储，记的账无法保存', 6000);
    }
    showRuleNotice();
    if (window.matchMedia && window.matchMedia('(min-width: 720px)').matches) {
      elAmount.focus();
    }
  });
}

/* 记住上次在哪个标签页（记一笔 / 流水 / 本月）。
   背景：浏览器恢复上次会话或刷新时会保留滚动位置和 <input> 里已输入的
   内容，但页面内的标签状态只在内存里——结果常常是页面停在中间、可内容
   却是第一页，看起来像卡住了。存一个字符串在 localStorage 里最省事。 */
function restoreLastPage() {
  var page = null;
  try { page = localStorage.getItem('ledger.v1.page'); } catch (e) { page = null; }
  /* 认不出来（第一次打开、存的值坏了）就停在「记一笔」 */
  if (page !== 'record' && page !== 'list' && page !== 'summary') { return; }
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].getAttribute('data-page') === page) { go(page); return; }
  }
}

/* 词库出问题时说一句（正常情况下什么都不做）。
   只提示，不拦路——词库坏了照样能记账。 */
function showRuleNotice() {
  if (!RULE_NOTICE || RULE_NOTICE.quiet) { return; }
  toast(RULE_NOTICE.text, 7000);
}

/* 先试着连电脑上的本地服务，连不上就退回浏览器存储。
   本地模式的账本要从 IndexedDB 读（异步），所以两个分支都等
   startLocalMode 读完再回调 cb——调用方拿到的是「已就绪」的界面。 */
function detectStorage(cb) {
  if (location.protocol === 'file:') {
    startLocalMode(cb);
    return;
  }
  api('GET', '/api/db', null, function (err, status, text) {
    if (!err && status === 401) {
      /* 服务在但这台设备没通过口令验证：先进本地模式把界面撑起来，
         弹口令输入层，验证成功后刷新重走探测 */
      startLocalMode(function () {
        cb();
        showPinGate(null);
      });
      return;
    }
    if (!err && status === 200) {
      try {
        var res = JSON.parse(text);
        mode = 'server';
        serverRev = Number(res.rev) || 0;
        db = sanitizeDB(res.data);
        setSyncState('saved');
        purgeOldDeleted();
        applyDueRecurring();
        loadServerInfo();
        offerLegacyImport();
        cb();
        return;
      } catch (e) { /* 解析失败，落到本地模式 */ }
    }
    startLocalMode(cb);
  });
}

function startLocalMode(cb) {
  mode = 'local';
  db = freshDB();

  /* 角标走 setSyncState 统一出口：mode 已是 local，显示红色「浏览器存储」 */
  setSyncState('local');

  var box = $('storageBox');
  if (box) {
    box.className = 'notice';
    box.innerHTML = '当前数据存在<b>这个浏览器</b>里，没有连上电脑上的记账本服务。' +
      '清理浏览器数据会丢失，记得定期导出备份。';
  }

  loadLocalDBAsync(function (loaded) {
    db = loaded;
    purgeOldDeleted();
    applyDueRecurring();
    if (cb) { cb(); }
  });
}

function loadServerInfo() {
  api('GET', '/api/info', null, function (err, status, text) {
    if (err || status !== 200) { return; }
    try { serverInfo = JSON.parse(text); } catch (e) { return; }
    renderStorageBox();
    renderMobileBox();
    renderLanRow();
  });
}

function renderStorageBox() {
  var box = $('storageBox');
  if (!box || mode !== 'server' || !serverInfo) { return; }
  box.className = 'notice is-ok';
  box.innerHTML = '数据存在电脑上的这个文件里：<br><code>' + esc(serverInfo.dataFile) + '</code>' +
    '<br>每次保存都会在 <code>' + esc(serverInfo.backupDir) + '</code> 留一份历史版本。' +
    (serverInfo.lanEnabled ? '' :
      '<br>当前仅本机可访问。手机要连的话，打开下面的「允许手机访问」。');
}

function renderMobileBox() {
  var wrap = $('mobileBox');
  if (!wrap || mode !== 'server' || !serverInfo) { return; }
  /* 局域网访问关着时不显示地址（服务端此时也不会给地址） */
  if (serverInfo.lanEnabled === false) { wrap.classList.add('is-hidden'); return; }
  var addrs = serverInfo.addresses || [];
  if (!addrs.length) { wrap.classList.add('is-hidden'); return; }
  var url = 'http://' + addrs[0].address + ':' + serverInfo.port + '/';
  wrap.classList.remove('is-hidden');
  $('mobileUrl').textContent = url;
  $('btnCopyUrl').setAttribute('data-url', url);
}

/* ---------- 局域网访问开关 ---------- */

/* 局域网开关只在本机显示。
   手机上显示这个开关等于给自己递刀：关掉它，这台手机立刻连不上；
   服务端本来就会拒非本机来源（/api/lan 返回 403），这里直接把入口藏掉，
   让「能不能动这台电脑的设置」在界面上也一眼看得出来。 */
function renderLanRow() {
  if (!elLanRow || !elLanSwitch) { return; }
  var isLocal = mode === 'server' && serverInfo && serverInfo.local === true;
  if (!isLocal) {
    elLanRow.classList.add('is-hidden');
    renderPinLine();
    return;
  }
  elLanRow.classList.remove('is-hidden');
  var on = !!serverInfo.lanEnabled;
  elLanSwitch.classList.toggle('is-on', on);
  elLanSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
  renderPinLine();
}

/* 口令提示行 + 修改口令面板。
   两处都只在本机显示：
   - /api/info 只对回环地址回 pin（手机上拿到的是 null），没口令就没得显示
   - serverInfo.local 由服务端按来源地址判断，手机端即使伪造也改不了，
     改口令接口自己也会再挡一次（非本机一律 403） */
function renderPinLine() {
  var line = $('pinLine');
  var box = $('pinEditBox');
  if (!line) { return; }
  var isServer = mode === 'server' && !!serverInfo;
  var isLocal = isServer && serverInfo.local === true;
  var hasPin = isServer && !!serverInfo.pin;

  line.classList.toggle('is-hidden', !(hasPin && isLocal));
  if (hasPin && isLocal) { $('pinValue').textContent = serverInfo.pin; }

  if (!box) { return; }
  box.classList.toggle('is-hidden', !isLocal);
  if (!isLocal) { return; }
  if ($('pinEditTitle')) {
    $('pinEditTitle').textContent = hasPin ? '修改访问口令' : '设置访问口令';
  }
}

/* 改口令：本机直接填新口令就生效（用户定的取舍——电脑前坐的就是主人，
   不加「先答对旧口令」「再确认一遍」的摩擦）。换完，别的设备上的
   旧凭据自动失效，需要重新输一次新口令。 */
function savePinChange() {
  if (mode !== 'server' || !serverInfo) { toast('现在没有连上电脑上的服务'); return; }
  var newPin = (($('pinNewInput') || {}).value || '').trim();
  var hint = $('pinEditHint');
  function say(msg, cls) {
    if (!hint) { toast(msg, 3500); return; }
    hint.textContent = msg;
    hint.className = 'pin-edit-hint' + (cls ? ' ' + cls : '');
  }
  if (!/^[0-9]{6}$/.test(newPin)) { say('口令要 6 位数字', 'is-warn'); return; }

  var btn = $('btnPinSave');
  if (btn) { btn.disabled = true; }
  api('POST', '/api/pin', JSON.stringify({ pin: newPin }), function (err, status, text) {
    if (btn) { btn.disabled = false; }
    var res = null;
    try { res = JSON.parse(text); } catch (e) { res = null; }
    if (err) { say('连不上服务，口令没有改', 'is-warn'); return; }
    if (status === 200 && res && res.ok) {
      serverInfo.pin = res.pin || newPin;
      $('pinNewInput').value = '';
      renderPinLine();
      say('已换成新口令：' + serverInfo.pin + '（别的设备下次要重输）', 'is-ok');
      toast('访问口令已更新');
      return;
    }
    say((res && res.error) || '口令没能改成功', 'is-warn');
  });
}

/* 清除流水页的全部额外筛选（类型 / 来源 / 分类 / 搜索），回到按月浏览 */
function clearListFilters() {
  state.listFilter = 'all';
  state.listSource = 'all';
  state.listCategories = [];
  syncFilterChips();
  syncSourceChips();
  clearListSearch();
  clearRangeInputs();
  state.showAll = false;
  renderList();
}

/* ---------- 局域网口令闸（新设备输一次） ---------- */

var pinGateCb = null;

function showPinGate(cb) {
  pinGateCb = cb || null;
  $('pinGate').classList.remove('is-hidden');
  $('pinErr').classList.add('is-hidden');
  var input = $('pinInput');
  input.value = '';
  setTimeout(function () { input.focus(); }, 60);
}

function submitPin() {
  var pin = $('pinInput').value.trim();
  if (!/^[0-9]{6}$/.test(pin)) { $('pinErr').classList.remove('is-hidden'); return; }
  $('btnPinOk').disabled = true;
  api('POST', '/api/auth', JSON.stringify({ pin: pin }), function (err, status) {
    $('btnPinOk').disabled = false;
    if (!err && status === 200) {
      $('pinGate').classList.add('is-hidden');
      var cb = pinGateCb;
      pinGateCb = null;
      if (cb) { cb(); } else { location.reload(); }
    } else {
      $('pinErr').classList.remove('is-hidden');
    }
  });
}

$('btnPinOk').addEventListener('click', submitPin);
$('pinInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { submitPin(); }
});
/* 逃生出口：拿不到口令（比如人不在电脑旁）时不把人卡死在验证页——
   退回浏览器存储先记着，刷新页面可以再试口令。 */
$('btnPinSkip').addEventListener('click', function () {
  $('pinGate').classList.add('is-hidden');
  pinGateCb = null;
  toast('先用浏览器存储记账：数据只存在这台设备上，不会同步到电脑', 4500);
});
/* 「换一个」：一键让服务端随机换一个新口令（旧设备下次要重输）。
   想自己指定口令就用下面的编辑框。 */
$('btnPinRegen').addEventListener('click', function () {
  api('POST', '/api/lan', JSON.stringify({ regen: true }), function (err, status, text) {
    if (err || status !== 200) { toast('没能更换口令'); return; }
    try {
      serverInfo.pin = JSON.parse(text).pin || serverInfo.pin;
      renderPinLine();
      if ($('pinNewInput')) { $('pinNewInput').value = ''; }
      toast('已换新口令：' + serverInfo.pin + '（别的设备下次要重输）');
    } catch (e) { toast('没能更换口令'); }
  });
});

/* 口令点一下就复制（和「复制地址」同一个手感）：手机上要照着输，
   能复制就不用一个数字一个数字念。 */
function copyPin() {
  var pin = (serverInfo && serverInfo.pin) || $('pinValue').textContent || '';
  if (!pin) { return; }
  copyText(pin, function (ok) {
    var area = $('pinCopyArea');
    if (ok && area) {
      area.classList.add('is-copied');
      setTimeout(function () { area.classList.remove('is-copied'); }, 900);
    }
    toast(ok ? ('口令 ' + pin + ' 已复制，粘到手机上就行') : '复制失败，手输一下吧', 3200);
  });
}

var elPinCopy = $('pinCopyArea');
if (elPinCopy) {
  elPinCopy.addEventListener('click', copyPin);
  elPinCopy.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyPin(); }
  });
}

$('btnPinSave').addEventListener('click', savePinChange);
$('pinNewInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { savePinChange(); }
});

elLanSwitch.addEventListener('click', function () {
  if (elLanSwitch.disabled) { return; }
  var enable = !(serverInfo && serverInfo.lanEnabled);
  elLanSwitch.disabled = true;
  api('POST', '/api/lan', JSON.stringify({ enabled: enable }), function (err, status, text) {
    elLanSwitch.disabled = false;
    if (err) { toast('连不上服务，开关没有生效'); return; }
    var res = null;
    try { res = JSON.parse(text); } catch (e) { /* 出错时保持 null */ }
    if (status === 200 && res && res.ok) {
      serverInfo.lanEnabled = res.lanEnabled;
      serverInfo.addresses = res.addresses || [];
      if (res.pin) { serverInfo.pin = res.pin; }
      renderLanRow();
      renderMobileBox();
      renderStorageBox();
      toast(res.lanEnabled
        ? (res.pin ? '已允许局域网访问。新设备首次连接的口令：' + res.pin : '已允许局域网设备访问，手机打开地址或刷新即可')
        : '已关闭局域网访问，现在只有这台电脑能连');
    } else if (status === 403) {
      toast('这个开关只能在电脑上更改');
    } else {
      toast('没能更改：' + ((res && res.error) || '服务出错'));
    }
  });
});

/* 服务模式下，如果浏览器里还留着以前记的账，问一句要不要搬过来 */
function offerLegacyImport() {
  if (db.transactions.length) { return; }
  /* 浏览器里的账本可能在 IndexedDB（新）或 localStorage（旧），
     loadLocalDBAsync 两个都看 */
  loadLocalDBAsync(function (legacy) {
    if (!legacy || !legacy.transactions.length) { return; }
    if (db.transactions.length) { return; } /* 等待期间服务端已有数据就不打扰 */
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
  });
}

init();
