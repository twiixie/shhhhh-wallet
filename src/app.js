// shhhhh silent wallet: UI. Keys never leave the browser; storage is encrypted with the password.
import qrcode from 'qrcode-generator';
import * as K from './keys.js';
import { bytesToHex, outputPrivKey, decodeAddress } from './sp.js';
import { NODE, TAPROOT_START, MIN_START, getTip, getFees, syncWallet, spendable, broadcast, contentUrl, liveWatch, getDeposit , getTxStatus } from './node.js';

// shhhhh wallet launched after this block: wallets made here cannot have older payments, so restores start here by default
const SHHHHH_START = MIN_START;
import { buildSend, buildSendInscription, vsizeOf, DUST } from './send.js';
import { buildInscribeTransfer } from './inscribe.js';
import { kv } from './db.js';
import { taprootAddress } from './scan.js';
import { Address, NETWORK } from '@scure/btc-signer';
const LS_NAME = 'shhhhh.name';                                   // wallet name shown in the header (this browser only)
const walletName = () => (store.get(LS_NAME) || '').trim() || 'Silent wallet';
const LS_VAULT = 'shhhhh.vault', LS_STATE = 'shhhhh.state', LS_PARTIAL = 'shhhhh.scan';  // scan progress of an unfinished first sync
const $ = (id) => document.getElementById(id);
const app = $('app');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const short = (s, a = 10, b = 8) => (s && s.length > a + b + 1 ? s.slice(0, a) + '…' + s.slice(-b) : s);

// session (memory only, gone on lock / reload)
let S = null;            // { wallet, secret, stateKey, state }
let syncing = false, syncGen = 0, syncAbort = null;  // a sync in progress; cancelSync() stops it (also on the server)
function cancelSync() { syncGen++; syncing = false; if (S) S.busy = false; if (syncAbort) { syncAbort.abort(); syncAbort = null; } stopLive(); }

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function screen(...kids) { app.replaceChildren(h('div', { class: 'screen' }, ...kids)); window.scrollTo(0, 0); }
const FRIENDLY = [
  [/no spendable BTC/i, 'You have no BTC to send yet.'],
  [/not enough (plain )?BTC/i, 'Not enough BTC for this amount plus the fee.'],
  [/at least 330 sats/i, 'The minimum is 330 sats (0.0000033 BTC).'],
  [/balance too small/i, 'Your balance is too small to cover the fee.'],
  [/invalid|checksum|unknown (address|prefix)|not a silent payment address|bech32|base58/i, "That address doesn't look right."],
  [/wrong password/i, 'Wrong password.'],
  [/enter an amount/i, 'Enter an amount.'],
];
function friendly(m) { for (const [re, t] of FRIENDLY) if (re.test(m)) return t; return m.charAt(0).toUpperCase() + m.slice(1); }
function err(box, e) { box.textContent = friendly(e && e.message ? e.message : String(e)); box.hidden = false; }
const logo = () => h('div', { class: 'brand' }, h('img', { src: 'logo.png', alt: '' }), h('span', {}, 'shhhhh ', h('b', {}, 'wallet')));

// ---------------------------------------------------------------- start
// full-height "gate" layout (welcome + unlock): wordmark on top, big logo, form, buttons at the bottom
function gate(mid, bottom) {
  app.replaceChildren(h('div', { class: 'gate' },
    h('header', { class: 'gate-top' }, h('span', {}, 'shhhhh')),
    h('div', { class: 'gate-mid' }, h('img', { class: 'gate-logo', src: 'logo.png', alt: '' }), ...mid),
    h('div', { class: 'gate-bot' }, ...bottom)));
  window.scrollTo(0, 0);
}

// Restore is switched on only in the owner's local copy (tools/dev-server.mjs on 127.0.0.1:8362), not in the extension/beta
const LOCAL_ONLY = typeof location !== 'undefined' && location.host === '127.0.0.1:8362';
function start() {
  if (store.get(LS_VAULT)) { resumeSession().then((sec) => (sec ? openSession(sec) : unlockScreen())).catch(() => unlockScreen()); return; }
  gate([h('h2', {}, 'A silent Bitcoin wallet'), h('p', { class: 'fine center' }, 'BTC, BRC-20 and inscriptions. Private by default.')],
    [h('button', { class: 'main pill-btn', onclick: () => createScreen() }, 'Create a new wallet'),
     // restore is paused for the beta (full scans are heavy on the node): the screen stays in the code for later
     LOCAL_ONLY
       ? h('button', { class: 'textbtn', onclick: () => restoreScreen() }, 'Restore with 12 words')        // owner's local copy only
       : h('button', { class: 'textbtn', onclick: () => toast('Restoring a wallet is coming soon') }, 'Restore with 12 words · soon')]);
}

// ---------------------------------------------------------------- backup import (moves a wallet between the web page and the extension)
// A backup = the password-encrypted vault (phrase, start block, state key) + the sync data sealed with that state key.
// Nothing in it is readable without the password.
const BACKUP_FORMAT = 'shhhhh-wallet-backup';
function importScreen() {
  const e = h('div', { class: 'err', hidden: true });
  const area = h('textarea', { id: 'bk', rows: 4, autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the backup text, or choose the file below' });
  const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => { const f = file.files[0]; if (f) area.value = await f.text(); } });
  screen(logo(), h('h2', {}, 'Import a backup'),
    h('p', { class: 'fine' }, 'From Settings → Back up. Needs its password.'),
    h('label', { class: 'field' }, 'Backup', area), file,
    h('label', { class: 'field' }, 'Password of that wallet', h('input', { id: 'bkpw', type: 'password', autocomplete: 'current-password' })),
    e,
    h('button', { class: 'main', id: 'go', onclick: async () => {
      e.hidden = true;
      let b; try { b = JSON.parse($('bk').value); } catch { return err(e, 'That is not a shhhhh wallet backup.'); }
      if (!b || b.format !== BACKUP_FORMAT || !b.vault) return err(e, 'That is not a shhhhh wallet backup.');
      $('go').disabled = true; $('go').textContent = 'Checking…';
      try {
        const secret = await K.unlockVault(b.vault, $('bkpw').value);   // proves the password before anything is stored
        store.set(LS_VAULT, b.vault);
        await kv.del(LS_PARTIAL);
        if (b.state) await kv.set(LS_STATE, b.state); else await kv.del(LS_STATE);
        await openSession(secret);
        toast('Wallet imported ✓');
      } catch (x) { err(e, x); $('go').disabled = false; $('go').textContent = 'Import'; }
    } }, 'Import'),
    h('button', { class: 'ghost', onclick: start }, 'Back'));
}

// ---------------------------------------------------------------- create
function createScreen() {
  const words = K.newMnemonic(12).split(' ');
  screen(logo(), h('h2', {}, 'Your recovery phrase'),
    h('p', { class: 'warn' }, 'Write these 12 words on paper, in order. Never share them.'),
    h('ol', { class: 'words' }, words.map((w) => h('li', {}, w))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'saved' }), ' I wrote down the 12 words'),
    h('button', { class: 'main', onclick: () => { if (!$('saved').checked) return toast('Tick the box once you wrote the words down'); passwordScreen(words.join(' '), null); } }, 'Continue'),
    h('button', { class: 'ghost', onclick: start }, 'Back'));
}
function confirmScreen(words) {
  const picks = [...crypto.getRandomValues(new Uint8Array(3))].map((b, i) => ((b % 4) + i * 4)).sort((a, b) => a - b);
  const e = h('div', { class: 'err', hidden: true });
  screen(logo(), h('h2', {}, 'Check your phrase'), h('p', {}, 'Type these words from your paper:'),
    picks.map((i) => h('label', { class: 'field' }, `Word #${i + 1}`, h('input', { id: 'w' + i, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' }))),
    e,
    h('button', { class: 'main', onclick: () => {
      const bad = picks.filter((i) => $('w' + i).value.trim().toLowerCase() !== words[i]);
      if (bad.length) return err(e, `Word #${bad[0] + 1} does not match. Check your paper.`);
      passwordScreen(words.join(' '), null);
    } }, 'Confirm'),
    h('button', { class: 'ghost', onclick: () => createScreen() }, 'Start over'));
}

// ---------------------------------------------------------------- restore
function restoreScreen() {
  const e = h('div', { class: 'err', hidden: true });
  screen(logo(), h('h2', {}, 'Restore a wallet'),
    h('label', { class: 'field' }, 'Recovery phrase (12 or 24 words)', h('textarea', { id: 'phrase', rows: 3, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' })),
    h('div', { class: 'field' }, 'Where does this wallet come from?',
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'src', value: 'shhhhh', checked: true }), ' Created in shhhhh wallet (fast: a few seconds)'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'src', value: 'full' }), ' Another silent payment wallet, like Cake or Sparrow (scans from block 968,000, the shhhhh launch)'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'src', value: 'block' }), ' I know the block to start from:'),
      h('input', { id: 'bday', inputmode: 'numeric', placeholder: 'e.g. 968871', onfocus: () => { document.querySelector('input[name=src][value=block]').checked = true; } })),
    e,
    h('button', { class: 'main', onclick: () => {
      const p = $('phrase').value;
      if (!K.isValidMnemonic(p)) return err(e, 'That phrase is not valid. Check the words and their order.');
      const src = document.querySelector('input[name=src]:checked').value;
      let b = src === 'full' ? TAPROOT_START : SHHHHH_START;
      if (src === 'block') { b = parseInt($('bday').value, 10); if (!Number.isFinite(b) || b < 0) return err(e, 'Enter a block number, e.g. 968871.'); }
      passwordScreen(K.normalizeMnemonic(p), b);
    } }, 'Continue'),
    h('button', { class: 'ghost', onclick: start }, 'Back'));
}

