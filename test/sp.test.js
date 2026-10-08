// Runs the official BIP352 send/receive test vectors against src/sp.js.   node test/sp.test.js
import fs from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import * as sp from '../src/sp.js';

const V = JSON.parse(fs.readFileSync(new URL('./bip352-vectors.json', import.meta.url)));
const vinOf = (v) => ({ txid: v.txid, vout: v.vout, scriptSig: v.scriptSig, txinwitness: v.txinwitness, prevoutScript: v.prevout.scriptPubKey.hex });
const MSG = sha256(new TextEncoder().encode('message')), AUX = sha256(new TextEncoder().encode('random auxiliary data'));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log('FAIL', name); } };

for (const tc of V) {
  for (const s of tc.sending) {
    const name = `send: ${tc.comment}`;
    const eligible = s.given.vin.filter((v) => sp.inputPubKey(vinOf(v)));
    const inputs = eligible.map((v) => ({ txid: v.txid, vout: v.vout, priv: v.private_key,
      taproot: v.prevout.scriptPubKey.hex.startsWith('5120') }));
    const recips = s.given.recipients.flatMap((r) => Array(r.count || 1).fill(typeof r === 'string' ? r : r.address));
    const expect = s.expected.outputs;                        // list of acceptable output sets
    let got;
    try { got = inputs.length && recips.length ? sp.createOutputs(inputs, recips, s.given.vin).map((o) => o.xonly) : []; }
    catch (e) { got = []; }
    const norm = (a) => [...a].sort().join(',');
    ok(expect.some((set) => norm(set) === norm(got)), name);
  }
  for (const r of tc.receiving) {
    const name = `receive: ${tc.comment}`;
    const g = r.given, km = g.key_material;
    const bScan = BigInt('0x' + km.scan_priv_key), bSpend = BigInt('0x' + km.spend_priv_key);
    const Bspend = sp.Point.BASE.multiply(bSpend);
    const addrs = [sp.keysToAddress(bScan, bSpend), ...g.labels.map((m) => sp.keysToAddress(bScan, bSpend, { label: m }))];
    ok(JSON.stringify(addrs.sort()) === JSON.stringify([...r.expected.addresses].sort()), name + ' (addresses)');
    const td = sp.txTweakData(g.vin.map(vinOf));
    const want = r.expected.outputs || [];
    if (r.expected.n_outputs != null && !r.expected.outputs) {
      const td2 = sp.txTweakData(g.vin.map(vinOf));
      const n = td2 ? sp.scanTx(td2.tweak, g.outputs, bScan, Bspend, sp.labelTable(bScan, Bspend, g.labels)).length : 0;
      ok(n === r.expected.n_outputs, `${name} (found ${n}, want ${r.expected.n_outputs})`); continue;
    }
    if (!td) { ok(want.length === 0, name + ' (no eligible inputs)'); continue; }
    const found = sp.scanTx(td.tweak, g.outputs, bScan, Bspend, sp.labelTable(bScan, Bspend, g.labels));
    const key = (o) => o.pub_key || o.xonly;
    ok(found.length === want.length, `${name} (found ${found.length}, want ${want.length})`);
    for (const w of want) {
      const f = found.find((x) => x.xonly === w.pub_key);
      if (!f) { ok(false, name + ' missing ' + w.pub_key.slice(0, 12)); continue; }
      ok(f.tweak === w.priv_key_tweak, name + ' tweak');
      const priv = sp.outputPrivKey(bSpend, f.tweak);
      ok(sp.signMsg(priv, MSG, AUX) === w.signature, name + ' signature');
    }
    if (r.expected.tweak) ok(sp.bytesToHex(td.tweak.toRawBytes(true)) === r.expected.tweak, name + ' tweak point');
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
