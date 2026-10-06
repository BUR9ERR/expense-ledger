'use strict';

/* ============================================================
   记账本 · 纯逻辑层（core.js）
   ------------------------------------------------------------
   这个文件只放「不碰 DOM、不碰网络、不碰存储」的纯函数：
   金额与日期运算、数据清洗、冲突合并、账单解析（CSV/xlsx）、
   分类词库匹配。渲染和界面都在 app.js，读写分别在
   app.js（浏览器）与 server.js（本地服务）。

   为什么单独拆出来：这些函数是整个程序最容易藏 bug 的地方
   （浮点误差、日期边界、合并冲突、编码），拆成无依赖的纯函数
   之后可以用 node --test 直接测试，不用起浏览器。

   UMD 导出：浏览器挂 window.LedgerCore（在 app.js 之前加载），
   Node 端 require 后直接用（server.js 和测试都这么用）。
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.LedgerCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 日期 ---------- */

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

  /* 流水分组的日期标题：今天 / 昨天 / M月D日 + 星期几 */
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

  /* ---------- 金额 ---------- */

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

  /* ---------- 金额算式 ----------
     记账时真正高频的输入不是「一个数」，而是「一串算式」：
     午饭 23 + 咖啡 18、35×2、100-12.5。这里给金额框用的求值器。

     刻意不用 eval / new Function：
       - 这是把用户输入（还可能来自导入的文本）变成代码执行，风险不必要
       - 单遍扫描 + 一个栈，几十行就能覆盖「加减乘除 + 括号外的优先级」
     支持：数字、+ - * / × ÷（含全角 ＋－×÷）、空格；先乘除后加减。
     不支持括号（记账场景用不上，硬加会让实现复杂一倍）。
     认不出来（连续运算符、除零、只有运算符）时返回 null，由调用方提示。 */

  function normalizeExpr(s) {
    return String(s == null ? '' : s)
      .replace(/[＋]/g, '+')
      .replace(/[－—–−]/g, '-')
      .replace(/[×✕✖]/g, '*')
      .replace(/[÷／]/g, '/')
      .replace(/[＝]/g, '=')
      .replace(/\s+/g, '');
  }

  function tokenizeExpr(s) {
    var tokens = [];
    var num = '';
    var src = normalizeExpr(s);
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if ((ch >= '0' && ch <= '9') || ch === '.') {
        num += ch;
        continue;
      }
      if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
        /* 开头的 + / - 当成数字的正负号（-12+5） */
        if (num === '' && tokens.length === 0 && (ch === '-' || ch === '+')) {
          num = ch;
          continue;
        }
        if (num === '' || num === '-' || num === '+') { return null; }
        tokens.push(num);
        tokens.push(ch);
        num = '';
        continue;
      }
      return null;              /* 出现了不认识的字符 */
    }
    if (num === '' || num === '-' || num === '+') { return null; }
    tokens.push(num);
    return tokens;
  }

  function evalExpr(s) {
    var tokens = tokenizeExpr(s);
    if (!tokens) { return null; }
    /* 第一遍：乘除 */
    var stack = [Number(tokens[0])];
    if (!isFinite(stack[0])) { return null; }
    for (var i = 1; i < tokens.length; i += 2) {
      var op = tokens[i];
      var val = Number(tokens[i + 1]);
      if (!isFinite(val)) { return null; }
      if (op === '*' || op === '/') {
        if (op === '/' && val === 0) { return null; }   /* 除零：不算，交给用户改 */
        var prev = stack.pop();
        stack.push(op === '*' ? prev * val : prev / val);
      } else {
        stack.push(op === '-' ? -val : val);            /* 加减留到第二遍 */
      }
    }
    /* 第二遍：加总（此时 stack 里都是待相加的项） */
    var sum = 0;
    for (var j = 0; j < stack.length; j++) {
      sum += stack[j];
      if (!isFinite(sum)) { return null; }
    }
    if (sum < 0) { return null; }                       /* 金额不能是负数 */
    return sum;
  }

  /* 金额框的入口：算式 → 分。
     传 '23+18' 得 4100；传 '23' 得 2300；认不出来返回 null。 */
  function evalAmountToCents(raw) {
    var v = evalExpr(raw);
    if (v === null) { return null; }
    var cents = Math.round(v * 100);
    if (!isFinite(cents) || cents < 0 || cents > 1e11) { return null; }
    return cents;
  }

  /* ---------- 数据结构与清洗 ---------- */

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
    /* 不计收支专用分类：转账、信用卡还款、借还款这类钱只是在自己账户之间挪。
       它永远不会出现在「记一笔」的分类宫格里（那是支出/收入专用的），
       只用在不计收支那笔账的分类上，让流水里能看懂这笔是干什么的。 */
    { id: 'transfer', kind: 'transfer', name: '转账', icon: '\uD83D\uDD01', color: '#7C8AA0', soft: '#EAEEF4' },
    { id: 'salary',   kind: 'income',  name: '工资', icon: '\uD83D\uDCB0', color: '#1D9E75', soft: '#E1F3EC' },
    { id: 'bonus',    kind: 'income',  name: '奖金', icon: '\uD83C\uDF89', color: '#3AAF8A', soft: '#E5F5EF' },
    { id: 'parttime', kind: 'income',  name: '兼职', icon: '\uD83D\uDCBC', color: '#4CAF93', soft: '#E7F5F1' },
    { id: 'invest',   kind: 'income',  name: '投资', icon: '\uD83D\uDCC8', color: '#2E9E7E', soft: '#E3F3EE' },
    { id: 'gift',     kind: 'income',  name: '红包', icon: '\uD83E\uDDE7', color: '#DE5E5E', soft: '#FBE9E9' },
    { id: 'other_i',  kind: 'income',  name: '其他', icon: '\uD83D\uDCE5', color: '#9AA0A6', soft: '#EFEFEF' }
  ];

  function freshDB() {
    return {
      version: 1,
      categories: DEFAULT_CATEGORIES.slice(),
      transactions: [],
      budgets: {},
      recur: [],
      rules: [],
      createdAt: Date.now()
    };
  }

  /* ---------- 账单来源：手动记的 / 微信导入的 / 支付宝导入的 ---------- */

  var SOURCE_LABEL = {
    manual: '\u624B\u52A8',
    wechat: '\u5FAE\u4FE1',
    alipay: '\u652F\u4ED8\u5B9D'
  };

  /* 只用于把「页面上的选择」写回数据，不做推断 */
  function normSource(v) {
    return (v === 'wechat' || v === 'alipay') ? v : 'manual';
  }

  /* 这笔账是谁记进来的？
     先看显式 source 字段；没有就按交易单号前缀认——导入时 id 就是
     wx: / ali: 开头的，老数据不用迁移、不用重新导入；仍认不出才算「手动」。 */
  function srcOf(t) {
    if (!t) { return 'manual'; }
    if (t.source === 'wechat' || t.source === 'alipay' || t.source === 'manual') {
      return t.source;
    }
    var id = String(t.id || '');
    if (id.indexOf('wx:') === 0) { return 'wechat'; }
    if (id.indexOf('ali:') === 0) { return 'alipay'; }
    return 'manual';
  }

  /* 这笔账算不算「钱花掉了 / 钱进账了」。
     不计收支（type === 'transfer'）的账在流水里照常显示、照常能改，
     但不进任何汇总：支出、收入、日均、分类占比、预算、年度报告、CSV 统计。 */
  function countsInStats(t) {
    return !!t && !t.deletedAt && (t.type === 'expense' || t.type === 'income');
  }

  /* 类型的中文名（流水行、编辑页、导出都用它，别在各处硬编码） */
  var TYPE_LABEL = { expense: '\u652F\u51FA', income: '\u6536\u5165', transfer: '\u4E0D\u8BA1\u6536\u652F' };

  /* 单笔账目的收口：不管来自哪里的数据（导入 / 接口 / 浏览器缓存），
     都在这里定形成统一的字段与类型，坏账直接丢弃而不是带病入库。
     - id 是合并与去重的身份，没有 id 的账目无法参与合并，只能丢
     - 金额换算成能通过 Number 的数，换不出来同样丢
     - 日期不合法时退回 createdAt 当天，保证流水页总能归组
     - source 只在值合法时保留；没有这个字段的老记录不补写，
       让 srcOf 在读取时按单号前缀推断，数据保持原样 */
  function sanitizeTx(t) {
    if (!t || typeof t !== 'object') { return null; }
    var cents = toCents(t.amount);
    if (!isFinite(cents)) { return null; }
    var id = String(t.id == null ? '' : t.id).slice(0, 80);
    if (!id) { return null; }
    /* 三种类型：支出 / 收入 / 不计收支（transfer：转账、信用卡还款这类，
       钱只是在自己账户之间挪，不算花掉也不算进账） */
    var type = t.type === 'income' ? 'income' : (t.type === 'transfer' ? 'transfer' : 'expense');
    var createdAt = Number(t.createdAt) || Date.now();
    var date = /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || ''))
      ? String(t.date)
      : ymd(new Date(createdAt));
    var fallbackCat = type === 'income' ? 'other_i' : (type === 'transfer' ? 'transfer' : 'other_e');
    var out = {
      id: id,
      type: type,
      amount: cents / 100,
      categoryId: String(t.categoryId || fallbackCat).slice(0, 40),
      date: date,
      note: String(t.note || '').slice(0, 40),
      createdAt: createdAt,
      updatedAt: Number(t.updatedAt) || createdAt
    };
    if (t.source === 'manual' || t.source === 'wechat' || t.source === 'alipay') {
      out.source = t.source;
    }
    /* 软删除墓碑：保留时间戳随同步走，回收站与 30 天清理都靠它 */
    if (t.deletedAt != null) {
      var del = Number(t.deletedAt);
      if (isFinite(del) && del > 0) { out.deletedAt = del; }
    }
    /* 周期记账产物标记：既是幂等键（本月补没补过），也留着溯源 */
    if (typeof t.recurId === 'string' && t.recurId) {
      out.recurId = t.recurId.slice(0, 60);
    }
    return out;
  }

  /* 预算表收口：键是月份（YYYY-MM），值是 { total, rollover?, [分类id]: 金额 }。
     rollover 是这个月是否把上月结余带进来的开关，单独保留成布尔；
     其余只留合法月份与有限非负数，月份最多留 240 个（20 年），防撑爆。 */
  function sanitizeBudgets(raw) {
    var out = {};
    /* 键先过月份格式白名单再排序：只有合法键能进后续流程，
       外部数据（备份文件 / 接口）里的任何其他键（含 __proto__ 这类）
       在这里就被丢掉，不可能影响排序或写进结果对象 */
    var keys = Object.keys(raw).filter(function (k) {
      return /^\d{4}-\d{2}$/.test(k);
    }).sort();
    for (var i = 0; i < keys.length && i < 240; i++) {
      var key = keys[i];
      var val = raw[key];
      if (!val || typeof val !== 'object') { continue; }
      var month = {};
      if (val.rollover === true) { month.rollover = true; }
      var vk = Object.keys(val);
      for (var j = 0; j < vk.length; j++) {
        if (vk[j] === 'rollover') { continue; }
        var n = Number(val[vk[j]]);
        if (isFinite(n) && n >= 0 && n < 1e9) {
          month[String(vk[j]).slice(0, 40)] = Math.round(n * 100) / 100;
        }
      }
      /* 只要清洗后还有内容（总预算、任一分类预算、或 rollover 开关）
         就保留。条件必须是「非空」而不是「多于一项」——写成 >1 会把
         「只设总预算」或「只设一个分类」的月份整个丢掉（交接审查
         2026-10-07 抓到的数据丢失 bug：界面显示已保存，刷新就没了）。 */
      if (Object.keys(month).length) { out[key] = month; }
    }
    return out;
  }

  /* 周期记账模板收口：金额必须能换算成有效分，日期 1~31，最多 100 条 */
  function sanitizeRecurs(raw) {
    var out = [];
    for (var i = 0; i < raw.length && out.length < 100; i++) {
      var r = raw[i];
      if (!r || typeof r !== 'object') { continue; }
      var id = String(r.id == null ? '' : r.id).slice(0, 60);
      var cents = toCents(r.amount);
      var day = Math.round(Number(r.day));
      if (!id || !isFinite(cents) || cents <= 0) { continue; }
      if (!(day >= 1 && day <= 31)) { continue; }
      var rType = r.type === 'income' ? 'income' : 'expense';
      out.push({
        id: id,
        type: rType,
        amount: cents / 100,
        categoryId: String(r.categoryId || (rType === 'income' ? 'other_i' : 'other_e')).slice(0, 40),
        note: String(r.note || '').slice(0, 40),
        day: day
      });
    }
    return out;
  }

  /* limits 可选：服务端入库时用小上限（分类 300 / 账目 20 万）防止被撑爆；
     浏览器端读自己的缓存时不传，行为与旧版一致。
     categories 是「整体替换」语义：给了非空数组就完全用它的（过滤无效项），
     没给或给空数组才回落默认分类——与旧版行为一致。
     budgets / recur 同样逐项收口后整体替换，缺了就回落空值。 */
  function sanitizeDB(raw, limits) {
    limits = limits || {};
    var maxCats = limits.maxCategories || Infinity;
    var maxTx = limits.maxTransactions || Infinity;
    var out = freshDB();
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.categories) && raw.categories.length) {
        var cats = [];
        for (var c = 0; c < raw.categories.length && cats.length < maxCats; c++) {
          var cat = sanitizeCategory(raw.categories[c]);
          if (cat && !cats.some(function (x) { return x.id === cat.id; })) { cats.push(cat); }
        }
        out.categories = cats;
      }
      if (Array.isArray(raw.transactions)) {
        for (var i = 0; i < raw.transactions.length && out.transactions.length < maxTx; i++) {
          var tx = sanitizeTx(raw.transactions[i]);
          if (tx) { out.transactions.push(tx); }
        }
      }
      /* 账本里已经有「不计收支」的账目、分类表里却没有这个分类时补上。
         正常用不出问题（新建账本自带），但导入别人的账本、或别人手工
         编辑过 ledger.json 时，缺了它那些转账账目就会显示成「未知」分类。 */
      if (out.transactions.some(function (t) { return t.type === 'transfer'; }) &&
          !out.categories.some(function (c) { return c.id === 'transfer'; })) {
        for (var d = 0; d < DEFAULT_CATEGORIES.length; d++) {
          if (DEFAULT_CATEGORIES[d].id === 'transfer') { out.categories.unshift(DEFAULT_CATEGORIES[d]); }
        }
      }
      if (raw.budgets && typeof raw.budgets === 'object') {
        out.budgets = sanitizeBudgets(raw.budgets);
      }
      if (Array.isArray(raw.recur)) {
        out.recur = sanitizeRecurs(raw.recur);
      }
      /* 用户自己的导入规则（关键词 → 分类）：跟账本一起存、一起备份 */
      if (Array.isArray(raw.rules)) {
        out.rules = sanitizeRules(raw.rules);
      }
      if (raw.createdAt) { out.createdAt = Number(raw.createdAt) || Date.now(); }
    }
    return out;
  }

  /* 冲突合并（409 后用）。
     规则：
     1. 两边都有的 → 谁的 updatedAt 更新就用谁的。
        已知局限：updatedAt 是各设备自己的时钟，设备间时钟有偏差时
        可能用旧改动盖掉新改动。要彻底解决需要墓碑机制，暂未做。
     2. 只有本地有的 → 看它是不是「上次成功保存之后才记的」
          · 是（createdAt > lastPushAt）→ 本地刚记的新账，保留
          · 否 → 服务端早就删掉的残留，丢弃（否则删过的账目会自己冒回来）
        注意 lastPushAt 是页面内存变量，刷新后归零——归零期间规则 2
        退化为「全部保留」，已删除的账目可能复活，这是当前已知的边界。
     3. 返回统计，供界面提示合并了什么。 */
  function mergeTransactions(localTx, remoteTx, lastPushAt) {
    var merged = remoteTx.slice();
    var remoteById = {};
    remoteTx.forEach(function (t) { remoteById[t.id] = t; });

    var tookLocalUpdates = 0;
    var keptLocalNew = 0;
    var droppedStale = 0;

    localTx.forEach(function (t) {
      var r = remoteById[t.id];
      if (r) {
        if ((t.updatedAt || 0) > (r.updatedAt || 0)) {
          var idx = merged.indexOf(r);
          if (idx >= 0) { merged[idx] = t; tookLocalUpdates++; }
        }
        return;
      }
      if ((t.createdAt || 0) > lastPushAt) { merged.push(t); keptLocalNew++; }
      else { droppedStale++; }
    });

    return {
      transactions: merged,
      tookLocalUpdates: tookLocalUpdates,
      keptLocalNew: keptLocalNew,
      droppedStale: droppedStale
    };
  }

  /* ============================================================
     流水筛选（类型 / 来源 / 分类 / 关键词）
     ------------------------------------------------------------
     这段是纯函数：只认「账目数组 + 一份筛选条件」，不认识 DOM，
     也不认识 state。app.js 的 renderList 用它出列表，交互里用它
     把「点了哪一项」折算成新的筛选条件，两边都不会各写一套规则
     （历史上搜索模式与按月浏览就是两套 if，加一个筛选要改两处）。

     conditions:
       month    'YYYY-MM'  只在这个月里找；不传（空）表示跨全部月份
       keyword  关键词     匹配备注或分类名（分类名由 catName 提供）
       type     'all' | 'expense' | 'income'
       source   'all' | 'manual' | 'wechat' | 'alipay'
       category 分类 id 的数组，空 / 不传 = 全部分类（**多选**，命中任一即可；
                也接受单个字符串，兼容只筛一个的调用方）
     已软删除（有 deletedAt 墓碑）的账目永远不出现在结果里。
     ============================================================ */

  /* 账目是否属于某个月（YYYY-MM）。按本地时区判断，与 parseYmd 一致 */
  function inMonth(t, monthKey) {
    if (!monthKey) { return true; }
    var p = String(monthKey).split('-');
    var y = Number(p[0]);
    var m = Number(p[1]);
    if (!y || !m) { return true; }
    var d = parseYmd(t.date);
    return d.getFullYear() === y && d.getMonth() === m - 1;
  }

  /* 把「分类筛选」归一成数组：空数组 = 不筛（全部）。
     接受数组、单个字符串、以及老代码里的 'all'。 */
  function normCategoryFilter(v) {
    if (v == null || v === '' || v === 'all') { return []; }
    var list = (v instanceof Array) ? v : [v];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = String(list[i] == null ? '' : list[i]);
      if (!s || s === 'all') { continue; }
      if (out.indexOf(s) < 0) { out.push(s); }
    }
    return out;
  }

  /* 按筛选条件过滤账目。
     catName 是「分类 id → 分类名」的函数，搜索要按分类名匹配。
     返回新数组，入参不动。 */
  function filterTx(transactions, conditions, catName) {
    var c = conditions || {};
    var kw = String(c.keyword == null ? '' : c.keyword).trim().toLowerCase();
    var nameOf = typeof catName === 'function' ? catName : function () { return ''; };
    var cats = normCategoryFilter(c.category);
    /* 金额/日期范围：空值不生效；金额单位是元，与账目一致 */
    var min = (c.minAmount === '' || c.minAmount == null) ? null : Number(c.minAmount);
    var max = (c.maxAmount === '' || c.maxAmount == null) ? null : Number(c.maxAmount);
    var dateFrom = c.dateFrom ? String(c.dateFrom) : '';
    var dateTo = c.dateTo ? String(c.dateTo) : '';
    return (transactions || []).filter(function (t) {
      if (!t || t.deletedAt) { return false; }
      if (c.month && !inMonth(t, c.month)) { return false; }
      if (c.type && c.type !== 'all' && t.type !== c.type) { return false; }
      if (c.source && c.source !== 'all' && srcOf(t) !== c.source) { return false; }
      if (cats.length && cats.indexOf(String(t.categoryId)) < 0) { return false; }
      if (kw) {
        var hit = String(t.note || '').toLowerCase().indexOf(kw) >= 0 ||
                  String(nameOf(t.categoryId) || '').toLowerCase().indexOf(kw) >= 0;
        if (!hit) { return false; }
      }
      if (min != null && isFinite(min) && !(t.amount >= min)) { return false; }
      if (max != null && isFinite(max) && !(t.amount <= max)) { return false; }
      if (dateFrom && String(t.date) < dateFrom) { return false; }
      if (dateTo && String(t.date) > dateTo) { return false; }
      return true;
    });
  }

  /* 流水默认排序：日期新的在前，同一天按记账时间倒序 */
  function sortTxDesc(list) {
    return list.slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  /* 当前还有没有筛选在起作用（除月份之外的「额外筛选」）。
     app.js 用它决定要不要显示「清除筛选」。 */
  function hasExtraFilter(conditions) {
    var c = conditions || {};
    return !!(c.keyword || (c.type && c.type !== 'all') ||
              (c.source && c.source !== 'all') ||
              normCategoryFilter(c.category).length ||
              (c.minAmount != null && c.minAmount !== '') ||
              (c.maxAmount != null && c.maxAmount !== '') ||
              c.dateFrom || c.dateTo);
  }

  /* 点了一个分类之后，新的「已选分类」数组（多选：点一下加进去，再点一下拿掉）。
     分类已经不在分类表里时（账本换了分类、导入的账本分类不同）直接忽略这次点击，
     并且把结果里失效的 id 清掉——避免出现「筛选器指着不存在的分类、列表永远空」
     的死状态。 */
  function toggleCategoryFilter(current, id, categories) {
    var known = [];
    for (var i = 0; i < (categories || []).length; i++) {
      if (categories[i] && categories[i].id != null) { known.push(String(categories[i].id)); }
    }
    var want = String(id == null ? '' : id);
    /* 「全部分类」（all / 空）就是清空选择，不是「点一颗不存在的分类」 */
    if (!want || want === 'all') { return []; }
    var out = normCategoryFilter(current).filter(function (x) { return known.indexOf(x) >= 0; });
    if (known.indexOf(want) < 0) { return out; }
    var at = out.indexOf(want);
    if (at >= 0) { out.splice(at, 1); } else { out.push(want); }
    return out;
  }

  /* 把一组分类 id 收敛成「分类表里还存在的那些」，顺序按分类表来。
     账本换过分类 / 导入过别人的账本之后，列表里可能留着已经不存在的 id。 */
  function cleanCategoryFilter(current, categories) {
    var want = normCategoryFilter(current);
    var out = [];
    for (var i = 0; i < (categories || []).length; i++) {
      var c = categories[i];
      if (!c || c.id == null) { continue; }
      if (want.indexOf(String(c.id)) >= 0 && out.indexOf(String(c.id)) < 0) {
        out.push(String(c.id));
      }
    }
    return out;
  }

  /* ---------- 流水统计（收入 / 支出 / 不计收支） ----------
     一笔账只有三种可能：支出、收入、**不计收支**（转账、信用卡还款、
     借还款这类只是钱在账户之间挪，不是花掉）。第三种如果不排除，
     「本月支出」「日均」「分类占比」「预算已用」全都会虚高——
     这是真实账目里最常见的一类失真。

     这里的口径是**唯一口径**：app.js 的所有汇总都必须调 countStats，
     不要再各写一遍 filter（历史上就是各处自己 filter，加了新类型必然漏）。 */
  function expenseTx(list) {
    return (list || []).filter(function (t) { return t && !t.deletedAt && t.type === 'expense'; });
  }

  function incomeTx(list) {
    return (list || []).filter(function (t) { return t && !t.deletedAt && t.type === 'income'; });
  }

  function transferTx(list) {
    return (list || []).filter(function (t) { return t && !t.deletedAt && t.type === 'transfer'; });
  }

  /* 一组账目的口径统计。transferCents 单独给出来，界面上可以如实显示
     「另有 X 笔转账（不计收支）」，而不是假装它们不存在。 */
  function countStats(list) {
    var exp = expenseTx(list);
    var inc = incomeTx(list);
    var tr = transferTx(list);
    return {
      count: (list || []).length,
      expenseCount: exp.length,
      incomeCount: inc.length,
      transferCount: tr.length,
      expenseCents: sumCents(exp),
      incomeCents: sumCents(inc),
      transferCents: sumCents(tr)
    };
  }

  /* ============================================================
     导入规则（关键词 → 分类）
     ------------------------------------------------------------
     assets/分类词库.js 是一份「通用词库」，改它要开编辑器；这张表是
     **用户自己的规则**，存在账本里、跟着备份走，导入时优先于词库。

     规则怎么来的：导入的账目你手动改过分类之后，程序会把商户名
     （备注里「·」前面那段）记成一条规则，下次同一家店自动归到该类。
     这正是 Actual Budget 的「自动学习规则」思路，只是简化成
     「关键词包含」一种匹配，不做 DSL。

     匹配规则：从上往下找，第一条命中的赢（所以新学的排前面 =
     最近改的优先）。关键词做成子串匹配、ASCII 不区分大小写。
     ============================================================ */

  function sanitizeRules(raw) {
    var out = [];
    if (!Array.isArray(raw)) { return out; }
    for (var i = 0; i < raw.length && out.length < 300; i++) {
      var r = raw[i];
      if (!r || typeof r !== 'object') { continue; }
      var cat = String(r.categoryId == null ? '' : r.categoryId).slice(0, 40);
      if (!cat) { continue; }
      var words = Array.isArray(r.keywords) ? r.keywords : [];
      var kws = [];
      for (var j = 0; j < words.length && kws.length < 50; j++) {
        var w = String(words[j] == null ? '' : words[j]).replace(/^\s+|\s+$/g, '').slice(0, 24);
        if (w && kws.indexOf(w) < 0) { kws.push(w); }
      }
      if (!kws.length) { continue; }
      out.push({
        id: String(r.id == null ? '' : r.id).slice(0, 60) || uid(),
        keywords: kws,
        categoryId: cat,
        hits: Math.max(0, Math.round(Number(r.hits) || 0)),
        updatedAt: Number(r.updatedAt) || Date.now()
      });
    }
    return out;
  }

  /* 从备注里取出「商户名」：备注是按「对方 · 商品」拼的，取 · 前面那段。
     取不出东西（没有 ·、只有商品名）时退回整条备注。 */
  function peerOfNote(note) {
    var s = String(note == null ? '' : note).replace(/^\s+|\s+$/g, '');
    if (!s) { return ''; }
    var at = s.indexOf(' · ');
    var peer = at > 0 ? s.slice(0, at) : s;
    return peer.replace(/^\s+|\s+$/g, '').slice(0, 24);
  }

  /* 已知会被词库/规则覆盖的通用词，学成规则没意义还容易误伤 */
  var LEARN_STOPWORDS = [
    '转账', '红包', '退款', '收款', '付款', '消费', '订单', '商户', '科技有限公司',
    '有限公司', '个体户', '不详', '未知', '其他', '无说明', '商品', '扫码支付'
  ];

  /* 这笔账的备注值不值得学成规则（太短、太通用、没有信息量的都不学） */
  function learnableKeyword(note) {
    var w = peerOfNote(note);
    if (!w) { return ''; }
    if (w.length < 2) { return ''; }
    /* 纯数字/单字符没意义 */
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(w)) { return ''; }
    for (var i = 0; i < LEARN_STOPWORDS.length; i++) {
      if (w === LEARN_STOPWORDS[i]) { return ''; }
    }
    return w;
  }

  /* 用户改了某笔账的分类 → 算出新的规则表（不改入参）。
     同一个关键词已经有规则时，改那条规则的分类并挪到最前面
     （最近改的优先）；否则新建一条。
     categoryId 为空表示「这条不该学」（调用方传 learnableKeyword 的结果）。 */
  function learnRule(rules, keyword, categoryId, now) {
    var kw = String(keyword == null ? '' : keyword).replace(/^\s+|\s+$/g, '').slice(0, 24);
    var cat = String(categoryId == null ? '' : categoryId).slice(0, 40);
    var list = sanitizeRules(rules);
    if (!kw || !cat) { return list; }

    var found = null;
    var rest = [];
    for (var i = 0; i < list.length; i++) {
      if (!found && list[i].keywords.indexOf(kw) >= 0) { found = list[i]; }
      else { rest.push(list[i]); }
    }
    var ts = Number(now) || Date.now();
    var next = found || { id: uid(), keywords: [kw], hits: 0 };
    next.keywords = next.keywords.indexOf(kw) >= 0 ? next.keywords : next.keywords.concat([kw]);
    next.categoryId = cat;
    next.updatedAt = ts;
    /* 学过的规则排最前面：最近改的优先 */
    rest.unshift(next);
    return sanitizeRules(rest);
  }

  /* 用用户规则猜分类：命中返回 categoryId，没命中返回 ''。
     按顺序找第一条命中的（列表顺序 = 优先级）。 */
  function matchRule(rules, text) {
    var r = matchRuleEntry(rules, text);
    return r ? String(r.categoryId) : '';
  }

  /* 同上，但返回整条规则（界面要显示「命中 N 次」就得知道是哪一条） */
  function matchRuleEntry(rules, text) {
    var t = String(text == null ? '' : text);
    if (!t) { return null; }
    var lower = t.toLowerCase();
    for (var i = 0; i < (rules || []).length; i++) {
      var r = rules[i];
      if (!r || !r.keywords) { continue; }
      for (var j = 0; j < r.keywords.length; j++) {
        var w = String(r.keywords[j] || '');
        if (!w) { continue; }
        var hit = /^[\x00-\x7F]*$/.test(w)
          ? lower.indexOf(w.toLowerCase()) >= 0      /* 纯 ASCII：忽略大小写 */
          : t.indexOf(w) >= 0;
        if (hit) { return r; }
      }
    }
    return null;
  }

  /* 命中计数累加（不改入参）：counts 是 { 规则id: 次数 }。
     导入完把「哪条规则挑中了多少笔」记上，界面才有「命中 N 次」可看。 */
  function bumpRuleHits(rules, counts) {
    return sanitizeRules(rules).map(function (r) {
      var add = Math.max(0, Math.round(Number((counts || {})[r.id]) || 0));
      if (!add) { return r; }
      r.hits = (r.hits || 0) + add;
      return r;
    });
  }

  /* ---------- 预算（含跨月结转） ----------
     预算是「这个月打算花多少」。但真实生活里有一类支出是不规则的：
     年缴保险、体检、修车、过节红包——按月摊平之后，没花的月份不该被清零，
     超支的月份也该从下个月里扣。这就是 Actual Budget 的 Rollover Spending。

     规则（`预算[key].rollover === true` 的月份才结转）：
       本月可用 = 本月预算 + 上月可用 − 上月已花
     上月结转是**递归**的（上月自己的可用又来自上上月），所以一年只设一次
     预算也能一路滚下来。用月份缓存防重入，往回最多看 60 个月。

     总预算与分类预算各滚各的；总额只看 total，分类只看该分类。

     **单位统一是「元」**（和 db.budgets 里存的一致）：这里的 spent / left /
     carried 都是元，别和 sumCents 出来的「分」混用。界面上要乘以 100 再格式化。 */
  function monthBefore(key) {
    var p = String(key || '').split('-');
    var y = Number(p[0]);
    var m = Number(p[1]);
    if (!y || !m) { return ''; }
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
    return y + '-' + pad2(m);
  }

  function budgetCtx() {
    return { tx: [], budgets: {}, cache: {}, depth: 0 };
  }

  /* 某个月的预算/已花/结转/剩余。budgetCtx 是上面那个共享上下文，
     内部用递归 + 缓存算结转，所以别在外面直接改它的 cache。 */
  function monthBudget(ctx, key) {
    var c = ctx || budgetCtx();
    if (!key || !/^\d{4}-\d{2}$/.test(key)) {
      return { key: '', total: 0, spent: 0, carried: 0, left: 0, cats: {} };
    }
    if (c.cache[key]) { return c.cache[key]; }
    /* 先放一个占位，防数据异常（比如月份互相引用）时无限递归 */
    if (c.depth > 60) {
      return { key: key, total: 0, spent: 0, carried: 0, left: 0, cats: {} };
    }
    c.depth++;

    var b = (c.budgets && c.budgets[key]) || {};
    var total = Math.max(0, Number(b.total) || 0);

    /* 分类：本月有预算的分类 ∪ 上月有结余的分类 */
    var ids = [];
    Object.keys(b).forEach(function (k) {
      if (k !== 'total' && k !== 'rollover' && ids.indexOf(k) < 0) { ids.push(k); }
    });

    var carry = 0;
    var prev = null;
    if (b.rollover === true) {
      prev = monthBudget(c, monthBefore(key));
      carry = prev.left;
      /* 上月有结余/超支的分类也要出现在本月，否则「结转」看不见 */
      Object.keys(prev.cats).forEach(function (id) {
        if (ids.indexOf(id) < 0) { ids.push(id); }
      });
    }

    var cats = {};
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var catBudget = Math.max(0, Number(b[id]) || 0);
      var catCarry = 0;
      if (prev && prev.cats[id]) { catCarry = prev.cats[id].left; }
      var catSpentCents = 0;
      if (c.tx && c.tx.length) {
        catSpentCents = sumCents(expenseTx(c.tx.filter(function (t) {
          return t.categoryId === id && String(t.date).indexOf(key) === 0;
        })));
      }
      var catSpent = catSpentCents / 100;
      cats[id] = {
        budget: catBudget,
        carried: catCarry,
        available: catBudget + catCarry,
        spent: catSpent,
        left: catBudget + catCarry - catSpent
      };
    }

    var spentCents = c.tx && c.tx.length
      ? sumCents(expenseTx(c.tx.filter(function (t) { return String(t.date).indexOf(key) === 0; })))
      : 0;
    var spent = spentCents / 100;

    var out = {
      key: key,
      rollover: b.rollover === true,
      total: total,
      spent: spent,
      carried: carry,
      available: total + carry,
      left: total + carry - spent,
      cats: cats
    };
    c.depth--;
    c.cache[key] = out;
    return out;
  }

  /* 从「一笔流水 + 一组预算」直接算某个月的预算情况（界面的入口）。
     rollover 只在预算里标了 rollover === true 的月份生效。 */
  function budgetOf(transactions, budgets, key) {
    var ctx = budgetCtx();
    ctx.tx = transactions || [];
    ctx.budgets = budgets || {};
    return monthBudget(ctx, key);
  }

  /* 一组账目在某个自然月里的口径统计（本月/上月/某月都能用）。
     key 形如 'YYYY-MM'；不传就用调用方给的默认月。 */
  function monthStats(transactions, key) {
    var list = (transactions || []).filter(function (t) {
      return !t.deletedAt && String(t.date).indexOf(String(key) + '-') === 0;
    });
    var st = countStats(list);
    st.key = key;
    return st;
  }

  /* 环比：本月与上月比。返回的 direction 是「支出变多/变少」，
     不是「数字变大/变小」——判断好坏由界面决定（支出涨是坏消息）。
     上月为 0 或没有上月数据时 pct 为 null（百分比在这种基数下没意义）。 */
  function compareMonths(transactions, key) {
    var prevKey = monthBefore(key);
    var cur = monthStats(transactions, key);
    var prev = monthStats(transactions, prevKey);
    var diff = cur.expenseCents - prev.expenseCents;
    var pct = prev.expenseCents > 0
      ? Math.round(diff / prev.expenseCents * 1000) / 10
      : null;
    return {
      key: key,
      prevKey: prevKey,
      curCents: cur.expenseCents,
      prevCents: prev.expenseCents,
      diffCents: diff,
      pct: pct,
      direction: diff > 0 ? 'up' : (diff < 0 ? 'down' : 'same')
    };
  }

  /* ---------- 日历（按月热力图） ----------
     一个月一张 7 列网格，每格是一天的**支出**（转账/收入不算）与笔数。
     色阶是相对的：按当月最大单日支出分 4 档，所以「哪天花得多」一眼能看出来，
     金额不塞进格子（窄屏上每格只有 44px 宽，塞数字必然溢出、还会糊成一团）。

     返回：
       weeks    按行分组的格子（行 = 周），每格 { day, date, cents, count, level }
                level 0~4；0 = 那天没有支出
       maxCents 当月最大单日支出（分）
       totalCents / days 有支出的天数
     前后补白（上月/下月的日子）用 date:'' 表示，界面画成空格。 */
  function monthCalendar(transactions, key) {
    var p = String(key || '').split('-');
    var y = Number(p[0]);
    var m = Number(p[1]);
    if (!y || !m) { return { weeks: [], maxCents: 0, totalCents: 0, days: 0 }; }

    var byDay = {};
    (transactions || []).forEach(function (t) {
      if (!t || t.deletedAt || t.type !== 'expense') { return; }
      if (String(t.date).indexOf(key + '-') !== 0) { return; }
      var d = Number(String(t.date).slice(8, 10));
      if (!byDay[d]) { byDay[d] = { cents: 0, count: 0 }; }
      byDay[d].cents += toCents(t.amount);
      byDay[d].count += 1;
    });

    var last = daysInMonth(key);
    var maxCents = 0;
    var totalCents = 0;
    var days = 0;
    for (var d = 1; d <= last; d++) {
      if (!byDay[d]) { continue; }
      totalCents += byDay[d].cents;
      days++;
      if (byDay[d].cents > maxCents) { maxCents = byDay[d].cents; }
    }

    /* 色阶：0 无支出；1~4 按 maxCents 的 1/4、1/2、3/4 分档。
       全是同一天花钱时给最高档（否则「只有一天有账」会看不出深浅）。 */
    function levelOf(cents) {
      if (!cents) { return 0; }
      if (!maxCents || cents >= maxCents) { return 4; }
      var r = cents / maxCents;
      if (r <= 0.25) { return 1; }
      if (r <= 0.5) { return 2; }
      if (r <= 0.75) { return 3; }
      return 4;
    }

    var firstWeekday = new Date(y, m - 1, 1).getDay();   /* 0 = 周日 */
    var cells = [];
    for (var i = 0; i < firstWeekday; i++) {
      cells.push({ day: 0, date: '', cents: 0, count: 0, level: 0 });
    }
    for (var dd = 1; dd <= last; dd++) {
      var info = byDay[dd];
      cells.push({
        day: dd,
        date: key + '-' + pad2(dd),
        cents: info ? info.cents : 0,
        count: info ? info.count : 0,
        level: levelOf(info ? info.cents : 0)
      });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ day: 0, date: '', cents: 0, count: 0, level: 0 });
    }
    var weeks = [];
    for (var w = 0; w < cells.length; w += 7) { weeks.push(cells.slice(w, w + 7)); }

    return { weeks: weeks, maxCents: maxCents, totalCents: totalCents, days: days };
  }

  /* 分类的收口：id/名称/图标/颜色/类型都定形，坏值丢掉或回落。
     自定义分类允许颜色是任意 CSS 颜色串吗？不允许——它会进 style 属性，
     所以这里统一走和前端 safeColor 一样的白名单（#RGB / #RRGGBB / rgb()）。
     archived 是「归档」：不再出现在记一笔和筛选里，但历史账目照常显示。 */
  var CAT_KINDS = ['expense', 'income', 'transfer'];

  function catColor(v, fallback) {
    var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
    if (/^#[0-9a-fA-F]{3}$/.test(s) || /^#[0-9a-fA-F]{6}$/.test(s)) { return s; }
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/.test(s)) { return s; }
    return fallback;
  }

  function sanitizeCategory(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    var id = String(raw.id == null ? '' : raw.id).replace(/[^\w:-]/g, '').slice(0, 40);
    var name = String(raw.name == null ? '' : raw.name).replace(/^\s+|\s+$/g, '').slice(0, 12);
    if (!name) { return null; }        /* 没有名字的分类没有意义，见下面 addCategory */
    if (!id) { id = 'c' + uid(); }     /* 界面「新增分类」只填名字，id 自动生成 */
    var kind = CAT_KINDS.indexOf(raw.kind) >= 0 ? raw.kind : 'expense';
    var cat = {
      id: id,
      kind: kind,
      name: name,
      icon: Array.from(String(raw.icon == null ? '' : raw.icon)).slice(0, 2).join('') || '📌',
      color: catColor(raw.color, '#9AA0A6'),
      soft: catColor(raw.soft, '#EFEFEF')
    };
    if (raw.archived === true) { cat.archived = true; }
    return cat;
  }

  /* 分类的增删改（都返回**新的**数组，不改入参——走和账目一样的「不可变」路子，
     免得异步保存/渲染时看到改了一半的数组）。

     addCategory：id 可以不传（自动生成），同名同类型的直接返回原数组（不重复建）
     updateCategory：改名字/图标/颜色/类型；内置分类可以改名字与外观，
       但不允许改 type（转账分类被改成支出会让不计收支的历史账目错位）
     removeCategory：真删。调用方要先确认「这个分类下还有没有账目」——
       有账目时应该引导用户去「归档」（archived），而不是删掉让历史变未知。
     archiveCategory：归档/取消归档。 */
  function addCategory(categories, input) {
    var list = (categories || []).slice();
    var raw = input || {};
    /* id 撞了才算「已存在」——判重只看调用方原样给的 id，
       不能拿 sanitizeCategory 自动补出来的 id 去比（那会永远不撞）。 */
    var wantId = String(raw.id == null ? '' : raw.id).replace(/[^\w:-]/g, '').slice(0, 40);
    if (wantId) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === wantId) { return list; }
      }
    }
    var cat = sanitizeCategory(wantId ? raw : { id: null, kind: raw.kind, name: raw.name, icon: raw.icon, color: raw.color, soft: raw.soft });
    if (!cat) { return list; }
    /* 同名同类型的不重复建（用户手滑点两下） */
    for (var j = 0; j < list.length; j++) {
      if (list[j].name === cat.name && list[j].kind === cat.kind) { return list; }
    }
    list.push(cat);
    return list;
  }

  function updateCategory(categories, id, patch) {
    var list = (categories || []).slice();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) { continue; }
      var merged = {};
      Object.keys(list[i]).forEach(function (k) { merged[k] = list[i][k]; });
      Object.keys(patch || {}).forEach(function (k) { merged[k] = patch[k]; });
      merged.id = id;                                  /* id 不许改 */
      if (id === 'transfer') { merged.kind = 'transfer'; merged.archived = false; }
      var next = sanitizeCategory(merged);
      if (next) { list[i] = next; }
      return list;
    }
    return list;
  }

  function removeCategory(categories, id) {
    if (id === 'transfer') { return (categories || []).slice(); }   /* 内置的不给删 */
    return (categories || []).filter(function (c) { return c.id !== id; });
  }

  function archiveCategory(categories, id, archived) {
    if (id === 'transfer') { return (categories || []).slice(); }
    return updateCategory(categories, id, { archived: archived === true });
  }

  /* 某个分类下有多少笔账（含已删除的——删掉了也仍然是「这个分类用过的证据」） */
  function countTxInCategory(transactions, id) {
    return (transactions || []).filter(function (t) { return t && t.categoryId === id; }).length;
  }

  /* 可选的分类：没过期的（没归档的）。kind 传了只取那一类。 */
  function activeCategories(categories, kind) {
    return (categories || []).filter(function (c) {
      if (!c || c.archived) { return false; }
      return !kind || c.kind === kind;
    });
  }

  /* ---------- 疑似转账（不计收支）的识别 ----------
     从微信/支付宝导出的账单里，转账、信用卡还款、零钱提现、余额宝存取
     这些都是**钱的搬运**，不是消费。账单里它们往往只留一个名字或一句
     「转账备注」，词库认不出品类，就掉进「其他」被当成支出——
     这是导入账目里最常见的一类失真（用户真实数据里就有好几笔）。

     这里只做「提醒」：命中的账目会被列出来让用户自己勾（一键标为不计收支），
     绝不自动替用户改分类——猜错比不改更糟。 */

  /* 强信号：备注/交易类型里直接出现这些词，基本可以确定是搬运 */
  var TRANSFER_STRONG = /转账|还款|信用卡还款|提现|零钱通|余额宝|转到|借呗|花呗还款|还花呗|还白条|信用卡|还款成功/i;
  /* 弱信号：账单自己的「交易类型/分类」列写了这些（支付宝常见） */
  var TRANSFER_KIND = /转账|还款|提现|理财|借贷|信用/i;
  /* 反信号：明确是消费的词，出现就不算（「转账给某某超市」这种要放过） */
  var TRANSFER_NOT = /外卖|打车|超市|便利店|餐|饮|店$|商城|商城订单/i;

  /* 这笔账像不像「不计收支」。返回 true / false。 */
  function isTransferLike(t) {
    if (!t || t.type === 'transfer') { return false; }   /* 已经是了，不用提醒 */
    if (t.type === 'income') { return false; }           /* 只管支出里的搬运 */
    var note = String(t.note == null ? '' : t.note);
    if (!note) { return false; }
    if (TRANSFER_NOT.test(note)) { return false; }
    /* 备注是「对方 · 商品」拼的：只要任意一段命中就算 */
    if (TRANSFER_STRONG.test(note)) { return true; }
    return false;
  }

  /* 从账单行里判断「交易类型/分类」列是否说明这是搬运（导入时标记用） */
  function isTransferKind(text) {
    return TRANSFER_KIND.test(String(text == null ? '' : text));
  }

  /* 扫一遍账目，挑出疑似不计收支的（默认只看支出、跳过已删除与已经是 transfer 的）。
     返回数组（不改入参）。 */
  function findTransferSuspects(transactions) {
    return (transactions || []).filter(function (t) {
      if (!t || t.deletedAt) { return false; }
      return isTransferLike(t);
    });
  }

  /* 把一批账目标成不计收支（不改入参，返回新的数组）。
     ids 是 id 的数组；分类还是原来的（保留用户/词库的判断），只是类型变了。
     已经是 transfer 的保持不动。 */
  function markAsTransfer(transactions, ids) {
    var set = {};
    (ids || []).forEach(function (id) { set[String(id)] = true; });
    return (transactions || []).map(function (t) {
      if (!t || !set[String(t.id)] || t.type === 'transfer') { return t; }
      var next = {};
      Object.keys(t).forEach(function (k) { next[k] = t[k]; });
      next.type = 'transfer';
      next.updatedAt = Date.now();
      return next;
    });
  }

  /* ---------- 数据体检：找可疑的账目 ----------
     只挑出来给用户看，绝不自动改——和「疑似转账」同一个原则。
     四类检查：
       duplicates  同一天 + 同类型 + 同金额的多笔（可能是重复记账，
                   也可能真是两杯一样的咖啡——自己判断）
       future      日期在今天之后的（手滑选错日期）
       zero        零金额（导入或手输残留，统计里不起作用但碍眼）
       orphan      分类已不存在（账本导入/改分类留下的孤儿，显示成「未知」）
     已软删除的不参与体检。 */
  function findDataIssues(transactions, categories, todayStr) {
    var known = {};
    (categories || []).forEach(function (c) {
      if (c && c.id) { known[c.id] = true; }
    });
    var issues = { duplicates: [], future: [], zero: [], orphan: [] };
    var seen = {};
    var today = String(todayStr);

    (transactions || []).forEach(function (t) {
      if (!t || t.deletedAt) { return; }
      if (String(t.date) > today) { issues.future.push(t); }
      if (!(toCents(t.amount) > 0)) { issues.zero.push(t); }
      if (!known[t.categoryId]) { issues.orphan.push(t); }
      var key = [t.date, t.type, toCents(t.amount)].join('|');
      if (!seen[key]) { seen[key] = []; }
      seen[key].push(t);
    });

    Object.keys(seen).forEach(function (key) {
      if (seen[key].length > 1) { issues.duplicates.push(seen[key]); }
    });
    return issues;
  }

  /* ---------- 回收站：软删除的清理 ---------- */

  /* 删掉的账目保留 keepMs 毫秒（默认 30 天）后清掉。
     返回 { kept, purged }——kept 是保留的账目数组（含未删的），
     purged 是这次清掉的条数。墓碑是「删除」随同步走的方式，
     清太早会让已删的账在别的设备复活，30 天是安全余量。 */
  function purgeDeleted(transactions, now, keepMs) {
    var keep = [];
    var purged = 0;
    var limit = now - (keepMs == null ? 30 * 86400000 : keepMs);
    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      if (t.deletedAt && t.deletedAt <= limit) { purged++; continue; }
      keep.push(t);
    }
    return { kept: keep, purged: purged };
  }

  /* ---------- 周期记账：该补记的账 ---------- */

  /* 某个月有多少天。monthKey 是 'YYYY-MM'。 */
  function daysInMonth(monthKey) {
    var p = String(monthKey || '').split('-');
    var y = Number(p[0]);
    var m = Number(p[1]);
    if (!y || !m || m < 1 || m > 12) { return 31; }
    return new Date(y, m, 0).getDate();
  }

  /* 模板里的「每月几号」在这个月实际落在哪天。
     这是**月末回退**：模板写 31 号，2 月只有 28 天 → 落 28 号（闰年 29 号）；
     写 30 号、31 号在小月同理回退到当月最后一天。
     没有这条规则，31 号的房租/话费模板在 2 月**永远不会触发**——
     以前是靠「今天 >= 模板日」判断，小月份里这一天永远不存在。 */
  function recurDayInMonth(day, monthKey) {
    var want = Math.round(Number(day));
    if (!(want >= 1)) { return 0; }
    var last = daysInMonth(monthKey);
    return Math.min(want, last);
  }

  /* 检查周期模板，返回该补记、还没补的账目数组（不改入参）。
     幂等键 recurId = 'recur:模板id:月份'——同一模板同一个月只补一次，
     所以重复调用、多设备各自调用都不会记两笔；删掉当月那笔也不会再补
     （删除是打墓碑，仍留在 txs 里，recurId 还在）。

     触发条件：今天 >= 该模板在这个月的实际落点（含月末回退）。
     也就是说 31 号的模板在 2 月 28 号就会补记，而不是等一个不存在的一天。

     金额非法的模板跳过；类型为「不计收支」的模板也照记（房租是支出、
     信用卡还款才是转账，这里不替用户判断，用户自己选）。 */
  function applyRecurring(recus, txs, todayStr, now) {
    var out = [];
    if (!Array.isArray(recus)) { return out; }
    var month = String(todayStr).slice(0, 7);
    var today = Number(String(todayStr).slice(8, 10));
    for (var i = 0; i < recus.length; i++) {
      var r = recus[i];
      if (!r || typeof r !== 'object') { continue; }
      var onDay = recurDayInMonth(r.day, month);
      if (!onDay || !(today >= onDay)) { continue; }
      var cents = toCents(r.amount);
      if (!isFinite(cents) || cents <= 0) { continue; }
      var recurId = 'recur:' + String(r.id) + ':' + month;
      var exists = false;
      for (var j = 0; j < txs.length; j++) {
        if (txs[j] && txs[j].recurId === recurId) { exists = true; break; }
      }
      if (exists) { continue; }
      var ts = Number(now) || Date.now();
      var type = r.type === 'income' ? 'income' : (r.type === 'transfer' ? 'transfer' : 'expense');
      out.push({
        id: recurId,
        recurId: recurId,
        type: type,
        amount: cents / 100,
        categoryId: String(r.categoryId || (type === 'income' ? 'other_i' : (type === 'transfer' ? 'transfer' : 'other_e'))),
        /* 日期落在实际落点那天，而不是「打开记账本的那天」——
           2 月 28 号才打开时，补记的房租就该记在 28 号，不是 3 月 3 号 */
        date: month + '-' + pad2(onDay),
        note: String(r.note || '').slice(0, 40),
        source: 'manual',
        createdAt: ts,
        updatedAt: ts
      });
    }
    return out;
  }

  /* ---------- CSV 导出 ---------- */

  /* 账目 → Excel 友好的 CSV：UTF-8 BOM 开头（Excel 不加 BOM 会按 GBK
     读出乱码），CRLF 换行，含逗号/引号/换行的字段按 CSV 规则加引号转义。
     已软删除的账目不导出。
     类型列如实写「支出 / 收入 / 不计收支」，并在末尾补一列「计入统计」，
     这样用户拿 CSV 自己算总数时不会把转账也算进去（分类名由调用方传）。 */
  function txsToCsv(transactions, categoryName) {
    function field(v) {
      var s = String(v == null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = ['日期,类型,分类,金额,来源,备注,计入统计'];
    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      if (t.deletedAt) { continue; }
      var type = t.type === 'income' ? '收入' : (t.type === 'transfer' ? '不计收支' : '支出');
      lines.push([
        field(t.date),
        field(type),
        field(categoryName(t.categoryId)),
        field(t.amount),
        field(SOURCE_LABEL[srcOf(t)]),
        field(t.note),
        field(countsInStats(t) ? '是' : '否')
      ].join(','));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  /* ---------- 年度报告 ---------- */

  /* 一年的账目聚合：总额、逐月支出（分）、最大单笔、最常去的收款方
     （备注按「对方 · 商品」拼的，取 · 前面的对方名）、分类占比。
     已软删除的不算；**不计收支（transfer）也不算**——它既不是花掉也不是进账，
     算进去会把年支出、逐月柱状和分类排行一起抬高（转账还款是重灾区）。 */
  function yearReport(transactions, year) {
    var prefix = String(year) + '-';
    var expenseCents = 0, incomeCents = 0;
    var byMonth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var byCat = {};
    var byPeer = {};
    var maxTx = null, maxCents = 0;
    var transferCount = 0, transferCents = 0;

    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      if (t.deletedAt) { continue; }
      if (String(t.date).indexOf(prefix) !== 0) { continue; }
      var cents = toCents(t.amount);
      if (t.type === 'transfer') {
        transferCount++;
        transferCents += cents;
        continue;
      }
      if (t.type !== 'income') {
        expenseCents += cents;
        var mi = Number(String(t.date).slice(5, 7)) - 1;
        if (mi >= 0 && mi < 12) { byMonth[mi] += cents; }
        byCat[t.categoryId] = (byCat[t.categoryId] || 0) + cents;
        var peer = String(t.note || '').split(' · ')[0] || '（无说明）';
        byPeer[peer] = (byPeer[peer] || 0) + cents;
        if (cents > maxCents) { maxCents = cents; maxTx = t; }
      } else {
        incomeCents += cents;
      }
    }

    var peers = Object.keys(byPeer).map(function (name) {
      return { name: name, cents: byPeer[name] };
    }).sort(function (a, b) { return b.cents - a.cents; }).slice(0, 5);

    return {
      expenseCents: expenseCents,
      incomeCents: incomeCents,
      byMonth: byMonth,
      byCategory: byCat,
      topPeers: peers,
      maxTx: maxTx,
      transferCount: transferCount,
      transferCents: transferCents
    };
  }

  /* 导入文本 / 备份文件的收口：认得出结构才收 */
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

      var type = item.type === 'income' ? 'income' : (item.type === 'transfer' ? 'transfer' : 'expense');

      var cents = 0;
      if (typeof item.amountCents === 'number') { cents = Math.round(item.amountCents); }
      else if (typeof item.amount === 'number') { cents = Math.round(item.amount * 100); }
      else if (typeof item.amount === 'string') { cents = parseAmountToCents(item.amount); }
      if (!(cents > 0)) { continue; }

      var tx = {
        id: String(item.id || uid()),
        type: type,
        amount: cents / 100,
        categoryId: String(item.categoryId || (type === 'income' ? 'other_i' : (type === 'transfer' ? 'transfer' : 'other_e'))),
        date: date,
        note: String(item.note || '').slice(0, 40),
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now()
      };
      if (item.source === 'manual' || item.source === 'wechat' || item.source === 'alipay') {
        tx.source = item.source;
      }
      if (item.deletedAt != null) {
        var del = Number(item.deletedAt);
        if (isFinite(del) && del > 0) { tx.deletedAt = del; }
      }
      if (typeof item.recurId === 'string' && item.recurId) {
        tx.recurId = item.recurId.slice(0, 60);
      }
      out.push(tx);
    }

    return {
      transactions: out,
      categories: incomingCats,
      /* 预算、周期模板、导入规则也要跟着备份走：它们和账目一样是用户数据，
         早先的备份文件没有这几个字段，回落空值即可 */
      budgets: (raw.budgets && typeof raw.budgets === 'object') ? sanitizeBudgets(raw.budgets) : {},
      recur: Array.isArray(raw.recur) ? sanitizeRecurs(raw.recur) : [],
      rules: Array.isArray(raw.rules) ? sanitizeRules(raw.rules) : []
    };
  }

  /* ============================================================
     分类词库匹配
     ------------------------------------------------------------
     >>> 词本身写在 assets/分类词库.js 里，不在本文件。
     >>> 要加词请改那一个文件，改完刷新页面就生效。

     这里只负责把那份词表「编译」成能匹配的正则，规则是：

     - 按 CATEGORY_ORDER 的顺序从上往下试，命中第一组就返回
       —— **所以顺序就是优先级**。
     - 同一组内部的词**从长到短**排。中文没有词边界，长词优先
       能避免「中国移动」被「移动」抢走、「样例长词店」被「样例」抢走。
     - 分组顺序的原则：**越具体、越不会误伤的排前面**。
       已知的几组冲突（改顺序前先想清楚）：
         · 药店/医院  必须早于 日用   （否则「口罩」被日用抓走）
         · 打印       必须早于 日用   （否则「纸张」先中日用）
         · 话费/宽带  必须早于 日用   （否则「充值卡」先中）
         · 罚款/证件  必须早于 交通   （否则「交警支队」先中交通）

     注意：词表里用户可能把某个分类名写重复、或写成不认识的
     名字、或漏掉结尾逗号。这里全部容错——认不出来就跳过，
     绝不会因为词库写错而让记账本打不开。
     ============================================================ */

  /* 中文分类名 → 内部分类 id。
     左边是「分类词库.js」里用的名字，右边是这个程序的分类 id
     （见 DEFAULT_CATEGORIES）。 */
  var RULE_GROUP_IDS = [
    ['餐饮', 'food'],     ['交通', 'traffic'], ['购物', 'shop'],
    ['居住', 'home'],     ['娱乐', 'fun'],     ['医疗', 'health'],
    ['人情', 'social'],   ['学习', 'study'],   ['日用', 'daily'],
    ['工资', 'salary'],   ['奖金', 'bonus'],   ['兼职', 'parttime'],
    ['投资', 'invest'],   ['红包', 'gift']
  ];

  /* 分组的先后顺序 = 优先级。想调整优先级就改这个数组的次序。 */
  var CATEGORY_ORDER = [
    '医疗', '学习', '居住', '交通', '餐饮', '娱乐', '购物', '人情', '日用',
    '工资', '奖金', '兼职', '投资', '红包'
  ];

  /* 把用户词表里的一组词拼成一个正则。
     - 词按长度倒序：长词先试，避免被短词抢先命中
     - 正则里要转义的字符（. * + ? ^ $ { } ( ) | [ ] \ ）逐个转义
     - 转义会让正则变长，攒到 ~2000 字符就切成一条新的，
       避免个别浏览器对超长正则的限制 */
  function buildRuleRegex(words) {
    var parts = [];
    for (var w = 0; w < words.length; w++) {
      var s = String(words[w] == null ? '' : words[w]).replace(/^\s+|\s+$/g, '');
      if (s) { parts.push(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
    }
    if (!parts.length) { return null; }
    parts.sort(function (a, b) { return b.length - a.length; });
    var regexes = [], cur = [];
    for (var i = 0; i < parts.length; i++) {
      cur.push(parts[i]);
      if (cur.join('|').length >= 2000) {
        regexes.push(new RegExp(cur.join('|'), 'i'));
        cur = [];
      }
    }
    if (cur.length) { regexes.push(new RegExp(cur.join('|'), 'i')); }
    return regexes;
  }

  /* 词表 → 检查清单。返回一条条规则，交给 compileRules 编排。 */
  function collectRules(raw) {
    var out = [];
    if (raw && typeof raw === 'object') {
      for (var i = 0; i < RULE_GROUP_IDS.length; i++) {
        var cn = RULE_GROUP_IDS[i][0];
        var id = RULE_GROUP_IDS[i][1];
        var words = raw[cn];
        if (typeof words === 'string') { words = words.split(/[,，、\s]+/); }
        if (!(words instanceof Array) || !words.length) { continue; }
        var regexes = buildRuleRegex(words);
        if (!regexes || !regexes.length) { continue; }
        var kind = /^(salary|bonus|parttime|invest|gift)$/.test(id) ? 'income' : 'expense';
        out.push({ name: cn, id: id, kind: kind, regexes: regexes });
      }
    }

    /* 把「没写进来」和「写错了」的分类补成没有规则的占位，
       保证清单永远是完整的十四类，一眼能看出漏了谁。 */
    var seen = {};
    for (var j = 0; j < out.length; j++) { seen[out[j].name] = true; }
    var missing = [];
    for (var k = 0; k < RULE_GROUP_IDS.length; k++) {
      if (seen[RULE_GROUP_IDS[k][0]]) { continue; }
      var g = RULE_GROUP_IDS[k];
      missing.push({ name: g[0], id: g[1], regexes: [], empty: true });
    }

    /* 按优先级排序：CATEGORY_ORDER 里点过名的排前面，其余按原顺序兜底。 */
    var rank = {};
    for (var n = 0; n < CATEGORY_ORDER.length; n++) { rank[CATEGORY_ORDER[n]] = n; }
    out.sort(function (a, b) {
      var ra = rank[a.name], rb = rank[b.name];
      if (ra == null) { ra = 999; }
      if (rb == null) { rb = 999; }
      return ra - rb;
    });

    return { rules: out, missing: missing };
  }

  /* 词表（window.MY_RULES 的内容）→ 可用于匹配的扁平规则数组。
     与旧版 compileRules 行为一致，只是把结果作为值返回，
     不再直接写 window（挂 __RULE_INFO__ 由调用方决定）。 */
  function compileRules(raw) {
    var res = collectRules(raw);
    var list = [];
    for (var i = 0; i < res.rules.length; i++) {
      var r = res.rules[i];
      for (var j = 0; j < r.regexes.length; j++) {
        list.push([r.kind, r.regexes[j], r.id]);
      }
    }
    return {
      list: list,
      info: {
        total: list.length,
        missing: res.missing.map(function (m) { return m.name; }),
        loaded: res.rules.length
      }
    };
  }

  /* 词库没读到（文件被删、路径不对、语法写坏）时，别让记账本打不开，
     退回一套最小规则。 */
  function fallbackRules() {
    return [
      ['expense', /外卖|餐饮|餐厅|咖啡|奶茶|面馆|食堂/i, 'food'],
      ['expense', /打车|地铁|公交|加油|停车|高铁|机票/i, 'traffic'],
      ['expense', /医院|药房|药店|诊所|挂号/i, 'health'],
      ['expense', /房租|物业|水费|电费|燃气|宽带|话费/i, 'home'],
      ['expense', /电影|游戏|会员|门票|旅游|健身/i, 'fun'],
      ['income',  /工资|薪资|薪水|代发/i, 'salary'],
      ['income',  /红包|转账|退款/i, 'gift']
    ];
  }

  /* rules 是 compileRules(...).list 或 fallbackRules() 的产物 */
  function guessCategory(rules, text, type) {
    var t = String(text || '');
    for (var i = 0; i < rules.length; i++) {
      if (rules[i][0] === type && rules[i][1].test(t)) { return rules[i][2]; }
    }
    return type === 'income' ? 'other_i' : 'other_e';
  }

  /* ============================================================
     账单解析（微信 / 支付宝）
     ------------------------------------------------------------
     两家都不提供个人消费接口，只能从 App 里导出账单文件。
     文件都是「前面几行说明 + 一张表」，所以这里做三件事：
     认格式（CSV / xlsx）→ 找到表头 → 按列名取字段。
     账目 id 直接用「交易单号」，重复导入自然就不会重复记账。
     ============================================================ */

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
     两个来源的差别只有一处：xlsx 的时间是序列号，要换算。
     rules 参数：guessCategory 用的已编译规则（compileRules().list）。
     userRules 参数：用户自己学出来的「关键词 → 分类」规则（db.rules），
     优先级高于词库——用户改过两次的店，就该按用户的来。 */
  function parseBillTable(rows, serialTime, rules, userRules) {
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
      var dateStr = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
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
      /* 先看用户自己的规则（改过分类的店），没有再走词库与交易类型兜底 */
      var categoryId = matchRule(userRules, guessText);
      if (!categoryId) { categoryId = guessCategory(rules || [], guessText, type); }
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
        /* 来源跟着账单是谁家的走：流水里一眼能看出这笔是导入的还是自己记的 */
        source: isWx ? 'wechat' : 'alipay',
        createdAt: ts,
        updatedAt: ts
      });
    }

    return { ok: true, kind: head.kind, rows: out, skip: skip, total: rows.length };
  }

  function parseBillText(text, rules, userRules) {
    return parseBillTable(csvToRows(text), false, rules, userRules);
  }

  /* 微信给的是 xlsx：先还原成二维表，再走同一套解析 */
  function parseBillXlsx(buf, rules, userRules) {
    return parseBillTable(xlsxToRows(buf), true, rules, userRules);
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
     换算放在知道列含义之后做（见 xlsxSerialToMs）。 */
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

  return {
    /* 日期 */
    pad2: pad2, ymd: ymd, parseYmd: parseYmd, todayStr: todayStr, dayHead: dayHead, uid: uid,
    /* 金额 */
    toCents: toCents, sumCents: sumCents, fmtMoney: fmtMoney, fmtShort: fmtShort,
    parseAmountToCents: parseAmountToCents,
    normalizeExpr: normalizeExpr, tokenizeExpr: tokenizeExpr,
    evalExpr: evalExpr, evalAmountToCents: evalAmountToCents,
    /* 数据结构与清洗 */
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES, freshDB: freshDB, sanitizeTx: sanitizeTx,
    sanitizeDB: sanitizeDB, mergeTransactions: mergeTransactions, normalizeImport: normalizeImport,
    sanitizeBudgets: sanitizeBudgets, sanitizeRecurs: sanitizeRecurs,
    sanitizeRules: sanitizeRules, sanitizeCategory: sanitizeCategory, catColor: catColor,
    /* 分类自定义（增删改 / 归档） */
    addCategory: addCategory, updateCategory: updateCategory,
    removeCategory: removeCategory, archiveCategory: archiveCategory,
    countTxInCategory: countTxInCategory, activeCategories: activeCategories,
    /* 预算（含跨月结转） */
    monthBefore: monthBefore, budgetOf: budgetOf, budgetCtx: budgetCtx, monthBudget: monthBudget,
    /* 导入规则（关键词 → 分类） */
    peerOfNote: peerOfNote, learnableKeyword: learnableKeyword,
    learnRule: learnRule, matchRule: matchRule, matchRuleEntry: matchRuleEntry,
    bumpRuleHits: bumpRuleHits,
    /* 软删除 / 周期记账 / CSV / 年度报告 */
    purgeDeleted: purgeDeleted, applyRecurring: applyRecurring,
    findDataIssues: findDataIssues,
    daysInMonth: daysInMonth, recurDayInMonth: recurDayInMonth,
    txsToCsv: txsToCsv, yearReport: yearReport,
    /* 流水筛选 */
    inMonth: inMonth, filterTx: filterTx, sortTxDesc: sortTxDesc,
    hasExtraFilter: hasExtraFilter, normCategoryFilter: normCategoryFilter,
    toggleCategoryFilter: toggleCategoryFilter, cleanCategoryFilter: cleanCategoryFilter,
    /* 统计口径 */
    expenseTx: expenseTx, incomeTx: incomeTx, transferTx: transferTx, countStats: countStats,
    monthStats: monthStats, compareMonths: compareMonths,
    monthCalendar: monthCalendar,
    /* 疑似转账（不计收支） */
    isTransferLike: isTransferLike, isTransferKind: isTransferKind,
    findTransferSuspects: findTransferSuspects, markAsTransfer: markAsTransfer,
    /* 账单来源 */
    SOURCE_LABEL: SOURCE_LABEL, normSource: normSource, srcOf: srcOf,
    TYPE_LABEL: TYPE_LABEL, countsInStats: countsInStats,
    /* 词库匹配 */
    RULE_GROUP_IDS: RULE_GROUP_IDS, CATEGORY_ORDER: CATEGORY_ORDER,
    buildRuleRegex: buildRuleRegex, collectRules: collectRules,
    compileRules: compileRules, fallbackRules: fallbackRules, guessCategory: guessCategory,
    /* 账单解析 */
    decodeBillBytes: decodeBillBytes, pickCol: pickCol, fieldOf: fieldOf,
    parseBillTime: parseBillTime, splitCsvLine: splitCsvLine, csvToRows: csvToRows,
    parseBillTable: parseBillTable, parseBillText: parseBillText, parseBillXlsx: parseBillXlsx,
    /* xlsx */
    zipRead: zipRead, zipEntry: zipEntry, zipNeed: zipNeed, xmlUnescape: xmlUnescape,
    xlsxColNum: xlsxColNum, xlsxSharedStrings: xlsxSharedStrings, xlsxToRows: xlsxToRows,
    xlsxSerialToMs: xlsxSerialToMs, xlsxTimeCell: xlsxTimeCell
  };
});
