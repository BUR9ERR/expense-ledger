'use strict';

/* ============================================================
   core.js 纯逻辑测试
   ------------------------------------------------------------
   全部使用合成的假数据（假商户名、假单号），与真实词库
   assets/分类词库.js 无任何关系——测试不读取、不引用那个文件。
   运行：node --test tests/
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../assets/core.js');

/* ---------- 金额 ---------- */

test('toCents 用分参与计算，避开浮点误差', () => {
  assert.strictEqual(C.toCents(0.1 + 0.2), 30);
  assert.strictEqual(C.toCents(12.5), 1250);
  assert.strictEqual(C.toCents(-3.2), -320);
});

test('parseAmountToCents 剥离杂字符并四舍五入到分', () => {
  assert.strictEqual(C.parseAmountToCents('12.5'), 1250);
  assert.strictEqual(C.parseAmountToCents('¥1,234.56'), 123456);
  /* 第三位小数四舍五入 */
  assert.strictEqual(C.parseAmountToCents('1.234'), 123);
  assert.strictEqual(C.parseAmountToCents('1.235'), 124);
  assert.strictEqual(C.parseAmountToCents(''), 0);
  assert.strictEqual(C.parseAmountToCents('abc'), 0);
});

test('fmtMoney 千分位与负数', () => {
  assert.strictEqual(C.fmtMoney(0), '¥0');
  assert.strictEqual(C.fmtMoney(5), '¥0.05');
  assert.strictEqual(C.fmtMoney(50), '¥0.50');
  assert.strictEqual(C.fmtMoney(123456), '¥1,234.56');
  assert.strictEqual(C.fmtMoney(-50), '-¥0.50');
  assert.strictEqual(C.fmtMoney(-123456789), '-¥1,234,567.89');
});

test('fmtShort 万 / k 缩写', () => {
  assert.strictEqual(C.fmtShort(99900), '999');
  assert.strictEqual(C.fmtShort(100000), '1k');
  assert.strictEqual(C.fmtShort(150000), '1.5k');
  assert.strictEqual(C.fmtShort(1000000), '1万');      // ¥10,000
  assert.strictEqual(C.fmtShort(120000000), '120万');  // ¥1,200,000
});

/* ---------- 金额算式（记账时的 23+18） ---------- */

const cents = (s) => C.evalAmountToCents(s);

test('金额算式：单个数字与老行为一致', () => {
  assert.strictEqual(cents('23'), 2300);
  assert.strictEqual(cents('23.5'), 2350);
  assert.strictEqual(cents('0.1'), 10);
  assert.strictEqual(cents('0.025'), 3, '四舍五入到分');
  assert.strictEqual(cents('0'), 0);
  /* 注意：算式求值走的是 Number（IEEE754），不像 parseAmountToCents 那样按字符串
     取到分。所以 '1.005' 这种「二进制表示本身就不精确」的输入会得到 100 而不是 101。
     记账场景里这是可接受的（人手输入的金额不会有 1.005 这种三分位），
     真要做金额级的精确运算得引入整数分词器，代价不值。 */
  assert.strictEqual(cents('1.005'), 100);
  /* 老接口（纯数字走 parseAmountToCents）不受影响 */
  assert.strictEqual(C.parseAmountToCents('1.005'), 101);
});

test('金额算式：加减乘除与优先级', () => {
  assert.strictEqual(cents('23+18'), 4100);
  assert.strictEqual(cents('100-12.5'), 8750);
  assert.strictEqual(cents('35*2'), 7000);
  assert.strictEqual(cents('100/4'), 2500);
  /* 先乘除后加减 */
  assert.strictEqual(cents('10+2*3'), 1600);
  assert.strictEqual(cents('2*3+10'), 1600);
  assert.strictEqual(cents('100-2*3'), 9400);
  assert.strictEqual(cents('10/4+1'), 350);
  /* 连续加减、多个运算符 */
  assert.strictEqual(cents('12+8+35'), 5500);
  assert.strictEqual(cents('100-10-20'), 7000);
  assert.strictEqual(cents('1+2*3*4'), 2500);
});

test('金额算式：全角运算符与空格', () => {
  assert.strictEqual(cents('23 ＋ 18'), 4100);
  assert.strictEqual(cents('35×2'), 7000);
  assert.strictEqual(cents('100÷4'), 2500);
  assert.strictEqual(cents('100－12.5'), 8750);
  assert.strictEqual(cents(' 12 + 8 '), 2000);
});

test('金额算式：非法输入一律返回 null（不猜、不抛异常）', () => {
  assert.strictEqual(cents(''), null);
  assert.strictEqual(cents('abc'), null);
  assert.strictEqual(cents('23+'), null, '结尾是运算符');
  assert.strictEqual(cents('+23'), 2300, '开头正号当符号');
  assert.strictEqual(cents('23++18'), null, '连续运算符');
  assert.strictEqual(cents('23+*18'), null);
  assert.strictEqual(cents('100/0'), null, '除零');
  assert.strictEqual(cents('1/3'), 33, '循环小数取到分');
  assert.strictEqual(cents('12-30'), null, '负数金额不接受');
  assert.strictEqual(cents(null), null);
});

test('normalizeExpr / tokenizeExpr：归一化与分词可单独测', () => {
  assert.strictEqual(C.normalizeExpr('23 × 2'), '23*2');
  assert.strictEqual(C.normalizeExpr(' 1 ＋ 2 '), '1+2');
  assert.deepStrictEqual(C.tokenizeExpr('1+2*3'), ['1', '+', '2', '*', '3']);
  assert.deepStrictEqual(C.tokenizeExpr('-12+5'), ['-12', '+', '5']);
  assert.strictEqual(C.tokenizeExpr('1+'), null);
  assert.strictEqual(C.tokenizeExpr('1a'), null);
});

/* ---------- 日期 ---------- */

test('ymd 补零、parseYmd 还原', () => {
  assert.strictEqual(C.ymd(new Date(2026, 0, 5)), '2026-01-05');
  const d = C.parseYmd('2026-10-03');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 9);
  assert.strictEqual(d.getDate(), 3);
});

test('dayHead 分组标题（今天 / 日期+星期）', () => {
  const today = C.todayStr();
  assert.ok(C.dayHead(today).indexOf('今天') === 0);
  assert.ok(C.dayHead('2026-01-01').indexOf('1月1日') >= 0);
});

/* ---------- 数据清洗 ---------- */

test('sanitizeDB 定形合法账目，丢掉无 id 和金额非法的坏账', () => {
  const db = C.sanitizeDB({
    categories: [{ id: 'x', name: '自定' }, '垃圾', null],
    transactions: [
      { id: 'a', amount: '12.5', date: '2026-01-02', type: 'income' },
      { amount: 5 },                      // 无 id → 丢
      { id: 'b', amount: '不是数字' },      // 金额非法 → 丢
      { id: 'c', amount: 3, createdAt: 1700000000000 } // 无日期 → 回退 createdAt
    ],
    createdAt: 1
  });
  assert.strictEqual(db.categories.length, 1);
  assert.strictEqual(db.transactions.length, 2);
  assert.strictEqual(db.transactions[0].amount, 12.5);
  assert.strictEqual(db.transactions[0].type, 'income');
  assert.strictEqual(db.transactions[1].id, 'c');
  assert.match(db.transactions[1].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('sanitizeDB 备份字段齐全、空输入给默认结构', () => {
  const empty = C.sanitizeDB(null);
  assert.strictEqual(empty.version, 1);
  assert.deepStrictEqual(empty.transactions, []);
  assert.ok(Array.isArray(empty.categories) && empty.categories.length > 0);
});

test('sanitizeDB limits 上限生效（服务端防撑爆用）', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: 't' + i, amount: 1 }));
  const cats = Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, name: '分类' + i }));
  const db = C.sanitizeDB(
    { transactions: many, categories: cats },
    { maxTransactions: 10, maxCategories: 2 });
  assert.strictEqual(db.transactions.length, 10);
  assert.strictEqual(db.categories.length, 2);
});

/* ---------- 账单来源 ---------- */

test('srcOf：显式字段优先，没有就按单号前缀认，认不出算手动', () => {
  assert.strictEqual(C.srcOf({ source: 'wechat', id: 'a' }), 'wechat');
  assert.strictEqual(C.srcOf({ source: 'alipay' }), 'alipay');
  assert.strictEqual(C.srcOf({ source: 'manual' }), 'manual');
  assert.strictEqual(C.srcOf({ source: '乱写的', id: 'wx:123' }), 'wechat');
  /* 加来源功能之前导入的老记录：无 source 字段，但 id 记着出处 */
  assert.strictEqual(C.srcOf({ id: 'wx:1000123', amount: 1 }), 'wechat');
  assert.strictEqual(C.srcOf({ id: 'ali:20260901', amount: 1 }), 'alipay');
  assert.strictEqual(C.srcOf({ id: '手工记的id', amount: 1 }), 'manual');
  assert.strictEqual(C.srcOf(null), 'manual');
});

test('normSource 只认三个合法值，其余一律手动', () => {
  assert.strictEqual(C.normSource('wechat'), 'wechat');
  assert.strictEqual(C.normSource('alipay'), 'alipay');
  assert.strictEqual(C.normSource('manual'), 'manual');
  assert.strictEqual(C.normSource('wx'), 'manual');
  assert.strictEqual(C.normSource(undefined), 'manual');
});

test('sanitizeTx 保留合法 source，非法/缺失不写字段（老数据推断留给 srcOf）', () => {
  const kept = C.sanitizeTx({ id: 'a', amount: 1, source: 'wechat' });
  assert.strictEqual(kept.source, 'wechat');
  const dropped = C.sanitizeTx({ id: 'b', amount: 1, source: 'hacker' });
  assert.ok(!('source' in dropped), '非法值不能进数据');
  const old = C.sanitizeTx({ id: 'wx:1', amount: 1 });
  assert.ok(!('source' in old), '老记录不补写字段，数据保持原样');
  /* JSON 落盘后老记录保持无 source，srcOf 读取时照样认得出 */
  const round = JSON.parse(JSON.stringify(C.sanitizeDB({ transactions: [old] })));
  assert.strictEqual(C.srcOf(round.transactions[0]), 'wechat');
});

