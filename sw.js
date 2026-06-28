// Nexus Service Worker — Phase 1
// Handles: app shell caching, offline fallback, background sync for message queue

const CACHE_NAME = 'nexus-shell-v3';

// Files that make up the app shell — cached on install
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/db.js',
  './src/crypto.js',
  './src/auth.js',
  './src/realtime.js',
  './src/lock.js',
  './src/themes.js',
  './src/app.js',
  './src/appearance.js',
  './src/drive.js',
  './src/spine.js',
  './src/media.js',
];

// Hosts that should always go to the network (Firebase, Google APIs)
// fonts.googleapis.com and fonts.gstatic.com are intentionally absent —
// the stale-while-revalidate font handler below caches them for offline use.
const NETWORK_ONLY_HOSTS = [
  'firebaseio.com',
  'firebasedatabase.app',
  'firebaseapp.com',
  'accounts.google.com',
];

// Only http/https responses can be stored in the Cache API.
// chrome-extension://, file://, data:, etc. will throw if you call cache.put() on them.
function isCacheable(request) {
  const scheme = new URL(request.url).protocol;
  return scheme === 'http:' || scheme === 'https:';
}

// ---- Install ----------------------------------------------------------------
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => {
        // Don't fail install if some shell files aren't available yet
        console.warn('[SW] Shell cache partial:', err);
        self.skipWaiting();
      })
  );
});

// ---- Activate ---------------------------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ---- Fetch ------------------------------------------------------------------
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Network-only for Firebase and Google services
  if (NETWORK_ONLY_HOSTS.some(host => url.hostname.includes(host))) return;

  // For Google Fonts CSS and font files — network first, cache fallback
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (isCacheable(event.request)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for app shell files
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) {
          // Refresh cache in background (stale-while-revalidate)
          if (isCacheable(event.request)) {
            fetch(event.request)
              .then(response => {
                if (response.ok) {
                  caches.open(CACHE_NAME).then(c => c.put(event.request, response));
                }
              })
              .catch(() => {});
          }
          return cached;
        }

        // Not in cache — try network, cache the response
        return fetch(event.request).then(response => {
          if (response.ok && isCacheable(event.request)) {
            const toCache = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
          }
          return response;
        });
      })
      .catch(() => {
        // Offline and not cached — return the app shell for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      })
  );
});

// ---- Background Sync --------------------------------------------------------
// When connectivity restores, this event fires for registered sync tags.
// The app itself drains the queue; we just signal all open clients.
self.addEventListener('sync', event => {
  if (event.tag === 'nexus-send-queue') {
    event.waitUntil(notifyClientsToSync());
  }
});

async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => {
    client.postMessage({ type: 'NEXUS_DRAIN_QUEUE' });
  });
}

// ---- Push Notifications -----------------------------------------------------
// Requires FCM to be enabled in the Firebase project.
// The notification intentionally shows no message content — only "New message" —
// to preserve end-to-end privacy (the SW never has the decryption key).
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}

  const title   = data.title   ?? 'Nexus';
  const body    = data.body    ?? 'New message';
  const options = {
    body,
    icon:   './icons/icon-192.png',
    badge:  './icons/icon-192.png',
    tag:    'nexus-message',          // collapse multiple into one notification
    renotify: true,
    data:   { url: data.url ?? './' },
    actions: [{ action: 'open', title: 'Open' }],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url ?? './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url);
    })
  );
});

// ---- Message from app -------------------------------------------------------
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CACHE_URLS') {
    // Dynamically cache additional URLs (e.g. media thumbnails in Phase 2)
    // Filter out non-http(s) URLs — cache.put() rejects chrome-extension://, file://, etc.
    const urls = (event.data.urls || []).filter(u => {
      try { const s = new URL(u).protocol; return s === 'http:' || s === 'https:'; }
      catch { return false; }
    });
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache => cache.addAll(urls))
    );
  }
});
