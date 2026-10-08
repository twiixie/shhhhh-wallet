// Client for the shhhhh node bridge (node.shhhhh.site): finds the wallet's coins with Frigate, then checks every
// result locally with the wallet's own keys (the server is never trusted to say what is ours), then asks which
// coins are unspent, what inscriptions they carry, and the BRC-20 balances of our addresses.
import { Transaction } from '@scure/btc-signer';
import { Point, labelTable, bytesToHex, hexToBytes } from './sp.js';
import { txCandidates, matchOutput, taprootAddress } from './scan.js';
import { CHANGE_LABEL } from './keys.js';

export const NODE = 'https://node.shhhhh.site';
export const TAPROOT_START = 709632;                        // nothing before Taproot can be a silent payment
// shhhhh wallets are all new (restore is off): nothing can be older than the launch block. The node refuses earlier scans.
export const MIN_START = 968000;

async function j(url, opts) {
  // a busy node answers 429: wait and retry that request (3, 6, 12, 24, 48 s) instead of failing the whole sync
  let r;
  for (let i = 0; ; i++) {
    r = await fetch(url, opts);
    if (r.status !== 429 || i >= 5) break;
    await new Promise((ok) => setTimeout(ok, 3000 * 2 ** i));
  }
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t; }
  if (!r.ok) throw new Error((body && body.error) || `node error ${r.status}`);
  return body;
}
export const getTip = (base = NODE) => j(`${base}/v1/tip`).then((x) => x.height);
export const getFees = (base = NODE) => j(`${base}/v1/fees`);
export const getTxHex = (txid, base = NODE) => j(`${base}/v1/tx/${txid}`);
export const getTxStatus = (txid, base = NODE) => j(`${base}/v1/txstatus/${txid}`);
export const broadcast = (hex, base = NODE) => j(`${base}/v1/broadcast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex }) });
export const getOutspends = (outpoints, base = NODE) => j(`${base}/v1/outspends`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outpoints }) });
export const getOutputInscriptions = (outpoint, base = NODE) => j(`${base}/v1/ord/output/${outpoint}`);
export const getBrc20 = (address, base = NODE) => j(`${base}/v1/brc20/${address}`);
export const getTransferable = (address, tick, base = NODE) => j(`${base}/v1/brc20-transferable/${address}/${encodeURIComponent(tick)}`);
export const getInscriptionInfo = (id, base = NODE) => j(`${base}/v1/ord/inscription/${id}`);
export const contentUrl = (id, base = NODE) => `${base}/v1/ord/content/${id}`;

// Frigate scan over WebSocket. Resolves with [{ height, txid, tweak }] once the scan is up to date (progress 1).
export function frigateScan(wallet, start, { base = NODE, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('cancelled'));   // already cancelled: don't start
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/sp');
    // cancelling closes the socket: the bridge then closes Frigate, which stops the scan on the server too
    if (signal) signal.addEventListener('abort', () => { ws.close(1000, 'cancelled'); reject(new Error('cancelled')); }, { once: true });
    const found = new Map();
    // no overall time limit (a busy node is slow, not broken): give up only after 10 minutes without any message
    let timer, settle;
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => { ws.close(); reject(new Error('no answer from the shhhhh node for 10 minutes')); }, 10 * 60 * 1000); };
    idle();
    ws.onopen = () => ws.send(JSON.stringify({ scan: wallet.bScan.toString(16).padStart(64, '0'), spend: bytesToHex(wallet.Bspend.toRawBytes(true)), start }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      idle(); if (settle) { clearTimeout(settle); settle = setTimeout(() => { clearTimeout(timer); ws.close(); resolve([...found.values()]); }, 3000); }
      if (m.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(m.error)); }
      if (m.type !== 'history') return;
      for (const h of m.history) found.set(h.txid, h);
      if (onProgress) onProgress(m.progress, found.size);
      // Frigate can send "progress 1" (empty) BEFORE the results of a range scan: after progress 1, keep listening
      // until 3 s pass without a new message, then finish
      if (m.progress === 1) { clearTimeout(settle); settle = setTimeout(() => { clearTimeout(timer); ws.close(); resolve([...found.values()]); }, 3000); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('cannot reach the shhhhh node')); };
    ws.onclose = (ev) => { if (ev.code !== 1000 && ev.code !== 1005) { clearTimeout(timer); reject(new Error(ev.reason || 'connection closed')); } };
  });
}

// One tx from the scan -> our outputs in it, verified with our own keys.
export function ownOutputs(txHex, tweakHex, wallet) {
  const tx = Transaction.fromRaw(hexToBytes(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const labels = labelTable(wallet.bScan, wallet.Bspend, [CHANGE_LABEL]);
  const cands = txCandidates(Point.fromHex(tweakHex), wallet, labels);
  const out = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const s = bytesToHex(o.script);
    if (s.length !== 68 || !s.startsWith('5120')) continue;
    const m = matchOutput(cands, s.slice(4));
    if (m) out.push({ txid: tx.id, vout: i, value: Number(o.amount), xonly: s.slice(4), tweak: m.tweak, label: m.label, address: taprootAddress(s.slice(4)) });
  }
  return out;
}

// Full sync: returns { height, coins (ALL owned outputs, with spent flag + inscriptions), brc20: [{tick, balance, ...}], txs }
// prev: the previous result (incremental: rescans only from prev.height - 100 for reorg safety).
export const REORG = 6;                                     // incremental syncs re-check the last 6 blocks (reorg safety)
export const BRC20_PER_SYNC = 300;
export const SMALL_WALLET = 200;                          // up to this many addresses: ask every one for tokens once                         // at most this many token lookups per sync
export const BRC20_TTL = 30 * 60 * 1000;                  // re-ask an address's BRC-20 balance after 30 min
export const CHUNK = 20000;                               // blocks per scan request: ~40 s of server time each
export async function syncWallet(wallet, { base = NODE, birthday = TAPROOT_START, prev = null, onStep, signal, resume = null, onChunk = null, onCheckpoint = null, onBrc20Save = null, brc20All = false, keep = null, fromStart = false } = {}) {
  const step = (s, x) => onStep && onStep(s, x);
  const tip = await getTip(base);
  // fromStart (a rescan): read again from the start block, but keep `prev` so payments already known are not downloaded again
  const start = Math.max(MIN_START, prev && !fromStart ? Math.max(birthday, prev.height - REORG) : birthday);
  // long ranges are scanned in chunks of CHUNK blocks; after each chunk onChunk({ cursor, hist }) lets the app save
  // progress, and `resume` (that saved object) continues from there instead of starting over
  let cursor = start, hist = [];
  if (resume && resume.start === start && resume.cursor > start) { cursor = resume.cursor; hist = resume.hist || []; }
  const span = Math.max(1, tip - start);
  step('scan', (cursor - start) / span);
  while (tip - cursor > CHUNK) {
    if (signal && signal.aborted) throw new Error('cancelled');
    const to = cursor + CHUNK - 1;
    const part = await frigateScan(wallet, `${cursor}-${to}`, { base, signal, onProgress: (p) => step('scan', (cursor - start + p * CHUNK) / span) });
    hist.push(...part); cursor = to + 1;
    if (onChunk) await onChunk({ start, cursor, hist });
  }
  hist.push(...await frigateScan(wallet, cursor, { base, signal, onProgress: (p) => step('scan', (cursor - start + p * (tip - cursor)) / span) }));
  const known = new Map((prev ? prev.coins : []).map((c) => [`${c.txid}:${c.vout}`, c]));
  const txs = new Map((prev ? prev.txs : []).map((t) => [t.txid, t]));
  // known transactions only get their height updated; new ones are downloaded and checked, 4 at a time (node limit: 1200 requests a minute per IP)
  const knownTx = new Set([...known.values()].map((c) => c.txid));
  const todo = [];
  for (const h of hist) {
    if (!txs.has(h.txid) || (txs.get(h.txid).height || 0) !== h.height) txs.set(h.txid, { txid: h.txid, height: h.height });
    if (knownTx.has(h.txid)) { for (const c of known.values()) if (c.txid === h.txid) c.height = h.height; } else todo.push(h);
  }
  let k = 0;
  step('verify', todo.length ? 0 : 1);
  const verifyWorker = async () => {
    while (todo.length) {
      if (signal && signal.aborted) throw new Error('cancelled');
      const h = todo.shift();
      const hex = await getTxHex(h.txid, base);
      for (const c of ownOutputs(hex, h.tweak, wallet)) known.set(`${c.txid}:${c.vout}`, { ...c, height: h.height, spent: false, inscriptions: null });
      step('verify', ++k / (k + todo.length));
    }
  };
  await Promise.all(Array.from({ length: 4 }, verifyWorker));
  // Our own sends: their change comes back on the change label, so a transaction with a change coin is outgoing.
  // How much left the wallet = our coins it spent minus what came back (once per transaction, stored as t.out).
  const byTx = new Map();
  for (const c of known.values()) { if (!byTx.has(c.txid)) byTx.set(c.txid, []); byTx.get(c.txid).push(c); }
  const own = new Map([...known.values()].map((c) => [`${c.txid}:${c.vout}`, c]));
  for (const t of txs.values()) {
    const cs = byTx.get(t.txid) || [];
    if (t.out != null || !cs.some((c) => c.label === CHANGE_LABEL)) continue;
    try {
      const tx = Transaction.fromRaw(hexToBytes(await getTxHex(t.txid, base)), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
      let spent = 0;
      for (let i = 0; i < tx.inputsLength; i++) { const inp = tx.getInput(i); const c = own.get(`${bytesToHex(inp.txid)}:${inp.index}`); if (c) spent += c.value; }
      t.out = Math.max(0, spent - cs.reduce((a, c) => a + c.value, 0));
    } catch { /* tried again next sync */ }
  }
  // spent or not (only re-check coins we last saw unspent)
  const open = [...known.values()].filter((c) => !c.spent);
  for (let i = 0; i < open.length; i += 500) {
    const res = await getOutspends(open.slice(i, i + 500).map((c) => `${c.txid}:${c.vout}`), base);
    res.forEach((r, n) => { open[i + n].spent = !r.unspent; });
  }
  // checkpoint: the scan is the expensive part; save it now so a later failure never redoes it
  // token balances already read (also kept through a rescan via `keep`): addresses checked < BRC20_TTL ago are not asked again
  const from = prev || keep;
  const keepBrc = { brc20: (from && from.brc20) || [], brc20ByAddress: (from && from.brc20ByAddress) || {}, brc20At: (from && from.brc20At) || {}, brc20AtHeight: (from && from.brc20AtHeight) || {} };
  const snapshot = () => ({ height: tip, coins: [...known.values()], txs: [...txs.values()].sort((a, b) => (b.height || 9e9) - (a.height || 9e9)), ...keepBrc });
  if (onCheckpoint) await onCheckpoint(snapshot());
  // inscriptions on unspent coins (once per coin: what's on a coin never changes while it sits there)
  // ord only knows confirmed blocks: an answer counts only for a confirmed coin that ord has indexed (c.ordOk).
  // Coins of inscription size checked before this rule (no ordOk) are looked at once more.
  const unspent = [...known.values()].filter((c) => !c.spent && (!c.inscriptions || (!c.ordOk && c.value <= 10000 && !c.inscriptions.length)) && (c.height || 0) > 0);
  k = 0;
  step('inscriptions', unspent.length ? 0 : 1);
  const ordWorker = async () => {                           // 4 at a time
    while (unspent.length) {
      if (signal && signal.aborted) throw new Error('cancelled');
      const c = unspent.shift();
      try {
        const o = await getOutputInscriptions(`${c.txid}:${c.vout}`, base);
        if (!o || o.indexed === false) { c.inscriptions = null; continue; }   // ord not there yet: unknown, asked next sync
        c.inscriptions = o.inscriptions || [];
        c.runes = o.runes && Object.keys(o.runes).length ? o.runes : null;
        c.ordOk = true;
      } catch { c.inscriptions = null; }                  // unknown: treated as inscribed (never spent as fee) until checked
      step('inscriptions', ++k / (k + unspent.length));
    }
  };
  await Promise.all(Array.from({ length: 4 }, ordWorker));
  // BRC-20 balances live on addresses, not coins. Each address's answer is remembered; it is asked again only when
  // it is new or its answer is older than BRC20_TTL. 4 lookups run at once (gentle on UniSat's per-second limit).
  step('brc20', 0);
  const perAddr = { ...keepBrc.brc20ByAddress }, at = { ...keepBrc.brc20At }, atH = { ...keepBrc.brc20AtHeight };
  const addrs = [...new Set([...known.values()].map((c) => c.address))];
  // likely token holders first: coins carrying an inscription, then small coins (token transfers are 330-10,000 sats)
  const firstCoin = new Map(); for (const c of known.values()) if (!firstCoin.has(c.address)) firstCoin.set(c.address, c);
  const rank = (a) => { const c = firstCoin.get(a); return (c.inscriptions && c.inscriptions.length) ? 0 : c.value <= 10000 ? 1 : 2; };
  // Which addresses can hold BRC-20 at all? A silent-payment address is used once, so only if the coin that created it
  // carried an inscription (a token transfer). Unspent coin: ord says exactly (no inscription => skip, it never moved).
  // Spent coin: unknown, so check only small ones (transfer outputs are 330-10,000 sats). Known holders always stay.
  const canHold = (a) => {
    if (brc20All || (perAddr[a] && perAddr[a].some((t) => Number(t.balance) > 0))) return true;
    if (addrs.length <= SMALL_WALLET) return true;                     // normal wallets: every address is asked (once)
    const cs = [...known.values()].filter((c) => c.address === a);
    // Tokens only sit on an address where an inscription landed. Unspent coins are checked by ord first; a spent coin
    // counts only if it was SEEN carrying an inscription (a coin spent before the wallet could look is skipped:
    // "Find missing tokens" in Settings checks those too). Keeps wallets with thousands of spent coins cheap.
    return cs.some((c) => (c.inscriptions && c.inscriptions.length > 0) || (c.inscriptions == null && !c.spent));
  };
  // An answer of "no tokens" for an address whose coins are all spent never changes (a one-time address nobody else
  // knows), so it is kept forever.
  // An answer is only trusted as final if it was asked a few blocks AFTER the last coin at that address (the indexer
  // needs time: an early "no tokens" was once kept forever). Big wallets keep their older answers (no re-ask storm).
  const lastH = (a) => Math.max(0, ...[...known.values()].filter((c) => c.address === a).map((c) => c.height || tip));
  const fresh = (a) => (atH[a] == null ? addrs.length > SMALL_WALLET && !!perAddr[a] : atH[a] >= lastH(a) + 3);
  const settled = (a) => perAddr[a] && at[a] && fresh(a) && !perAddr[a].some((t) => Number(t.balance) > 0) && [...known.values()].every((c) => c.address !== a || c.spent);
  // Asked once ever; after that only addresses that HOLD tokens are re-asked (every BRC20_TTL), because silent payment
  // addresses are never reused: a "no tokens" answer stays true. Keeps UniSat use small for wallets with thousands of payments.
  const holds = (a) => perAddr[a] && perAddr[a].some((t) => Number(t.balance) > 0);
  // addresses we just sent tokens from: re-asked every sync until the indexer has seen the confirmed send
  const sentFrom = new Set(((from && from.sent) || []).filter((x) => x.kind === 'brc20' && x.from && !(atH[x.from] >= (x.height || Infinity) + 1)).map((x) => x.from));
  const allDue = addrs.filter((a) => sentFrom.has(a) || (canHold(a) && (brc20All || (!settled(a) && (!perAddr[a] || !at[a] || !fresh(a) || (holds(a) && Date.now() - at[a] > BRC20_TTL)))))).sort((x, y) => rank(x) - rank(y));   // brc20All ("Find missing tokens"): ask every address again
  const due = allDue.slice(0, BRC20_PER_SYNC);             // the rest continues on the next sync (shared UniSat quota)
  // progress over ALL addresses that can hold tokens, so a reopened wallet shows where it really is (not 0% per batch)
  const eligible = Math.max(1, addrs.filter(canHold).length), already = eligible - allDue.length;
  let done = 0, sinceSave = 0;
  step('brc20', already / eligible);
  const totalsNow = () => {
    const m = new Map();
    for (const a of addrs) for (const t of perAddr[a] || []) {
      const cur = m.get(t.tick) || { tick: t.tick, selfMint: t.selfMint, balance: 0, available: 0, transferable: 0 };
      cur.balance += Number(t.balance); cur.available += Number(t.available); cur.transferable += Number(t.transferable); m.set(t.tick, cur);
    }
    return [...m.values()];
  };
  const worker = async () => {
    while (due.length) {
      if (signal && signal.aborted) return;
      const a = due.shift();
      try { perAddr[a] = await getBrc20(a, base); at[a] = Date.now(); atH[a] = tip; } catch { /* keep the previous answer; retried next sync */ }
      step('brc20', Math.min(1, (already + ++done) / eligible));
      // save answers as they come in, so a reload continues instead of reading everything again
      if (onBrc20Save && ++sinceSave >= 10) { sinceSave = 0; await onBrc20Save({ brc20: totalsNow(), brc20ByAddress: { ...perAddr }, brc20At: { ...at }, brc20AtHeight: { ...atH } }); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);   // the bridge paces UniSat itself
  const totals = new Map();
  for (const a of addrs) for (const t of perAddr[a] || []) {
    const cur = totals.get(t.tick) || { tick: t.tick, selfMint: t.selfMint, balance: 0, available: 0, transferable: 0 };
    cur.balance += Number(t.balance); cur.available += Number(t.available); cur.transferable += Number(t.transferable);
    totals.set(t.tick, cur);
  }
  // Transfers waiting for step 2 (e.g. after a restore, the device notes are gone): for each of our addresses that
  // holds "transferable" tokens, ask which transfer inscriptions wait there and where they sit -> spendable with our key.
  const waiting = [];
  if (!(signal && signal.aborted)) {
    const coinByAddr = new Map([...known.values()].map((c) => [c.address, c]));
    for (const [a, toks] of Object.entries(perAddr)) {
      const holder = coinByAddr.get(a); if (!holder) continue;
      for (const t of toks || []) {
        if (!(Number(t.transferable) > 0)) continue;
        try {
          for (const w of await getTransferable(a, t.tick, base)) {
            const info = await getInscriptionInfo(w.inscriptionId, base);
            const [txid, vout] = String(info.satpoint || '').split(':');
            if (!txid || info.address !== a) continue;                    // must still sit on our address
            waiting.push({ tick: w.tick || t.tick, amt: String(w.amt), inscriptionId: w.inscriptionId, revealTxid: txid, vout: Number(vout),
                           postage: Number(info.value), holder: { xonly: holder.xonly, tweak: holder.tweak }, to: null, recovered: true });
          }
        } catch { /* tried again next sync */ }
      }
    }
  }
  return { ...snapshot(), brc20: [...totals.values()], brc20ByAddress: perAddr, brc20At: at, brc20AtHeight: atH, waiting };
}

// Spendable view for send.js: our unspent coins with private keys; inscribed (or unknown) coins are flagged.
export function spendable(result, wallet, outputPrivKey) {
  // a coin that holds one of our BRC-20 transfers (pending or found waiting) is never used as fee money,
  // even if ord has not reported its inscription yet (that is how a transfer once ended up in the change)
  const held = new Set([...(result.pending || []), ...(result.waiting || [])].map((p) => `${p.revealTxid}:${p.vout || 0}`));
  return result.coins.filter((c) => !c.spent).map((c) => ({
    txid: c.txid, vout: c.vout, value: c.value, xonly: c.xonly, priv: outputPrivKey(wallet.bSpend, c.tweak),
    inscribed: held.has(`${c.txid}:${c.vout}`) || c.inscriptions === null || (c.inscriptions && c.inscriptions.length > 0) || !!c.runes,
  }));
}

// Live watch: one long-lived subscription from `fromHeight`. After its first "up to date" message, any further
// history (a payment in the mempool or a new block) calls onActivity(). Returns { close }.
export function liveWatch(wallet, fromHeight, { base = NODE, onActivity, onClose } = {}) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/sp');
  let caughtUp = false, closed = false;
  ws.onopen = () => ws.send(JSON.stringify({ scan: wallet.bScan.toString(16).padStart(64, '0'), spend: bytesToHex(wallet.Bspend.toRawBytes(true)), start: fromHeight }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type !== 'history') return;
    if (caughtUp && m.history.length && onActivity) onActivity(m.history);
    if (m.progress === 1) setTimeout(() => { caughtUp = true; }, 3000);   // late results of the initial scan are not "new"
  };
  ws.onclose = () => { if (!closed && onClose) onClose(); };
  return { close: () => { closed = true; try { ws.close(1000, 'bye'); } catch {} } };
}

// ---------------------------------------------------------------- deposit address (normal bc1p, for exchanges / UniSat)
// The node has no index by normal address, so coins come from public explorers (the address is not private anyway);
// what each coin carries comes from our ord, BRC-20 balances from the bridge.
const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];
async function addressUtxos(address) {
  let last;
  for (const b of EXPLORERS) {
    try { const r = await fetch(`${b}/address/${address}/utxo`, { signal: AbortSignal.timeout(15000) }); if (r.ok) return await r.json(); last = new Error(`${r.status}`); }
    catch (e) { last = e; }
  }
  throw new Error('cannot read the deposit address right now' + (last ? ` (${last.message})` : ''));
}
async function addressTxs(address) {                        // last ~50 txs touching the address (newest first)
  for (const b of EXPLORERS) {
    try { const r = await fetch(`${b}/address/${address}/txs`, { signal: AbortSignal.timeout(15000) }); if (r.ok) return await r.json(); } catch {}
  }
  return null;
}
const depOrd = new Map();                                     // outpoint -> inscriptions (confirmed coins never change)
export async function getDeposit(dep, base = NODE) {
  const utxos = await addressUtxos(dep.address);
  const coins = [];
  for (const u of utxos) {
    let insc = null;
    // ord only knows confirmed blocks: an unconfirmed (or not yet indexed) coin may carry an inscription, so it is
    // treated as inscribed and never used as fee money (that is how a transfer once ended up in the change)
    const confirmed = !!(u.status && u.status.confirmed), op = `${u.txid}:${u.vout}`;
    if (confirmed && depOrd.has(op)) insc = depOrd.get(op);
    else if (confirmed) try {
      const o = await getOutputInscriptions(op, base);
      if (o && o.indexed !== false) { insc = o.inscriptions || []; if (o.runes && Object.keys(o.runes).length) insc = insc.concat(['runes']); depOrd.set(op, insc); }
    } catch {}
    coins.push({ txid: u.txid, vout: u.vout, value: u.value, confirmed, xonly: dep.xonly, priv: dep.priv,
                 inscriptions: insc, inscribed: insc === null || insc.length > 0 });
  }
  let brc20 = null;                                            // null = could not ask (not the same as "no tokens")
  try { brc20 = (await getBrc20(dep.address, base)).filter((t) => Number(t.balance) > 0); } catch {}
  // payments INTO the deposit address (net received > 0), for Activity; null = could not read the history
  const txs = await addressTxs(dep.address);
  const history = txs && txs.map((t) => {
    const got = t.vout.filter((o) => o.scriptpubkey_address === dep.address).reduce((a, o) => a + o.value, 0);
    const gave = t.vin.filter((i) => i.prevout && i.prevout.scriptpubkey_address === dep.address).reduce((a, i) => a + i.prevout.value, 0);
    return { txid: t.txid, height: (t.status && t.status.confirmed && t.status.block_height) || 0, amount: got - gave };
  }).filter((t) => t.amount > 0);
  return { coins, brc20, history, btc: coins.filter((c) => !c.inscribed).reduce((a, c) => a + c.value, 0), at: Date.now() };
}
