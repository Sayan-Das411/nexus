// Nexus Service Worker — Phase 1
// Handles: app shell caching, offline fallback, background sync for message queue

const CACHE_NAME = 'nexus-shell-v1';

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
];

// Hosts that should always go to the network (Firebase, Google APIs)
const NETWORK_ONLY_HOSTS = [
  'firebaseio.com',
  'firebasedatabase.app',
  'firebaseapp.com',
  'googleapis.com',
  'gstatic.com',
  'accounts.google.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

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

  // For Google Fonts CSS — network first, cache fallback
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
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
          fetch(event.request)
            .then(response => {
              if (response.ok) {
                caches.open(CACHE_NAME).then(c => c.put(event.request, response));
              }
            })
            .catch(() => {});
          return cached;
        }

        // Not in cache — try network, cache the response
        return fetch(event.request).then(response => {
          if (response.ok) {
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

// ---- Push Notifications (stub for Phase 4) ----------------------------------
self.addEventListener('push', event => {
  // Phase 4 will populate this
});

// ---- Message from app -------------------------------------------------------
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CACHE_URLS') {
    // Dynamically cache additional URLs (e.g. media thumbnails in Phase 2)
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache => cache.addAll(event.data.urls || []))
    );
  }
});
