// Inscriptions: build the commit + reveal pair (standard ord envelope, proven on mainnet), used for
// BRC-20 "transfer" inscriptions. The reveal output pays the TOKEN HOLDER address itself (BRC-20 credits the
// transfer to the address that receives the reveal), then the inscription is sent with buildSendInscription().
//
// The commit key is derived from the wallet's spend key + a nonce, so a stuck commit can always be revealed or
// recovered from the recovery phrase alone.
import { Transaction, SigHash } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, concatBytes, numberToBytesBE } from '@noble/curves/abstract/utils';
import { Point, N, tagged } from './sp.js';
import { buildSend, DUST } from './send.js';

export const POSTAGE = 546;                                  // value of the inscription output (UniSat-compatible)
export const BRC20_CT = 'text/plain;charset=utf-8';
const enc = new TextEncoder();

function push(b) {
  if (b.length < 0x4c) return concatBytes(new Uint8Array([b.length]), b);
  if (b.length <= 0xff) return concatBytes(new Uint8Array([0x4c, b.length]), b);
  return concatBytes(new Uint8Array([0x4d, b.length & 255, b.length >> 8]), b);
}
export function inscriptionScript(xonly32, contentType, body) {
  const parts = [push(xonly32), new Uint8Array([0xac]),             // <pk> OP_CHECKSIG
                 new Uint8Array([0x00, 0x63]), push(enc.encode('ord')), // OP_FALSE OP_IF "ord"
                 push(new Uint8Array([1])), push(enc.encode(contentType)), // tag 1: content type
                 new Uint8Array([0x00])];                                 // body separator
  for (let i = 0; i < body.length; i += 520) parts.push(push(body.slice(i, i + 520)));
  parts.push(new Uint8Array([0x68]));                                     // OP_ENDIF
  return concatBytes(...parts);
}
const cs = (n) => (n < 0xfd ? new Uint8Array([n]) : new Uint8Array([0xfd, n & 255, n >> 8]));
const leafHash = (script) => tagged('TapLeaf', new Uint8Array([0xc0]), cs(script.length), script);
const be32 = (n) => numberToBytesBE(n, 32);
const toInt = (b) => BigInt('0x' + bytesToHex(b));

export const brc20Transfer = (tick, amt) => enc.encode(JSON.stringify({ p: 'brc-20', op: 'transfer', tick, amt: String(amt) }));
export function commitKey(bSpend, nonce) {
  return toInt(tagged('shhhhh/commit', be32(bSpend), enc.encode(String(nonce)))) % (N - 1n) + 1n;
}

// Commit address for an envelope with key `k` -> { script (leaf), outScript, controlBlock, internalX }
export function commitTarget(k, contentType, body) {
  const P = Point.BASE.multiply(k), Px = P.toRawBytes(true).slice(1);
  const script = inscriptionScript(Px, contentType, body);
  const t = toInt(tagged('TapTweak', Px, leafHash(script)));
  const Q = Point.fromHex(concatBytes(new Uint8Array([2]), Px)).add(Point.BASE.multiply(t));
  const Qb = Q.toRawBytes(true);
  return { script, outScript: concatBytes(new Uint8Array([0x51, 0x20]), Qb.slice(1)), controlBlock: concatBytes(new Uint8Array([0xc0 | (Qb[0] & 1)]), Px) };
}
export const revealVsize = (script) => Math.ceil(10.5 + 41 + 43 + (1 + 1 + 64 + cs(script.length).length + script.length + 1 + 33) / 4);

// Reveal: spend the commit output by script path -> one output (the holder's address script) with POSTAGE sats.
export function buildReveal({ commitTxid, commitVout, commitValue, k, contentType, body, toScript }) {
  const c = commitTarget(k, contentType, body);
  const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  tx.addInput({ txid: commitTxid, index: commitVout, sequence: 0xfffffffd, witnessUtxo: { script: c.outScript, amount: BigInt(commitValue) } });
  tx.addOutput({ script: toScript, amount: BigInt(POSTAGE) });
  const msg = tx.preimageWitnessV1(0, [c.outScript], SigHash.DEFAULT, [BigInt(commitValue)], -1, c.script, 0xc0);
  const sig = schnorr.sign(msg, k);
  tx.updateInput(0, { finalScriptWitness: [sig, c.script, c.controlBlock] }, true);
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize, inscriptionId: tx.id + 'i0' };
}

// BRC-20 transfer, step 1: commit (paid from plain coins) + reveal to the holder address.
// holder: the wallet output (bc1p, x-only) that holds the token balance. Returns both signed txs + the nonce to keep.
export function buildInscribeTransfer({ wallet, utxos, holderXonly, tick, amt, feeRate, changeAddress, network, nonce }) {
  const body = brc20Transfer(tick, amt);
  const k = commitKey(wallet.bSpend, nonce);
  const c = commitTarget(k, BRC20_CT, body);
  const revealFee = Math.ceil(revealVsize(c.script) * feeRate);
  const commitValue = POSTAGE + revealFee;
  const commitAddrScript = c.outScript;
  // commit: a normal send to the commit script (buildSend takes addresses, so pass the raw script via a tiny shim)
  const commit = buildSend({ utxos, recipients: [{ address: { script: commitAddrScript }, value: commitValue }], feeRate, changeAddress, network });
  const vout = commit.outputs.findIndex((o) => o.value === commitValue && o.raw);
  const reveal = buildReveal({ commitTxid: commit.txid, commitVout: vout, commitValue, k, contentType: BRC20_CT, body,
                               toScript: hexToBytes('5120' + holderXonly) });
  if (reveal.vsize * feeRate > revealFee + 1) throw new Error('reveal fee estimate too low (internal check)');
  return { commit, reveal, nonce, inscriptionId: reveal.inscriptionId, holderXonly, postage: POSTAGE };
}