test('normalizeImport 带上合法 source', () => {
  const r = C.normalizeImport({
    transactions: [
      { id: 'a', date: '2026-01-01', amount: 5, source: 'alipay' },
      { id: 'b', date: '2026-01-02', amount: 5, source: '垃圾值' },
      { id: 'c', date: '2026-01-03', amount: 5 }
    ]
  });
  assert.strictEqual(r.transactions[0].source, 'alipay');
  assert.ok(!('source' in r.transactions[1]));
  assert.ok(!('source' in r.transactions[2]));
});

test('SOURCE_LABEL 三个来源都有中文标签', () => {
  assert.strictEqual(Object.keys(C.SOURCE_LABEL).length, 3);
  assert.ok(C.SOURCE_LABEL[C.srcOf({ id: 'wx:1' })]);
  assert.ok(C.SOURCE_LABEL[C.srcOf({ id: 'ali:1' })]);
  assert.ok(C.SOURCE_LABEL[C.srcOf({ id: 'x' })]);
});

/* ---------- 软删除 / 周期记账 / CSV / 年度报告 / 预算 ---------- */

test('sanitizeTx 保留 deletedAt 与 recurId，非法值不进数据', () => {
  const del = C.sanitizeTx({ id: 'a', amount: 1, deletedAt: 12345 });
  assert.strictEqual(del.deletedAt, 12345);
  const rid = C.sanitizeTx({ id: 'b', amount: 1, recurId: 'recur:t1:2026-10' });
  assert.strictEqual(rid.recurId, 'recur:t1:2026-10');
  const bad = C.sanitizeTx({ id: 'c', amount: 1, deletedAt: '不是数字', recurId: 42 });
  assert.ok(!('deletedAt' in bad));
  assert.ok(!('recurId' in bad));
  /* 软删除的账在 sanitizeDB 往返后仍是墓碑（同步链路不丢删除） */
  const round = JSON.parse(JSON.stringify(C.sanitizeDB({ transactions: [del] })));
  assert.strictEqual(round.transactions[0].deletedAt, 12345);
});

test('sanitizeDB 收口 budgets 与 recur，垃圾值丢弃', () => {
  const db = C.sanitizeDB({
    transactions: [],
    budgets: {
      '2026-10': { total: 2000.5, food: 600, 垃圾键: 'x' },
      '不是月份': { total: 1 },
      '2026-11': '垃圾'
    },
    recur: [
      { id: 'r1', type: 'expense', amount: 15, categoryId: 'food', note: '话费', day: 10 },
      { id: '', amount: 5, day: 1 },        // 无 id → 丢
      { id: 'r2', amount: 'x', day: 1 },    // 金额非法 → 丢
      { id: 'r3', amount: 5, day: 99 }      // 日期非法 → 丢
    ]
  });
  assert.strictEqual(db.budgets['2026-10'].total, 2000.5);
  assert.strictEqual(db.budgets['2026-10'].food, 600);
  assert.ok(!('垃圾键' in db.budgets['2026-10']));
  assert.ok(!db.budgets['不是月份'] && !db.budgets['2026-11']);
  assert.strictEqual(db.recur.length, 1);
  assert.strictEqual(db.recur[0].note, '话费');
  /* 空库回落空结构（freshDB 形状齐全） */
  assert.deepStrictEqual(C.sanitizeDB(null).budgets, {});
  assert.deepStrictEqual(C.sanitizeDB(null).recur, []);
});

test('purgeDeleted：30 天内的墓碑保留，过期的清掉', () => {
  const now = 100 * 86400000;
  const r = C.purgeDeleted([
    { id: 'a', amount: 1 },
    { id: 'b', amount: 1, deletedAt: now - 29 * 86400000 },  // 29 天前删 → 留
    { id: 'c', amount: 1, deletedAt: now - 31 * 86400000 },  // 31 天前删 → 清
    { id: 'd', amount: 1, deletedAt: now }                    // 刚删 → 留
  ], now);
  assert.deepStrictEqual(r.kept.map(t => t.id), ['a', 'b', 'd']);
  assert.strictEqual(r.purged, 1);
});

test('applyRecurring：到期补记、幂等不重复、未到期不补', () => {
  const now = 1759000000000;
  const recus = [
    { id: 'r1', type: 'expense', amount: 15, categoryId: 'food', note: '话费', day: 5 },
    { id: 'r2', type: 'expense', amount: 30, categoryId: 'home', note: '房租', day: 20 }
  ];
  const txs = [{ id: 'old', amount: 1, date: '2026-10-01' }];
  // 今天 10 月 6 日：r1（5 号）该补，r2（20 号）没到
  const out = C.applyRecurring(recus, txs, '2026-10-06', now);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'recur:r1:2026-10');
  assert.strictEqual(out[0].recurId, 'recur:r1:2026-10');
  assert.strictEqual(out[0].amount, 15);
  /* 日期记在模板落点那天（5 号），不是「打开记账本那天」（6 号）——
     补记的账该落在它本来的日子上，否则月度统计和对账都会偏 */
  assert.strictEqual(out[0].date, '2026-10-05');
  // 补完再跑：已存在同 recurId → 不重复
  const txs2 = txs.concat(out);
  assert.strictEqual(C.applyRecurring(recus, txs2, '2026-10-06', now).length, 0);
  // 已删的补记账仍占位（防止删掉后同月又被补回来）
  const txs3 = txs.concat(out.map(t => Object.assign({}, t, { deletedAt: now })));
  assert.strictEqual(C.applyRecurring(recus, txs3, '2026-10-06', now).length, 0);
});

test('txsToCsv：BOM 开头、特殊字符转义、软删除不导出', () => {
  const csv = C.txsToCsv([
    { id: 'a', date: '2026-10-01', type: 'expense', amount: 12.5, categoryId: 'food', note: '美团 · 外卖', source: 'wechat' },
    { id: 'c', date: '2026-10-03', type: 'expense', amount: 1, categoryId: 'food', note: '含,逗号 "引号"' },
    { id: 'b', date: '2026-10-02', type: 'income', amount: 3, categoryId: 'salary', note: '已删除的', deletedAt: 123 }
  ], id => ({ food: '餐饮', salary: '工资' }[id] || '其他'));
  assert.ok(csv.indexOf('\uFEFF') === 0);
  assert.ok(csv.indexOf('\r\n') > 0);
  assert.ok(csv.indexOf('支出,餐饮,12.5,微信,美团 · 外卖') > 0);
  assert.ok(csv.indexOf('b') < 0, '软删除的账不导出');
  assert.ok(csv.indexOf('"含,逗号 ""引号"""') > 0);
});

test('yearReport：总额、逐月、最大单笔、常去收款方、软删除不算', () => {
  const mk = (id, date, amount, type, note, extra) =>
    Object.assign({ id, date, type, amount, categoryId: 'food', note }, extra);
  const r = C.yearReport([
    mk('a', '2026-01-05', 100, 'expense', '美团 · 外卖'),
    mk('b', '2026-01-20', 50, 'expense', '美团 · 猪脚饭'),
    mk('c', '2026-03-01', 2026, 'expense', '大件 · 家电'),
    mk('d', '2026-02-01', 5000, 'income', '工资'),
    mk('e', '2025-12-01', 999, 'expense', '去年的'),
    mk('f', '2026-06-01', 77, 'expense', '已删的', { deletedAt: 1 })
  ], 2026);
  assert.strictEqual(r.expenseCents, (100 + 50 + 2026) * 100);
  assert.strictEqual(r.incomeCents, 5000 * 100);
  assert.strictEqual(r.byMonth[0], 150 * 100);
  assert.strictEqual(r.byMonth[2], 2026 * 100);
  assert.strictEqual(r.maxTx.id, 'c');
  assert.deepStrictEqual(r.topPeers[0], { name: '大件', cents: 2026 * 100 });
  assert.deepStrictEqual(r.topPeers[1], { name: '美团', cents: 150 * 100 });
  assert.strictEqual(r.topPeers.length, 2);
});

test('normalizeImport 带上 deletedAt / recurId', () => {
  const r = C.normalizeImport({
    transactions: [
      { id: 'a', date: '2026-01-01', amount: 5, deletedAt: 9, recurId: 'recur:r1:2026-01' },
      { id: 'b', date: '2026-01-02', amount: 5, deletedAt: '垃圾' }
    ]
  });
  assert.strictEqual(r.transactions[0].deletedAt, 9);
  assert.strictEqual(r.transactions[0].recurId, 'recur:r1:2026-01');
  assert.ok(!('deletedAt' in r.transactions[1]));
});

test('normalizeImport 带回预算与周期模板（备份完整往返），坏值收口', () => {
  const r = C.normalizeImport({
    transactions: [{ id: 'a', date: '2026-01-01', amount: 5 }],
    budgets: { '2026-01': { total: 1000, food: 300 }, '垃圾月': { total: 1 } },
    recur: [
      { id: 'r1', amount: 15, day: 5, note: '话费' },
      { id: 'r2', amount: -1, day: 5 }   // 金额非法 → 丢
    ]
  });
  assert.strictEqual(r.budgets['2026-01'].total, 1000);
  assert.strictEqual(r.budgets['2026-01'].food, 300);
  assert.ok(!r.budgets['垃圾月']);
  assert.strictEqual(r.recur.length, 1);
  assert.strictEqual(r.recur[0].note, '话费');
  /* 早先的备份没有这两个字段 → 回落空值，不报错 */
  const old = C.normalizeImport({ transactions: [{ id: 'b', date: '2026-01-02', amount: 1 }] });
  assert.deepStrictEqual(old.budgets, {});
  assert.deepStrictEqual(old.recur, []);
});

/* ---------- 冲突合并 ---------- */

test('mergeTransactions：两边都有取 updatedAt 新的', () => {
  const r = C.mergeTransactions(
    [{ id: 'a', updatedAt: 5, createdAt: 1, note: 'local' }],
    [{ id: 'a', updatedAt: 9, createdAt: 1, note: 'remote' }],
    0);
  assert.strictEqual(r.transactions[0].note, 'remote');
  assert.strictEqual(r.tookLocalUpdates, 0);

  const r2 = C.mergeTransactions(
    [{ id: 'a', updatedAt: 10, createdAt: 1, note: 'local-new' }],
    [{ id: 'a', updatedAt: 9, createdAt: 1, note: 'remote' }],
    0);
  assert.strictEqual(r2.transactions[0].note, 'local-new');
  assert.strictEqual(r2.tookLocalUpdates, 1);
});

