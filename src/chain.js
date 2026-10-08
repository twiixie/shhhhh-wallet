// Esplora (mempool.space / blockstream) tx JSON -> BIP352 inputs/outputs.
const cs = (n) => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 255, n >> 8] : [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const hx = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join('');
export function witnessHex(items) {                      // esplora gives the witness as an array of hex items
  if (!items || !items.length) return '';
  let out = hx(cs(items.length));
  for (const it of items) out += hx(cs(it.length / 2)) + it;
  return out;
}
export function esploraVins(tx) {
  return tx.vin.filter((v) => !v.is_coinbase).map((v) => ({ txid: v.txid, vout: v.vout, scriptSig: v.scriptsig || '',
    txinwitness: witnessHex(v.witness), prevoutScript: v.prevout.scriptpubkey }));
}
export function taprootOutputs(tx) {                     // [{ vout, xonly, value }]
  return tx.vout.map((o, i) => ({ vout: i, spk: o.scriptpubkey, value: o.value }))
    .filter((o) => o.spk.length === 68 && o.spk.startsWith('5120')).map((o) => ({ vout: o.vout, xonly: o.spk.slice(4), value: o.value }));
}
