'use strict';

/* ============================================================
   主题预置（assets/theme-init.js）
   ------------------------------------------------------------
   在首帧之前按 localStorage.theme（auto/light/dark）挂好
   data-theme，避免深色用户看到一闪而过的浅色。

   为什么单独一个文件、而且在 <head> 里同步加载：
   服务端发的是 CSP `script-src 'self'`，页面里不允许内联脚本
   （这是防注入的一道闸）。这段逻辑又必须比样式表和 body 先跑，
   所以只能是一个外部小文件，放在 CSS 之前。

   真正应用主题（含切换开关）的逻辑在 app.js。
   ============================================================ */

(function () {
  try {
    var t = localStorage.getItem('theme') || 'auto';
    var dark = t === 'dark' || (t !== 'light' && window.matchMedia &&
               window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) { document.documentElement.setAttribute('data-theme', 'dark'); }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { meta.setAttribute('content', dark ? '#000000' : '#F2F2F7'); }
  } catch (e) { /* 隐私模式等取不到 localStorage 时按浅色走 */ }
})();
