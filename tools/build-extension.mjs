// Package the wallet as a private Chrome extension (Manifest V3) for loading by hand (chrome://extensions,
// "Load unpacked"). Not for the Chrome Web Store. Output: ./extension/ (+ .zip)
//   node tools/build-extension.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = new URL('../extension' + (process.argv.includes('--store') ? '-store' : ''), import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(ROOT + 'package.json'));

execFileSync('node', ['tools/build.mjs'], { cwd: ROOT, stdio: 'ignore' });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT + '/icons', { recursive: true });

// popup page: same app, fixed popup size (Chrome popups are at most 800 x 600)
let html = fs.readFileSync(ROOT + 'dist/index.html', 'utf8');
html = html.replace('</style>', 'html,body{width:390px;min-height:600px;overflow-x:hidden}#app{min-height:600px}.shell{height:600px;min-height:0;overflow:hidden}.shell .content{overflow-y:auto;padding-bottom:16px;scrollbar-width:none}.shell .content::-webkit-scrollbar,html::-webkit-scrollbar,.sheet::-webkit-scrollbar{display:none}html,.sheet{scrollbar-width:none}.shell .tabs{position:static;flex:none}.sheet-bg{position:fixed}\n</style>');
fs.writeFileSync(OUT + '/index.html', html);
// side panel page: same app, full height of the panel, any width
let panel = fs.readFileSync(ROOT + 'dist/index.html', 'utf8').replace('<html', '<html data-panel="1"');
panel = panel.replace('</style>', 'html,body{height:100%;overflow:hidden}#app{height:100vh}.shell{height:100vh;min-height:0;overflow:hidden}.shell .content{overflow-y:auto;padding-bottom:16px;scrollbar-width:none}.shell .content::-webkit-scrollbar,html::-webkit-scrollbar,.sheet::-webkit-scrollbar{display:none}html,.sheet{scrollbar-width:none}.shell .tabs{position:static;flex:none}.sheet-bg{position:fixed}.gate{min-height:100vh}\n</style>');
fs.writeFileSync(OUT + '/panel.html', panel);
// background: re-applies the user's "icon opens the side panel" choice when Chrome starts (no network, no keys)
// --store: Chrome Web Store build (no local-only mint page access; written next to the normal zip as -store.zip)
const STORE = process.argv.includes('--store');
const LOCAL_SITES = STORE ? [] : ['http://127.0.0.1:8364'];
const SITES = [...LOCAL_SITES, 'https://shhhhh.site'];                // sites allowed to ask (connect / pay)
fs.writeFileSync(OUT + '/background.js', `const apply = async () => {
  const on = !!(await chrome.storage.local.get('sidePanelMode')).sidePanelMode;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: on });
  await chrome.action.setPopup({ popup: on ? '' : 'index.html' });
};
chrome.runtime.onStartup.addListener(apply);
chrome.runtime.onInstalled.addListener(apply);
// site requests (window.shhhhh): only from the allow list; the wallet window shows them and answers the tab itself
const SITES = ${JSON.stringify(SITES)};
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.type !== 'shhhhh-request') return;
  const origin = sender.origin || (sender.url && new URL(sender.url).origin);
  if (!sender.tab || !SITES.includes(origin)) { send({ error: 'This site is not allowed to use the shhhhh wallet' }); return; }
  if (!['connect', 'sendBitcoin'].includes(msg.method)) { send({ error: 'Unknown request' }); return; }
  const req = { id: String(msg.id).slice(0, 64), method: msg.method, params: msg.params || {}, origin, tabId: sender.tab.id, at: Date.now() };
  // open at the top right of the browser window the request came from (like other wallets)
  const W = 400, H = 660;
  chrome.storage.session.set({ shhhhhReq: req })
    .then(() => chrome.windows.get(sender.tab.windowId).catch(() => null))
    .then((win) => {
      const base = { url: 'index.html?req=1', type: 'popup', width: W, height: H, focused: true };
      const at = win && win.width ? { left: Math.max(0, win.left + win.width - W - 16), top: Math.max(0, win.top + 80) } : {};
      return chrome.windows.create({ ...base, ...at }).catch(() => chrome.windows.create(base));   // position refused: default spot
    })
    .then(() => send({ ok: true }), (e) => send({ error: String(e && e.message || e) }));
  return true;
});
`);
// content scripts: inpage.js (page world) defines window.shhhhh; content.js relays to the extension and back
fs.writeFileSync(OUT + '/inpage.js', `(() => {
  if (window.shhhhh) return;
  let n = 0; const wait = new Map();
  window.addEventListener('message', (ev) => {
    const d = ev.data; if (ev.source !== window || !d || d.target !== 'shhhhh-page' || !wait.has(d.id)) return;
    const w = wait.get(d.id); wait.delete(d.id); d.error ? w.rej(new Error(d.error)) : w.res(d.result);
  });
  const call = (method, params) => new Promise((res, rej) => { const id = 'r' + Date.now() + '-' + (++n); wait.set(id, { res, rej });
    window.postMessage({ target: 'shhhhh-content', id, method, params }, location.origin); });
  window.shhhhh = Object.freeze({ isShhhhh: true, connect: () => call('connect'), sendBitcoin: (address, sats, feeRate) => call('sendBitcoin', { address, sats, feeRate }) });
  window.dispatchEvent(new Event('shhhhh#initialized'));
})();
`);
fs.writeFileSync(OUT + '/content.js', `window.addEventListener('message', (ev) => {
  const d = ev.data; if (ev.source !== window || !d || d.target !== 'shhhhh-content') return;
  const back = (error) => window.postMessage({ target: 'shhhhh-page', id: d.id, error }, location.origin);
  chrome.runtime.sendMessage({ type: 'shhhhh-request', id: d.id, method: d.method, params: d.params })
    .then((r) => { if (r && r.error) back(r.error); }, (e) => back(String(e && e.message || e)));
});
chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === 'shhhhh-response') window.postMessage({ target: 'shhhhh-page', id: m.id, result: m.result, error: m.error }, location.origin);
});
`);
for (const f of ['app.js', 'logo.png', 'favicon.png']) fs.copyFileSync(ROOT + 'dist/' + f, OUT + '/' + f);

