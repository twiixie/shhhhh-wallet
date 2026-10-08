// Scanner tests on synthetic index pages built with real BIP352 sending.   node test/scan.test.js
import * as sp from '../src/sp.js';
import * as K from '../src/keys.js';
import { scanPage, newState, balances, taprootAddress } from '../src/scan.js';
import { bytesToHex } from '../src/sp.js';

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log('FAIL', name); } };
const me = K.walletFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const other = K.walletFromMnemonic(K.newMnemonic());
const rnd = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const txid = () => rnd();

// A fake tx paying silent-payment outputs: returns { txid, data (index tx data), outs: [bc1p...] }
function spTx(recipients) {
  const ins = [{ txid: txid(), vout: 1, priv: rnd(), taproot: true }, { txid: txid(), vout: 0, priv: rnd(), taproot: true }];
  const outs = sp.createOutputs(ins, recipients).map((o) => taprootAddress(o.xonly));
  const k = ins.map((i) => {                               // taproot inputs: x-only key with even y (0x02 prefix)
    const x = sp.Point.BASE.multiply(BigInt('0x' + i.priv)).toRawBytes(true).slice(1);
    return '02' + bytesToHex(x);
  });
  const sorted = ins.slice().sort((a, b) => {
    const ka = a.txid.match(/../g).reverse().join('') + [0, 8, 16, 24].map((s) => ((a.vout >>> s) & 255).toString(16).padStart(2, '0')).join('');
    const kb = b.txid.match(/../g).reverse().join('') + [0, 8, 16, 24].map((s) => ((b.vout >>> s) & 255).toString(16).padStart(2, '0')).join('');
    return ka < kb ? -1 : 1;
  });
  return { txid: txid(), data: { o: `${sorted[0].txid}:${sorted[0].vout}`, k }, outs };
}

const t1 = spTx([other.address, me.address, other.address]);          // batch: someone else, me, someone else again
const t2 = spTx([me.address, me.address]);                             // two outputs to me in one tx (k = 0, 1)
const t3 = spTx([me.changeAddress]);                                     // my labeled change address
const t4 = spTx([other.address]);
const ib = 'aa'.repeat(32) + 'i0';
const page = { n: 0, tx: { [t1.txid]: t1.data, [t2.txid]: t2.data, [t3.txid]: t3.data, [t4.txid]: t4.data }, e: [
  ['T', 100, t1.txid, 0, 'bc1pzzz', t1.outs[0], '500', 'x1'],
  ['T', 100, t1.txid, 1, 'bc1pzzz', t1.outs[1], '1000', 'x2'],            // mine
  ['T', 100, t1.txid, 2, 'bc1pzzz', t1.outs[2], '700', 'x3'],
  ['T', 101, t2.txid, 0, 'bc1pzzz', t2.outs[0], '2000', 'x4'],            // mine
  ['T', 101, t2.txid, 1, 'bc1pzzz', t2.outs[1], '3000', 'x5'],            // mine (k = 1)
  ['T', 102, t3.txid, 0, 'bc1pzzz', t3.outs[0], '400', 'x6'],             // mine (change label)
  ['T', 103, t4.txid, 0, 'bc1pzzz', t4.outs[0], '9999', 'x7'],
  ['I', 104, 'cc'.repeat(32), 0, '', t2.outs[1], '1200', ib],             // I set aside 1,200 to send
] };
const st = newState(0);
ok(scanPage(st, page, me, 1000) === 4, 'finds exactly my 4 outputs');
let b = balances(st);
ok(b.total === 6400 && b.transferable === 1200 && b.available === 5200, `balance 6,400 (got ${b.total}/${b.transferable})`);
ok(Object.values(st.addrs).some((a) => a.label === 0), 'change output found via its label');

// spending: my transfer inscription moves out -> balance drops, pending cleared
page.e.push(['T', 105, 'dd'.repeat(32), 0, t2.outs[1], 'bc1qsomeoneelse', '1200', ib]);
ok(scanPage(st, page, me, 1000) === 0, 'rescan of the same page adds nothing');
b = balances(st);
ok(b.total === 5200 && b.transferable === 0, `after sending 1,200: 5,200 (got ${b.total})`);
ok(st.history.filter((h) => h.dir === 'in').length === 4 && st.history.some((h) => h.dir === 'out' && h.amount === 1200), 'history in/out');

// the other wallet sees only its own
const so = newState(0); scanPage(so, page, other, 1000);
ok(balances(so).total === 500 + 700 + 9999, 'other wallet balance');
// birthday after the payments -> nothing found
const sb = newState(200); scanPage(sb, page, me, 1000);
ok(balances(sb).total === 0, 'birthday skips older blocks');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
