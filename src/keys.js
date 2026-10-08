// Recovery phrase -> BIP352 keys, and the password-encrypted vault kept in the browser.
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { bytesToNumberBE } from '@noble/curves/abstract/utils';
import { keysToAddress, Point, N, tagged, bytesToHex } from './sp.js';
import { bech32m } from '@scure/base';

// BIP352 derivation: scan m/352'/0'/0'/1'/0, spend m/352'/0'/0'/0'/0 (coin type 0 = mainnet)
export const SCAN_PATH = "m/352'/0'/0'/1'/0", SPEND_PATH = "m/352'/0'/0'/0'/0";
export const CHANGE_LABEL = 0;                            // BIP352: label m=0 is reserved for change

export const newMnemonic = (words = 12) => generateMnemonic(wordlist, words === 24 ? 256 : 128);
export const normalizeMnemonic = (m) => m.trim().toLowerCase().split(/\s+/).join(' ');
export const isValidMnemonic = (m) => validateMnemonic(normalizeMnemonic(m), wordlist);

export function walletFromMnemonic(mnemonic, passphrase = '') {
  const m = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(m, wordlist)) throw new Error('recovery phrase is not valid (check the words and their order)');
  return walletFromSeed(mnemonicToSeedSync(m, passphrase));
}
export function walletFromSeed(seed) {
  const root = HDKey.fromMasterSeed(seed);
  const bScan = bytesToNumberBE(root.derive(SCAN_PATH).privateKey);
  const bSpend = bytesToNumberBE(root.derive(SPEND_PATH).privateKey);
  return { ...walletFromKeys(bScan, bSpend), deposit: bip86(bytesToNumberBE(root.derive(DEPOSIT_PATH).privateKey)) };
}

// Deposit address: a normal BIP86 taproot address from the same phrase (the first address UniSat / Xverse show),
// for exchanges and UniSat, which cannot pay sp1 addresses. Funds there are moved to silent addresses in the app.
export const DEPOSIT_PATH = "m/86'/0'/0'/0/0";
export function bip86(d0) {
  const P = Point.BASE.multiply(d0), Px = P.toRawBytes(true).slice(1);
  const dEven = P.toAffine().y % 2n === 0n ? d0 : N - d0;
  const t = BigInt('0x' + bytesToHex(tagged('TapTweak', Px)));
  const priv = (dEven + t) % N, xonly = bytesToHex(Point.BASE.multiply(priv).toRawBytes(true).slice(1));
  return { priv, xonly, address: bech32m.encode('bc', [1, ...bech32m.toWords(Uint8Array.from(xonly.match(/../g).map((x) => parseInt(x, 16))))]) };
}
export function walletFromKeys(bScan, bSpend) {
  return { bScan, bSpend, Bspend: Point.BASE.multiply(bSpend),
           address: keysToAddress(bScan, bSpend), changeAddress: keysToAddress(bScan, bSpend, { label: CHANGE_LABEL }) };
}

// ---------------------------------------------------------------- vault: AES-256-GCM, key from the password (PBKDF2-SHA256)
const ITER = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();
// base64 in 32 KB slices: spreading a large array into one String.fromCharCode call overflows the call stack
const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aesKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
                                 { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// secret: { mnemonic, passphrase, birthday } -> JSON-able vault (nothing readable without the password)
export async function lockVault(secret, password) {
  if (!password || password.length < 8) throw new Error('password must be at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(password, salt, ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secret))));
  return { v: 1, kdf: 'pbkdf2-sha256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
export async function unlockVault(vault, password) {
  const key = await aesKey(password, unb64(vault.salt), vault.iter);
  try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct)))); }
  catch { throw new Error('wrong password'); }
}

// ---------------------------------------------------------------- encrypted app state (scan results, history)
// The vault holds a random 32-byte `stateKey`; scan state is AES-GCM encrypted with it, so it is unreadable without the password.
export const newStateKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export async function stateCryptoKey(stateKeyB64) {
  return crypto.subtle.importKey('raw', unb64(stateKeyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function openJSON(key, sealed) {
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct))));
}