// ---------------------------------------------------------------- password
function passwordScreen(mnemonic, birthday) {
  const e = h('div', { class: 'err', hidden: true });
  screen(logo(), h('h2', {}, 'Set a password'),
    h('p', { class: 'fine' }, 'Locks the wallet on this device.'),
    h('label', { class: 'field' }, 'Password (8+ characters)', h('input', { id: 'pw1', type: 'password', autocomplete: 'new-password' })),
    h('label', { class: 'field' }, 'Repeat password', h('input', { id: 'pw2', type: 'password', autocomplete: 'new-password' })),
    e,
    h('button', { class: 'main', id: 'go', onclick: async () => {
      const a = $('pw1').value, b = $('pw2').value;
      if (a.length < 8) return err(e, 'Use at least 8 characters.');
      if (a !== b) return err(e, 'The passwords do not match.');
      $('go').disabled = true; $('go').textContent = 'Encrypting…';
      try {
        let bday = birthday;
        if (bday === null) {                          // new wallet: nothing can have been sent to it before now
          // a new wallet cannot have older payments: never fall back to a full scan if this lookup fails
          try { bday = await getTip(); } catch { bday = 0; }
          bday = Math.max(bday || 0, SHHHHH_START);
        }
        const secret = { mnemonic, birthday: bday, stateKey: K.newStateKey(), created: Date.now() };
        store.set(LS_VAULT, await K.lockVault(secret, a));
        kv.del(LS_STATE);
        await openSession(secret);
      } catch (x) { err(e, x); $('go').disabled = false; $('go').textContent = 'Create wallet'; }
    } }, 'Create wallet'));
}

// ---------------------------------------------------------------- unlock
function unlockScreen() {
  const e = h('div', { class: 'err', hidden: true });
  const go = async () => {
    $('go').disabled = true; $('go').textContent = 'Unlocking…';
    try { await openSession(await K.unlockVault(store.get(LS_VAULT), $('pw').value)); }
    catch (x) { err(e, x); $('go').disabled = false; $('go').textContent = 'Unlock'; }
  };
  gate([h('h2', {}, 'Enter your password'),
      h('input', { id: 'pw', type: 'password', placeholder: 'Password', autocomplete: 'current-password', onkeydown: (ev) => ev.key === 'Enter' && go() }), e],
    [h('button', { class: 'main pill-btn', id: 'go', onclick: go }, 'Unlock'),
     h('button', { class: 'textbtn', onclick: () => { if (confirm('Forgot your password? It cannot be reset. You can remove this wallet from this browser; only your 12 words can bring it back (restore is coming soon). Remove it now?')) { store.del(LS_VAULT); store.del(LS_NAME); kv.del(LS_STATE); kv.del(LS_PARTIAL); start(); } } }, 'Forgot password')]);
  setTimeout(() => $('pw') && $('pw').focus(), 50);
}

async function openSession(secret) {
  const wallet = K.walletFromMnemonic(secret.mnemonic);
  const stateKey = await K.stateCryptoKey(secret.stateKey);
  let state = null;
  // sync data lives in IndexedDB (big wallets do not fit in localStorage); move any old copy over once
  for (const k of [LS_STATE, LS_PARTIAL]) { const old = store.get(k); if (old) { await kv.set(k, old); store.del(k); } }
  const sealed = await kv.get(LS_STATE);
  if (sealed) { try { state = await K.openJSON(stateKey, sealed); } catch { state = null; } }
  if (state && !Array.isArray(state.coins)) state = null;     // saved by an older version (other format): sync again
  let partial = null;
  const sp = await kv.get(LS_PARTIAL);
  if (sp) { try { partial = await K.openJSON(stateKey, sp); } catch { partial = null; } }
  S = { wallet, secret, stateKey, state, partial };
  touch(true);
  if (DAPP) return dappScreen();                          // a site's connect / pay request: no home, no sync
  tab = 'home'; home();
  sync(); loadPrice();
}
function lock() { cancelSync(); endSession(); deposit = null; S = null; spage = null; unlockScreen(); }

// ---------------------------------------------------------------- site requests (extension only): connect + pay
// A site on the allow list (background.js) asks through window.shhhhh; background.js keeps the request in
// chrome.storage.session (not readable by web pages) and opens this window with ?req. Nothing is shared or spent
// without a tap here, and a payment also needs the password. The answer goes straight back to the asking tab.
const DAPP = typeof location !== 'undefined' && new URLSearchParams(location.search).has('req') && typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.session);
let dappReq = null, dappDone = false;
async function connectedSites() { try { return (await chrome.storage.local.get('shhhhhSites')).shhhhhSites || []; } catch { return []; } }
function dappReply(payload) {
  if (dappDone || !dappReq) return; dappDone = true;
  chrome.tabs.sendMessage(dappReq.tabId, { type: 'shhhhh-response', id: dappReq.id, ...payload }).catch(() => {});
  chrome.storage.session.remove('shhhhhReq').catch(() => {});
}
if (DAPP) window.addEventListener('beforeunload', () => dappReply({ error: 'Request cancelled' }));
async function dappScreen() {
  dappReq = (await chrome.storage.session.get('shhhhhReq')).shhhhhReq || null;
  if (!dappReq || Date.now() - dappReq.at > 10 * 60000) return gate([h('h2', {}, 'No request'), h('p', { class: 'fine' }, 'This request has expired. Try again from the site.')], [h('button', { class: 'main pill-btn', onclick: () => window.close() }, 'Close')]);
  const site = dappReq.origin.replace(/^https?:\/\//, ''), done = (payload, msg) => { dappReply(payload); if (msg) toast(msg); setTimeout(() => window.close(), 700); };
  const cancel = h('button', { class: 'textbtn', onclick: () => done({ error: 'Request rejected' }) }, 'Cancel');
  if (dappReq.method === 'connect') {
    return gate([h('h2', {}, 'Connect to ' + site), h('p', { class: 'fine' }, 'This site will see your silent payment address. It cannot spend anything: every payment needs your password.'),
        h('div', { class: 'mono' }, S.wallet.address)],
      [h('button', { class: 'main pill-btn', onclick: async () => {
          const list = await connectedSites(); if (!list.includes(dappReq.origin)) await chrome.storage.local.set({ shhhhhSites: [...list, dappReq.origin] });
          done({ result: { address: S.wallet.address } }, 'Connected ✓');
        } }, 'Connect'), cancel]);
  }
  if (dappReq.method === 'sendBitcoin') {
    const { address, sats, feeRate } = dappReq.params || {};
    const fail = (m) => gate([h('h2', {}, 'Payment request'), h('p', { class: 'warn' }, m)], [h('button', { class: 'main pill-btn', onclick: () => done({ error: m }) }, 'Close')]);
    if (!(await connectedSites()).includes(dappReq.origin)) return fail('Connect this site first.');
    let to; try { to = validDest(String(address || '')); } catch (x) { return fail('The site sent a bad address.'); }
    if (!Number.isInteger(sats) || sats < DUST || sats > 1e8) return fail('The site asked for an invalid amount.');
    if (!S.state || !Array.isArray(S.state.coins)) return fail('Your wallet has not finished syncing yet. Open the shhhhh wallet, wait until it says Synced, then try again.');
    await refreshDeposit().catch(() => {});
    let rate = 2; try { rate = (await getFees()).normal; } catch {}
    const siteRate = typeof feeRate === 'number' && feeRate >= 0.1 && feeRate <= 500 ? feeRate : null;   // a site may ask for a fee rate (shown below)
    if (siteRate) rate = siteRate;
    const build = () => buildSend({ utxos: walletCoins(), recipients: [{ address: to, value: sats }], feeRate: rate, changeAddress: S.wallet.changeAddress });
    let preview; try { preview = build(); } catch (x) { return fail(friendly(x.message)); }
    const box = h('div', { class: 'sheet dapp' });
    screen(box);
    reviewIn(box, { title: 'Pay ' + site, cta: 'Confirm & pay',
      hero: { big: btcStr(sats) + ' BTC', sub: dollars(sats) },
      rows: [['To', to], ['Network fee', btcStr(preview.fee) + ' BTC', `${rate} sat/vB` + (siteRate ? ' · set by the site' : '')], ['Total', btcStr(sats + preview.fee) + ' BTC', dollars(sats + preview.fee)]],
      note: `Requested by ${site}. Only confirm if you started this payment.`,
      run: async (status) => { const tx = build(); status('Broadcasting…'); const { txid } = await broadcast(tx.hex); await finishSend({ ...tx, txid }, 'btc', sats); done({ result: { txid } }, 'Paid ✓'); } });
    box.querySelector('.sheet-back').onclick = () => done({ error: 'Request rejected' });
    return;
  }
  done({ error: 'Unknown request' });
}

// ---------------------------------------------------------------- auto-lock
// Locks after N minutes without use (default 15, chosen in Settings). In the Chrome extension the unlocked
// wallet survives closing the popup: it is kept in chrome.storage.session (memory only, never written to disk,
// gone when Chrome quits, not readable by web pages). On the website a reload always asks for the password.
const LS_LOCK = 'shhhhh.autolock';
const autoLockMin = () => store.get(LS_LOCK) || 15;
const extSession = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session ? chrome.storage.session : null;
let lastActive = Date.now(), lastSaved = 0;
function keepSession() {
  lastSaved = Date.now();
  if (extSession && S) extSession.set({ shhhhhSession: { secret: S.secret, lastActive } }).catch(() => {});
}
function endSession() { if (extSession) extSession.remove('shhhhhSession').catch(() => {}); }
function touch(force = false) { lastActive = Date.now(); if (S && (force || lastActive - lastSaved > 5000)) keepSession(); }
function setAutoLock(m) { store.set(LS_LOCK, m); touch(true); }
for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, () => touch(), { passive: true, capture: true });
setInterval(() => { if (S && Date.now() - lastActive > autoLockMin() * 60000) lock(); }, 5000);
async function resumeSession() {
  if (!extSession) return null;
  try {
    const { shhhhhSession: x } = await extSession.get('shhhhhSession');
    if (x && x.secret && Date.now() - x.lastActive < autoLockMin() * 60000) return x.secret;
  } catch {}
  endSession(); return null;
}