test('mergeTransactions：本地新账保留，残留丢弃', () => {
  const r = C.mergeTransactions(
    [
      { id: 'fresh', createdAt: 200, updatedAt: 200 },  // lastPushAt=100 之后记的 → 保留
      { id: 'stale', createdAt: 50, updatedAt: 50 }     // 更早 → 服务端已删的残留 → 丢
    ],
    [],
    100);
  assert.strictEqual(r.transactions.length, 1);
  assert.strictEqual(r.transactions[0].id, 'fresh');
  assert.strictEqual(r.keptLocalNew, 1);
  assert.strictEqual(r.droppedStale, 1);
});

test('mergeTransactions：不改入参数组', () => {
  const local = [{ id: 'x', createdAt: 999, updatedAt: 999 }];
  const remote = [{ id: 'y', createdAt: 1, updatedAt: 1 }];
  C.mergeTransactions(local, remote, 0);
  assert.strictEqual(local.length, 1);
  assert.strictEqual(remote.length, 1);
});

/* ---------- 词库编译与匹配（全部合成词，与真实词库无关） ---------- */

test('compileRules 编译词表并报告缺失分组', () => {
  const r = C.compileRules({ 餐饮: ['测试面馆', '样本餐厅'], 红包: ['样例红包'] });
  assert.strictEqual(r.info.loaded, 2);
  assert.ok(r.info.missing.indexOf('交通') >= 0);   // 没写的组会出现在缺失清单
  assert.ok(r.list.some(x => x[2] === 'food'));
  assert.ok(r.list.some(x => x[2] === 'gift'));
});

test('词组里的正则特殊字符被转义，长词优先匹配', () => {
  const r = C.compileRules({ 购物: ['样例.超市(东门店)', '样例超市旗舰'] });
  assert.ok(r.list.some(x => x[2] === 'shop'));
  const shop = r.list.filter(x => x[2] === 'shop');
  const hit = shop.some(x => x[1].test('去了样例超市旗舰店'));
  assert.ok(hit, '长词应能命中');
});

test('collectRules 容错：词库写坏不会抛异常', () => {
  const r = C.collectRules({ 餐饮: '不是数组', 交通: [], 购物: null, 居住: undefined });
  /* 空组跳过；字符串值按分隔符拆成词 */
  assert.ok(r.rules.every(x => x.id !== 'traffic'));
  assert.strictEqual(r.rules.filter(x => x.id === 'food').length, 1);
});

test('guessCategory 命中返回分类 id，未命中回落其他', () => {
  const r = C.compileRules({ 餐饮: ['测试面馆'] });
  assert.strictEqual(C.guessCategory(r.list, '去测试面馆', 'expense'), 'food');
  assert.strictEqual(C.guessCategory(r.list, '完全无关的地方', 'expense'), 'other_e');
  assert.strictEqual(C.guessCategory(r.list, '完全无关的地方', 'income'), 'other_i');
});

test('fallbackRules 始终可用', () => {
  const fb = C.fallbackRules();
  assert.ok(fb.length > 0);
  assert.strictEqual(C.guessCategory(fb, '楼下面馆吃面', 'expense'), 'food');
});

/* ---------- CSV / 账单解析（合成账单行） ---------- */

test('splitCsvLine 处理引号转义与零宽字符', () => {
  assert.deepStrictEqual(
    C.splitCsvLine('a,"b""c",d'),
    ['a', 'b"c', 'd']);
  /* 支付宝在订单号后粘的 Tab 排版垃圾要被清掉，但不能当分隔符 */
  const cols = C.splitCsvLine('10001\t,12.50,,备注');
  assert.strictEqual(cols[0], '10001');
  assert.strictEqual(cols.length, 4);
  const zw = C.splitCsvLine('1000\u200B1,x');
  assert.strictEqual(zw[0], '10001');
});

test('csvToRows 丢空行、兼容 CRLF', () => {
  const rows = C.csvToRows('a,b\r\nc,d\r\n\r\n,e,\n');
  assert.strictEqual(rows.length, 3);
});

test('parseBillTable 认微信表头并按单号生成 id', () => {
  const rules = C.compileRules({ 餐饮: ['样例饭店'] }).list;
  const csv = [
    '微信支付账单明细,,,',
    '交易时间,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2026-09-01 12:00:00,样例饭店,午餐,支出,¥12.50,零钱,支付成功,1000123,/,/',
    '2026-09-02 08:00:00,某人,转账,/,0.01,零钱,已收钱,1000124,/,/',
    '2026-09-03 09:00:00,样例饭店,退款,支出,¥5.00,零钱,已退款(全额),1000125,/,/'
  ].join('\n');
  const res = C.parseBillText(csv, rules);
  assert.ok(res.ok);
  assert.strictEqual(res.kind, 'wx');
  /* 第二行「/」不计收支跳过；第三行退款跳过 */
  assert.strictEqual(res.rows.length, 1);
  assert.strictEqual(res.rows[0].id, 'wx:1000123');
  assert.strictEqual(res.rows[0].amount, 12.5);
  assert.strictEqual(res.rows[0].type, 'expense');
  assert.strictEqual(res.rows[0].source, 'wechat');
  assert.strictEqual(res.skip.refund, 1);
  assert.strictEqual(res.skip.noCount, 1);
});

test('parseBillTable 认支付宝表头（交易订单号 + 收/支 是它独有的）', () => {
  const rules = C.fallbackRules();
  const csv = [
    '支付宝交易记录明细查询,,,',
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/支付方式,交易状态,交易订单号,商家订单号,备注',
    '2026-09-01 12:00:00,餐饮美食,样例商户,acc@样例,样例商品说明,支出,25.00,余额,交易成功,20260901001,M001,/',
  ].join('\n');
  const res = C.parseBillText(csv, rules);
  assert.ok(res.ok, '应认出支付宝表头');
  assert.strictEqual(res.kind, 'ali');
  assert.strictEqual(res.rows.length, 1);
  assert.strictEqual(res.rows[0].id, 'ali:20260901001');
  assert.strictEqual(res.rows[0].amount, 25);
  assert.strictEqual(res.rows[0].source, 'alipay');
});

test('parseBillTable 没有表头时明确报 noHeader', () => {
  const res = C.parseBillText('随便什么,内容\n1,2', C.fallbackRules());
  assert.ok(!res.ok);
  assert.strictEqual(res.reason, 'noHeader');
});

test('decodeBillBytes 认 BOM、非法 UTF-8 走 GBK 不抛异常', () => {
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61, 0x62]);
  assert.strictEqual(C.decodeBillBytes(bom.buffer), 'ab');
  /* 单个 0x80 是非法 UTF-8，GBK 解码应给出某个字符而不是抛异常 */
  const bad = new Uint8Array([0x80, 0x81]);
  assert.strictEqual(typeof C.decodeBillBytes(bad.buffer), 'string');
});

/* ---------- xlsx（手搭 store 方式 zip，走完整解包路径） ---------- */

/* 构造一个 method=0（store）的最小 zip：
   zipRead 只读中央目录，zipEntry 只校验局部头签名，CRC 填 0 即可 */
function buildStoreZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);            // method = store
    local.writeUInt32LE(data.length, 18); // csize
    local.writeUInt32LE(data.length, 22); // usize
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0, 10);              // method
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

test('xlsxToRows + parseBillXlsx：store 方式 zip 全链路', () => {
  const zip = buildStoreZip([
    ['xl/sharedStrings.xml',
     '<sst><si><t>样例商户</t></si><si><t>样例商品说明</t></si></sst>'],
    ['xl/worksheets/sheet1.xml',
     '<worksheet><rows>' +
     '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
     '<row><c r="A2"><v>46267</v></c><c r="B2" t="s"><v>0</v></c></row>' +
     '</rows></worksheet>']
  ]);
  const rows = C.xlsxToRows(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][0], '样例商户');
  assert.strictEqual(rows[1][0], '46267');
});

test('xlsxSerialToMs 处理 Excel 1900 假闰年边界', () => {
  const fmt = (ms) => {
    const d = new Date(ms);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  };
  assert.strictEqual(fmt(C.xlsxSerialToMs(59)), '1900-2-28');
  assert.strictEqual(fmt(C.xlsxSerialToMs(60)), '1900-2-28'); // 不存在的 2/29
  assert.strictEqual(fmt(C.xlsxSerialToMs(61)), '1900-3-1');
  assert.strictEqual(C.xlsxSerialToMs(0), null);
  assert.strictEqual(C.xlsxSerialToMs(-1), null);
  assert.strictEqual(C.xlsxSerialToMs('abc'), null);
});

test('normalizeImport：认结构、拒垃圾、金额取分', () => {
  const ok = C.normalizeImport(JSON.stringify({
    categories: [],
    transactions: [
      { id: 'x1', type: 'expense', amount: 12.5, date: '2026-01-02' },
      { id: 'x2', type: 'income', amountCents: 500, date: '2026-01-03' },
      { id: 'x3', type: 'expense', amount: '9.9', date: '2026-01-04', createdAt: 100 }
    ]
  }));
  assert.strictEqual(ok.transactions.length, 3);
  assert.strictEqual(ok.transactions[1].amount, 5);
  assert.strictEqual(ok.transactions[2].amount, 9.9);
  assert.strictEqual(C.normalizeImport('不是json'), null);
  assert.strictEqual(C.normalizeImport('{}'), null);
});

/* ---------- 流水筛选（类型 / 来源 / 分类 / 关键词） ----------

   这套筛选是「搜索模式」与「按月浏览」共用的唯一一份规则，
   所以这里测的不是界面，而是「点哪个筛选能看见哪几笔」。 */

