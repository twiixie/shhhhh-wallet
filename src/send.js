// Sending from silent-payment outputs: coin selection, fees, sp1 + normal recipients, change to our own labeled
// silent address, BIP340 key-path signing with the output key used as-is (BIP352 outputs have no extra taproot tweak).
//
// Safety rules (enforced here, not in the UI):
//   - coins carrying inscriptions are NEVER used as fee / amount inputs; they move only via sendInscription()
//   - an inscription always goes first in, first out, to output 0, with its coin's full value, so its sat lands there
import { Transaction, OutScript, Address, SigHash, NETWORK } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { createOutputs, N } from './sp.js';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';

export const DUST = 330;                                    // smallest p2tr output we create
export const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const OUT_VB = { p2tr: 43, p2wpkh: 31, p2wsh: 43, p2pkh: 34, p2sh: 32 };
const IN_VB = 57.5;                                          // taproot key-path input
const TX_VB = 10.5;

const isSp = (a) => typeof a === 'string' && /^t?sp1/i.test(a);
function outScript(address, network) {
  if (address && address.script) return { kind: address.script.length === 34 ? 'p2tr' : 'p2wsh', script: address.script, raw: true };   // raw output script (e.g. a commit)
  if (isSp(address)) return { kind: 'sp' };
  const dec = Address(network).decode(address);
  return { kind: dec.type === 'tr' ? 'p2tr' : dec.type === 'wpkh' ? 'p2wpkh' : dec.type === 'wsh' ? 'p2wsh' : dec.type === 'pkh' ? 'p2pkh' : 'p2sh', script: OutScript.encode(dec) };
}
const outVb = (kind) => (kind === 'sp' ? OUT_VB.p2tr : OUT_VB[kind] || 43);
export const vsizeOf = (nIn, kinds) => Math.ceil(TX_VB + nIn * IN_VB + kinds.reduce((a, k) => a + outVb(k), 0));

// utxo: { txid, vout, value, xonly (hex output key), priv (bigint), inscribed (bool) }
function signAndBuild(inputs, outputs, network) {
  const tx = new Transaction({ allowUnknownOutputs: false });
  for (const u of inputs) tx.addInput({ txid: u.txid, index: u.vout, sequence: 0xfffffffd,
                                       witnessUtxo: { script: hexToBytes('5120' + u.xonly), amount: BigInt(u.value) } });
  for (const o of outputs) tx.addOutput({ script: o.script, amount: BigInt(o.value) });
  const scripts = inputs.map((u) => hexToBytes('5120' + u.xonly)), amounts = inputs.map((u) => BigInt(u.value));
  inputs.forEach((u, i) => {
    const msg = tx.preimageWitnessV1(i, scripts, SigHash.DEFAULT, amounts);
    const sig = schnorr.sign(msg, u.priv);                  // BIP340 handles an odd-y output key internally
    if (!schnorr.verify(sig, msg, hexToBytes(u.xonly))) throw new Error('signature check failed for input ' + i);
    tx.updateInput(i, { finalScriptWitness: [sig] });
  });
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize };
}

// Resolve recipients (sp1 or normal) into output scripts. sp1 outputs depend on ALL inputs, so this runs after
// coin selection with the final input set.
function resolveOutputs(inputs, payTo, network) {
  const sp = payTo.filter((p) => isSp(p.address));
  const spOut = sp.length ? createOutputs(inputs.map((u) => ({ txid: u.txid, vout: u.vout, priv: u.priv, taproot: true })),
                                          sp.map((p) => p.address)) : [];
  let k = 0;
  return payTo.map((p) => (isSp(p.address)
    ? { script: hexToBytes('5120' + spOut[k++].xonly), value: p.value, to: p.address }
    : { script: outScript(p.address, network).script, value: p.value, to: p.address, raw: !!(p.address && p.address.script) }));
}

