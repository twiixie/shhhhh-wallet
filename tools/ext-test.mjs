// Extension test: loads the built extension (./extension) into Chrome for Testing
// (branded Chrome no longer loads unpacked extensions from the command line) and checks extension-only features.
//   node tools/build-extension.mjs && node tools/ext-test.mjs [outDir]
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import { createHash } from 'node:crypto';
const OUT = process.argv[2] || fs.mkdtempSync(os.tmpdir() + '/shhhhh-ext-');
const EXT = process.env.EXT || new URL('../extension', import.meta.url).pathname;
const CFT = fs.readdirSync(os.homedir() + '/.cache/shhhhh-cft/chrome').map((d) => `${os.homedir()}/.cache/shhhhh-cft/chrome/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find((p) => fs.existsSync(p));
const prof = fs.mkdtempSync(OUT + '/prof-');
const chrome = spawn(CFT, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + prof, '--load-extension=' + EXT, '--disable-extensions-except=' + EXT, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => { for (let i = 0; i < 50; i++) { try { return await (await fetch('http://127.0.0.1:9334/json/list')).json(); } catch { await sleep(200); } } return []; };
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(8000).then(() => { throw new Error('attach timeout'); })]);
  let id = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { const x = p.get(m.id); p.delete(m.id); m.error ? x.rej(new Error(m.error.message)) : x.res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; p.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const waitFor = async (e, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(e)) return; } catch {} await sleep(250); } throw new Error('timeout ' + e); };
  await send('Runtime.enable'); return { js, waitFor };
}
const newTab = async (url) => (await (await fetch('http://127.0.0.1:9334/json/new?' + url, { method: 'PUT' })).json());
let fail = 0; const ok = (c, n) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };
try {
  await list();
  const ID = [...createHash('sha256').update(fs.realpathSync(EXT)).digest('hex').slice(0, 32)].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
  // a wallet in the extension
  const w = await attach(await newTab(`chrome-extension://${ID}/index.html`));
  await w.waitFor(`!!document.querySelector('.gate')`);
  await w.js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Create a new wallet')).click()`);
  await w.js(`document.getElementById('saved').checked = true`); await w.js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue').click()`);
  for (const id of ['pw1', 'pw2']) await w.js(`(() => { const e = document.getElementById('${id}'); e.value = 'test-password-1'; e.dispatchEvent(new Event('input')); })()`);
  await w.js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create wallet').click()`);
  await w.waitFor(`!!document.getElementById('sync')`, 30000);
  ok(true, 'wallet created in the extension');

  // side panel: switching it Off (here from the popup page) closes a side panel that is open
  await w.js(`chrome.storage.local.set({ sidePanelMode: true })`);
  await attach(await newTab(`chrome-extension://${ID}/panel.html`)).then((pn) => pn.waitFor(`!!document.getElementById('sync')`, 30000));
  ok(true, 'side panel page open (same unlocked wallet)');
  await w.js(`[...document.querySelectorAll('.tab')].find(b => /Settings/.test(b.textContent)).click()`); await sleep(400);
  await w.js(`[...document.querySelectorAll('button')].find(b => /Side panel/.test(b.textContent)).click()`); await sleep(400);
  await w.js(`[...document.querySelectorAll('.content button')].find(b => /^Popup/.test(b.textContent.trim())).click()`);
  let gone = false; for (let i = 0; i < 20 && !gone; i++) { await sleep(300); gone = !(await list()).some((t) => t.url.endsWith('/panel.html')); }
  ok(gone, 'switching Side panel to Off closes the open side panel');
  ok((await w.js(`chrome.storage.local.get('sidePanelMode').then((x) => x.sidePanelMode)`)) === false, 'setting saved as Off');
} catch (e) { ok(false, e.message); }
chrome.kill(); await sleep(800); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
console.log(fail ? fail + ' failed' : 'all passed'); process.exit(fail ? 1 : 0);
