// BIP352 silent payments: addresses, input key extraction, sending, receiving (scanning) with labels.
// Pure functions over bytes/hex; checked against the official BIP352 test vectors (test/sp.test.js).
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes, bytesToNumberBE, numberToBytesBE } from '@noble/curves/abstract/utils';
import { bech32m } from '@scure/base';

const P = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;
export const K_MAX = 2323;                                  // max outputs per recipient group (BIP352)
const NUMS_H = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

const mod = (a) => ((a % N) + N) % N;
const be32 = (n) => numberToBytesBE(n, 32);
const u32be = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const tagCache = {};
export function tagged(tag, ...msgs) {
  const t = tagCache[tag] || (tagCache[tag] = sha256(new TextEncoder().encode(tag)));
  return sha256(concatBytes(t, t, ...msgs));
}
const toInt = (b) => bytesToNumberBE(b);
const ser = (pt) => pt.toRawBytes(true);
const xonly = (pt) => pt.toRawBytes(true).slice(1);
const liftX = (x32) => P.fromHex(concatBytes(new Uint8Array([2]), x32));
const h = (x) => (typeof x === 'string' ? hexToBytes(x) : x);

// ---------------------------------------------------------------- addresses
export function encodeAddress(Bscan, Bspend, hrp = 'sp') {
  const words = bech32m.toWords(concatBytes(ser(Bscan), ser(Bspend)));
  return bech32m.encode(hrp, [0, ...words], 1023);
}
export function decodeAddress(addr) {
  const { prefix, words } = bech32m.decode(addr, 1023);
  if (prefix !== 'sp' && prefix !== 'tsp') throw new Error('not a silent payment address');
  const ver = words[0];
  if (ver === 31) throw new Error('unsupported silent payment version');
  const data = bech32m.fromWords(words.slice(1));
  if (ver === 0 && data.length !== 66) throw new Error('bad silent payment address length');
  if (data.length < 66) throw new Error('bad silent payment address');
  return { hrp: prefix, Bscan: P.fromHex(data.slice(0, 33)), Bspend: P.fromHex(data.slice(33, 66)) };
}
export function labelTweak(bScan, m) {
  return mod(toInt(tagged('BIP0352/Label', be32(bScan), u32be(m))));
}
export function labeledSpend(Bspend, bScan, m) {
  return Bspend.add(P.BASE.multiply(labelTweak(bScan, m)));
}
export function keysToAddress(bScan, bSpend, { label = null, hrp = 'sp' } = {}) {
  const Bscan = P.BASE.multiply(bScan); let Bspend = P.BASE.multiply(bSpend);
  if (label !== null) Bspend = labeledSpend(Bspend, bScan, label);
  return encodeAddress(Bscan, Bspend, hrp);
}

// ---------------------------------------------------------------- input public keys (BIP352 "Inputs For Shared Secret Derivation")
// vin item: { txid, vout, scriptSig (hex), txinwitness (hex, serialized witness stack), prevoutScript (hex) }
function parseWitness(hex) {
  if (!hex) return [];
  const b = hexToBytes(hex); let i = 0;
  const vi = () => { const f = b[i++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b[i] | (b[i + 1] << 8); i += 2; return v; }
    if (f === 0xfe) { const v = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); i += 4; return v >>> 0; } throw new Error('witness too big'); };
  const n = vi(), items = [];
  for (let k = 0; k < n; k++) { const l = vi(); items.push(b.slice(i, i + l)); i += l; }
  return items;
}
const isCompressed = (k) => k.length === 33 && (k[0] === 2 || k[0] === 3);
function hash160(b) { return ripemd160(sha256(b)); }
import { ripemd160 } from '@noble/hashes/ripemd160';

// -> compressed pubkey bytes (33) for taproot already even-y via 0x02 prefix, or null when the input is not eligible
export function inputPubKey(vin) {
  const spk = h(vin.prevoutScript), sig = h(vin.scriptSig || ''), wit = parseWitness(vin.txinwitness || '');
  // P2TR
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) {
    let stack = wit.slice();
    if (stack.length > 1 && stack[stack.length - 1][0] === 0x50) stack = stack.slice(0, -1);   // annex
    if (stack.length > 1) {                                                                     // script path
      const control = stack[stack.length - 1];
      if (bytesToHex(control.slice(1, 33)) === NUMS_H) return null;
    }
    return concatBytes(new Uint8Array([2]), spk.slice(2, 34));
  }
  // P2WPKH
  if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) {
    const k = wit[wit.length - 1];
    return k && isCompressed(k) ? k : null;
  }
  // P2SH-P2WPKH
  if (spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87) {
    if (sig.length === 23 && sig[0] === 0x16 && sig[1] === 0x00 && sig[2] === 0x14) {
      const k = wit[wit.length - 1];
      return k && isCompressed(k) ? k : null;
    }
    return null;
  }
  // P2PKH: last 33 bytes of scriptSig that hash to the script's hash160 (handles malleated scriptSigs)
  if (spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14 && spk[23] === 0x88 && spk[24] === 0xac) {
    const want = bytesToHex(spk.slice(3, 23));
    for (let end = sig.length; end >= 33; end--) {
      const k = sig.slice(end - 33, end);
      if (isCompressed(k) && bytesToHex(hash160(k)) === want) return k;
    }
    return null;
  }
  return null;
}