// ---------------------------------------------------------------- icons + avatar
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  down: '<path d="M12 4v15"/><path d="m6 13 6 6 6-6"/>',
  up: '<path d="M12 20V5"/><path d="m6 11 6-6 6 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  pen: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m16 7 3 3"/><path d="m18 5 2 2"/>',
  save: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5h3.5a1.75 1.75 0 0 1 0 3.5H9.5h4a1.75 1.75 0 0 1 0 3.5H9.5"/><path d="M11 8v1.5M11 16.5V18"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.9L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L21 15"/><path d="M21 20v-5h-5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>',
  panelx: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/><path d="m7 10 4 4m0-4-4 4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.6 3.4"/><path d="M6.3 6.3A17 17 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.7-1.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
};
function icon(name, size = 22) {
  const sp = document.createElement('span'); sp.className = 'ic';
  sp.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return sp;
}
// account avatar: a gradient picked from the address, so each wallet looks different (like Phantom's colored circles)
function avatar(addr) {
  let x = 0; for (const c of addr) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const a = x % 360, b = (a + 50 + (x >> 9) % 80) % 360;
  return h('div', { class: 'avatar', style: `background:linear-gradient(135deg,hsl(${a} 75% 58%),hsl(${b} 70% 45%))` }, [...walletName()][0].toUpperCase());
}

// ---------------------------------------------------------------- main app (Phantom-style: header, tabs, sheets)
let tab = 'home', btcUsd = null;
setInterval(() => { if (S && document.visibilityState === 'visible') loadPrice(); }, 300000);
async function loadPrice() {
  // our node first (works when mempool.space is blocked or slow), mempool.space as a fallback
  try { btcUsd = (await (await fetch(NODE + '/v1/price', { signal: AbortSignal.timeout(8000) })).json()).usd || null; } catch {}
  if (!btcUsd) try { btcUsd = (await (await fetch('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(8000) })).json()).USD || null; } catch {}
  if (S && tab === 'home') home();
}
// BTC amount: up to 8 decimals, trailing zeros trimmed (0 -> "0")
const btcStr = (sats) => (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') || '0';
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Chrome extension only: move the wallet from the small popup into Chrome's side panel (stays open while browsing)
const inSidePanel = () => document.documentElement.dataset.panel === '1';
const hasSidePanel = () => typeof chrome !== 'undefined' && !!(chrome.sidePanel && chrome.sidePanel.open && chrome.windows);
const canSidePanel = () => hasSidePanel() && !inSidePanel();
// "Always open in the side panel": the toolbar icon opens the panel instead of the popup (also re-applied by background.js)
async function getPanelMode() { try { return !!(await chrome.storage.local.get('sidePanelMode')).sidePanelMode; } catch { return false; } }
async function setPanelMode(on) {
  await chrome.storage.local.set({ sidePanelMode: on });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: on });
  await chrome.action.setPopup({ popup: on ? '' : 'index.html' });
  if (!on) {                                                // switched off: close any side panel that is open now
    chrome.runtime.sendMessage({ type: 'shhhhh-close-panel' }).catch(() => {});
    if (inSidePanel()) setTimeout(() => window.close(), 900);  // switched off from inside the panel itself
  }
}
// an open side panel closes itself when the setting is switched off (from the popup or another window)
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage && typeof document !== 'undefined' && document.documentElement.dataset.panel === '1')
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'shhhhh-close-panel') window.close(); });
async function openSidePanel() {
  try { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); window.close(); }
  catch { toast('The side panel needs Chrome 116 or newer'); }
}
function shell(content) {
  const tabs = [['home', 'Home', 'home'], ['collect', 'Collectibles', 'grid'], ['activity', 'Activity', 'clock'], ['settings', 'Settings', 'gear']];
  app.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'hdr' },
      h('button', { class: 'acct', onclick: (ev) => copy(S.wallet.address, ev.currentTarget.querySelector('small')) },
        avatar(S.wallet.address), h('span', {}, h('b', {}, walletName()), h('small', {}, short(S.wallet.address, 8, 6), icon('copy', 13)))),
      h('div', { class: 'hdr-btns' },
        canSidePanel() ? h('button', { class: 'icon', title: 'Open in side panel', 'aria-label': 'Open in side panel', onclick: openSidePanel }, icon('panel', 20)) : null,
        inSidePanel() ? h('button', { class: 'icon', title: 'Close side panel', 'aria-label': 'Close side panel', onclick: () => window.close() }, icon('panelx', 20)) : null,
        h('button', { class: 'icon', title: 'Lock', 'aria-label': 'Lock', onclick: lock }, icon('lock', 20)))),
    h('main', { class: 'content' }, content),
    h('nav', { class: 'tabs' }, tabs.map(([id, label, ic]) =>
      h('button', { class: 'tab' + (tab === id ? ' on' : ''), onclick: () => { tab = id; spage = null; render(); } }, icon(ic, 23), h('span', {}, label))))));
  window.scrollTo(0, 0);
}
function render() { ({ home, collect, activity, settings })[tab](); }

// balances from the last node sync
function view() {
  const st = S.state;
  if (!st || !Array.isArray(st.coins)) return { btc: 0, tokens: [], insc: [], hiddenInsc: [], ready: false };
  const unspent = st.coins.filter((c) => !c.spent), dep = depositCoins();
  const plain = unspent.filter((c) => c.inscriptions && !c.inscriptions.length && !c.runes);
  const hidden = new Set(st.hidden || []);
  const allInsc = [...unspent, ...dep.filter((c) => !(c.inscriptions || []).includes('runes'))].flatMap((c) => (c.inscriptions || []).map((id) => ({ id, coin: c })));
  const insc = allInsc.filter((x) => !hidden.has(x.id)), hiddenInsc = allInsc.filter((x) => hidden.has(x.id));
  // a BRC-20 send leaves the shown balance at once; UniSat's number is trusted again once it was asked
  // at least 1 block after the send confirmed (brc20AtHeight per address)
  const notCounted = (st.sent || []).filter((x) => x.kind === 'brc20' && x.from && x.tick && !((st.brc20AtHeight || {})[x.from] >= (x.height || Infinity) + 1));
  const sum = new Map();                                    // silent addresses + the deposit address, per tick
  for (const t of [...(st.brc20 || []), ...depositTokens()]) {
    const cur = sum.get(t.tick) || { tick: t.tick, selfMint: t.selfMint, balance: 0, available: 0, transferable: 0 };
    cur.balance += Number(t.balance); cur.available += Number(t.available); cur.transferable += Number(t.transferable || 0);
    sum.set(t.tick, cur);
  }
  const tokens = [...sum.values()].map((t) => {
    const minus = notCounted.filter((x) => x.tick === t.tick).reduce((a, x) => a + Number(x.amt), 0);
    return minus ? { ...t, balance: Math.max(0, t.balance - minus), available: Math.max(0, t.available - minus) } : t;
  }).filter((t) => t.balance > 0).sort((a, b) => (b.tick === 'shhhhh') - (a.tick === 'shhhhh') || b.balance - a.balance);
  const btc = plain.reduce((a, c) => a + c.value, 0) + dep.filter((c) => !c.inscribed).reduce((a, c) => a + c.value, 0);
  return { btc, tokens, insc, hiddenInsc, ready: true };
}

