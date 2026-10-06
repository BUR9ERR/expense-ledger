'use strict';

/* ============================================================
   记账本 Service Worker
   ------------------------------------------------------------
   目的：手机「添加到主屏幕」后当 App 用——断网也能打开页面，
   照常记账（数据先存浏览器，联网后同步到电脑）。

   三条铁律：
   1. /api/ 开头的请求永远直连网络，绝不缓存也绝不用缓存应答
      ——账目数据宁可报错也不能给旧的；
   2. 页面导航走「网络优先」：有网时总是拿最新版，断网才用缓存；
   3. 静态资源（js/css/图标/词库）走「缓存优先、后台更新」。

   CACHE_VERSION 里的 __ASSET_HASH__ 由服务端发 /sw.js 时注入
   「被缓存文件的内容哈希」：任何一个被缓存的文件变了，sw.js 的
   字节就变，浏览器自动换新 SW、清旧缓存——不用再手动改版本号。
   ============================================================ */

var CACHE_VERSION = 'ledger-__ASSET_HASH__';

var PRECACHE = [
  '/',
  '/index.html',
  '/assets/theme-init.js',
  '/assets/core.js',
  '/assets/app.js',
  '/assets/pwa.js',
  '/assets/styles.css',
  '/manifest.webmanifest',
  '/assets/icon.svg',
  '/assets/icon-180.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== CACHE_VERSION) { return caches.delete(k); }
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') { return; }

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }

  /* 铁律 1：数据接口只走网络 */
  if (url.pathname.indexOf('/api/') === 0) { return; }

  /* 词库文件也不缓存：用户改完词库刷新一次就要生效，不能让他刷两次。
     断网时拿不到这个词库也没关系——app.js 里有内置的兜底规则。 */
  if (url.pathname.indexOf('/assets/') === 0 &&
      decodeURIComponent(url.pathname).indexOf('分类词库') >= 0) { return; }

  /* 铁律 2：页面导航网络优先 */
  var isNav = req.mode === 'navigate' ||
              url.pathname === '/' || url.pathname === '/index.html';
  if (isNav) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put('/index.html', copy); });
          return res;
        })
        .catch(function () {
          return caches.match('/index.html');
        })
    );
    return;
  }

  /* 铁律 3：静态资源网络优先，断网才回落缓存。
     以前是「缓存优先 + 后台更新」——代价是页面常常跑上一版代码：
     index.html 网络优先是新的，app.js 却从缓存拿了旧的，新按钮配旧
     逻辑，点了没反应（开发和用户都踩过）。本服务就跑在用户自己电脑
     上，取网络几乎零成本；改网络优先后刷新一次即全部最新，断网时
     仍回落缓存，离线记账不受影响。 */
  event.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req);
      })
  );
});