/* 合成账目：三个月份、两种类型、三种来源、几个分类 */
const FILTER_TX = [
  { id: 'a1', type: 'expense', amount: 10, categoryId: 'food', date: '2026-03-05', note: '楼下快餐', createdAt: 1 },
  { id: 'a2', type: 'expense', amount: 20, categoryId: 'food', date: '2026-03-06', note: '外卖', createdAt: 2 },
  { id: 'wx:1', type: 'expense', amount: 30, categoryId: 'shop', date: '2026-03-07', note: '便利店', source: 'wechat', createdAt: 3 },
  { id: 'ali:1', type: 'income', amount: 40, categoryId: 'salary', date: '2026-03-08', note: '代发工资', source: 'alipay', createdAt: 4 },
  { id: 'a3', type: 'expense', amount: 50, categoryId: 'food', date: '2026-04-01', note: '快餐', createdAt: 5 },
  { id: 'a4', type: 'expense', amount: 60, categoryId: 'traffic', date: '2026-04-02', note: '地铁', createdAt: 6, deletedAt: 999 }
];
const CAT_NAME = (id) => ({ food: '餐饮', shop: '购物', salary: '工资', traffic: '交通' }[id] || '未知');
const ids = (list) => list.map((t) => t.id);

test('filterTx：不传月份时跨月，墓碑账目永远不出现', () => {
  const all = C.filterTx(FILTER_TX, {}, CAT_NAME);
  assert.deepStrictEqual(ids(all), ['a1', 'a2', 'wx:1', 'ali:1', 'a3']);
});

test('filterTx：按月份限定', () => {
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { month: '2026-04' }, CAT_NAME)), ['a3']);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { month: '2026-03' }, CAT_NAME)),
    ['a1', 'a2', 'wx:1', 'ali:1']);
});

test('filterTx：类型 / 来源 / 分类三种筛选可叠加', () => {
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { type: 'income' }, CAT_NAME)), ['ali:1']);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { source: 'wechat' }, CAT_NAME)), ['wx:1']);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { category: ['food'] }, CAT_NAME)), ['a1', 'a2', 'a3']);
  /* 叠加：2026-03 的餐饮支出 = a1 a2（wx:1 是购物，ali:1 是收入） */
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX,
    { month: '2026-03', type: 'expense', category: ['food'] }, CAT_NAME)), ['a1', 'a2']);
  /* 老账没有 source 字段：按单号前缀认出来源，能筛得到 */
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { source: 'alipay' }, CAT_NAME)), ['ali:1']);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { source: 'manual' }, CAT_NAME)), ['a1', 'a2', 'a3']);
});

test('filterTx：分类可多选，命中任一个就留下；空选择 = 全部', () => {
  /* 多选：餐饮 + 购物 */
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { category: ['food', 'shop'] }, CAT_NAME)),
    ['a1', 'a2', 'wx:1', 'a3']);
  /* 多选 + 类型叠加：收入的分类选了也不影响支出筛选 */
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX,
    { category: ['food', 'salary'], type: 'income' }, CAT_NAME)), ['ali:1']);
  /* 空数组 / 'all' / null 都等于「全部分类」 */
  assert.strictEqual(C.filterTx(FILTER_TX, { category: [] }, CAT_NAME).length, 5);
  assert.strictEqual(C.filterTx(FILTER_TX, { category: 'all' }, CAT_NAME).length, 5);
  assert.strictEqual(C.filterTx(FILTER_TX, {}, CAT_NAME).length, 5);
  /* 单个字符串（老调用方）也认 */
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { category: 'shop' }, CAT_NAME)), ['wx:1']);
  /* 重复的 id 不影响结果 */
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { category: ['food', 'food'] }, CAT_NAME)),
    ['a1', 'a2', 'a3']);
});

test('filterTx：关键词匹配备注或分类名，大小写不敏感', () => {
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { keyword: '快餐' }, CAT_NAME)), ['a1', 'a3']);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { keyword: '购物' }, CAT_NAME)), ['wx:1']);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { keyword: '  地铁  ' }, CAT_NAME)), []);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX, { keyword: '没这个词' }, CAT_NAME)), []);
});

test('filterTx：关键词可与分类筛选叠加（搜索时筛选不能失灵）', () => {
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX,
    { keyword: '快餐', category: ['food'] }, CAT_NAME)), ['a1', 'a3']);
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX,
    { keyword: '快餐', category: ['traffic'] }, CAT_NAME)), []);
  /* 多选里只要有一个分类对得上，关键词又命中，就该留下 */
  assert.deepStrictEqual(ids(C.filterTx(FILTER_TX,
    { keyword: '快餐', category: ['traffic', 'food'] }, CAT_NAME)), ['a1', 'a3']);
});

test('sortTxDesc：日期倒序，同一天按记账时间倒序，且不改入参', () => {
  const input = [
    { id: 'x', date: '2026-03-05', createdAt: 1 },
    { id: 'y', date: '2026-03-05', createdAt: 9 },
    { id: 'z', date: '2026-03-06', createdAt: 1 }
  ];
  const out = C.sortTxDesc(input);
  assert.deepStrictEqual(ids(out), ['z', 'y', 'x']);
  assert.deepStrictEqual(ids(input), ['x', 'y', 'z'], '原数组顺序不该被改动');
});

test('filterTx：金额范围与日期范围（空值不生效）', () => {
  const tx = [
    { id: 'a', date: '2026-09-01', type: 'expense', amount: 5 },
    { id: 'b', date: '2026-09-15', type: 'expense', amount: 50 },
    { id: 'c', date: '2026-10-01', type: 'expense', amount: 500 }
  ];
  assert.deepStrictEqual(
    C.filterTx(tx, { minAmount: 10, maxAmount: 100 }).map(t => t.id), ['b'],
    '金额在 10~100 之间的只有 b');
  assert.deepStrictEqual(
    C.filterTx(tx, { minAmount: '' }).map(t => t.id), ['a', 'b', 'c'],
    '空的最小金额不生效');
  assert.deepStrictEqual(
    C.filterTx(tx, { dateFrom: '2026-09-10', dateTo: '2026-09-30' }).map(t => t.id), ['b'],
    '日期范围只命中 9 月中旬');
  assert.deepStrictEqual(
    C.filterTx(tx, { dateFrom: '2026-09-10' }).map(t => t.id), ['b', 'c'],
    '只有下限日期时取其后全部');
  /* 与其他条件叠加 */
  assert.deepStrictEqual(
    C.filterTx(tx, { minAmount: 10, type: 'income' }).length, 0,
    '金额范围与类型叠加');
});

test('findDataIssues：重复 / 未来日期 / 零金额 / 失效分类', () => {
  const categories = [{ id: 'food', kind: 'expense', name: '餐饮' }];
  const issues = C.findDataIssues([
    { id: 'a', date: '2026-09-01', type: 'expense', amount: 5, categoryId: 'food', deletedAt: 9 },
    { id: 'b', date: '2026-09-01', type: 'expense', amount: 5, categoryId: 'food' },
    { id: 'c', date: '2026-09-01', type: 'expense', amount: 5, categoryId: 'food' },
    { id: 'd', date: '2099-01-01', type: 'expense', amount: 8, categoryId: 'food' },
    { id: 'e', date: '2026-09-02', type: 'expense', amount: 0, categoryId: 'food' },
    { id: 'f', date: '2026-09-03', type: 'expense', amount: 3, categoryId: '已消失的分类' }
  ], categories, '2026-10-01');
  /* 软删除的 a 不参与；b/c 同日同额同类型 → 一组重复 */
  assert.strictEqual(issues.duplicates.length, 1);
  assert.deepStrictEqual(issues.duplicates[0].map(t => t.id), ['b', 'c']);
  assert.deepStrictEqual(issues.future.map(t => t.id), ['d']);
  assert.deepStrictEqual(issues.zero.map(t => t.id), ['e']);
  assert.deepStrictEqual(issues.orphan.map(t => t.id), ['f']);
  /* 干净账本 → 四类全空 */
  const clean = C.findDataIssues([
    { id: 'ok', date: '2026-09-05', type: 'expense', amount: 6, categoryId: 'food' }
  ], categories, '2026-10-01');
  assert.strictEqual(clean.duplicates.length, 0);
  assert.strictEqual(clean.future.length, 0);
  assert.strictEqual(clean.zero.length, 0);
  assert.strictEqual(clean.orphan.length, 0);
});

test('hasExtraFilter：只有月份不算「额外筛选」', () => {
  assert.strictEqual(C.hasExtraFilter({}), false);
  assert.strictEqual(C.hasExtraFilter({ month: '2026-03' }), false);
  assert.strictEqual(C.hasExtraFilter({ month: '2026-03', type: 'all', source: 'all', category: [] }), false);
  assert.strictEqual(C.hasExtraFilter({ type: 'income' }), true);
  assert.strictEqual(C.hasExtraFilter({ source: 'wechat' }), true);
  assert.strictEqual(C.hasExtraFilter({ category: ['food'] }), true);
  assert.strictEqual(C.hasExtraFilter({ keyword: '餐' }), true);
});

test('normCategoryFilter：数组 / 字符串 / all 都归一成干净的数组', () => {
  assert.deepStrictEqual(C.normCategoryFilter(['food', 'shop']), ['food', 'shop']);
  assert.deepStrictEqual(C.normCategoryFilter('food'), ['food']);
  assert.deepStrictEqual(C.normCategoryFilter('all'), []);
  assert.deepStrictEqual(C.normCategoryFilter(null), []);
  assert.deepStrictEqual(C.normCategoryFilter(['food', 'food', 'all', '']), ['food'], '去重、丢掉 all 与空值');
});

test('toggleCategoryFilter：点一下加进去、再点一下拿掉', () => {
  const cats = [{ id: 'food' }, { id: 'shop' }, { id: 'traffic' }];
  assert.deepStrictEqual(C.toggleCategoryFilter([], 'food', cats), ['food']);
  assert.deepStrictEqual(C.toggleCategoryFilter(['food'], 'shop', cats), ['food', 'shop']);
  assert.deepStrictEqual(C.toggleCategoryFilter(['food', 'shop'], 'food', cats), ['shop'], '再点一下取消');
  assert.deepStrictEqual(C.toggleCategoryFilter(['food'], 'all', cats), [], '「全部分类」= 清空');
  assert.deepStrictEqual(C.toggleCategoryFilter(['food'], '不存在', cats), ['food'],
    '点不认识的分类不生效，已有的选择不能丢');
  /* 选过、后来分类被换掉的 id 会被顺手清掉 */
  assert.deepStrictEqual(C.toggleCategoryFilter(['food', '已经没了'], 'shop', cats), ['food', 'shop']);
});

