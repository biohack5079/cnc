// /home/my/d/cybernetcall/cnc/static/cnc/service-worker.js
// Service worker with pre-caching for local assets and external libraries

// Define a unique name for the cache, including a version number
const CACHE_NAME = 'cybernetcall-cache-v5'; // Keep or increment version as needed

// List of URLs to pre-cache when the service worker installs
const urlsToCache = [
  // Core application shell
  '/', // The main HTML page
  '/static/cnc/manifest.json',
  '/static/cnc/app.js',
  '/static/cnc/style.css',
  // Icons used by manifest and potentially HTML
  '/static/cnc/icons/icon-192x192.png',
  '/static/cnc/icons/icon-512x512.png',
  '/static/cnc/icons/icon-maskable-512x512.png', // Also cache maskable icon
  '/static/cnc/notification.mp3', // 通知音ファイルをキャッシュに追加
  // External libraries loaded from CDNs in index.html
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js',
  'https://unpkg.com/idb@7/build/umd.js',
  'https://unpkg.com/html5-qrcode' // Note:unpkg might redirect, consider specific version URL if issues arise
];

// Event listener for the 'install' event
self.addEventListener('install', event => {
  console.log('[Service Worker] Install event');
  // Force the waiting service worker to become the active service worker.
  self.skipWaiting();
  // Pre-cache the defined URLs
  event.waitUntil(
    caches.open(CACHE_NAME) // Open the specified cache
      .then(cache => {
        console.log('[Service Worker] Opened cache:', CACHE_NAME);
        // Add all URLs from urlsToCache to the cache
        return cache.addAll(urlsToCache)
          .catch(err => {
            // Log errors if any URL fails to cache (e.g., network error)
            console.error('[Service Worker] Failed to cache one or more resources during install:', err);
            // Optional: You might want to throw the error to fail the installation
            // if core assets couldn't be cached.
            // throw err;
          });
      })
  );
});

// Event listener for the 'activate' event
self.addEventListener('activate', event => {
  console.log('[Service Worker] Activate event');
  // Clean up old caches
  event.waitUntil(
    caches.keys().then(keys =>
      // Wait for all promises to resolve (deleting old caches)
      Promise.all(keys.map(key => {
        // If a cache key doesn't match the current CACHE_NAME, delete it
        if (key !== CACHE_NAME) {
          console.log('[Service Worker] Deleting old cache:', key);
          return caches.delete(key);
        }
      }))
    ).then(() => {
      // Take control of uncontrolled clients (pages) immediately
      return self.clients.claim();
    })
  );
});

// Listen for messages from the client (app.js) if needed in the future
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'REQUEST_CLIENTS_INFO') {
    console.log('[Service Worker] Received message from client:', event.data);
    // Example: Respond with some info or trigger other SW actions
    // event.source.postMessage({ type: 'CLIENTS_INFO_RESPONSE', data: 'Some info from SW' });
  }
});

// Event listener for the 'fetch' event (intercepting network requests)
self.addEventListener('fetch', event => {
  // Use a "Network falling back to cache" strategy for navigation requests.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // For all other requests (JS, CSS, images, etc.), use a "Cache first" strategy.
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

// --- Push通知のイベントリスナーを追加 ---

// Push通知を受信したときに発火
self.addEventListener('push', event => {
  console.log('[Service Worker] Push Received.');

  // PushされたデータをJSONとして解析
  // デフォルトのタイトルと本文を用意
  let data = { title: 'New Message', body: 'You have a new message.' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      console.error('[Service Worker] Push event data is not valid JSON.', e);
    }
  }

  const title = data.title || 'CyberNetCall';
  const options = {
    body: data.body,
    icon: '/static/cnc/icons/icon-192x192.png', // 通知に表示されるアイコン
    badge: '/static/cnc/icons/icon-192x192.png', // Androidでステータスバーに表示される小さなアイコン
    sound: '/static/cnc/notification.mp3', // iOSやAndroidで通知音を鳴らす
    vibrate: [200, 100, 200] // Androidでバイブレーションを鳴らす (振動200ms, 停止100ms, 振動200ms)
  };

  const promiseChain = self.registration.showNotification(title, options)
    .then(() => {
      if ('setAppBadge' in self.navigator) {
        return self.navigator.setAppBadge(1); // とりあえずバッジを1に設定
      }
    });
  event.waitUntil(promiseChain);
});

// ユーザーが通知をクリックしたときに発火
self.addEventListener('notificationclick', event => {
  console.log('[Service Worker] Notification click Received.');

  // 通知を閉じる
  event.notification.close();

  // アプリのウィンドウを開くか、既存のウィンドウにフォーカスする
  event.waitUntil(
    clients.openWindow('/')
  );
});
