// Sending tests on a private regtest node (tools/regtest.sh start). Real transactions, mined and checked by Bitcoin Core.
//   node test/send.regtest.mjs
import * as sp from '../src/sp.js';
import * as K from '../src/keys.js';
import { buildSend, buildSendInscription, REGTEST, DUST } from '../src/send.js';
import { bech32m } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';

let pass = 0, fail = 0;
const ok = (c, name) => { console.log((c ? 'ok   ' : 'FAIL ') + name); c ? pass++ : fail++; };
let rid = 0;
async function rpc(method, params = [], wallet) {
  const r = await fetch('http://127.0.0.1:18543/' + (wallet ? 'wallet/' + wallet : ''), { method: 'POST',
    headers: { Authorization: 'Basic ' + btoa('u:p'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rid, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(method + ': ' + j.error.message); return j.result;
}
const mine = async (n = 1) => rpc('generatetoaddress', [n, await rpc('getnewaddress', [], 'funder')]);
const trAddr = (xonly) => bech32m.encode('bcrt', [1, ...bech32m.toWords(hexToBytes(xonly))]);
const rnd = () => BigInt('0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(32)))) % (sp.N - 1n) + 1n;
const xonlyOf = (d) => bytesToHex(sp.Point.BASE.multiply(d).toRawBytes(true).slice(1));
const tsp = (w, label = null) => sp.keysToAddress(w.bScan, w.bSpend, { hrp: 'tsp', label });

// Core tx (verbosity 2) -> BIP352 inputs
async function coreTx(txid) {
  const t = await rpc('getrawtransaction', [txid, 2]);
  const vins = t.vin.map((v) => ({ txid: v.txid, vout: v.vout, scriptSig: v.scriptSig.hex,
    txinwitness: v.txinwitness ? witHex(v.txinwitness) : '', prevoutScript: v.prevout.scriptPubKey.hex }));
  const outs = t.vout.map((o) => ({ n: o.n, value: Math.round(o.value * 1e8), spk: o.scriptPubKey.hex }));
  return { t, vins, outs };
}
function witHex(items) {
  const cs = (n) => (n < 0xfd ? n.toString(16).padStart(2, '0') : 'fd' + (n & 255).toString(16).padStart(2, '0') + (n >> 8).toString(16).padStart(2, '0'));
  return cs(items.length) + items.map((i) => cs(i.length / 2) + i).join('');
}
// wallet-side scan of one tx -> our utxos (with private keys)
async function scanFor(w, txid) {
  const { vins, outs } = await coreTx(txid);
  const td = sp.txTweakData(vins);
  const tr = outs.filter((o) => o.spk.startsWith('5120') && o.spk.length === 68);
  const found = sp.scanTx(td.tweak, tr.map((o) => o.spk.slice(4)), w.bScan, w.Bspend, sp.labelTable(w.bScan, w.Bspend, [K.CHANGE_LABEL]));
  return found.map((f) => { const o = tr.find((x) => x.spk.slice(4) === f.xonly);
    return { txid, vout: o.n, value: o.value, xonly: f.xonly, priv: sp.outputPrivKey(w.bSpend, f.tweak), label: f.label, inscribed: false }; });
}
async function broadcast(hex) { const txid = await rpc('sendrawtransaction', [hex]); await mine(1); return txid; }

try {
  try { await rpc('createwallet', ['funder']); } catch { try { await rpc('loadwallet', ['funder']); } catch {} }
  if ((await rpc('getblockcount')) < 110) await mine(110);

  const W = K.walletFromMnemonic(K.newMnemonic()), W2 = K.walletFromMnemonic(K.newMnemonic());

  // 1. an outside sender pays W's sp1 (tsp) address: key A funded by Core, then A -> W (built with our own sender code)
  const a = rnd(), ax = xonlyOf(a);
  const fundTxid = await rpc('sendtoaddress', [trAddr(ax), 0.002], 'funder'); await mine(1);
  const fund = (await coreTx(fundTxid)).outs.find((o) => o.spk === '5120' + ax);
  const s1 = buildSend({ utxos: [{ txid: fundTxid, vout: fund.n, value: fund.value, xonly: ax, priv: a }],
    recipients: [{ address: tsp(W), value: 150000 }], feeRate: 2, changeAddress: trAddr(ax), network: REGTEST });
  const t1 = await broadcast(s1.hex);
  ok(true, `sender -> W sp1 accepted and mined (fee ${s1.fee} sats, ${s1.vsize} vB)`);
  let mine1 = await scanFor(W, t1);
  ok(mine1.length === 1 && mine1[0].value === 150000, 'W finds the 150,000 sat payment by scanning');
  ok((await scanFor(W2, t1)).length === 0, 'another wallet finds nothing in it');

  // 2. W spends: 20,000 to W2 (sp1) + 5,000 to a normal address, change back to W's labeled change address
  const normal = await rpc('getnewaddress', ['', 'bech32'], 'funder');
  const s2 = buildSend({ utxos: mine1, recipients: [{ address: tsp(W2), value: 20000 }, { address: normal, value: 5000 }],
    feeRate: 3, changeAddress: tsp(W, K.CHANGE_LABEL), network: REGTEST });
  const t2 = await broadcast(s2.hex);
  const e2 = await rpc('getmempoolentry', [t2]).catch(() => null);
  ok(true, `W -> sp1 + normal + change accepted and mined (fee ${s2.fee} sats at 3 sat/vB, real ${s2.vsize} vB)`);
  ok(s2.fee >= s2.vsize * 3, 'fee covers the requested rate');
  const w2got = await scanFor(W2, t2);
  ok(w2got.length === 1 && w2got[0].value === 20000, 'W2 finds its 20,000');
  const change = await scanFor(W, t2);
  ok(change.length === 1 && change[0].label === 0 && change[0].value === 150000 - 20000 - 5000 - s2.fee, `W finds its change via the change label (${change[0] && change[0].value})`);
  const recv = await rpc('getreceivedbyaddress', [normal, 1], 'funder');
  ok(Math.round(recv * 1e8) === 5000, 'normal address received 5,000');

  // 3. W2 spends its received output back to W (sp1 -> sp1, no change: send max)
  const s3 = buildSend({ utxos: w2got, recipients: [{ address: tsp(W), value: 0 }], feeRate: 1, changeAddress: tsp(W2, 0), network: REGTEST, sendMax: true });
  const t3 = await broadcast(s3.hex);
  const back = await scanFor(W, t3);
  ok(back.length === 1 && back[0].value === 20000 - s3.fee, `send max: W2 -> W ${back[0] && back[0].value} sats, fee ${s3.fee}`);

  // 4. inscription safety: an inscribed coin is never used for amount/fees, and moves only to output 0 with its full value
  const coins = [{ ...change[0], inscribed: true }, back[0]];
  let threw = false;
  try { buildSend({ utxos: [coins[0]], recipients: [{ address: normal, value: 1000 }], feeRate: 1, changeAddress: tsp(W, 0), network: REGTEST }); } catch { threw = true; }
  ok(threw, 'refuses to pay from an inscribed coin');
  const s4 = buildSend({ utxos: coins, recipients: [{ address: normal, value: 1000 }], feeRate: 1, changeAddress: tsp(W, 0), network: REGTEST });
  ok(!s4.inputs.includes(`${coins[0].txid}:${coins[0].vout}`), 'normal send skips the inscribed coin');
  const s5 = buildSendInscription({ utxos: coins, inscribed: coins[0], to: tsp(W2), feeRate: 2, changeAddress: tsp(W, 0), network: REGTEST });
  const t5 = await broadcast(s5.hex);
  const { outs: o5, t: tx5 } = await coreTx(t5);
  ok(tx5.vin[0].txid === coins[0].txid && tx5.vin[0].vout === coins[0].vout, 'inscribed coin is input 0');
  ok(o5[0].value === coins[0].value, 'output 0 keeps the inscribed coin\'s full value (inscription lands there)');
  const insc = await scanFor(W2, t5);
  ok(insc.some((u) => u.vout === 0), 'W2 (sp1) owns output 0');

  // 5. errors
  let e = '';
  try { buildSend({ utxos: back, recipients: [{ address: normal, value: 10 }], feeRate: 1, changeAddress: tsp(W, 0), network: REGTEST }); } catch (x) { e = x.message; }
  ok(/at least/.test(e), 'refuses dust amounts');
  try { buildSend({ utxos: back, recipients: [{ address: normal, value: 10_000_000 }], feeRate: 1, changeAddress: tsp(W, 0), network: REGTEST }); } catch (x) { e = x.message; }
  ok(/not enough/.test(e), 'refuses more than the balance');
} catch (e) { ok(false, e.stack || e.message); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