test('cleanCategoryFilter：只留分类表里还存在的，顺序按分类表来', () => {
  const cats = [{ id: 'shop' }, { id: 'food' }];
  assert.deepStrictEqual(C.cleanCategoryFilter(['food', 'shop'], cats), ['shop', 'food']);
  assert.deepStrictEqual(C.cleanCategoryFilter(['food', '没了'], cats), ['food']);
  assert.deepStrictEqual(C.cleanCategoryFilter([], cats), []);
  assert.deepStrictEqual(C.cleanCategoryFilter(['food'], []), []);
});

/* ---------- 不计收支（转账 / 还款） ----------
   这一类的账目在流水里照常存在，但不能进任何汇总：
   支出、收入、日均、分类占比、预算、年度报告。 */

const TRANSFER_TX = [
  { id: 'e1', type: 'expense', amount: 30, categoryId: 'food', date: '2026-05-01' },
  { id: 'i1', type: 'income', amount: 100, categoryId: 'salary', date: '2026-05-02' },
  { id: 't1', type: 'transfer', amount: 500, categoryId: 'transfer', date: '2026-05-03' },
  { id: 't2', type: 'transfer', amount: 200, categoryId: 'transfer', date: '2026-05-04' },
  { id: 'gone', type: 'expense', amount: 999, categoryId: 'food', date: '2026-05-05', deletedAt: 1 }
];

test('countStats：转账与墓碑都不进支出/收入', () => {
  const s = C.countStats(TRANSFER_TX);
  assert.strictEqual(s.count, 5, '笔数仍然如实统计');
  assert.strictEqual(s.expenseCents, 3000, '墓碑那笔不算');
  assert.strictEqual(s.incomeCents, 10000);
  assert.strictEqual(s.transferCents, 70000);
  assert.strictEqual(s.transferCount, 2);
  assert.strictEqual(s.expenseCount, 1);
  assert.strictEqual(s.incomeCount, 1);
});

test('expenseTx / incomeTx / transferTx：各自只挑自己的类型', () => {
  assert.deepStrictEqual(C.expenseTx(TRANSFER_TX).map((t) => t.id), ['e1']);
  assert.deepStrictEqual(C.incomeTx(TRANSFER_TX).map((t) => t.id), ['i1']);
  assert.deepStrictEqual(C.transferTx(TRANSFER_TX).map((t) => t.id), ['t1', 't2']);
  assert.deepStrictEqual(C.expenseTx([]), []);
  assert.deepStrictEqual(C.transferTx(null), []);
});

test('countsInStats：只有支出与收入算数', () => {
  assert.strictEqual(C.countsInStats({ type: 'expense' }), true);
  assert.strictEqual(C.countsInStats({ type: 'income' }), true);
  assert.strictEqual(C.countsInStats({ type: 'transfer' }), false);
  assert.strictEqual(C.countsInStats({ type: 'expense', deletedAt: 1 }), false);
  assert.strictEqual(C.countsInStats(null), false);
});

test('sanitizeTx：type=transfer 保得住，缺分类时给它转账分类', () => {
  const t = C.sanitizeTx({ id: 'x', type: 'transfer', amount: 100, date: '2026-05-06' });
  assert.strictEqual(t.type, 'transfer');
  assert.strictEqual(t.categoryId, 'transfer', '没给分类时不该落到「其他支出」');
  /* 认不出来的类型仍然回落支出（老数据/脏数据） */
  assert.strictEqual(C.sanitizeTx({ id: 'y', type: '???', amount: 1, date: '2026-05-06' }).type, 'expense');
});

test('sanitizeDB：不计收支的账目能通过清洗并保留类型', () => {
  const db = C.sanitizeDB({ transactions: TRANSFER_TX });
  const t = db.transactions.filter((x) => x.id === 't1')[0];
  assert.ok(t, 't1 应该留下');
  assert.strictEqual(t.type, 'transfer');
  /* 墓碑是同步用的标记，清洗时必须保留（否则删掉的账会在别的设备复活） */
  assert.strictEqual(db.transactions.filter((x) => x.id === 'gone')[0].deletedAt, 1);
  assert.strictEqual(db.transactions.length, 5);
  /* 但统计要把它排除在外 */
  assert.strictEqual(C.countStats(db.transactions).expenseCents, 3000);
});

test('yearReport：转账不进年支出/年收入，但单独给出笔数与金额', () => {
  const r = C.yearReport(TRANSFER_TX, 2026);
  assert.strictEqual(r.expenseCents, 3000);
  assert.strictEqual(r.incomeCents, 10000);
  assert.strictEqual(r.transferCount, 2);
  assert.strictEqual(r.transferCents, 70000);
  assert.strictEqual(r.byMonth[4], 3000, '五月支出只有那笔 30 元');
  assert.strictEqual(r.maxTx.id, 'e1', '最大单笔不会被 500 元的转账抢走');
  assert.ok(!r.byCategory.transfer, '转账分类不该出现在分类占比里');
});

test('txsToCsv：类型列如实写「不计收支」，并带「计入统计」列', () => {
  const csv = C.txsToCsv(TRANSFER_TX, (id) => ({ food: '餐饮', salary: '工资', transfer: '转账' }[id] || id));
  const lines = csv.replace('\uFEFF', '').split('\r\n');
  assert.strictEqual(lines[0], '日期,类型,分类,金额,来源,备注,计入统计');
  assert.strictEqual(lines.length, 5, '表头 + 4 条（墓碑不导出）');
  const cells = lines.slice(1).map((l) => l.split(','));
  const byDate = {};
  cells.forEach((c) => { byDate[c[0]] = c; });
  assert.strictEqual(byDate['2026-05-03'][1], '不计收支');
  assert.strictEqual(byDate['2026-05-03'][2], '转账');
  assert.strictEqual(byDate['2026-05-03'][6], '否', '转账标明不计入统计');
  assert.strictEqual(byDate['2026-05-01'][1], '支出');
  assert.strictEqual(byDate['2026-05-01'][6], '是');
  assert.strictEqual(byDate['2026-05-05'], undefined, '软删除的不导出');
});

test('normalizeImport：type=transfer 在备份往返里不丢', () => {
  const back = C.normalizeImport(JSON.stringify({
    transactions: [{ id: 't9', type: 'transfer', amount: 66, date: '2026-05-07' }]
  }));
  assert.strictEqual(back.transactions.length, 1);
  assert.strictEqual(back.transactions[0].type, 'transfer');
  assert.strictEqual(back.transactions[0].categoryId, 'transfer');
});

/* ---------- 导入规则（关键词 → 分类，自动学习） ---------- */

test('peerOfNote：从备注里取商户名（· 前面那段）', () => {
  assert.strictEqual(C.peerOfNote('星巴克 · 拿铁'), '星巴克');
  assert.strictEqual(C.peerOfNote('星巴克'), '星巴克');
  assert.strictEqual(C.peerOfNote('  美团 · 外卖  '), '美团');
  assert.strictEqual(C.peerOfNote(''), '');
  assert.strictEqual(C.peerOfNote(null), '');
  assert.strictEqual(C.peerOfNote(' · 只有商品'), '· 只有商品', '前面为空时不硬切');
});

test('learnableKeyword：太短/纯数字/通用词不学', () => {
  assert.strictEqual(C.learnableKeyword('星巴克 · 拿铁'), '星巴克');
  assert.strictEqual(C.learnableKeyword('Manner咖啡 · 拿铁'), 'Manner咖啡');
  assert.strictEqual(C.learnableKeyword('·'), '', '空关键词');
  assert.strictEqual(C.learnableKeyword('A · 某物'), '', '一个字符太短');
  assert.strictEqual(C.learnableKeyword('12345 · 某物'), '', '纯数字不学');
  assert.strictEqual(C.learnableKeyword('转账 · 微信转账'), '', '通用词不学');
  assert.strictEqual(C.learnableKeyword(''), '');
});

test('learnRule：新规则排最前，同一关键词改分类不重复建', () => {
  let rules = C.learnRule([], '星巴克', 'food', 1000);
  assert.strictEqual(rules.length, 1);
  assert.deepStrictEqual(rules[0].keywords, ['星巴克']);
  assert.strictEqual(rules[0].categoryId, 'food');

  rules = C.learnRule(rules, '瑞幸', 'food', 2000);
  assert.strictEqual(rules.length, 2);
  assert.deepStrictEqual(rules[0].keywords, ['瑞幸'], '新学的排最前面（最近改的优先）');

  /* 同一关键词改成别的分类：还是两条，分类被更新 */
  rules = C.learnRule(rules, '星巴克', 'fun', 3000);
  assert.strictEqual(rules.length, 2);
  assert.strictEqual(rules[0].keywords[0], '星巴克');
  assert.strictEqual(rules[0].categoryId, 'fun');
  assert.strictEqual(rules[0].updatedAt, 3000);

  /* 关键词或分类为空 → 原样返回（不该学的不学） */
  assert.strictEqual(C.learnRule(rules, '', 'food', 1).length, 2);
  assert.strictEqual(C.learnRule(rules, '肯德基', '', 1).length, 2);
  assert.strictEqual(C.learnRule(null, '肯德基', 'food', 1).length, 1);
});

test('matchRule：按顺序第一条命中；ASCII 不分大小写', () => {
  const rules = [
    { id: 'r1', keywords: ['星巴克'], categoryId: 'food' },
    { id: 'r2', keywords: ['STARBUCKS'], categoryId: 'fun' }
  ];
  assert.strictEqual(C.matchRule(rules, '星巴克 · 拿铁'), 'food');
  assert.strictEqual(C.matchRule(rules, 'starbucks · latte'), 'fun');
  assert.strictEqual(C.matchRule(rules, 'Starbucks 咖啡'), 'fun');
  assert.strictEqual(C.matchRule(rules, '全家 · 矿泉水'), '');
  assert.strictEqual(C.matchRule([], '随便'), '');
  assert.strictEqual(C.matchRule(rules, ''), '');
  /* 顺序即优先级：把 fun 那条挪前面就优先命中 */
  assert.strictEqual(C.matchRule([rules[1], rules[0]], '星巴克 starbucks'), 'fun');
  /* 整条规则也能取到（界面显示命中次数用） */
  assert.strictEqual(C.matchRuleEntry(rules, '星巴克').id, 'r1');
  assert.strictEqual(C.matchRuleEntry(rules, '无关'), null);
});

