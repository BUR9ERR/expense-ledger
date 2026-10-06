'use strict';

/* ============================================================
   PWA 注册（assets/pwa.js）
   ------------------------------------------------------------
   注册 Service Worker：支持「添加到主屏幕」与断网打开。
   只在 http/https 下注册（双击 index.html、用 file:// 打开时跳过，
   那种场景没有 origin，注册必然失败）。

   放在外部文件而不是页面内联：服务端 CSP 是 script-src 'self'，
   内联脚本会被浏览器拦掉。加载顺序在 app.js 之后，注册失败也不
   影响记账（app.js 早就跑起来了）。
   ============================================================ */

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* 注册失败不影响使用 */ });
  });
}
