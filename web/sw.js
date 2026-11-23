/* 玥玥展台 · Service Worker（第108轮）
 * 目的只有一个：让手机浏览器能把展台「加到主屏幕」，点开像 App 一样全屏，不用每次敲地址。
 * 策略保守，避免把调试时的旧页面钉死：
 *   - 页面导航(navigate)：先走网络，失败才用缓存里的同路径（离线兜底）
 *   - /api/ 一律不缓存（那里是模型钥匙和实时回复）
 *   - 静态资源：先给缓存，同时后台更新（stale-while-revalidate）
 */
const VERSION = 'yueyue-booth-v1';
const SHELL = [
  '/web/landing.html',
  '/web/m.css',
  '/web/boot.js',
  '/web/support.html',
  '/web/yueyue_avatar.webp',
  '/web/icon-192.png',
  '/web/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;           // 对话与钥匙：永不缓存

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match(url.pathname).then((r) => r || caches.match('/web/landing.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