test('bumpRuleHits：命中计数累加，未知 id 不动', () => {
  const rules = [
    { id: 'r1', keywords: ['星巴克'], categoryId: 'food', hits: 2 },
    { id: 'r2', keywords: ['瑞幸'], categoryId: 'food', hits: 0 }
  ];
  const out = C.bumpRuleHits(rules, { r1: 3 });
  assert.strictEqual(out[0].hits, 5);
  assert.strictEqual(out[1].hits, 0);
  assert.strictEqual(C.bumpRuleHits(rules, { 没有的id: 9 })[0].hits, 2);
  assert.strictEqual(C.bumpRuleHits(rules, null)[0].hits, 2);
});

test('sanitizeRules：收口坏值、去重关键词、限量', () => {
  const out = C.sanitizeRules([
    { id: 'a', keywords: ['星巴克', '星巴克', ' ', '瑞幸'], categoryId: 'food', hits: -5 },
    { id: 'b', keywords: [], categoryId: 'food' },
    { id: 'c', keywords: ['x'], categoryId: '' },
    '垃圾',
    null
  ]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].keywords, ['星巴克', '瑞幸']);
  assert.strictEqual(out[0].hits, 0, '负数命中归零');
  assert.ok(out[0].id === 'a');
  assert.ok(C.sanitizeRules(null).length === 0);
});

test('sanitizeDB / normalizeImport：规则跟着账本走、跟着备份往返', () => {
  const db = C.sanitizeDB({ rules: [{ id: 'r1', keywords: ['星巴克'], categoryId: 'food' }] });
  assert.strictEqual(db.rules.length, 1);
  assert.ok(Array.isArray(C.freshDB().rules), '空账本也有 rules 数组');

  const back = C.normalizeImport(JSON.stringify({
    transactions: [{ id: 'x', amount: 1, date: '2026-05-01' }],
    rules: [{ id: 'r1', keywords: ['星巴克'], categoryId: 'food' }]
  }));
  assert.strictEqual(back.rules.length, 1);
  assert.strictEqual(back.rules[0].categoryId, 'food');
  /* 老备份文件没有 rules 字段 → 空数组，不报错 */
  assert.deepStrictEqual(C.normalizeImport(JSON.stringify({ transactions: [] })).rules, []);
});

test('parseBillText：用户规则优先于内置词库', () => {
  const csv = [
    '交易时间,交易对方,商品,收/支,金额(元),交易单号',
    '2026-05-01 12:00:00,某家店,拿铁,支出,18.00,ORDER-1'
  ].join('\n');
  /* 没有用户规则时走词库（这个商户名不在词库里 → 其他） */
  const without = C.parseBillText(csv, [], []);
  assert.strictEqual(without.rows[0].categoryId, 'other_e');
  /* 有用户规则命中 → 按用户的来 */
  const withRule = C.parseBillText(csv, [], [{ id: 'r1', keywords: ['某家店'], categoryId: 'fun' }]);
  assert.strictEqual(withRule.rows[0].categoryId, 'fun');
});

/* ---------- 预算跨月结转（Rollover） ---------- */

test('monthBefore：跨年前一个月', () => {
  assert.strictEqual(C.monthBefore('2026-05'), '2026-04');
  assert.strictEqual(C.monthBefore('2026-01'), '2025-12');
  assert.strictEqual(C.monthBefore('乱写'), '');
});

test('budgetOf：没开结转时只看本月', () => {
  const tx = [
    { id: 'a', type: 'expense', amount: 300, categoryId: 'food', date: '2026-06-10' },
    { id: 'b', type: 'expense', amount: 100, categoryId: 'fun', date: '2026-06-11' }
  ];
  const budgets = { '2026-06': { total: 1000, food: 500 } };
  const r = C.budgetOf(tx, budgets, '2026-06');
  assert.strictEqual(r.total, 1000);
  assert.strictEqual(r.spent, 400);
  assert.strictEqual(r.carried, 0);
  assert.strictEqual(r.left, 600);
  assert.strictEqual(r.cats.food.available, 500);
  assert.strictEqual(r.cats.food.left, 200);
});

test('budgetOf：开了结转，上月结余带进本月（超支则扣）', () => {
  const tx = [
    /* 5 月：food 预算 500，花了 300 → 结余 200 */
    { id: 'a', type: 'expense', amount: 300, categoryId: 'food', date: '2026-05-10' },
    /* 6 月：food 花 100 */
    { id: 'b', type: 'expense', amount: 100, categoryId: 'food', date: '2026-06-10' }
  ];
  const budgets = {
    '2026-05': { total: 1000, food: 500 },
    '2026-06': { total: 800, food: 400, rollover: true }
  };
  const r = C.budgetOf(tx, budgets, '2026-06');
  /* 总预算 800 + 5 月结余 (1000-300=700) = 1500；6 月花 100 → 剩 1400 */
  assert.strictEqual(r.carried, 700);
  assert.strictEqual(r.available, 1500);
  assert.strictEqual(r.left, 1400);
  /* 分类：400 + 200 = 600，花 100 → 剩 500 */
  assert.strictEqual(r.cats.food.carried, 200);
  assert.strictEqual(r.cats.food.available, 600);
  assert.strictEqual(r.cats.food.left, 500);
});

test('budgetOf：上月超支会从本月扣（负数结转）', () => {
  const tx = [
    { id: 'a', type: 'expense', amount: 700, categoryId: 'food', date: '2026-05-10' }
  ];
  const budgets = {
    '2026-05': { total: 500, food: 300 },
    '2026-06': { total: 500, food: 300, rollover: true }
  };
  const r = C.budgetOf(tx, budgets, '2026-06');
  assert.strictEqual(r.carried, -200, '上月超支 200（1000 预算里 500 是给分类的）');
  assert.strictEqual(r.cats.food.carried, -400, '分类超支 400（预算 300、花了 700）');
  assert.strictEqual(r.available, 300);
  assert.strictEqual(r.cats.food.available, -100, '本月 300 - 上月超支 400 = 已经没得花了');
});

test('budgetOf：结转是递归的（一年只设一次预算也能滚下来）', () => {
  const budgets = {
    '2026-01': { total: 1000, rollover: true },
    '2026-02': { rollover: true },
    '2026-03': { rollover: true }
  };
  /* 一路没花钱：3 月的可用额还是 1000，不是 0 */
  const r = C.budgetOf([], budgets, '2026-03');
  assert.strictEqual(r.carried, 1000);
  assert.strictEqual(r.available, 1000);
  /* 中间任何一个月花了钱，后面的结转跟着变 */
  const tx = [{ id: 'a', type: 'expense', amount: 400, categoryId: 'food', date: '2026-02-05' }];
  const r2 = C.budgetOf(tx, budgets, '2026-03');
  assert.strictEqual(r2.carried, 600);
});

test('budgetOf：没标 rollover 的月份不结转；转账不计入已花', () => {
  const tx = [
    { id: 'a', type: 'expense', amount: 300, categoryId: 'food', date: '2026-05-10' },
    { id: 't', type: 'transfer', amount: 5000, categoryId: 'transfer', date: '2026-06-01' }
  ];
  const budgets = { '2026-05': { total: 1000 }, '2026-06': { total: 800 } };
  const r = C.budgetOf(tx, budgets, '2026-06');
  assert.strictEqual(r.carried, 0, '没开结转');
  assert.strictEqual(r.spent, 0, '转账不算已花');
  const r2 = C.budgetOf(tx, { '2026-05': { total: 1000 }, '2026-06': { total: 800, rollover: true } }, '2026-06');
  assert.strictEqual(r2.carried, 700);
});

test('sanitizeBudgets：rollover 开关保得住，坏值照旧过滤', () => {
  const out = C.sanitizeBudgets({
    '2026-06': { total: 800, food: 400, rollover: true, 坏值: 'abc' },
    '2026-07': { rollover: true },
    '不是月份': { total: 1 },
    '2026-08': { food: -5 }
  });
  assert.strictEqual(out['2026-06'].rollover, true);
  assert.strictEqual(out['2026-06'].food, 400);
  assert.strictEqual(out['2026-06']['坏值'], undefined);
  assert.strictEqual(out['2026-07'].rollover, true, '只有开关的月份也保留');
  assert.strictEqual(out['不是月份'], undefined);
  assert.strictEqual(out['2026-08'], undefined, '全是非法值的月份丢掉');
  /* 备份往返不丢开关 */
  const back = C.normalizeImport(JSON.stringify({
    transactions: [], budgets: { '2026-06': { total: 800, rollover: true } }
  }));
  assert.strictEqual(back.budgets['2026-06'].rollover, true);
});

test('sanitizeBudgets：只有总预算或单个分类的月份不能丢（交接审查回归）', () => {
  /* 2026-10-07 交接审查抓到的数据丢失：保留条件写成 length > 1，
     「只设总预算」（最常见用法）或「只设一个分类」的月份被整个丢掉，
     且丢在服务端入库清洗这一步——界面显示已保存，刷新就没了。 */
  const out = C.sanitizeBudgets({
    '2026-10': { total: 2000 },
    '2026-11': { food: 600 },
    '2026-12': {}
  });
  assert.deepStrictEqual(out['2026-10'], { total: 2000 }, '只有总预算要保留');
  assert.deepStrictEqual(out['2026-11'], { food: 600 }, '只有单个分类要保留');
  assert.strictEqual(out['2026-12'], undefined, '真正全空的月份才丢');
  /* 完整 sanitizeDB 往返（服务端入库走的就是它）也不丢 */
  const db = C.sanitizeDB({
    transactions: [],
    budgets: { '2026-10': { total: 2000 } }
  });
  assert.deepStrictEqual(db.budgets['2026-10'], { total: 2000 });
  /* 备份文件里只有总预算的月份，导入后同样保得住 */
  const back = C.normalizeImport({
    transactions: [], budgets: { '2026-10': { total: 2000 } }
  });
  assert.deepStrictEqual(back.budgets['2026-10'], { total: 2000 });
});

/* ---------- 月度统计与环比 ---------- */

