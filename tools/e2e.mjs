// Browser test: drives headless Chrome over the DevTools protocol against the local preview.
//   node tools/e2e.mjs [outDir]   (dev server must be running on 127.0.0.1:8362)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const OUT = process.argv[2] || '.';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = fs.mkdtempSync(OUT + '/chrome-');
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + profile, '--window-size=430,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const errors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const t = await (await fetch('http://127.0.0.1:9333/json')).json(); const p = t.find((x) => x.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not start');
}
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64')); };
const waitFor = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(250); } throw new Error('timeout waiting for ' + expr); };
const click = (text) => js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
const tap = (text) => js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
const type = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); })()`);

let fail = 0; const ok = (c, n) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };
try {
  ws = new WebSocket(await connect());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' ')); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8362/' });
  await waitFor(`!!document.querySelector('.gate h2')`);
  await shot('1-welcome');

  // restore: switched on ONLY on the owner's local copy (this test runs there); the extension/beta keep "soon"
  await tap('Restore with 12 words'); await sleep(300);
  ok(await js(`!!document.querySelector('#phrase')`), 'local copy: restore screen opens');
  await click('Back'); await sleep(300);
  // create a wallet (also the flow every beta tester uses)
  await click('Create a new wallet');
  const firstWords = await js(`[...document.querySelectorAll('.words li')].map(li => li.textContent)`);
  await js(`document.getElementById('saved').checked = true`); await click('Continue');
  await type('#pw1', 'test-password-1'); await type('#pw2', 'test-password-1');
  await click('Create wallet');
  await waitFor(`!!document.getElementById('sync')`, 30000);
  ok(/Bitcoin/.test(await js(`document.querySelector('.asset').textContent`)), 'BTC is listed first');
  await tap('Receive'); await waitFor(`!!document.querySelector('.sheet-bg.open')`);
  await sleep(400); await shot('2b-receive');
  const addr = await js(`document.querySelector('.sheet .mono').textContent`);
  ok(/^sp1q[02-9ac-hj-np-z]{100,}$/.test(addr), 'shows a valid sp1 address');
  ok(await js(`!!document.querySelector('.sheet .qrbox svg')`), 'QR code drawn');
  await js(`document.querySelector('.sheet-x').click()`); await sleep(400);
  await shot('2-syncing');
  const t0 = Date.now();
  await waitFor(`/Synced|Up to date/.test(document.getElementById('sync').textContent)`, 900000);
  ok(true, `new wallet synced in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  ok(await js(`[...document.querySelectorAll('.asset')].find(a => /shhhhh/.test(a.textContent)).textContent.includes('0 shhhhh')`), 'balance 0 for the test wallet');
  ok(/0\.0000\s*0000\s*BTC/.test(await js(`document.querySelector('.bcard-amt').textContent`)), 'balance card shows 0.0000 0000 BTC');
  await js(`document.querySelector('.bcard-top [aria-label="Hide balance"]').click()`); await sleep(200);
  ok(/••••/.test(await js(`document.querySelector('.bcard-amt').textContent`)), 'eye button hides the balance');
  await js(`document.querySelector('.bcard-top [aria-label="Show balance"]').click()`); await sleep(200);
  await shot('3-home');
  const LS = await js(`JSON.stringify(localStorage)`);
  ok(!LS.includes(firstWords.slice(0, 3).join(' ')), 'recovery phrase not readable in storage');

  // send: the sheet opens, Review responds; the empty test wallet must show an error IN the sheet (no popups)
  await tap('Send'); await waitFor(`!!document.querySelector('.sheet-bg.open #to')`);
  await type('#to', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'); await type('#amt', '0.0001');
  await js(`[...document.querySelectorAll('.sheet button')].find(b => b.textContent.trim() === 'Review').click()`);
  await waitFor(`!document.querySelector('.sheet .err').hidden`, 10000);
  const sendErr = await js(`document.querySelector('.sheet .err').textContent`);
  ok(/no BTC|not enough/i.test(sendErr), 'Send > Review shows an in-sheet message: ' + sendErr);
  // custom fee: empty -> clear message; 2.5 sat/vB -> accepted (the empty wallet then says no BTC)
  await js(`[...document.querySelectorAll('.sheet .seg3 button')].find(b => b.textContent.includes('Custom')).click()`); await sleep(200);
  ok(await js(`!document.querySelector('.sheet .custom-fee').hidden`), 'fee picker: Custom shows a rate box');
  await js(`[...document.querySelectorAll('.sheet button')].find(b => b.textContent.trim() === 'Review').click()`); await sleep(300);
  ok(/custom fee/i.test(await js(`document.querySelector('.sheet .err').textContent`)), 'custom fee empty -> asks for a rate');
  await js(`(() => { const e = document.querySelector('.sheet .custom-fee input'); e.value = '2.5'; e.dispatchEvent(new Event('input')); })()`);
  await js(`[...document.querySelectorAll('.sheet button')].find(b => b.textContent.trim() === 'Review').click()`); await sleep(500);
  ok(/no BTC|not enough/i.test(await js(`document.querySelector('.sheet .err').textContent`)), 'custom fee 2.5 accepted (empty wallet: no BTC)');
  await shot('5b-send');
  await js(`document.querySelectorAll('.sheet-bg').forEach(b => b.remove())`); await sleep(300);
  // wallet name: rename shows in the header (avatar letter too), long names cut with "…", default comes back
  await js(`[...document.querySelectorAll('.tab')].find(b => /Settings/.test(b.textContent)).click()`); await sleep(300);
  await js(`[...document.querySelectorAll('button')].find(b => /Wallet name/.test(b.textContent)).click()`); await sleep(300);
  await type('#wname', 'Bear vault <b>x</b> 🐻');
  await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click()`); await sleep(400);
  ok(await js(`document.querySelector('.acct b').textContent === 'Bear vault <b>x</b> 🐻' && !document.querySelector('.acct b b')`), 'renamed wallet shows in the header (as plain text)');
  ok(await js(`document.querySelector('.acct .avatar').textContent === 'B'`), 'avatar letter follows the name');
  await js(`[...document.querySelectorAll('button')].find(b => /Wallet name/.test(b.textContent)).click()`); await sleep(300);
  await type('#wname', 'A very long wallet name here');
  await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click()`); await sleep(400);
  ok(await js(`(() => { const b = document.querySelector('.acct b'); return b.textContent.length <= 24 && b.scrollWidth >= b.clientWidth && document.querySelector('.hdr').scrollWidth <= document.querySelector('.hdr').clientWidth + 1; })()`), 'long name capped at 24 characters, header still fits');
  await shot('5d-name');
  await js(`[...document.querySelectorAll('button')].find(b => /Wallet name/.test(b.textContent)).click()`); await sleep(300);
  await js(`[...document.querySelectorAll('button')].find(b => /default name/.test(b.textContent)).click()`); await sleep(400);
  ok(await js(`document.querySelector('.acct b').textContent === 'Silent wallet'`), 'default name comes back');
  await js(`[...document.querySelectorAll('.tab')].find(b => /Home/.test(b.textContent)).click()`); await sleep(400);

  // fund: deposit address (BIP86 bc1p) + nothing arrived yet
  await tap('Fund'); await waitFor(`!!document.querySelector('.sheet-bg.open .qrbox')`);
  ok(/^bc1p[02-9ac-hj-np-z]{58}$/.test(await js(`document.querySelector('.sheet .mono').textContent`)), 'Fund shows a bc1p deposit address');
  ok(!(await js(`/Move to silent/.test(document.body.textContent)`)), 'no "Move to silent" step');
  await shot('5c-fund');
  await js(`document.querySelector('.sheet-x').click()`); await sleep(400);

  // lock + wrong password + unlock (state comes back from encrypted storage, no rescan)
  await js(`[...document.querySelectorAll('button')].find(b => b.title === 'Lock').click()`);
  await sleep(300); await shot('1b-unlock'); await type('#pw', 'wrong-password'); await click('Unlock');
  await waitFor(`!document.querySelector('.err').hidden`, 20000);
  ok(/wrong password/i.test(await js(`document.querySelector('.err').textContent`)), 'wrong password rejected');
  await type('#pw', 'test-password-1'); await click('Unlock');
  await waitFor(`/Synced|Up to date/.test((document.getElementById('sync')||{}).textContent||'')`, 30000);
  ok(true, 'unlocks, encrypted sync state restored');

  // settings: a list; each row opens its own page
  await tap('Settings'); await sleep(200);
  await shot('4-settings');
  await tap('Recovery phrase'); await sleep(200);
  await type('#pw', 'test-password-1'); await click('Show phrase');
  await waitFor(`document.querySelectorAll('.words li').length === 12`, 20000);
  ok(true, 'phrase page: shown after password');
  await js(`document.querySelector('[aria-label=Back]').click()`); await sleep(200);
  ok(await js(`!!document.querySelector('.slist .srow')`), 'back arrow returns to the settings list');
  // auto-lock: pick 5 minutes
  await tap('Auto-lock'); await sleep(200); await shot('4b-autolock');
  await tap('5 minutes'); await sleep(200);
  ok(await js(`localStorage.getItem('shhhhh.autolock')`) === '5' && /5 minutes/.test(await js(`document.querySelector('.srow.sel').textContent`)), 'auto-lock choice saved');
  await js(`document.querySelector('[aria-label=Back]').click()`); await sleep(200);
  ok(/5 minutes/.test(await js(`[...document.querySelectorAll('.slist')].map(x => x.textContent).join(' ')`)), 'list shows the auto-lock value');
  ok(!(await js(`/Back up|Scan from block/.test(document.querySelector('.content').textContent)`)), 'no backup / scan-from-block rows');
  // rescan once, then it is on cooldown
  await tap('Rescan wallet'); await sleep(200); await click('Rescan now'); await sleep(500);
  await tap('Settings'); await sleep(200); await tap('Rescan wallet'); await sleep(200);
  ok(/Available again in \d+ min/.test(await js(`document.querySelector('.pg-hero').textContent`)), 'rescan has a 30 min cooldown');
  await js(`localStorage.removeItem('shhhhh.used.rescan')`);
  await tap('Settings'); await sleep(200);

  // new wallet flow
  await tap('Remove wallet'); await sleep(200); await shot('4c-remove');
  await js(`window.confirm = () => false`);  // "Cancel": nothing removed
  await click('Remove wallet');
  ok(await js(`!!document.querySelector('.pg-hero')`), 'cancel keeps the wallet');
  await js(`window.confirm = () => true`);
  await click('Remove wallet');
  await waitFor(`!!document.querySelector('.gate h2')`);
  ok(!(await js(`[...document.querySelectorAll('button')].some(b => /Import/.test(b.textContent))`)), 'welcome has no import button');
  await click('Create a new wallet');
  const words = await js(`[...document.querySelectorAll('.words li')].map(li => li.textContent)`);
  ok(words.length === 12, 'new phrase has 12 words');
  await shot('5-new-phrase');
  await js(`document.getElementById('saved').checked = true`); await click('Continue');
  await type('#pw1', 'another-pass-9'); await type('#pw2', 'another-pass-9'); await click('Create wallet');
  await waitFor(`/Synced|Up to date/.test((document.getElementById('sync')||{}).textContent||'')`, 60000);
  ok(true, 'new wallet created and synced (starts at the current block, nothing to scan)');
  ok(errors.length === 0, 'no JavaScript errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) { console.log('FAIL', e.message); fail++; }
finally { chrome.kill(); await sleep(1000); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} }
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
