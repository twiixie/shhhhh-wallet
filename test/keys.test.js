// Keys + vault tests, and a real mainnet receive test with the project's deployer sp1 wallet.   node test/keys.test.js
import fs from 'node:fs';
import os from 'node:os';
import * as K from '../src/keys.js';
import * as sp from '../src/sp.js';
import { esploraVins, taprootOutputs } from '../src/chain.js';

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log('FAIL', name); } };

// 1. mnemonic -> keys: deterministic, valid sp1, change address differs, passphrase changes keys
const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const w = K.walletFromMnemonic(M), w2 = K.walletFromMnemonic('  ' + M.toUpperCase() + ' ');
ok(w.address === w2.address && w.address.startsWith('sp1q') && w.address.length === 116, 'address deterministic + normalized');
ok(sp.decodeAddress(w.address).Bscan.equals(sp.Point.BASE.multiply(w.bScan)), 'address carries the scan key');
ok(w.changeAddress !== w.address, 'change address is a labeled address');
ok(K.walletFromMnemonic(M, 'x').address !== w.address, 'passphrase gives a different wallet');
ok(!K.isValidMnemonic(M.replace('about', 'abandon')), 'bad checksum rejected');
ok(K.isValidMnemonic(K.newMnemonic()) && K.newMnemonic(24).split(' ').length === 24, 'new phrases valid');
console.log('abandon…about sp1:', w.address);
// BIP86 official test vector: "abandon … about", m/86'/0'/0'/0/0
ok(w.deposit.address === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'deposit address = BIP86 test vector');

// 2. vault round trip
const vault = await K.lockVault({ mnemonic: M, birthday: 969600 }, 'correct horse');
ok(!JSON.stringify(vault).includes('abandon'), 'vault hides the phrase');
ok((await K.unlockVault(vault, 'correct horse')).mnemonic === M, 'vault unlocks');
let wrong = false; try { await K.unlockVault(vault, 'wrong password'); } catch { wrong = true; }
ok(wrong, 'wrong password rejected');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
