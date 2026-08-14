// AI 雷达 Service Worker —— 让网页可「添加到主屏幕」并支持离线打开界面
const CACHE = "ai-radar-v1";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "styles.css",
  "manifest.webmanifest"
];

// 安装：预缓存核心静态资源
self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// 激活：清理旧缓存并接管页面
self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// 请求拦截
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;            // 只处理 GET
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // 第三方 API（CORS 代理等）走默认网络，不缓存

  // 同源静态资源：cache-first，后台静默更新
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