test('monthStats：按月口径统计（转账与墓碑都不算）', () => {
  const tx = [
    { id: 'a', type: 'expense', amount: 100, date: '2026-06-01' },
    { id: 'b', type: 'expense', amount: 50, date: '2026-06-30' },
    { id: 'c', type: 'income', amount: 200, date: '2026-06-15' },
    { id: 'd', type: 'transfer', amount: 900, date: '2026-06-20' },
    { id: 'e', type: 'expense', amount: 999, date: '2026-05-01' },
    { id: 'f', type: 'expense', amount: 888, date: '2026-06-05', deletedAt: 1 }
  ];
  const s = C.monthStats(tx, '2026-06');
  assert.strictEqual(s.expenseCents, 15000);
  assert.strictEqual(s.incomeCents, 20000);
  assert.strictEqual(s.transferCount, 1);
  assert.strictEqual(s.count, 4, '笔数含转账但不含墓碑与别的月份');
  assert.strictEqual(s.key, '2026-06');
  /* 前缀不能误伤：'2026-06' 不该把 '2026-060' 之类算进来（月份格式固定，这里只验边界） */
  assert.strictEqual(C.monthStats([{ id: 'x', type: 'expense', amount: 1, date: '2026-07-01' }], '2026-06').count, 0);
});

test('compareMonths：环比方向、百分比与基数过小的情况', () => {
  const tx = [
    { id: 'a', type: 'expense', amount: 200, date: '2026-05-10' },
    { id: 'b', type: 'expense', amount: 300, date: '2026-06-10' }
  ];
  const up = C.compareMonths(tx, '2026-06');
  assert.strictEqual(up.curCents, 30000);
  assert.strictEqual(up.prevCents, 20000);
  assert.strictEqual(up.diffCents, 10000);
  assert.strictEqual(up.pct, 50);
  assert.strictEqual(up.direction, 'up', '支出涨了 → up');
  assert.strictEqual(up.prevKey, '2026-05');

  /* 反过来：6 月比 5 月少 */
  const down = C.compareMonths(tx, '2026-05');
  assert.strictEqual(down.curCents, 20000);
  assert.strictEqual(down.prevCents, 0);
  assert.strictEqual(down.pct, null, '上月为 0 时不给百分比');
  assert.strictEqual(down.direction, 'up');
});

test('compareMonths：与上月持平', () => {
  const tx = [
    { id: 'a', type: 'expense', amount: 100, date: '2026-05-10' },
    { id: 'b', type: 'expense', amount: 100, date: '2026-06-10' }
  ];
  const same = C.compareMonths(tx, '2026-06');
  assert.strictEqual(same.direction, 'same');
  assert.strictEqual(same.diffCents, 0);
  assert.strictEqual(same.pct, 0);
});

/* ---------- 日历热力图 ---------- */

test('monthCalendar：按周分组、前后补白、色阶随当月最大单日变化', () => {
  const tx = [
    { id: 'a', type: 'expense', amount: 100, date: '2026-06-01' },
    { id: 'b', type: 'expense', amount: 50, date: '2026-06-01' },
    { id: 'c', type: 'expense', amount: 200, date: '2026-06-15' },
    { id: 'd', type: 'income', amount: 999, date: '2026-06-15' },   /* 收入不算 */
    { id: 'e', type: 'transfer', amount: 999, date: '2026-06-16' }, /* 转账不算 */
    { id: 'f', type: 'expense', amount: 999, date: '2026-07-01' },  /* 别的月份 */
    { id: 'g', type: 'expense', amount: 1, date: '2026-06-20', deletedAt: 1 }
  ];
  const cal = C.monthCalendar(tx, '2026-06');
  assert.strictEqual(cal.days, 2, '只有两天有支出');
  assert.strictEqual(cal.totalCents, 35000);
  assert.strictEqual(cal.maxCents, 20000);
  assert.strictEqual(cal.weeks.length % 1, 0);
  const flat = cal.weeks.reduce((acc, w) => acc.concat(w), []);
  assert.strictEqual(flat.length % 7, 0, '格子数一定是 7 的整数倍');
  assert.strictEqual(flat[0].date === '' || flat[0].day === 1, true, '开头可能补白');
  const d1 = flat.filter((c) => c.day === 1)[0];
  const d15 = flat.filter((c) => c.day === 15)[0];
  const d16 = flat.filter((c) => c.day === 16)[0];
  assert.strictEqual(d1.cents, 15000, '同一天两笔要合并');
  assert.strictEqual(d1.count, 2);
  assert.strictEqual(d1.level, 3, '15000/20000 = 75% → 第 3 档');
  assert.strictEqual(d15.level, 4, '最大的一天是最高档');
  assert.strictEqual(d16.level, 0, '转账不算支出');
  assert.strictEqual(d16.cents, 0);
});

test('monthCalendar：2026-06-01 是周一，所以第一周前面补 1 个空格', () => {
  const cal = C.monthCalendar([], '2026-06');
  const firstWeek = cal.weeks[0];
  assert.strictEqual(firstWeek[0].date, '', '周日那格是补白');
  assert.strictEqual(firstWeek[1].day, 1, '周一就是 1 号');
  assert.strictEqual(cal.days, 0);
  assert.strictEqual(cal.maxCents, 0);
  /* 空数据的月份也要有完整的网格 */
  assert.strictEqual(cal.weeks.reduce((n, w) => n + w.length, 0) % 7, 0);
  assert.strictEqual(C.monthCalendar([], '乱写').weeks.length, 0);
});

test('monthCalendar：只有一天有支出时也给最高档（否则看不出深浅）', () => {
  const cal = C.monthCalendar([{ id: 'a', type: 'expense', amount: 8, date: '2026-06-09' }], '2026-06');
  const flat = cal.weeks.reduce((acc, w) => acc.concat(w), []);
  assert.strictEqual(flat.filter((c) => c.day === 9)[0].level, 4);
});

/* ---------- 分类自定义（增删改 / 归档） ---------- */

test('sanitizeCategory：坏值收口，颜色只放行白名单写法', () => {
  const ok = C.sanitizeCategory({ id: 'pet', kind: 'expense', name: '宠物', icon: '🐱', color: '#E8833A', soft: '#FBEEDF' });
  assert.deepStrictEqual(ok, { id: 'pet', kind: 'expense', name: '宠物', icon: '🐱', color: '#E8833A', soft: '#FBEEDF' });

  /* 颜色不许从外面带任意字符串（会进 style 属性） */
  const bad = C.sanitizeCategory({ id: 'x', name: 'X', color: 'red;background:url(evil)', soft: 'javascript:1' });
  assert.strictEqual(bad.color, '#9AA0A6');
  assert.strictEqual(bad.soft, '#EFEFEF');

  /* 类型不认识 → 回落支出；图标空 → 有兜底；名字首尾空格清掉 */
  const loose = C.sanitizeCategory({ id: 'y', kind: '乱七八糟', name: '  宠物  ' });
  assert.strictEqual(loose.kind, 'expense');
  assert.strictEqual(loose.name, '宠物');
  assert.ok(loose.icon.length > 0);
  assert.ok(loose.icon.length <= 2, '图标最多两个码位（emoji 组合）');

  /* id 里的危险字符被清掉；没给 id 但有名字 → 自动生成（界面新增分类只填名字） */
  assert.ok(!/[^\w:-]/.test(C.sanitizeCategory({ id: 'a b/../c', name: 'A' }).id));
  const auto = C.sanitizeCategory({ name: '没有 id' });
  assert.ok(auto && auto.id.length > 0, '有名字就自动生成 id');
  /* 连名字都没有的丢掉：那种「分类」没意义，别往库里塞垃圾 */
  assert.strictEqual(C.sanitizeCategory({ kind: 'expense' }), null);
  assert.strictEqual(C.sanitizeCategory({ id: 'x', name: '   ' }), null, '只有 id、没有名字也丢');
  assert.strictEqual(C.sanitizeCategory(null), null);
});

test('addCategory：去重（同名同类型不重复建）、自动生成 id', () => {
  const base = C.DEFAULT_CATEGORIES;
  assert.strictEqual(C.addCategory(base, { name: '餐饮', kind: 'expense' }).length, base.length, '重名不建');
  const added = C.addCategory(base, { id: 'pet', name: '宠物', icon: '🐱', kind: 'expense' });
  assert.strictEqual(added.length, base.length + 1);
  assert.strictEqual(added[added.length - 1].id, 'pet');
  /* 同名但不同类型可以共存（默认分类里「其他」就是支出/收入各一个） */
  const both = C.addCategory(added, { name: '宠物', icon: '🐱', kind: 'income' });
  assert.strictEqual(both.length, base.length + 2);
  /* 不传 id 自动生成 */
  const auto = C.addCategory(base, { name: '新分类' });
  assert.ok(auto[auto.length - 1].id.length > 0);
  /* 入参不动 */
  assert.strictEqual(base.length, 17);
});

test('updateCategory：改名字/图标/颜色；内置转账不给改类型', () => {
  let cats = C.addCategory(C.DEFAULT_CATEGORIES, { id: 'pet', name: '宠物', icon: '🐱' });
  cats = C.updateCategory(cats, 'pet', { name: '毛孩子', icon: '🐶', color: '#123456' });
  const pet = cats.filter((c) => c.id === 'pet')[0];
  assert.strictEqual(pet.name, '毛孩子');
  assert.strictEqual(pet.icon, '🐶');
  assert.strictEqual(pet.color, '#123456');
  assert.strictEqual(pet.id, 'pet', 'id 不许被改');

  /* 内置的「转账」分类：改名字可以，改类型不行（否则不计收支的历史账目错位） */
  const tr = C.updateCategory(C.DEFAULT_CATEGORIES, 'transfer', { kind: 'expense', name: '转账还款' });
  const trCat = tr.filter((c) => c.id === 'transfer')[0];
  assert.strictEqual(trCat.kind, 'transfer');
  assert.strictEqual(trCat.name, '转账还款');
  /* 改不存在的分类：原样返回 */
  assert.strictEqual(C.updateCategory(C.DEFAULT_CATEGORIES, '没了', { name: 'x' }).length, 17);
});