// icons from the shhhhh logo (macOS sips)
for (const n of [16, 32, 48, 128]) execFileSync('sips', ['-z', String(n), String(n), ROOT + 'dist/logo.png', '--out', `${OUT}/icons/icon${n}.png`], { stdio: 'ignore' });

const manifest = {
  manifest_version: 3,
  name: 'shhhhh wallet',
  description: 'Silent payments wallet for BTC, BRC-20 and inscriptions. Keys never leave this browser.',
  // always increasing (the Chrome Web Store refuses a lower version): 1.<days since 2026-01-01>.<minute of the day, UTC>
  version: `1.${Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 864e5)}.${Math.floor(Date.now() / 6e4) % 1440}`,
  action: { default_popup: 'index.html', default_title: 'shhhhh wallet',
            default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } },
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  // only what the wallet talks to: the shhhhh node, and public explorers for the BTC price and the deposit address
  permissions: ['storage', 'sidePanel'],
  side_panel: { default_path: 'panel.html' },
  background: { service_worker: 'background.js' },
  host_permissions: ['https://node.shhhhh.site/*', 'https://mempool.space/*', 'https://blockstream.info/*'],
  content_scripts: [
    { matches: [...LOCAL_SITES.map((o) => o + '/*'), 'https://shhhhh.site/mint*'], js: ['inpage.js'], world: 'MAIN', run_at: 'document_start' },
    { matches: [...LOCAL_SITES.map((o) => o + '/*'), 'https://shhhhh.site/mint*'], js: ['content.js'], run_at: 'document_start' },
  ],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; connect-src https://node.shhhhh.site wss://node.shhhhh.site https://mempool.space https://blockstream.info; img-src 'self' https://node.shhhhh.site data:" },
};
fs.writeFileSync(OUT + '/manifest.json', JSON.stringify(manifest, null, 2));

const zip = OUT + '.zip';
fs.rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT });
console.log('extension folder:', OUT);
console.log('zip:', zip, (fs.statSync(zip).size / 1024).toFixed(0) + ' KB');
console.log('version', manifest.version, '(app ' + pkg.version + ')');