// gold balance card: big BTC (first 4 decimals bold, last 4 small), USD, hide + refresh buttons
const hidden = () => store.get('shhhhh.hide') === true;
function balanceCard(v) {
  const hide = hidden(), fixed = (v.btc / 1e8).toFixed(8);
  return h('div', { class: 'bcard' },
    h('div', { class: 'bcard-top' }, h('span', {}, 'Total balance'),
      h('button', { 'aria-label': hide ? 'Show balance' : 'Hide balance', onclick: () => { store.set('shhhhh.hide', !hide); home(); } }, icon(hide ? 'eyeoff' : 'eye', 19)),
      h('button', { 'aria-label': 'Refresh', class: syncing ? 'spinning' : '', onclick: () => {
        if (syncing || (S && S.busy)) return toast('Already syncing');
        sync(true); toast('Checking for new payments…');
      } }, icon('refresh', 17))),
    h('div', { class: 'bcard-amt' }, !v.ready ? h('span', { class: 'skel big' })
      : hide ? h('b', {}, '••••••') : [h('b', {}, fixed.slice(0, -4)), h('small', {}, fixed.slice(-4))],
      h('span', { class: 'bcard-unit' }, ' BTC')),
    h('div', { class: 'bcard-usd' }, !v.ready || !btcUsd ? '' : hide ? '$••••' : usd(v.btc / 1e8 * btcUsd)));
}
function home() {
  tab = 'home';
  const v = view();
  shell([
    h('section', { class: 'hero' },
      balanceCard(v),
      syncWidget(),
      h('div', { class: 'actions' },
        h('button', { onclick: receiveSheet }, h('i', {}, icon('down')), h('span', {}, 'Receive')),
        h('button', { class: v.ready ? '' : 'off', onclick: () => (v.ready ? sendSheet() : toast('Wait for the sync to finish')) }, h('i', {}, icon('up')), h('span', {}, 'Send')),
        h('button', { onclick: fundSheet }, h('i', {}, icon('plus')), h('span', {}, 'Fund')))),
    depositCard(),
    moveCard(),
    pendingCard(),
    h('section', { class: 'list' },
      asset({ icon: h('div', { class: 'coin btc' }, '₿'), name: 'Bitcoin', sub: btcUsd ? usd(btcUsd) : 'BTC',
              amount: btcStr(v.btc) + ' BTC', value: btcUsd ? usd(v.btc / 1e8 * btcUsd) : '', skeleton: !v.ready }),
      v.tokens.map((t) => asset({ icon: tokenIcon(t.tick), name: t.tick, sub: 'BRC-20' + (t.selfMint ? ' · self-mint' : ''),
              amount: fmt(t.balance) + ' ' + t.tick, value: t.transferable ? `${fmt(t.transferable)} ready to send` : '', onclick: () => brc20Sheet(t) })),
      !v.ready ? null : !v.tokens.length ? asset({ icon: tokenIcon('shhhhh'), name: 'shhhhh', sub: 'BRC-20', amount: '0 shhhhh', value: '' }) : null),
    v.insc.length ? h('section', { class: 'sect' },
      h('div', { class: 'sect-hd' }, h('b', {}, 'Collectibles'), h('button', { class: 'link', onclick: () => { tab = 'collect'; render(); } }, 'See all')),
      h('div', { class: 'tiles' }, v.insc.slice(0, 3).map(inscTile))) : null,
  ]);
}
function tokenIcon(tick) {
  if (tick === 'shhhhh') return h('img', { class: 'coin', src: 'logo.png', alt: '' });
  let x = 0; for (const c of tick) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return h('div', { class: 'coin', style: `background:hsl(${x % 360} 55% 32%);color:#fff;font-size:16px` }, tick.slice(0, 1).toUpperCase());
}
// Safe inscription view: images through <img> (never runs scripts, SVG included), text and BRC-20 as plain text,
// everything else as a labelled box. The node only serves safe types and honours a blocklist.
const inscMeta = new Map();
async function inscInfo(id) {
  if (!inscMeta.has(id)) inscMeta.set(id, fetch(`${NODE}/v1/ord/inscription/${id}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  return inscMeta.get(id);
}
function inscView(id, big = false) {
  const box = h('div', { class: 'insc-view' + (big ? ' big' : '') }, h('span', { class: 'spin' }));
  (async () => {
    const meta = await inscInfo(id);
    const type = (meta.content_type || '').toLowerCase();
    if (/^image\/(png|jpeg|gif|webp|avif|svg\+xml)/.test(type)) {
      box.replaceChildren(h('img', { src: contentUrl(id), alt: '', loading: 'lazy', onerror: () => box.replaceChildren(h('div', { class: 'insc-type' }, 'Not available')) }));
    } else if (/^(text\/plain|application\/json)/.test(type)) {
      const r = await fetch(contentUrl(id));
      if (!r.ok) return box.replaceChildren(h('div', { class: 'insc-type' }, r.status === 451 ? 'Blocked' : 'Not available'));
      const text = (await r.text()).slice(0, big ? 4000 : 400);
      let j = null; try { j = JSON.parse(text); } catch {}
      if (j && j.p === 'brc-20' && j.tick && j.op) {
        box.replaceChildren(h('div', { class: 'brc-card' }, h('b', {}, String(j.tick)), h('span', { class: 'op' }, String(j.op).toUpperCase()),
          j.amt ? h('span', { class: 'amt' }, fmt(j.amt)) : j.max ? h('span', { class: 'amt' }, 'max ' + fmt(j.max)) : null));
      } else {
        box.replaceChildren(h('pre', { class: 'insc-text' }, text));            // textContent only: shown, never interpreted
      }
    } else {
      box.replaceChildren(h('div', { class: 'insc-type' }, type ? type.split(';')[0] : 'Inscription'));
    }
  })().catch(() => box.replaceChildren(h('div', { class: 'insc-type' }, 'Not available')));
  return box;
}
function inscTile(x) {
  return h('button', { class: 'tile filled', onclick: () => inscriptionSheet(x) }, inscView(x.id));
}
function asset({ icon, name, sub, amount, value, soon, skeleton, onclick }) {
  return h(onclick ? 'button' : 'div', { class: 'asset', onclick }, icon,
    h('div', { class: 'meta' }, h('b', {}, name), h('small', {}, sub)),
    h('div', { class: 'amt' }, skeleton ? h('span', { class: 'skel' }) : h('b', {}, amount),
      soon ? h('span', { class: 'pill' }, soon) : h('small', {}, value)));
}

let showHidden = false;
async function setHidden(id, hide) {
  const set = new Set(S.state.hidden || []); hide ? set.add(id) : set.delete(id); S.state.hidden = [...set];
  await kv.set(LS_STATE, await K.sealJSON(S.stateKey, S.state)); render();
}
function collect() {
  const v = view();
  shell([h('h2', { class: 'ttl' }, 'Collectibles'),
    v.hiddenInsc.length ? h('button', { class: 'link', onclick: () => { showHidden = !showHidden; render(); } }, showHidden ? 'Hide hidden items' : `Show hidden (${v.hiddenInsc.length})`) : null,
    showHidden && v.hiddenInsc.length ? h('div', { class: 'tiles dim' }, v.hiddenInsc.map(inscTile)) : null,
    v.insc.length ? h('div', { class: 'tiles' }, v.insc.map(inscTile))
      : h('div', { class: 'empty' }, h('div', { class: 'big-ic' }, icon('grid', 28)), h('b', {}, v.ready ? 'No inscriptions yet' : 'Loading…'),
          h('p', {}, 'Art and BRC-20 inscriptions show up here.'))]);
}

function activity() {
  const st = S.state, sent = new Map(((st && st.sent) || []).map((x) => [x.txid, x]));
  const rows = [];
  for (const x of (st && st.sent) || []) rows.push({ txid: x.txid, height: x.height || 0, dir: 'out', amount: x.amount, label: x.kind === 'inscription' ? 'Sent inscription' : 'Sent' });
  for (const t of (st && st.txs) || []) {
    if (sent.has(t.txid)) continue;                         // our own send: its change is not a "receive"
    const mine = st.coins.filter((c) => c.txid === t.txid);
    // a send found on the blockchain (its change came back to us): shown as Sent, also after a rescan or on a new device
    if (t.out != null || mine.some((c) => c.label === 0)) { rows.push({ txid: t.txid, height: t.height, dir: 'out', amount: t.out || 0, label: 'Sent' }); continue; }
    rows.push({ txid: t.txid, height: t.height, dir: 'in', amount: mine.reduce((a, c) => a + c.value, 0), label: mine.some((c) => c.inscriptions && c.inscriptions.length) ? 'Received inscription' : 'Received' });
  }
  // payments into the deposit address (not part of the silent scan); our own transfer reveals are left out
  const ours = new Set([...sent.keys(), ...((st && st.pending) || []).map((p) => p.revealTxid), ...((st && st.waiting) || []).map((p) => p.revealTxid)]);
  for (const t of (deposit && deposit.history) || []) {
    if (ours.has(t.txid)) continue;
    const insc = deposit.coins.some((c) => c.txid === t.txid && c.inscriptions && c.inscriptions.length);
    rows.push({ txid: t.txid, height: t.height, dir: 'in', amount: t.amount, label: insc ? 'Deposit · inscription' : 'Deposit', deposit: true });
  }
  rows.sort((a, b) => (b.height || 9e9) - (a.height || 9e9));
  shell([h('h2', { class: 'ttl' }, 'Activity'),
    rows.length ? h('div', { class: 'list' }, rows.slice(0, 200).map((x) => h('a', { class: 'asset', href: `https://mempool.space/tx/${x.txid}`, target: '_blank', rel: 'noopener' },
      h('div', { class: 'coin ' + (x.dir === 'out' ? 'sent' : 'recv') }, icon(x.deposit ? 'plus' : x.dir === 'out' ? 'up' : 'down', 20)),
      h('div', { class: 'meta' }, h('b', {}, x.label), h('span', { class: 'badge ' + (x.height ? 'ok' : 'wait'), title: x.height ? `Block ${fmt(x.height)}` : 'Waiting for a block' }, x.height ? 'Confirmed' : 'Pending')),
      h('div', { class: 'amt' }, h('b', { class: x.dir === 'out' ? 'neg' : 'pos' }, (x.dir === 'out' ? '−' : '+') + btcStr(x.amount)), h('small', {}, 'BTC')))))
      : h('div', { class: 'empty' }, h('div', { class: 'big-ic' }, icon('clock', 28)), h('b', {}, 'No activity yet'), h('p', {}, 'Your payments show up here.'))]);
}

