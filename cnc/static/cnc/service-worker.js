// /home/my/d/cybernetcall/cnc/static/cnc/service-worker.js
// Service worker with pre-caching for local assets and external libraries

// Define a unique name for the cache, including a version number
const CACHE_NAME = 'cybernetcall-cache-v6'; // バージョンをインクリメント

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
      console.log('[Service Worker] Claiming clients');
      return self.clients.claim().then(() => {
        // After claiming clients, send a message to all controlled clients
        // This can be used by the app to know a new SW is active or app was launched
        self.clients.matchAll().then(clients => {
          clients.forEach(client => {
            console.log('[Service Worker] Sending APP_ACTIVATED message to client:', client.id);
            client.postMessage({ type: 'APP_ACTIVATED', newSW: true });
          });
        });
      });
    })
  );
});

// ----------------------------------------------------------------------
// ↓↓↓ FCM / PUSH NOTIFICATION HANDLING (NEW) ↓↓↓
// ----------------------------------------------------------------------

/**
 * PUSHイベントが発生した際に実行される。
 * 通常、FirebaseのSDKがこのイベントをフックし、FCMのペイロードを処理する。
 * ここでは、FCMのペイロードがService Workerに渡された場合の処理を記述する。
 * FCM通知ペイロードに'notification'フィールドが含まれていれば、
 * Firebase SDKが自動的に通知を表示するため、このイベントリスナーは
 * 'data'フィールドのみの通知（データメッセージ）の場合に特に重要となる。
 */
self.addEventListener('push', event => {
  console.log('[Service Worker] Push received.');

  // 通知ペイロードを取得。JSON形式を想定。
  const data = event.data ? event.data.json() : {};
  const notificationTitle = data.notification?.title || 'CyberNetCall Notification';
  const notificationOptions = {
    body: data.notification?.body || data.data?.message || 'You have a new activity.',
    icon: data.notification?.icon || '/static/cnc/icons/icon-192x192.png',
    badge: '/static/cnc/icons/icon-96x96.png',
    data: {
      url: data.data?.url || '/', // 通知クリックで開くURL。メッセージに応じて変更可能。
      type: data.data?.type // メッセージタイプ (例: 'call', 'direct-message')
    }
    // 'actions' (ボタン) もここに追加可能
  };

  // Service Workerが通知を表示
  event.waitUntil(
    self.registration.showNotification(notificationTitle, notificationOptions)
  );
});

/**
 * ユーザーが通知をクリックした際に実行される。
 */
self.addEventListener('notificationclick', event => {
  console.log('[Service Worker] Notification click received.');

  const clickedNotification = event.notification;
  const targetUrl = clickedNotification.data.url || '/'; // 通知に埋め込んだURLを取得
  
  clickedNotification.close(); // 通知を閉じる

  // 既存のクライアント（タブ）を検索し、存在すればそれをフォーカスする
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientList => {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        // 既に開いているタブがあればそれを再利用
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          // 通知の内容に応じてURLを更新してフォーカス
          if (client.url !== targetUrl) {
             return client.navigate(targetUrl).then(focusedClient => focusedClient.focus());
          }
          return client.focus();
        }
      }
      // 開いているタブがなければ、新しいタブを開く
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ----------------------------------------------------------------------
// ↑↑↑ FCM / PUSH NOTIFICATION HANDLING (NEW) ↑↑↑
// ----------------------------------------------------------------------

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
  const requestUrl = new URL(event.request.url);

  // Apply Stale-While-Revalidate strategy for app.js
  if (requestUrl.pathname === '/static/cnc/app.js') {
    // console.log('[Service Worker] Applying Stale-While-Revalidate for:', event.request.url);
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(event.request).then(cachedResponse => {
          const fetchPromise = fetch(event.request).then(networkResponse => {
            if (networkResponse && networkResponse.ok) {
              // console.log('[Service Worker] SWR: Caching new version of', event.request.url);
              cache.put(event.request, networkResponse.clone());
            } else if (networkResponse) {
              // console.warn('[Service Worker] SWR: Network request failed or not ok for', event.request.url, networkResponse.status);
            } else {
              // console.warn('[Service Worker] SWR: Network request completely failed for', event.request.url);
            }
            return networkResponse;
          }).catch(error => {
            // console.error('[Service Worker] SWR: Fetch error for', event.request.url, error);
            // If network fails, and there's a cached response, it will be used.
            // If no cached response, this will lead to an error for the client.
            return undefined; 
          });
          // Return cached response if available, otherwise wait for fetchPromise
          return cachedResponse || fetchPromise;
        });
      })
    );
  } else {
    // For all other resources, use Network falling back to cache strategy
    // console.log('[Service Worker] Applying Network falling back to cache for:', event.request.url);
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          // console.log('[Service Worker] Network failed, trying cache for:', event.request.url);
          return caches.match(event.request).then(cachedResponse => {
            // if (!cachedResponse) {
            //   console.log('[Service Worker] Not found in cache:', event.request.url);
            // }
            return cachedResponse;
          });
        })
    );
  }
});