function outpointBytes(txid, vout) {
  return concatBytes(hexToBytes(txid).reverse(), new Uint8Array([vout & 255, (vout >>> 8) & 255, (vout >>> 16) & 255, (vout >>> 24) & 255]));
}
function smallestOutpoint(vins) {
  let best = null;
  for (const v of vins) {
    const o = outpointBytes(v.txid, v.vout);
    if (!best || compare(o, best) < 0) best = o;
  }
  return best;
}
function compare(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

// Receiver data for one tx: A (sum of input pubkeys) and input_hash. null if the tx has no eligible inputs or sums to zero.
export function txTweakData(vins) {
  let A = null;
  for (const v of vins) {
    const k = inputPubKey(v); if (!k) continue;
    const pt = P.fromHex(k); A = A ? A.add(pt) : pt;
  }
  if (!A || A.equals(P.ZERO)) return null;
  const inputHash = mod(toInt(tagged('BIP0352/Inputs', smallestOutpoint(vins), ser(A))));
  return { A, inputHash, tweak: A.multiply(inputHash) };     // tweak = input_hash·A (what tweak indexes serve)
}

// Same, from index data: eligible input pubkeys (hex) + the tx's smallest outpoint "txid:vout".
export function tweakFromIndex(pubkeysHex, outpoint) {
  let A = null;
  for (const k of pubkeysHex) { const pt = P.fromHex(k); A = A ? A.add(pt) : pt; }
  if (!A || A.equals(P.ZERO)) return null;
  const [txid, vout] = outpoint.split(':');
  const inputHash = mod(toInt(tagged('BIP0352/Inputs', outpointBytes(txid, Number(vout)), ser(A))));
  return A.multiply(inputHash);
}

// ---------------------------------------------------------------- sending
// inputs: [{ txid, vout, priv (hex|bigint), taproot (bool) }]  (only eligible inputs)
// recipients: sp addresses (strings). allOutpoints: [{ txid, vout }] of EVERY input of the tx (eligible or not):
// the smallest one goes into input_hash. Returns [{ address, xonly (hex) }] in the order of `recipients`.
export function createOutputs(inputs, recipients, allOutpoints = inputs) {
  let a = 0n;
  for (const i of inputs) {
    let d = typeof i.priv === 'bigint' ? i.priv : toInt(h(i.priv));
    if (i.taproot && P.BASE.multiply(d).toAffine().y % 2n === 1n) d = N - d;
    a = mod(a + d);
  }
  if (a === 0n) throw new Error('input keys sum to zero: cannot send to a silent payment address with these inputs');
  const A = P.BASE.multiply(a);
  const inputHash = mod(toInt(tagged('BIP0352/Inputs', smallestOutpoint(allOutpoints), ser(A))));
  const groups = new Map();                                 // by scan key
  recipients.forEach((addr, idx) => {
    const r = decodeAddress(addr); const key = bytesToHex(ser(r.Bscan));
    if (!groups.has(key)) groups.set(key, { Bscan: r.Bscan, items: [] });
    groups.get(key).items.push({ idx, addr, Bspend: r.Bspend });
  });
  const out = new Array(recipients.length);
  for (const g of groups.values()) {
    if (g.items.length > K_MAX) throw new Error('too many outputs to one recipient');
    const ecdh = g.Bscan.multiply(mod(inputHash * a));
    g.items.forEach((it, k) => {
      const t = mod(toInt(tagged('BIP0352/SharedSecret', ser(ecdh), u32be(k))));
      if (t === 0n) throw new Error('bad shared secret');
      out[it.idx] = { address: it.addr, xonly: bytesToHex(xonly(it.Bspend.add(P.BASE.multiply(t)))) };
    });
  }
  return out;
}

// ---------------------------------------------------------------- receiving
// tweakPoint: input_hash·A for the tx. outputs: x-only taproot output keys (hex) of the tx.
// labels: Map labelPointHex(compressed) -> m, built with labelTable(). Returns [{ xonly, tweak (hex priv tweak), label }].
export function labelTable(bScan, Bspend, ms) {
  const t = new Map();
  for (const m of ms) { const pt = P.BASE.multiply(labelTweak(bScan, m)); t.set(bytesToHex(ser(pt)), { m, tw: labelTweak(bScan, m) }); }
  return t;
}
export function scanTx(tweakPoint, outputs, bScan, Bspend, labels = new Map()) {
  const ecdh = tweakPoint.multiply(bScan);
  const left = new Set(outputs.map((o) => o.toLowerCase()));
  const found = [];
  for (let k = 0; k < K_MAX + 1 && left.size; k++) {
    if (k === K_MAX) break;
    const t = mod(toInt(tagged('BIP0352/SharedSecret', ser(ecdh), u32be(k))));
    const Pk = Bspend.add(P.BASE.multiply(t));
    const x = bytesToHex(xonly(Pk));
    if (left.has(x)) { found.push({ xonly: x, tweak: bytesToHex(be32(t)), label: null }); left.delete(x); continue; }
    let hit = false;
    for (const o of left) {
      const Out = liftX(hexToBytes(o));
      for (const cand of [Out, Out.negate()]) {
        const L = cand.subtract(Pk);
        const lab = labels.get(bytesToHex(ser(L)));
        if (lab) {
          found.push({ xonly: o, tweak: bytesToHex(be32(mod(t + lab.tw))), label: lab.m }); left.delete(o); hit = true; break;
        }
      }
      if (hit) break;
    }
    if (!hit) break;
  }
  return found;
}

// private key for a found output (bSpend + tweak), and a BIP340 sign helper for tests
export function outputPrivKey(bSpend, tweakHex) { return mod(bSpend + toInt(hexToBytes(tweakHex))); }
export function signMsg(priv, msg32, aux32) {
  let d = priv; if (P.BASE.multiply(d).toAffine().y % 2n === 1n) d = N - d;
  return bytesToHex(schnorr.sign(msg32, be32(d), aux32));
}
export { P as Point, N, bytesToHex, hexToBytes, be32 };