// ---------------------------------------------------------------- send (BTC + inscriptions)
// build(close) returns the sheet's content; returns close()
function sheet(build) {
  const close = () => { bg.classList.remove('open'); setTimeout(() => bg.remove(), 250); };
  const x = h('button', { class: 'sheet-x', 'aria-label': 'Close', onclick: () => close() }, '✕');
  const bg = h('div', { class: 'sheet-bg', onclick: (ev) => ev.target === bg && close() }, h('div', { class: 'sheet' }, x, h('div', { class: 'grab' }), ...build(close)));
  document.body.append(bg); requestAnimationFrame(() => bg.classList.add('open'));
  return close;
}
function validDest(a) {
  a = a.trim();
  if (!a) throw new Error('Enter an address.');
  if (/^sp1/i.test(a)) { decodeAddress(a); return a; }
  Address(NETWORK).decode(a); return a;
}
const toSats = (btc) => { const v = String(btc).trim(); if (!/^\d*(\.\d{0,8})?$/.test(v) || v === '' || v === '.') throw new Error('enter an amount in BTC, e.g. 0.0001'); const [i, f = ''] = v.split('.'); return Number(i || 0) * 1e8 + Number((f + '00000000').slice(0, 8)); };
// Slow / Normal / Fast from the node, or Custom (any rate from 0.1 sat/vB). Returns a getter: rateOf() throws a clear
// message while a custom rate is missing or out of range, so Review shows it in the sheet.
async function feePicker(box, onChange) {
  let fees; try { fees = await getFees(); } catch { fees = { fast: 3, normal: 2, slow: 1, min: 1 }; }
  let rate = fees.normal, custom = false;
  const seg = h('div', { class: 'seg3 seg4' });
  const inp = h('input', { type: 'number', min: '0.1', max: '500', step: '0.1', inputmode: 'decimal', placeholder: 'e.g. 2.5', oninput: () => { if (onChange) onChange(); } });
  const hint = h('small', { class: 'fine' }, 'sat/vB');
  const row = h('div', { class: 'custom-fee', hidden: true }, inp, hint);
  const pick = (b, r) => { custom = r === null; [...seg.children].forEach((c) => c.classList.toggle('sel', c === b)); row.hidden = !custom; if (!custom) rate = r; else setTimeout(() => inp.focus(), 30); if (onChange) onChange(); };
  seg.replaceChildren(...[['Slow', fees.slow], ['Normal', fees.normal], ['Fast', fees.fast], ['Custom', null]].map(([n, r], i) => {
    const b = h('button', { class: i === 1 ? 'sel' : '', onclick: (ev) => { ev.preventDefault(); pick(b, r); } }, h('b', {}, n), h('small', {}, r === null ? 'your rate' : `${r} sat/vB`));
    return b;
  }));
  box.className = 'feepick'; box.replaceChildren(seg, row);
  inp.addEventListener('input', () => { const v = Number(inp.value); hint.textContent = v > 0 && v < 1 ? 'sat/vB · below 1 can take a long time to confirm' : 'sat/vB'; });
  return () => {
    if (!custom) return rate;
    const v = Number(inp.value);
    if (!(v >= 0.1 && v <= 500)) throw new Error('enter a custom fee between 0.1 and 500 sat/vB');
    return Math.round(v * 10) / 10;
  };
}
// In-sheet review + password (no browser popups: Chrome can silently block confirm and prompt dialogs on a page)
// review screen inside a sheet: big amount on top, clean label/value rows, password, confirm
const isAddr = (v) => typeof v === 'string' && /^(bc1|tb1|bcrt1|sp1|tsp1)[0-9a-z]{20,}$/i.test(v);
const dollars = (sats) => (btcUsd ? usd(sats / 1e8 * btcUsd) : null);
function reviewIn(sheetEl, { title, hero, rows, note, cta, run }) {
  const saved = [...sheetEl.childNodes];
  const e = h('div', { class: 'err', hidden: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Wallet password' });
  const go = h('button', { class: 'main pill-btn', onclick: async () => {
    e.hidden = true; go.disabled = true; go.textContent = 'Checking password…';
    try {
      await K.unlockVault(store.get(LS_VAULT), pw.value);       // re-check the password before spending
      await run((t) => { go.textContent = t; });
    } catch (x) { err(e, x); go.disabled = false; go.textContent = cta; }
  } }, cta);
  pw.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
  const row = ([k, v, sub]) => isAddr(v)
    ? h('div', { class: 'rv-row addr' }, h('div', { class: 'rv-line' }, h('span', { class: 'rv-k' }, k), h('b', { class: 'rv-v' }, short(v, 8, 8))), h('div', { class: 'rv-full' }, v))
    : h('div', { class: 'rv-row' }, h('span', { class: 'rv-k' }, k), h('span', { class: 'rv-v' }, h('b', {}, v), sub ? h('small', {}, sub) : null));
  sheetEl.replaceChildren(...[
    h('button', { class: 'sheet-back', 'aria-label': 'Back', onclick: () => sheetEl.replaceChildren(...saved) }, icon('back', 20)),
    h('div', { class: 'grab' }), h('h3', {}, title),
    hero ? h('div', { class: 'rv-hero' }, h('b', {}, hero.big), hero.sub ? h('small', {}, hero.sub) : null) : null,
    h('div', { class: 'rv-card' }, rows.map(row)),
    note ? h('p', { class: 'warn' }, note) : null,
    pw, e, go,
  ].filter(Boolean));
  setTimeout(() => pw.focus(), 60);
}
// local dev server only (tools/dev-server.mjs, port 8362): lets the browser test render the review screen without funds
if (typeof location !== 'undefined' && location.host === '127.0.0.1:8362') window.__dev = { reviewIn, sheet, dollars, get S() { return S; }, home: () => home(), completeTransfer, view: () => view(), walletCoins: () => walletCoins(), holders: (t) => holders(t), setDeposit: (d) => { deposit = d; } };
async function finishSend(tx, kind, amount, extra = {}) {
  S.state.sent = [...(S.state.sent || []), { txid: tx.txid, amount, fee: tx.fee, kind, at: Date.now(), inputs: tx.inputs || [], ...extra }];
  for (const op of tx.inputs || []) { const c = S.state.coins.find((x) => `${x.txid}:${x.vout}` === op); if (c) c.spent = true; }
  await kv.set(LS_STATE, await K.sealJSON(S.stateKey, S.state));
}
function sendSheet() {
  const e = h('div', { class: 'err', hidden: true }), feeBox = h('div', { class: 'rates' });
  const coins = walletCoins;
  let rateOf = () => 2, maxMode = false;
  // largest amount that can be sent: plain coins minus the fee for spending them all to one output
  const fillMax = () => {
    const plain = coins().filter((c) => !c.inscribed), sum = plain.reduce((a, c) => a + c.value, 0);
    let r; try { r = rateOf(); } catch (x) { return err(e, x); }
    const fee = Math.ceil(vsizeOf(plain.length, ['p2tr']) * r), v = sum - fee;
    $('amt').value = v >= DUST ? btcStr(v) : '0'; maxMode = v >= DUST;
    if (v < DUST) err(e, 'balance too small to cover the network fee');
  };
  const close = sheet((close) => [h('h3', {}, 'Send BTC'),
    h('label', { class: 'field' }, 'To', h('input', { id: 'to', autocomplete: 'off', spellcheck: 'false', placeholder: 'sp1… or bc1…' })),
    h('label', { class: 'field' }, 'Amount', h('div', { class: 'inwrap' },
      h('input', { id: 'amt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00000000', oninput: () => { maxMode = false; } }),
      h('span', { class: 'unit-in' }, 'BTC'), h('button', { class: 'max-in', onclick: (ev) => { ev.preventDefault(); e.hidden = true; fillMax(); } }, 'Max'))),
    h('label', { class: 'field' }, 'Fee', feeBox), e,
    
    h('button', { class: 'main', onclick: (ev) => {
      e.hidden = true;
      try {
        const to = validDest($('to').value), max = maxMode;
        const value = max ? 0 : toSats($('amt').value), rate = rateOf();
        const build = () => buildSend({ utxos: coins(), recipients: [{ address: to, value }], feeRate: rate, changeAddress: S.wallet.changeAddress, sendMax: max });
        const preview = build();                            // dry run: shows errors before asking the password
        const amount = max ? preview.outputs[0].value : value;
        reviewIn(ev.currentTarget.closest('.sheet'), { title: 'You are sending', cta: 'Confirm & send',
          hero: { big: btcStr(amount) + ' BTC', sub: dollars(amount) },
          rows: [['To', to], ['Network fee', btcStr(preview.fee) + ' BTC', `${rate} sat/vB` + (dollars(preview.fee) ? ' · ' + dollars(preview.fee) : '')], ['Total', btcStr(amount + preview.fee) + ' BTC', dollars(amount + preview.fee)]],
          run: async (status) => { const tx = build(); status('Broadcasting…'); const { txid } = await broadcast(tx.hex); await finishSend({ ...tx, txid }, 'btc', amount); close(); toast('Sent ✓'); render(); setTimeout(sync, 4000); } });
      } catch (x) { err(e, x); }
    } }, 'Review'),
  ]);
  feePicker(feeBox, () => { if (maxMode) fillMax(); }).then((f) => { rateOf = f; });
}
function inscriptionSheet(x) {
  const e = h('div', { class: 'err', hidden: true }), feeBox = h('div', { class: 'rates' });
  let rateOf = () => 2;
  const isHidden = (S.state.hidden || []).includes(x.id);
  const close = sheet((close) => [h('h3', {}, 'Inscription'), inscView(x.id, true),
    h('button', { class: 'link', onclick: () => { close(); setHidden(x.id, !isHidden); } }, isHidden ? 'Show in gallery again' : 'Hide from gallery (spam)'),
    h('a', { class: 'mono', href: `https://ordinals.com/inscription/${x.id}`, target: '_blank', rel: 'noopener' }, x.id),
    h('label', { class: 'field' }, 'Send to', h('input', { id: 'ito', autocomplete: 'off', spellcheck: 'false', placeholder: 'sp1… or bc1p…' })),
    h('label', { class: 'field' }, 'Fee', feeBox), e,
    
    h('button', { class: 'main', onclick: (ev) => {
      e.hidden = true;
      try {
        const to = validDest($('ito').value), rate = rateOf();
        const all = walletCoins();
        const coin = all.find((c) => c.txid === x.coin.txid && c.vout === x.coin.vout);
        const build = () => buildSendInscription({ utxos: all, inscribed: coin, to, feeRate: rate, changeAddress: S.wallet.changeAddress });
        const preview = build();
        const many = (x.coin.inscriptions || []).length;
        reviewIn(ev.currentTarget.closest('.sheet'), { title: 'You are sending', cta: 'Confirm & send',
          hero: { big: 'Inscription', sub: short(x.id, 10, 6) },
          rows: [['To', to], ['Network fee', btcStr(preview.fee) + ' BTC', `${rate} sat/vB` + (dollars(preview.fee) ? ' · ' + dollars(preview.fee) : '')]],
          note: many > 1 ? `This coin carries ${many} inscriptions: all of them will be sent.` : null,
          run: async (status) => { const tx = build(); status('Broadcasting…'); const { txid } = await broadcast(tx.hex); await finishSend({ ...tx, txid }, 'inscription', coin.value); close(); toast('Inscription sent ✓'); render(); setTimeout(sync, 4000); } });
      } catch (x2) { err(e, x2); }
    } }, 'Review'),
  ]);
  feePicker(feeBox).then((f) => { rateOf = f; });
}

function receiveSheet() {
  const qr = qrcode(0, 'M'); qr.addData(S.wallet.address.toUpperCase(), 'Alphanumeric'); qr.make();
  const close = () => { bg.classList.remove('open'); setTimeout(() => bg.remove(), 250); };
  const box = h('div', { class: 'qrbox' }); box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const bg = h('div', { class: 'sheet-bg', onclick: (ev) => ev.target === bg && close() },
    h('div', { class: 'sheet' }, h('button', { class: 'sheet-x', 'aria-label': 'Close', onclick: () => close() }, '✕'), h('div', { class: 'grab' }),
      h('h3', {}, 'Receive'), h('p', { class: 'fine' }, 'Your silent payment address'), box,
      h('div', { class: 'mono' }, S.wallet.address),
      h('button', { class: 'main', onclick: (ev) => copy(S.wallet.address, ev.currentTarget) }, 'Copy address'),
      h('p', { class: 'fine' }, 'Reusable and private. Senders need sp1 support, or use Fund.')));
  document.body.append(bg); requestAnimationFrame(() => bg.classList.add('open'));
}
function toast(msg) {
  const t = h('div', { class: 'toast' }, msg); document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show')); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
}
function copy(text, el) {
  navigator.clipboard.writeText(text).then(() => { toast('Address copied'); });
}

// ---------------------------------------------------------------- Fund: deposit address (normal bc1p, same 12 words)
// No "move to silent" step: once confirmed, deposit coins count in the balance and Send spends them directly
// (change goes to the silent change address). Unconfirmed ones only show as "incoming".
let deposit = null;                                       // last reading of the deposit address (not stored: it is public data)
async function refreshDeposit() {
  if (!S || !S.wallet.deposit) return null;
  const before = deposit;
  try { deposit = await getDeposit(S.wallet.deposit); } catch (e) { deposit = before && !before.error ? before : { error: e.message }; return deposit; }
  if (!deposit.history && before && before.history) deposit.history = before.history;   // history read failed: keep the last one
  if (deposit.brc20 === null) deposit.brc20 = before && Array.isArray(before.brc20) ? before.brc20 : [];   // token check failed: keep the last answer
  else if (S.state) S.state.brc20AtHeight = { ...(S.state.brc20AtHeight || {}), [S.wallet.deposit.address]: S.state.height || 0 };
  return deposit;
}
const usedInputs = () => new Set(((S.state && S.state.sent) || []).flatMap((x) => x.inputs || []));
// confirmed deposit coins, minus the ones our own sends already spent (the explorer can lag behind)
function depositCoins() {
  if (!deposit || deposit.error || !S.state) return [];
  const gone = usedInputs();
  const held = new Set([...(S.state.pending || []), ...(S.state.waiting || [])].map((p) => `${p.revealTxid}:${p.vout || 0}`));
  return deposit.coins.filter((c) => c.confirmed && !gone.has(`${c.txid}:${c.vout}`))
    .map((c) => ({ ...c, deposit: true, inscribed: c.inscribed || held.has(`${c.txid}:${c.vout}`) }));
}
const depositTokens = () => (deposit && !deposit.error && deposit.brc20) || [];
const walletCoins = () => [...spendable(S.state, S.wallet, outputPrivKey), ...depositCoins()];
function depositCard() {
  if (!deposit || deposit.error || !S.state) return null;
  const gone = usedInputs(), inc = deposit.coins.filter((c) => !c.confirmed && !gone.has(`${c.txid}:${c.vout}`));
  if (!inc.length) return null;
  return h('button', { class: 'card fundcard', onclick: fundSheet },
    h('b', {}, 'Incoming deposit'),
    h('span', { class: 'fine' }, `${inc.length === 1 ? '1 payment' : inc.length + ' payments'} on your deposit address · shows in your balance after 1 confirmation`));
}
function fundSheet() {
  if (!S.wallet.deposit) return toast('Lock and unlock the wallet once to enable funding');
  const dep = S.wallet.deposit;
  const qr = qrcode(0, 'M'); qr.addData(dep.address.toUpperCase(), 'Alphanumeric'); qr.make();
  const box = h('div', { class: 'qrbox' }); box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  sheet(() => [h('h3', {}, 'Fund your wallet'),
    h('p', { class: 'fine' }, 'For exchanges and other Bitcoin wallets. BTC, BRC-20 and inscriptions sent here show in your balance after 1 confirmation.'),
    box, h('div', { class: 'mono' }, dep.address),
    h('button', { class: 'main', onclick: () => copy(dep.address) }, 'Copy deposit address'),
    h('p', { class: 'warn' }, 'This is a normal address: anyone who knows it can see what it holds.'),
  ]);
}

// ---------------------------------------------------------------- BRC-20 send: 1) prepare (commit + reveal to the holder address)
//                                                                  2) complete (send the transfer inscription) after 1 confirmation
function holders(tick) {
  const by = (S.state && S.state.brc20ByAddress) || {};
  return Object.entries(by).map(([addr, list]) => ({ addr, t: list.find((x) => x.tick === tick) })).filter((x) => x.t && Number(x.t.available) > 0)
    .map((x) => ({ addr: x.addr, available: Number(x.t.available), coin: S.state.coins.find((c) => c.address === x.addr) }))
    .concat(depositTokens().filter((t) => t.tick === tick && Number(t.available) > 0)
      .map((t) => ({ addr: S.wallet.deposit.address, available: Number(t.available), coin: { xonly: S.wallet.deposit.xonly }, deposit: true })))
    .sort((a, b) => b.available - a.available);
}
function brc20Sheet(t) {
  const e = h('div', { class: 'err', hidden: true }), feeBox = h('div', { class: 'rates' });
  let rateOf = () => 2;
  const hs = holders(t.tick), most = hs.length ? hs[0].available : 0;
  const close = sheet((close) => [h('h3', {}, `Send ${t.tick}`),
    h('p', { class: 'fine' }, `Available: ${fmt(t.available)} ${t.tick}` + (hs.length > 1 ? ` (spread over ${hs.length} addresses; up to ${fmt(most)} per transfer)` : '')),
    h('label', { class: 'field' }, 'To', h('input', { id: 'bto', autocomplete: 'off', spellcheck: 'false', placeholder: 'sp1… or bc1p…' })),
    h('label', { class: 'field' }, h('span', {}, `Amount (${t.tick}) `, h('button', { class: 'link', onclick: () => { $('bamt').value = String(most); } }, 'Max')),
      h('input', { id: 'bamt', inputmode: 'decimal', autocomplete: 'off' })),
    h('label', { class: 'field' }, 'Fee', feeBox), e,
    h('p', { class: 'fine' }, '2 steps: prepare now, complete after 1 confirmation.'),
    h('button', { class: 'main', onclick: (ev) => {
      e.hidden = true;
      try {
        const to = validDest($('bto').value), amt = $('bamt').value.trim(), rate = rateOf();
        if (!/^\d+(\.\d+)?$/.test(amt) || Number(amt) <= 0) throw new Error('enter an amount');
        const holder = hs.find((x) => x.available >= Number(amt));
        if (!holder) throw new Error(`at most ${fmt(most)} ${t.tick} can be sent in one transfer`);
        if (!holder.coin) throw new Error('token address not found in this wallet');
        const nonce = Date.now();
        const build = () => buildInscribeTransfer({ wallet: S.wallet, utxos: walletCoins(), holderXonly: holder.coin.xonly,
          tick: t.tick, amt, feeRate: rate, changeAddress: S.wallet.changeAddress, nonce });
        const preview = build();
        const revealFee = preview.commit.outputs.find((o) => o.raw).value - preview.postage;
        reviewIn(ev.currentTarget.closest('.sheet'), { title: 'Step 1 of 2: prepare', cta: 'Confirm & prepare',
          rows: [['Token', `${fmt(amt)} ${t.tick}`], ['To', to], ['Network fees', `${btcStr(preview.commit.fee + revealFee)} BTC · ${rate} sat/vB`], ['Goes with the tokens', `${preview.postage} sats`]],
          note: 'After 1 confirmation (~10 min), tap Complete on the home screen to send it.',
          run: async (status) => {
            const it = build(); status('Broadcasting…');
            await broadcast(it.commit.hex); await broadcast(it.reveal.hex);
            for (const op of it.commit.inputs) { const c = S.state.coins.find((x) => `${x.txid}:${x.vout}` === op); if (c) c.spent = true; }
            S.state.pending = [...(S.state.pending || []), { tick: t.tick, amt, to, nonce, holder: holder.deposit ? { deposit: true, xonly: holder.coin.xonly } : { txid: holder.coin.txid, vout: holder.coin.vout, xonly: holder.coin.xonly, tweak: holder.coin.tweak },
              inscriptionId: it.inscriptionId, revealTxid: it.reveal.txid, commitTxid: it.commit.txid, postage: it.postage, at: Date.now() }];
            await finishSend({ txid: it.commit.txid, fee: it.commit.fee, inputs: it.commit.inputs }, 'brc20-prepare', it.commit.fee);
            close(); toast('Transfer prepared ✓ complete it after 1 confirmation'); render();
          } });
      } catch (x) { err(e, x); }
    } }, 'Review'),
  ]);
  feePicker(feeBox).then((f) => { rateOf = f; });
}
// "Moving to silent" progress on home: Sent -> seen by the wallet (mempool) -> Confirmed; gone 1 min after confirmation
const addMove = (txid, kind, what) => { S.state.moves = [...(S.state.moves || []), { txid, kind, what, at: Date.now() }]; };
function moveCard() {
  const st = S.state; if (!st || !st.moves || !st.moves.length) return null;
  const now = Date.now();
  for (const m of st.moves) { const t = (st.txs || []).find((x) => x.txid === m.txid); if (t && t.height > 0 && !m.doneAt) m.doneAt = now; }
  st.moves = st.moves.filter((m) => !m.doneAt || now - m.doneAt < 60000);
  if (!st.moves.length) return null;
  if (st.moves.some((m) => m.doneAt)) setTimeout(() => { if (S && tab === 'home' && !document.querySelector('.sheet-bg')) home(); }, 61000);
  return h('section', { class: 'mvcard' }, st.moves.map((m) => {
    const t = (st.txs || []).find((x) => x.txid === m.txid), stage = m.doneAt ? 3 : t ? 2 : 1;
    return h('a', { class: 'mv' + (m.doneAt ? ' done' : ''), href: `https://mempool.space/tx/${m.txid}`, target: '_blank', rel: 'noopener' },
      h('div', { class: 'mv-hd' }, h('b', {}, m.doneAt ? 'Moved to silent ✓' : 'Moving to silent'), h('span', {}, m.what)),
      h('div', { class: 'mv-bar' }, [1, 2, 3].map((i) => h('i', { class: i < stage || stage === 3 ? 'on' : i === stage ? 'now' : '' }))),
      h('div', { class: 'mv-steps' }, h('span', {}, 'Sent'), h('span', {}, 'In mempool'), h('span', {}, 'Confirmed')));
  }));
}
function pendingCard() {
  const noted = (S.state && S.state.pending) || [];
  const p = [...noted, ...((S.state && S.state.waiting) || []).filter((w) => !noted.some((n) => n.inscriptionId === w.inscriptionId))];
  if (!p.length) return null;
  return h('section', { class: 'card' }, h('b', {}, 'BRC-20 transfers in progress'),
    p.map((x) => h('div', { class: 'row' }, h('span', {}, x.to ? `${fmt(x.amt)} ${x.tick} → ${short(x.to, 8, 6)}` : `${fmt(x.amt)} ${x.tick} · ready to send`),
      h('button', { class: 'chip', onclick: () => completeTransfer(x) }, 'Complete'))),
    h('p', { class: 'fine' }, 'Tap Complete after 1 confirmation.'));
}
async function completeTransfer(x) {
  // opens a panel straight away; every problem is explained INSIDE it (a 2-second toast was easy to miss)
  let box = null;
  const close = sheet(() => { box = h('div', { class: 'ct-box' }, h('h3', {}, 'Step 2 of 2: send'), h('div', { class: 'sync-what' }, h('span', { class: 'spin' }), 'Checking the transfer…')); return [box]; });
  const fail = (msg, extra) => box.replaceChildren(...[h('h3', {}, 'Step 2 of 2: send'), h('p', { class: 'warn' }, msg), extra, h('button', { class: 'ghost pill-btn', onclick: close }, 'Close')].filter(Boolean));
  try {
    const st = await (await fetch(`${NODE}/v1/outspends`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outpoints: [`${x.revealTxid}:${x.vout || 0}`] }) })).json();
    if (!st[0] || !st[0].unspent) {
      const ts = await getTxStatus(x.revealTxid).catch(() => ({}));
      if (ts.found && ts.confirmed) {                                    // the inscription already moved on: nothing left to complete
        S.state.pending = S.state.pending.filter((p) => p.inscriptionId !== x.inscriptionId);
        await kv.set(LS_STATE, await K.sealJSON(S.stateKey, S.state)); render();
        return fail('This transfer was already completed (the token inscription has been sent). It is removed from this list.');
      }
      return fail(ts.found ? 'Step 1 is still waiting for its first confirmation. Try again in a few minutes.' : 'Step 1 is not on the network yet. Wait a few minutes and try again.');
    }
    if (!st[0].confirmations) return fail('Step 1 is still waiting for its first confirmation (~10 min). Try again after that.');
    if (!x.to) {                                                         // recovered transfer: ask where to send it
      const e = h('div', { class: 'err', hidden: true }), inp = h('input', { autocomplete: 'off', spellcheck: 'false', placeholder: 'sp1… or bc1p…' });
      const dest = await new Promise((resolve) => box.replaceChildren(h('h3', {}, 'Step 2 of 2: send'),
        h('p', { class: 'fine' }, `${fmt(x.amt)} ${x.tick} are ready to send. Where to?`), h('label', { class: 'field' }, 'To', inp), e,
        h('button', { class: 'main pill-btn', onclick: () => { try { resolve(validDest(inp.value)); } catch (er) { err(e, er); } } }, 'Continue'),
        h('button', { class: 'ghost pill-btn', onclick: () => { close(); resolve(null); } }, 'Cancel')));
      if (!dest) return;
      x = { ...x, to: dest };
    }
    const all = walletCoins();
    const coin = { txid: x.revealTxid, vout: x.vout || 0, value: x.postage, xonly: x.holder.xonly, priv: x.holder.deposit ? S.wallet.deposit.priv : outputPrivKey(S.wallet.bSpend, x.holder.tweak), inscribed: true };
    const fees = await getFees().catch(() => ({ normal: 2 }));
    const build = () => buildSendInscription({ utxos: [...all.filter((c) => !(c.txid === coin.txid && c.vout === coin.vout)), coin], inscribed: coin, to: x.to, feeRate: fees.normal, changeAddress: S.wallet.changeAddress });
    let preview;
    try { preview = build(); }
    catch (e) {
      if (/not enough plain BTC/i.test(e.message)) {
        const need = Math.ceil(vsizeOf(2, ['p2tr', 'p2tr']) * fees.normal) + DUST;
        return fail(`Step 2 needs a little BTC to pay the network fee: about ${fmt(need)} sats (${btcStr(need)} BTC). Add some BTC with Receive or Fund, wait for 1 confirmation, then tap Complete again. Your ${x.tick} are safe in the meantime.`);
      }
      throw e;
    }
    reviewIn(box.closest('.sheet'), { title: 'Step 2 of 2: send', cta: 'Confirm & send',
      rows: [['Token', `${fmt(x.amt)} ${x.tick}`], ['To', x.to], ['Network fee', `${btcStr(preview.fee)} BTC · ${fees.normal} sat/vB`]],
      run: async (status) => {
        const tx = build(); status('Broadcasting…');
        const { txid } = await broadcast(tx.hex);
        S.state.pending = (S.state.pending || []).filter((p) => p.inscriptionId !== x.inscriptionId);
        S.state.waiting = (S.state.waiting || []).filter((p) => p.inscriptionId !== x.inscriptionId);
        await finishSend({ ...tx, txid }, 'brc20', tx.fee, { tick: x.tick, amt: x.amt, from: x.holder.deposit ? S.wallet.deposit.address : taprootAddress(x.holder.xonly) });
        close(); toast(`Sent ${x.amt} ${x.tick} ✓`); render(); setTimeout(sync, 4000);
      } });
  } catch (e) { fail(friendly(e.message || String(e))); }
}

