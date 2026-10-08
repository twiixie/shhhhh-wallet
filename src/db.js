// Tiny key-value store on IndexedDB (hundreds of MB allowed), for the wallet's encrypted sync data.
// localStorage (5-10 MB) is too small for big wallets. Falls back to localStorage if IndexedDB is unavailable.
const DB = 'shhhhh-wallet', STORE = 'kv';
let dbp = null;
function open() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode); const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
const hasIdb = typeof indexedDB !== 'undefined';
export const kv = {
  async get(k) {
    if (hasIdb) { try { return (await tx('readonly', (s) => s.get(k))) ?? null; } catch {} }
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
  },
  async set(k, v) {
    if (hasIdb) { try { await tx('readwrite', (s) => s.put(v, k)); return; } catch (e) { if (!window.localStorage) throw e; } }
    localStorage.setItem(k, JSON.stringify(v));
  },
  async del(k) {
    if (hasIdb) { try { await tx('readwrite', (s) => s.delete(k)); } catch {} }
    try { localStorage.removeItem(k); } catch {}
  },
};
