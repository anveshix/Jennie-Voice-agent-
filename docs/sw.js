importScripts('./brain.js', './remind-store.js');

/* Offline shell for the phone app. Only same-origin GETs are cached; provider
   and Google API calls always go to the network. */
const CACHE = 'jenni-phone-v9';
const FILES = ['./', './index.html', './app.css', './security.js', './docs.js', './github.js', './brain.js', './remind-store.js', './connectors.js', './app.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jenni-phone-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
  );
});

/* ── task reminders ─────────────────────────────────────────────────────────
   The page writes a minimal index to IndexedDB (due dates; titles only when no
   PIN is set). Periodic Background Sync (installed Android Chrome PWAs) wakes
   this worker roughly twice a day; it notifies once per distinct state. */
async function remindNow() {
  const idx = await self.JENNI_REMIND_STORE.get('index');
  if (!idx || !idx.on) return;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date())) % 24;
  if (hour < 8) return;                                     // no pre-dawn pings
  const msg = self.JENNI_BRAIN.reminderText(idx.items, Date.now(), Boolean(idx.titles));
  if (!msg || idx.lastKey === msg.key) return;
  await self.registration.showNotification(msg.title, { body: msg.body, tag: 'jenni-tasks', icon: './icon-192.png', badge: './icon-192.png', data: { url: './' } });
  idx.lastKey = msg.key;
  await self.JENNI_REMIND_STORE.set('index', idx);
}

self.addEventListener('periodicsync', (event) => { if (event.tag === 'jenni-remind') event.waitUntil(remindNow().catch(() => {})); });
self.addEventListener('message', (event) => { if (event.data === 'remind-now') event.waitUntil(remindNow().catch(() => {})); });
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