// ---------------------------------------------------------------- sync (shhhhh node: Frigate + ord + BRC-20)
// ---------------------------------------------------------------- sync status widget
// 4 steps of a sync: Frigate scan -> verify with our keys -> ord (inscriptions) -> BRC-20 balances
const STEPS = [
  { id: 'scan', name: 'Frigate', what: 'Finding your payments' },
  { id: 'verify', name: 'Verify', what: 'Checking them with your keys' },
  { id: 'inscriptions', name: 'ord', what: 'Reading inscriptions' },
  { id: 'brc20', name: 'BRC-20', what: 'Reading token balances' },
];
function syncWidget() {
  const box = h('div', { id: 'sync', class: 'syncw' });
  fillSync(box);
  return box;
}
function fillSync(box) {
  if (!box) return;
  if (syncing && S.syncStep) {
    const cur = STEPS.findIndex((x) => x.id === S.syncStep), st = STEPS[cur] || STEPS[0];
    const pct = S.syncPct > 0 && S.syncPct <= 1 ? Math.round(S.syncPct * 100) : null;
    box.className = 'syncw busy';
    box.replaceChildren(
      h('div', { class: 'sync-steps' }, STEPS.map((x, i) => h('div', { class: 'seg' + (i < cur ? ' done' : i === cur ? ' on' : '') },
        h('i', { style: i === cur && pct !== null ? `width:${pct}%` : '' }), h('span', {}, x.name)))),
      h('div', { class: 'sync-what' }, h('span', { class: 'spin' }), `${st.what}`, pct !== null ? h('b', {}, ` ${pct}%`) : null));
  } else if (syncing) {
    box.className = 'syncw busy'; box.replaceChildren(h('div', { class: 'sync-what' }, h('span', { class: 'spin' }), 'Connecting to the shhhhh node…'));
  } else if (S.syncError) {
    box.className = 'syncw bad'; box.replaceChildren(h('div', { class: 'sc-row' },
      h('span', { class: 'sc-dot' }), h('div', { class: 'sc-main' }, h('b', {}, 'Sync paused'), h('small', {}, S.syncError.replace(/^Sync failed: /, '')))));
  } else if (S.state) {
    box.className = 'syncw ok' + (live ? ' live' : ''); box.replaceChildren(h('div', { class: 'sc-row' },
      h('span', { class: 'sc-dot' }),
      h('div', { class: 'sc-main' }, h('b', {}, 'Synced'), h('small', {}, live ? 'Live' : 'Up to date')),
      h('div', { class: 'sc-side' }, h('small', {}, 'Block '), h('b', {}, fmt(S.state.height)))));
  } else {
    box.className = 'syncw busy'; box.replaceChildren(h('div', { class: 'sync-what' }, h('span', { class: 'spin' }), 'Connecting to the shhhhh node…'));
  }
}
// quiet: a background refresh (new block / live payment) that keeps the "Up to date" line instead of showing progress
// Rescan: keeps the saved wallet (balance stays visible) and marks it; the next sync reads again from the start block
// but skips payments it already knows. The mark is saved, so closing the extension popup does not restart from zero.
async function startRescan() {
  if (S.state && S.state.coins) { S.state.rescan = true; await kv.set(LS_STATE, await K.sealJSON(S.stateKey, S.state)); }
  else { S.state = null; S.partial = null; kv.del(LS_STATE); kv.del(LS_PARTIAL); }
  spage = null; tab = 'home'; home(); sync();
}
async function sync(quiet = false) {
  if (!S || syncing) return;
  quiet = quiet && !!(S.state && S.state.coins);
  syncing = !quiet; S.syncError = null; const gen = ++syncGen; syncAbort = new AbortController(); S.busy = true;
  S.syncStep = null; S.syncPct = 0; fillSync($('sync'));
  try {
    const prev = S.state && S.state.coins ? S.state : null;
    const carry = prev || S.keep || null; const keep = S.keep || null; S.keep = null;   // a rescan keeps token balances, sends, pending transfers, hidden items
    const brc20All = !!S.brc20All; S.brc20All = false;
    const r = await syncWallet(S.wallet, { birthday: S.secret.birthday || 0, prev, keep, fromStart: !!(prev && prev.rescan), signal: syncAbort.signal, brc20All,
      resume: prev ? null : S.partial || null,
      onCheckpoint: async (snap) => { if (gen !== syncGen) return; snap.sent = (carry && carry.sent) || []; snap.pending = (carry && carry.pending) || []; snap.hidden = (carry && carry.hidden) || []; snap.moves = (carry && carry.moves) || []; S.state = snap; S.partial = null; await kv.del(LS_PARTIAL); await kv.set(LS_STATE, await K.sealJSON(S.stateKey, snap)); },
      onBrc20Save: async (b) => { if (gen !== syncGen || !S.state || !S.state.coins) return; Object.assign(S.state, b); await kv.set(LS_STATE, await K.sealJSON(S.stateKey, S.state)); if (tab === 'home' && !document.querySelector('.sheet-bg')) home(); },
      onChunk: async (part) => { if (gen !== syncGen) return; S.partial = part; await kv.set(LS_PARTIAL, await K.sealJSON(S.stateKey, part)); },
      onStep: (st, p) => { if (gen !== syncGen || quiet) return; S.syncStep = st; S.syncPct = p; fillSync($('sync')); } });
    if (gen !== syncGen || !S) return;
    // keep our local send log; mark sends confirmed once their tx shows up with a height
    r.sent = ((carry && carry.sent) || []).map((x) => ({ ...x, height: (r.txs.find((t) => t.txid === x.txid) || {}).height || x.height || 0 }));
    // sends the scan cannot see (no change came back, e.g. Max): ask the node whether they are confirmed
    for (const x of r.sent.filter((x) => !x.height).slice(0, 20)) { try { const st = await getTxStatus(x.txid); if (st.height) x.height = st.height; } catch {} }
    for (const x of r.sent) if (!r.txs.some((t) => t.txid === x.txid)) for (const c of r.coins) if (x.inputs && x.inputs.includes(`${c.txid}:${c.vout}`)) c.spent = true;
    r.pending = (carry && carry.pending) || []; r.hidden = (carry && carry.hidden) || []; r.moves = ((carry && carry.moves) || []).map((m) => (!m.doneAt && r.txs.some((t) => t.txid === m.txid && t.height > 0) ? { ...m, doneAt: Date.now() } : m)).filter((m) => !m.doneAt || Date.now() - m.doneAt < 60000);
    S.state = r; S.partial = null; kv.del(LS_PARTIAL);
    await kv.set(LS_STATE, await K.sealJSON(S.stateKey, S.state));
  } catch (x) {
    if (gen !== syncGen) return;                            // cancelled on purpose
    console.error('shhhhh sync failed:', x);
    S.syncError = 'Sync failed: ' + (x.message || x) + ' · retrying in 1 min';
    setTimeout(() => { if (gen === syncGen) sync(); }, 60000);
  } finally {
    if (S) S.busy = false;
    if (gen === syncGen) { syncing = false; startLive(); refreshDeposit().then(() => { if (S && tab === 'home' && !document.querySelector('.sheet-bg')) home(); }); if (S && tab !== 'settings' && !document.querySelector('.sheet-bg')) render(); }
  }
}
// After a sync: keep ONE live subscription open (new payments arrive instantly) and check the block height once a
// minute; a quiet incremental sync runs only when a block arrived or a payment showed up. No more blind re-syncs.
let live = null, liveFor = null;
function startLive() {
  if (!S || !S.state || !S.state.coins || (live && liveFor === S.wallet.address)) return;
  stopLive(); liveFor = S.wallet.address;
  live = liveWatch(S.wallet, S.state.height, {
    onActivity: () => { if (S && !S.busy) sync(true); },
    onClose: () => { live = null; setTimeout(() => S && startLive(), 15000); },   // reconnect after a drop
  });
}
function stopLive() { if (live) live.close(); live = null; liveFor = null; }
setInterval(async () => {
  if (!S || S.busy || !S.state || !S.state.coins || document.visibilityState !== 'visible') return;
  try { if ((await getTip()) > S.state.height) sync(true); } catch {}
}, 60000);

