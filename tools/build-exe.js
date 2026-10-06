'use strict';

/* ============================================================
   记账本 · 生成 SEA 打包入口（纯文件读写，不起任何进程）
   ------------------------------------------------------------
   被 tools\build-exe.bat 调用，只负责最脆弱的一步：
   把 assets/core.js 全文拼接进 dist/sea-entry.js，交给
   LedgerCore，再接上删掉 require 行的 server.js。
   （SEA 的主脚本不支持相对路径 require，只能构建时拼接；
    纯文本机械拼接，没有任何运行时代码生成。）

   后续步骤（生成 blob / 复制 Node 外壳 / 注入）见 build-exe.bat。
   回退方式见 README「打包成 exe」一节。
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* core.js 在 server.js 里的引入行——拼接时要从生成的入口里拿掉。
   这行变了（改名、挪位置），构建会在这里大声失败，不会带病出包。 */
const CORE_REQUIRE = "const LedgerCore = require('./assets/core.js');";

const coreSrc = fs.readFileSync(path.join(ROOT, 'assets', 'core.js'), 'utf8');
let serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
if (!serverSrc.includes(CORE_REQUIRE)) {
  console.error('  打包失败：server.js 里找不到预期的引入行（core.js 的加载方式改过了），');
  console.error('  tools/build-exe.js 里的拼接规则需要同步更新。');
  process.exit(1);
}
serverSrc = serverSrc.replace(
  CORE_REQUIRE,
  "/* LedgerCore 见本文件开头：构建时由 assets/core.js 全文拼接而来 */");

const entry =
  "'use strict';\n" +
  "/* 由 tools/build-exe.js 自动生成，不要手改、不要提交（dist/ 已忽略）。\n" +
  "   结构：assets/core.js 全文拼进一个 IIFE 拿到 module.exports 当 LedgerCore，\n" +
  "   再接上删掉 require 行的 server.js——SEA 主脚本不支持相对 require。 */\n" +
  'const LedgerCore = (function () {\n' +
  '  const module = { exports: {} };\n' +
  coreSrc + '\n' +
  '  return module.exports;\n' +
  '})();\n' +
  serverSrc + '\n';

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', 'sea-entry.js'), entry);
console.log('  已生成 dist/sea-entry.js（' +
  (Buffer.byteLength(entry) / 1024).toFixed(0) + ' KB）');