test('removeCategory / archiveCategory：内置转账删不掉，归档后不在可选列表里', () => {
  assert.strictEqual(C.removeCategory(C.DEFAULT_CATEGORIES, 'transfer').length, 17, '内置的不给删');
  let cats = C.removeCategory(C.DEFAULT_CATEGORIES, 'food');
  assert.strictEqual(cats.length, 16);
  assert.ok(!cats.some((c) => c.id === 'food'));

  cats = C.archiveCategory(cats, 'shop', true);
  assert.strictEqual(cats.filter((c) => c.id === 'shop')[0].archived, true);
  assert.ok(!C.activeCategories(cats, 'expense').some((c) => c.id === 'shop'), '归档的不在可选里');
  assert.ok(C.activeCategories(cats, 'expense').some((c) => c.id === 'food' === false));
  assert.strictEqual(C.archiveCategory(cats, 'transfer', true).filter((c) => c.id === 'transfer')[0].archived, undefined,
    '内置转账不给归档');
  /* 取消归档 */
  const back = C.archiveCategory(cats, 'shop', false);
  assert.ok(C.activeCategories(back, 'expense').some((c) => c.id === 'shop'));
});

test('countTxInCategory：含已删除的账目（删了也仍是用过这个分类的证据）', () => {
  const tx = [
    { id: 'a', categoryId: 'food' },
    { id: 'b', categoryId: 'food', deletedAt: 1 },
    { id: 'c', categoryId: 'shop' }
  ];
  assert.strictEqual(C.countTxInCategory(tx, 'food'), 2);
  assert.strictEqual(C.countTxInCategory(tx, 'shop'), 1);
  assert.strictEqual(C.countTxInCategory(tx, '没用过'), 0);
  assert.strictEqual(C.countTxInCategory(null, 'food'), 0);
});

test('sanitizeDB：自定义分类保得住，重复 id 去掉；转账账目缺分类会补回内置分类', () => {
  const db = C.sanitizeDB({
    categories: [
      { id: 'pet', kind: 'expense', name: '宠物', icon: '🐱', color: '#123456' },
      { id: 'pet', kind: 'expense', name: '重复的' },
      { id: 'bad id!', kind: 'expense', name: 'X' }
    ],
    transactions: [{ id: 't', type: 'transfer', amount: 5, date: '2026-05-01' }]
  });
  assert.strictEqual(db.categories.filter((c) => c.id === 'pet').length, 1, '重复 id 只留一条');
  assert.strictEqual(db.categories.filter((c) => c.id === 'pet')[0].name, '宠物');
  assert.strictEqual(db.categories[0].id, 'transfer', '有转账账目时补回内置分类并排前面');
  /* 自定义分类也要进备份往返 */
  const back = C.normalizeImport(JSON.stringify({
    transactions: [{ id: 'x', amount: 1, date: '2026-05-01' }],
    categories: [{ id: 'pet', kind: 'expense', name: '宠物', icon: '🐱' }]
  }));
  assert.strictEqual(back.categories[0].id, 'pet');
});

/* ---------- 疑似转账（不计收支）的批量标记 ---------- */

test('isTransferLike：认得转账/还款/提现，放过真消费', () => {
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: '卫宇琦 · 转账备注:微信转账' }), true);
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: 'yyy · 王浩然' }), false, '光有人名不算');
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: '招商银行 · 信用卡还款' }), true);
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: '零钱提现' }), true);
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: '转账给某某超市' }), false, '转账+消费词 → 放过');
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: '美团 · 外卖' }), false);
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: '转账' }), true);
  /* 收入不动（还款进来那种先不提醒，免得把工资算成搬运） */
  assert.strictEqual(C.isTransferLike({ type: 'income', note: '转账' }), false);
  /* 已经是不计收支的不用再提醒 */
  assert.strictEqual(C.isTransferLike({ type: 'transfer', note: '转账' }), false);
  assert.strictEqual(C.isTransferLike({ type: 'expense', note: '' }), false);
  assert.strictEqual(C.isTransferLike(null), false);
});

test('isTransferKind：账单的「交易类型/分类」列也能认', () => {
  assert.strictEqual(C.isTransferKind('转账红包'), true);
  assert.strictEqual(C.isTransferKind('信用卡还款'), true);
  assert.strictEqual(C.isTransferKind('理财'), true);
  assert.strictEqual(C.isTransferKind('餐饮美食'), false);
  assert.strictEqual(C.isTransferKind(''), false);
});

test('findTransferSuspects：只在支出里找，跳过墓碑与已经是 transfer 的', () => {
  const tx = [
    { id: 'a', type: 'expense', note: '微信转账', amount: 500 },
    { id: 'b', type: 'expense', note: '信用卡还款', amount: 200 },
    { id: 'c', type: 'expense', note: '美团外卖', amount: 30 },
    { id: 'd', type: 'transfer', note: '转账', amount: 10 },
    { id: 'e', type: 'expense', note: '转账', amount: 9, deletedAt: 1 },
    { id: 'f', type: 'income', note: '转账', amount: 9 }
  ];
  assert.deepStrictEqual(C.findTransferSuspects(tx).map((t) => t.id), ['a', 'b']);
  assert.deepStrictEqual(C.findTransferSuspects([]), []);
  assert.deepStrictEqual(C.findTransferSuspects(null), []);
});

test('markAsTransfer：按 id 标成不计收支，别的账目原样不动，入参不改', () => {
  const tx = [
    { id: 'a', type: 'expense', note: '微信转账', amount: 500, categoryId: 'social' },
    { id: 'b', type: 'expense', note: '美团外卖', amount: 30, categoryId: 'food' },
    { id: 'c', type: 'transfer', note: '已经是了', amount: 10 }
  ];
  const out = C.markAsTransfer(tx, ['a', 'c', '不存在的']);
  assert.strictEqual(out[0].type, 'transfer');
  assert.strictEqual(out[0].categoryId, 'social', '分类保留（那是用户/词库的判断）');
  assert.ok(out[0].updatedAt > 0);
  assert.strictEqual(out[1].type, 'expense');
  assert.strictEqual(out[2].type, 'transfer');
  assert.strictEqual(tx[0].type, 'expense', '入参不能被改');
  /* 标完之后统计口径里就不再算支出了 */
  assert.strictEqual(C.countStats(out).expenseCents, 3000);
  assert.strictEqual(C.countStats(out).transferCents, 51000);
});

/* ---------- 周期记账：月末回退与幂等 ---------- */

const RECUR = [
  { id: 'r1', type: 'expense', amount: 1500, categoryId: 'home', note: '房租', day: 31 }
];

test('daysInMonth：大小月与闰年', () => {
  assert.strictEqual(C.daysInMonth('2026-01'), 31);
  assert.strictEqual(C.daysInMonth('2026-02'), 28);
  assert.strictEqual(C.daysInMonth('2028-02'), 29, '闰年');
  assert.strictEqual(C.daysInMonth('2026-04'), 30);
  assert.strictEqual(C.daysInMonth('乱写'), 31, '认不出来时给个安全值');
});

test('recurDayInMonth：31 号在小月回退到当月最后一天', () => {
  assert.strictEqual(C.recurDayInMonth(31, '2026-01'), 31);
  assert.strictEqual(C.recurDayInMonth(31, '2026-02'), 28);
  assert.strictEqual(C.recurDayInMonth(31, '2028-02'), 29);
  assert.strictEqual(C.recurDayInMonth(31, '2026-04'), 30);
  assert.strictEqual(C.recurDayInMonth(15, '2026-02'), 15);
  assert.strictEqual(C.recurDayInMonth(0, '2026-02'), 0, '非法日期返回 0（不触发）');
  assert.strictEqual(C.recurDayInMonth('abc', '2026-02'), 0);
});

test('applyRecurring：31 号模板在 2 月会补记，以前永远不会触发', () => {
  /* 2 月 27 号：还没到 28，不补 */
  assert.strictEqual(C.applyRecurring(RECUR, [], '2026-02-27', 1000).length, 0);
  /* 2 月 28 号：到了月末回退的落点，补一笔，日期记在 28 号 */
  const out = C.applyRecurring(RECUR, [], '2026-02-28', 1000);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].date, '2026-02-28');
  assert.strictEqual(out[0].amount, 1500);
  assert.strictEqual(out[0].recurId, 'recur:r1:2026-02');
  assert.strictEqual(out[0].type, 'expense');
  /* 闰年 2 月：29 号才补 */
  assert.strictEqual(C.applyRecurring(RECUR, [], '2028-02-28', 1000).length, 0);
  assert.strictEqual(C.applyRecurring(RECUR, [], '2028-02-29', 1000)[0].date, '2028-02-29');
});

test('applyRecurring：同一个月只补一次（幂等键），删掉也不再补', () => {
  const first = C.applyRecurring(RECUR, [], '2026-02-28', 1000);
  const second = C.applyRecurring(RECUR, first, '2026-02-28', 2000);
  assert.strictEqual(second.length, 0, '已经补过就不再来一笔');
  /* 用户把补记的那笔删了（软删除，墓碑还在、recurId 还在）→ 不能复活 */
  const deleted = first.map((t) => Object.assign({}, t, { deletedAt: 3000 }));
  assert.strictEqual(C.applyRecurring(RECUR, deleted, '2026-03-05', 4000).length, 0,
    '2 月的不再补；3 月还没到 31 号也不补');
  /* 下个月到点就补新的一笔 */
  const march = C.applyRecurring(RECUR, deleted, '2026-03-31', 5000);
  assert.strictEqual(march.length, 1);
  assert.strictEqual(march[0].recurId, 'recur:r1:2026-03');
});

test('applyRecurring：金额非法或日期非法的模板跳过；不计收支模板也能记', () => {
  const bad = [
    { id: 'b1', type: 'expense', amount: 0, categoryId: 'home', day: 5 },
    { id: 'b2', type: 'expense', amount: 'abc', categoryId: 'home', day: 5 },
    { id: 'b3', type: 'expense', amount: 10, categoryId: 'home', day: 99 }
  ];
  assert.strictEqual(C.applyRecurring(bad, [], '2026-05-10', 1).length, 0);
  const tr = C.applyRecurring([{ id: 'r2', type: 'transfer', amount: 2000, day: 10, note: '还信用卡' }],
    [], '2026-05-10', 1);
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].type, 'transfer');
  assert.strictEqual(tr[0].categoryId, 'transfer', '没给分类时用转账分类');
});

