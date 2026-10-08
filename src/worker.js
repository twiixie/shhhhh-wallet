// Background scanner (Web Worker): downloads index pages and checks them against the wallet's keys, off the UI thread.
// Gets only what scanning needs: the scan private key and the spend PUBLIC key (never the spend private key).
import { Point } from './sp.js';
import { scanPage, newState } from './scan.js';

let stop = false;
self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'stop') { stop = true; return; }
  if (m.type !== 'scan') return;
  stop = false;
  try {
    const wallet = { bScan: BigInt('0x' + m.bScan), Bspend: Point.fromHex(m.Bspend) };
    const state = m.state || newState(m.birthday || 0);
    const meta = await (await fetch(m.base + '/api/sp-index', { cache: 'no-store' })).json();
    const size = meta.pageSize;
    let found = 0;
    for (let n = Math.floor(state.nextEntry / size); n < meta.pages; n++) {
      if (stop) break;
      // finished pages never change: let the browser cache keep them
      const page = await (await fetch(`${m.base}/api/sp-index?p=${n}`, { cache: n < meta.pages - 1 ? 'force-cache' : 'no-store' })).json();
      found += scanPage(state, page, wallet, size);
      state.height = Math.max(state.height || 0, page.e.length ? page.e[page.e.length - 1][1] : 0);
      self.postMessage({ type: 'progress', done: n + 1, total: meta.pages, found });
    }
    state.height = Math.max(state.height || 0, meta.height);
    self.postMessage({ type: 'done', state, found, stopped: stop });
  } catch (e) {
    self.postMessage({ type: 'error', error: String(e && e.message || e) });
  }
};
