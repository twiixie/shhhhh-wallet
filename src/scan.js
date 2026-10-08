// On-device $shhhhh scanner: walks the public index pages and finds this wallet's silent-payment outputs.
// Nothing about the wallet leaves the device: every user downloads the same pages.
import { tweakFromIndex, labelTable, Point, N, tagged, bytesToHex, hexToBytes } from './sp.js';
import { bech32m } from '@scure/base';
import { CHANGE_LABEL } from './keys.js';

const K_CHECK = 8;                                        // outputs per tx a sender could have made to us before this one
const ser = (pt) => pt.toRawBytes(true);
const u32be = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const mod = (a) => ((a % N) + N) % N;
const toInt = (b) => BigInt('0x' + bytesToHex(b));

export const taprootAddress = (xonlyHex) => bech32m.encode('bc', [1, ...bech32m.toWords(hexToBytes(xonlyHex))]);
export const addressXonly = (addr) => bytesToHex(Uint8Array.from(bech32m.fromWords(bech32m.decode(addr).words.slice(1))));

// Per tx: every output key a sender could have made for us: k = 0..K_CHECK-1, unlabeled and with each label
// (labeled output = Pk + label point, so its x-only key can be precomputed: one ECDH per tx, string compares per output).
export function txCandidates(tweakPoint, wallet, labels) {
  const ecdh = ser(tweakPoint.multiply(wallet.bScan));
  const out = new Map();                                  // x-only hex -> { tweak, label, k }
  for (let k = 0; k < K_CHECK; k++) {
    const t = mod(toInt(tagged('BIP0352/SharedSecret', ecdh, u32be(k))));
    const Pk = wallet.Bspend.add(Point.BASE.multiply(t));
    out.set(bytesToHex(ser(Pk).slice(1)), { tweak: hex32(t), label: null, k });
    for (const [lp, lab] of labels) out.set(bytesToHex(ser(Pk.add(Point.fromHex(lp))).slice(1)), { tweak: hex32(mod(t + lab.tw)), label: lab.m, k });
  }
  return out;
}
export const matchOutput = (cands, xonlyHex) => cands.get(xonlyHex) || null;
const hex32 = (n) => n.toString(16).padStart(64, '0');

// state: kept between runs so only new pages are scanned
//   { nextEntry, addrs: { bc1p: { tweak, label, txid, vout, height, in, out } }, history: [...], pending: { inscId: {addr, amount} } }
export function newState(birthdayHeight = 0) {
  return { nextEntry: 0, birthday: birthdayHeight, addrs: {}, history: [], pending: {} };
}

// Scan one page into state. Returns the number of new outputs found.
export function scanPage(state, page, wallet, pageSize, { onProgress } = {}) {
  const labels = labelTable(wallet.bScan, wallet.Bspend, [CHANGE_LABEL]);
  const tweaks = new Map();
  let found = 0;
  const first = page.n * pageSize;
  for (let i = Math.max(0, state.nextEntry - first); i < page.e.length; i++) {
    const [type, height, txid, vout, from, to, amount, insc] = page.e[i];
    const amt = Number(amount);
    if (type === 'T') {
      // received: a transfer to a bc1p output that is ours (checked on this device only)
      if (height >= state.birthday && !state.addrs[to] && page.tx[txid] && to.startsWith('bc1p')) {
        if (!tweaks.has(txid)) { const d = page.tx[txid]; const tw = d.k.length ? tweakFromIndex(d.k, d.o) : null; tweaks.set(txid, tw && txCandidates(tw, wallet, labels)); }
        const cands = tweaks.get(txid);
        const m = cands && matchOutput(cands, addressXonly(to));
        if (m) { state.addrs[to] = { tweak: m.tweak, label: m.label, txid, vout, height, in: 0, out: 0 }; found++; }
      }
      const mine = state.addrs[to], spent = state.addrs[from];
      if (mine) { mine.in += amt; state.history.push({ dir: from && state.addrs[from] ? 'self' : 'in', amount: amt, txid, height, addr: to }); }
      if (spent) {
        spent.out += amt; delete state.pending[insc];
        if (!mine) state.history.push({ dir: 'out', amount: amt, txid, height, addr: from, to });
      }
    } else if (type === 'I' && state.addrs[to]) {
      state.pending[insc] = { addr: to, amount: amt, txid, height };   // set aside to send (still ours until moved)
    }
    if (onProgress && i % 200 === 0) onProgress(first + i);
  }
  state.nextEntry = first + page.e.length;
  return found;
}

export function balances(state) {
  let total = 0, transferable = 0;
  const per = Object.entries(state.addrs).map(([addr, a]) => { const bal = a.in - a.out; total += bal; return { addr, balance: bal, label: a.label }; });
  for (const p of Object.values(state.pending)) transferable += p.amount;
  return { total, transferable, available: total - transferable, addresses: per.filter((x) => x.balance > 0) };
}
