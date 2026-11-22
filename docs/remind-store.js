/* Tiny IndexedDB key/value store shared by the page and the service worker
   (a worker cannot read localStorage). Holds ONLY the reminder index:
   due dates, plus task titles when no PIN is set. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_REMIND_STORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const DB = 'jenni-remind', STORE = 'kv';
  function open() {
    return new Promise((resolve, reject) => {
      const req = root.indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => { db.close(); resolve(out && out.result); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
  }
  return {
    get: (key) => tx('readonly', (s) => s.get(key)),
    set: (key, value) => tx('readwrite', (s) => s.put(value, key)),
    clear: () => tx('readwrite', (s) => s.clear())
  };
});
