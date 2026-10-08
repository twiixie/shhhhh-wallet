// BRC-20 transfer inscription tests on regtest, checked by a real `ord` index.
//   tools/regtest.sh start; node test/inscribe.regtest.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as sp from '../src/sp.js';
import * as K from '../src/keys.js';
import { buildSend, buildSendInscription, REGTEST } from '../src/send.js';
import { buildInscribeTransfer, commitKey } from '../src/inscribe.js';
import { bech32m } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';

let pass = 0, fail = 0;
const ok = (c, name) => { console.log((c ? 'ok   ' : 'FAIL ') + name); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rid = 0;
async function rpc(method, params = [], wallet) {
  const r = await fetch('http://127.0.0.1:18543/' + (wallet ? 'wallet/' + wallet : ''), { method: 'POST',
    headers: { Authorization: 'Basic ' + btoa('u:p') }, body: JSON.stringify({ jsonrpc: '1.0', id: ++rid, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(method + ': ' + j.error.message); return j.result;
}
const mine = async (n = 1) => rpc('generatetoaddress', [n, await rpc('getnewaddress', [], 'funder')]);
const trAddr = (x) => bech32m.encode('bcrt', [1, ...bech32m.toWords(hexToBytes(x))]);
const rnd = () => BigInt('0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(32)))) % (sp.N - 1n) + 1n;
const xonlyOf = (d) => bytesToHex(sp.Point.BASE.multiply(d).toRawBytes(true).slice(1));
const tsp = (w, label = null) => sp.keysToAddress(w.bScan, w.bSpend, { hrp: 'tsp', label });
const witHex = (items) => { const c = (n) => (n < 0xfd ? n.toString(16).padStart(2, '0') : 'fd' + (n & 255).toString(16).padStart(2, '0') + (n >> 8).toString(16).padStart(2, '0')); return c(items.length) + items.map((i) => c(i.length / 2) + i).join(''); };
async function scanFor(w, txid) {
  const t = await rpc('getrawtransaction', [txid, 2]);
  const vins = t.vin.map((v) => ({ txid: v.txid, vout: v.vout, scriptSig: v.scriptSig.hex, txinwitness: v.txinwitness ? witHex(v.txinwitness) : '', prevoutScript: v.prevout.scriptPubKey.hex }));
  const tr = t.vout.filter((o) => o.scriptPubKey.hex.startsWith('5120')).map((o) => ({ n: o.n, value: Math.round(o.value * 1e8), x: o.scriptPubKey.hex.slice(4) }));
  const td = sp.txTweakData(vins); if (!td) return [];
  return sp.scanTx(td.tweak, tr.map((o) => o.x), w.bScan, w.Bspend, sp.labelTable(w.bScan, w.Bspend, [0])).map((f) => {
    const o = tr.find((x) => x.x === f.xonly); return { txid, vout: o.n, value: o.value, xonly: f.xonly, priv: sp.outputPrivKey(w.bSpend, f.tweak), inscribed: false }; });
}
const send = async (hex) => { const id = await rpc('sendrawtransaction', [hex]); return id; };

// ord on regtest
const ordDir = fs.mkdtempSync(os.tmpdir() + '/ordtest-');
const ORD = process.env.ORD_BIN || 'ord';
const ord = spawn(ORD, ['--regtest', '--bitcoin-rpc-url', 'http://127.0.0.1:18543', '--bitcoin-rpc-username', 'u', '--bitcoin-rpc-password', 'p',
  '--data-dir', ordDir, 'server', '--http-port', '18580', '--address', '127.0.0.1'], { stdio: 'ignore' });
async function ordGet(path) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:18580' + path, { headers: { Accept: 'application/json' } }); if (r.ok) return r.headers.get('content-type')?.includes('json') ? r.json() : r.text(); } catch {}
    await sleep(500);
  }
  throw new Error('ord: no answer for ' + path);
}
async function ordSynced() { const h = await rpc('getblockcount'); for (let i = 0; i < 60; i++) { if (Number(await ordGet('/blockheight')) >= h) return; await sleep(500); } }

try {
  try { await rpc('loadwallet', ['funder']); } catch {}
  const W = K.walletFromMnemonic(K.newMnemonic()), W2 = K.walletFromMnemonic(K.newMnemonic());
  // fund W through a silent payment (outside sender key A)
  const a = rnd(), ax = xonlyOf(a);
  const f = await rpc('sendtoaddress', [trAddr(ax), 0.001], 'funder'); await mine(1);
  const fo = (await rpc('getrawtransaction', [f, 2])).vout.find((o) => o.scriptPubKey.hex === '5120' + ax);
  const s1 = buildSend({ utxos: [{ txid: f, vout: fo.n, value: Math.round(fo.value * 1e8), xonly: ax, priv: a }], recipients: [{ address: tsp(W), value: 60000 }], feeRate: 2, changeAddress: trAddr(ax), network: REGTEST });
  await send(s1.hex); await mine(1);
  const coins = await scanFor(W, s1.txid);
  ok(coins.length === 1, 'W funded by silent payment');
  const holder = coins[0];                                       // pretend this output holds a BRC-20 balance

  // step 1: commit + reveal a transfer inscription to the holder address
  const it = buildInscribeTransfer({ wallet: W, utxos: coins, holderXonly: holder.xonly, tick: 'shhhhh', amt: 1000, feeRate: 2, changeAddress: tsp(W, 0), network: REGTEST, nonce: 1 });
  await send(it.commit.hex);
  await send(it.reveal.hex);                                     // reveal can go right after the commit (same block)
  await mine(1); await ordSynced();
  const ins = await ordGet('/inscription/' + it.inscriptionId);
  ok(ins && ins.id === it.inscriptionId, 'ord indexes the transfer inscription');
  ok(ins.content_type === 'text/plain;charset=utf-8', 'content type ' + ins.content_type);
  const body = await ordGet('/content/' + it.inscriptionId);
  ok(String(body) === '{"p":"brc-20","op":"transfer","tick":"shhhhh","amt":"1000"}', 'body is the BRC-20 transfer JSON');
  ok(ins.satpoint === `${it.reveal.txid}:0:0`, 'inscription sits at reveal output 0, offset 0');
  ok(ins.address === trAddr(holder.xonly), 'reveal paid the HOLDER address (where BRC-20 credits the transfer)');
  ok(!(ins.charms || []).includes('cursed'), 'not cursed');

  // step 2: send the inscription to W2's sp1 address
  const inscribedCoin = { txid: it.reveal.txid, vout: 0, value: it.postage, xonly: holder.xonly, priv: holder.priv, inscribed: true };
  const change = await scanFor(W, it.commit.txid);
  ok(change.length === 1, 'commit change came back to W (labeled change)');
  const s2 = buildSendInscription({ utxos: [inscribedCoin, ...change], inscribed: inscribedCoin, to: tsp(W2), feeRate: 2, changeAddress: tsp(W, 0), network: REGTEST });
  await send(s2.hex); await mine(1); await ordSynced();
  const moved = await ordGet('/inscription/' + it.inscriptionId);
  ok(moved.satpoint === `${s2.txid}:0:0`, 'after sending: inscription at output 0 of the send');
  const w2 = await scanFor(W2, s2.txid);
  ok(w2.some((u) => u.vout === 0), 'W2 owns that output (found by its own scan)');
  ok(trAddr(w2.find((u) => u.vout === 0).xonly) === moved.address, 'ord address = W2\'s silent output');

  // recovery: the commit key comes back from the wallet keys + nonce alone
  ok(commitKey(W.bSpend, 1) === commitKey(W.bSpend, 1) && commitKey(W.bSpend, 1) !== commitKey(W.bSpend, 2), 'commit key is deterministic per nonce (recoverable from the phrase)');
} catch (e) { ok(false, e.stack || e.message); }
finally { ord.kill(); try { fs.rmSync(ordDir, { recursive: true, force: true }); } catch {} }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