// ---------------------------------------------------------------- settings
// list of rows; each opens its own page (back arrow on top). The tab bar stays.
let spage = null;
const LOCK_CHOICES = [[1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours']];
const lockLabel = (m) => (LOCK_CHOICES.find(([v]) => v === m) || [0, m + ' minutes'])[1];
function srow(ic, title, value, page, danger = false) {
  return h('button', { class: 'srow' + (danger ? ' danger' : ''), onclick: () => { spage = page; settings(); } },
    h('span', { class: 'srow-ic' }, icon(ic, 19)), h('span', { class: 'srow-t' }, h('b', {}, title)),
    value ? h('span', { class: 'srow-v' }, value) : null, h('span', { class: 'srow-ch' }, icon('chev', 16)));
}
function settings() {
  tab = 'settings';
  if (spage && PAGES[spage]) return PAGES[spage]();
  if (hasSidePanel() && S.panelMode === undefined) { getPanelMode().then((m) => { S.panelMode = m; if (tab === 'settings' && !spage) settings(); }); }
  spage = null;
  shell([h('h2', { class: 'ttl' }, 'Settings'),
    h('div', { class: 'sgroup' }, 'Wallet'),
    h('div', { class: 'slist' }, srow('pen', 'Wallet name', walletName(), 'name')),
    h('div', { class: 'sgroup' }, 'Security'),
    h('div', { class: 'slist' },
      srow('lock', 'Auto-lock', lockLabel(autoLockMin()), 'autolock'),
      srow('key', 'Recovery phrase', null, 'phrase')),
    hasSidePanel() ? h('div', { class: 'sgroup' }, 'Extension') : null,
    hasSidePanel() ? h('div', { class: 'slist' }, srow('panel', 'Side panel', S.panelMode ? 'On' : 'Off', 'sidepanel')) : null,
    h('div', { class: 'sgroup' }, 'Sync'),
    h('div', { class: 'slist' },
      srow('coin', 'Find missing tokens', null, 'brc20'),
      srow('refresh', 'Rescan wallet', null, 'rescan')),
    h('div', { class: 'slist' }, srow('trash', 'Remove wallet', null, 'remove', true)),
    h('p', { class: 'fine center' }, 'BIP352 silent payments · keys stay in this browser')]);
}
// one settings page: back bar, big icon, title, one-line description, then its content
function spageView(ic, title, desc, body, danger = false) {
  shell([h('div', { class: 'pg-top' },
      h('button', { class: 'icon', 'aria-label': 'Back', onclick: () => { spage = null; settings(); } }, icon('back', 20)),
      h('b', {}, 'Settings')),
    h('div', { class: 'pg-hero' + (danger ? ' danger' : '') }, h('span', { class: 'pg-ic' }, icon(ic, 30)), h('h2', {}, title), desc ? h('p', { class: 'fine center' }, desc) : null),
    ...body]);
}
// heavy actions on the shared node: once per 30 minutes per browser
const COOL_MIN = 30;
const markUsed = (k) => store.set('shhhhh.used.' + k, Date.now());
function coolingDown(k) {
  const left = COOL_MIN - Math.floor((Date.now() - (store.get('shhhhh.used.' + k) || 0)) / 60000);
  if (left <= 0) return false;
  spageView(k === 'rescan' ? 'refresh' : 'coin', k === 'rescan' ? 'Rescan wallet' : 'Find missing tokens',
    `Already done recently. Available again in ${left} min.`, [h('p', { class: 'fine center' }, 'This keeps the shhhhh node fast for everyone. Your wallet keeps syncing new blocks on its own.')]);
  return true;
}
const pwField = (id) => h('input', { id, type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
const NAME_MAX = 24;
const PAGES = {
  name() {
    const e = h('div', { class: 'err', hidden: true });
    const inp = h('input', { id: 'wname', type: 'text', maxlength: String(NAME_MAX), autocomplete: 'off', spellcheck: 'false', value: walletName(), placeholder: 'Silent wallet' });
    const save = () => {
      const v = [...inp.value.replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();   // longer names are cut
      if (v && v !== 'Silent wallet') store.set(LS_NAME, v); else store.del(LS_NAME);
      toast('Name saved'); spage = null; settings();
    };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
    spageView('pen', 'Wallet name', 'Shown at the top of your wallet. Only saved in this browser.', [
      inp, e, h('button', { class: 'main pill-btn', onclick: save }, 'Save'),
      h('button', { class: 'textbtn', onclick: () => { inp.value = ''; save(); } }, 'Use the default name')]);
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  },
  autolock() {
    const cur = autoLockMin();
    spageView('lock', 'Auto-lock', 'Lock the wallet after this long without use.', [
      h('div', { class: 'slist' }, LOCK_CHOICES.map(([m, label]) =>
        h('button', { class: 'srow opt' + (m === cur ? ' sel' : ''), onclick: () => { setAutoLock(m); toast(`Locks after ${label}`); PAGES.autolock(); } },
          h('span', { class: 'srow-t' }, h('b', {}, label)), m === cur ? h('span', { class: 'opt-ck' }, icon('check', 18)) : null))),
      h('p', { class: 'fine center' }, 'Use the lock button at the top to lock right away.')]);
  },
  async sidepanel() {
    S.panelMode = await getPanelMode();
    const opt = (on, label, sub) => h('button', { class: 'srow opt' + (S.panelMode === on ? ' sel' : ''), onclick: async () => {
      try { await setPanelMode(on); S.panelMode = on; toast(on ? 'The icon now opens the side panel' : 'The icon now opens the popup'); PAGES.sidepanel(); }
      catch { toast('Not available in this Chrome'); }
    } }, h('span', { class: 'srow-t' }, h('b', {}, label), h('small', {}, sub)), S.panelMode === on ? h('span', { class: 'opt-ck' }, icon('check', 18)) : null);
    spageView('panel', 'Side panel', 'Choose what the shhhhh icon in the toolbar opens.', [
      h('div', { class: 'slist' }, opt(false, 'Popup', 'Small window, closes when you click away'), opt(true, 'Side panel', 'Stays open on the right while you browse'))]);
  },
  phrase() {
    const e = h('div', { class: 'err', hidden: true }), out = h('div');
    const btn = h('button', { class: 'main pill-btn', onclick: async () => {
      e.hidden = true;
      try {
        const s = await K.unlockVault(store.get(LS_VAULT), $('pw').value);
        out.replaceChildren(h('ol', { class: 'words' }, s.mnemonic.split(' ').map((w) => h('li', {}, w))));
        form.remove();
      } catch (x) { err(e, x); }
    } }, 'Show phrase');
    const form = h('div', { class: 'pg-form' }, pwField('pw'), e, btn);
    spageView('key', 'Recovery phrase', null, [
      h('p', { class: 'warn' }, 'Never share these 12 words. Anyone who has them owns your wallet.'), form, out]);
    $('pw').addEventListener('keydown', (ev) => ev.key === 'Enter' && btn.click());
  },
  brc20() {
    if (coolingDown('brc20')) return;
    spageView('coin', 'Find missing tokens', 'Checks every address of this wallet for BRC-20 balances. Takes a few minutes.', [
      h('button', { class: 'main pill-btn', onclick: () => { markUsed('brc20'); S.brc20All = true; cancelSync(); spage = null; tab = 'home'; home(); sync(); } }, 'Check all now')]);
  },
  rescan() {
    if (coolingDown('rescan')) return;
    spageView('refresh', 'Rescan wallet', 'Reads your wallet again from the start block. Use it if a payment is missing.', [
      h('button', { class: 'main pill-btn', onclick: () => { markUsed('rescan'); cancelSync(); startRescan(); } }, 'Rescan now')]);
  },
  remove() {
    spageView('trash', 'Remove wallet', 'Deletes the wallet from this browser.', [
      h('p', { class: 'warn' }, 'Only your 12 words can bring it back. Without them, the funds are gone forever.'),
      h('button', { class: 'main pill-btn bad', onclick: () => {
        if (!confirm('Remove this wallet from this browser?')) return;
        cancelSync(); endSession(); S = null; spage = null; tab = 'home'; store.del(LS_VAULT); store.del(LS_NAME); kv.del(LS_STATE); kv.del(LS_PARTIAL); start();
      } }, 'Remove wallet')], true);
  },
};

start();