// BTC send. recipients: [{ address, value (sats) }]; sendMax: everything (minus fee) to the single recipient.
export function buildSend({ utxos, recipients, feeRate, changeAddress, network = NETWORK, sendMax = false }) {
  if (!recipients.length) throw new Error('no recipient');
  if (!(feeRate >= 0.1)) throw new Error('fee rate too low');
  const kinds = recipients.map((r) => outScript(r.address, network).kind);
  const spendable = utxos.filter((u) => !u.inscribed).sort((a, b) => b.value - a.value);
  if (!spendable.length) throw new Error('no spendable BTC (coins with inscriptions are never used for fees)');
  let inputs, fee, change = 0;
  if (sendMax) {
    if (recipients.length !== 1) throw new Error('send max needs exactly one recipient');
    inputs = spendable;
    fee = Math.ceil(vsizeOf(inputs.length, kinds) * feeRate);
    const v = inputs.reduce((a, u) => a + u.value, 0) - fee;
    if (v < DUST) throw new Error('balance too small to cover the fee');
    recipients = [{ ...recipients[0], value: v }];
  } else {
    for (const r of recipients) if (!(r.value >= DUST)) throw new Error(`amount must be at least ${DUST} sats`);
    const need = recipients.reduce((a, r) => a + r.value, 0);
    inputs = []; let sum = 0;
    for (const u of spendable) {
      inputs.push(u); sum += u.value;
      const feeWithChange = Math.ceil(vsizeOf(inputs.length, [...kinds, 'sp']) * feeRate);
      const feeNoChange = Math.ceil(vsizeOf(inputs.length, kinds) * feeRate);
      if (sum >= need + feeWithChange + DUST) { fee = feeWithChange; change = sum - need - fee; break; }
      if (sum >= need + feeNoChange) { fee = sum - need; change = 0; break; }       // leftover below dust goes to the fee
    }
    if (fee === undefined) throw new Error('not enough BTC for this amount plus the network fee');
  }
  const payTo = recipients.map((r) => ({ address: r.address, value: r.value }));
  if (change) payTo.push({ address: changeAddress, value: change, change: true });
  const outputs = resolveOutputs(inputs, payTo, network);
  const signed = signAndBuild(inputs, outputs, network);
  if (signed.vsize * feeRate > fee + 1) throw new Error('fee estimate too low (internal check)');
  return { ...signed, fee, change, inputs: inputs.map((u) => `${u.txid}:${u.vout}`), outputs: outputs.map((o) => ({ to: o.raw ? 'script' : o.to, value: o.value, raw: o.raw })) };
}

// Inscription send: inscribed coin first, to output 0 with its full value; fees from plain coins; change to us.
export function buildSendInscription({ utxos, inscribed, to, feeRate, changeAddress, network = NETWORK }) {
  if (!inscribed || !inscribed.inscribed) throw new Error('that coin carries no inscription');
  const toKind = outScript(to, network).kind;
  const plain = utxos.filter((u) => !u.inscribed).sort((a, b) => b.value - a.value);
  const inputs = [inscribed]; let sum = 0, fee, change = 0;
  for (const u of plain) {
    inputs.push(u); sum += u.value;
    const f1 = Math.ceil(vsizeOf(inputs.length, [toKind, 'sp']) * feeRate), f0 = Math.ceil(vsizeOf(inputs.length, [toKind]) * feeRate);
    if (sum >= f1 + DUST) { fee = f1; change = sum - f1; break; }
    if (sum >= f0) { fee = sum; change = 0; break; }
  }
  if (fee === undefined) throw new Error('not enough plain BTC to pay the fee (the inscribed coin itself is never used for fees)');
  const payTo = [{ address: to, value: inscribed.value }];
  if (change) payTo.push({ address: changeAddress, value: change, change: true });
  const outputs = resolveOutputs(inputs, payTo, network);
  return { ...signAndBuild(inputs, outputs, network), fee, change, inputs: inputs.map((u) => `${u.txid}:${u.vout}`) };
}

export { bytesToHex };
