# shhhhh wallet

A private Bitcoin wallet for Chrome, built on **silent payments** ([BIP352](https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki)).
Hold and send BTC, BRC-20 tokens and inscriptions. Your keys never leave your browser.

Website: [shhhhh.site](https://shhhhh.site) · Privacy policy: [shhhhh.site/privacy](https://shhhhh.site/privacy)

> **Beta.** Use small amounts only and keep your 12 words written down on paper.

## How it works

- **One reusable address (sp1).** Every payment to you lands on a new, unlinkable taproot address.
- **Keys stay local.** The 12-word phrase is created in the browser and stored encrypted with your password (AES-GCM, PBKDF2). Sync data is encrypted too.
- **Finding payments.** Silent payments can only be found with the scan key, so the wallet asks a node running [Frigate](https://github.com/sparrowwallet/frigate) to scan for them. The scan key cannot spend; every candidate the node returns is checked again locally with your keys.
- **Inscriptions and BRC-20.** Coins are checked with [ord](https://github.com/ordinals/ord) before they are ever used as fee money, so inscriptions are never spent by mistake. BRC-20 transfers use the usual two steps (inscribe the transfer to the holder address, then send it).
- **Deposit address.** A normal BIP86 taproot address from the same 12 words, for exchanges and other wallets.

## Layout

| Path | What |
|---|---|
| `src/` | The wallet: UI (`app.js`), keys and vault (`keys.js`), BIP352 (`sp.js`, `scan.js`), sync (`node.js`), transactions (`send.js`, `inscribe.js`) |
| `web/` | The page shell |
| `bridge/` | The small server between the wallet and Bitcoin Core, Frigate, ord and the BRC-20 indexer |
| `tools/` | Build scripts and browser tests |
| `test/` | Unit tests (incl. the official BIP352 test vectors) and regtest tests |

## Build

```sh
npm install
node tools/build.mjs              # web build -> dist/
node tools/build-extension.mjs    # Chrome extension -> extension/ (+ .zip)
```

Load it in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → choose `extension/`.

## Test

```sh
node test/sp.test.js              # BIP352 vectors
node test/scan.test.js
node test/keys.test.js
node tools/dev-server.mjs &       # http://127.0.0.1:8362
node tools/e2e.mjs                # browser test (Chrome)
```

Regtest tests (`test/*.regtest.mjs`) need `bitcoind` (and `ord` for inscriptions) on your PATH, or `BITCOIN_BIN` / `ORD_BIN`.

## Running your own bridge

`bridge/server.mjs` expects Bitcoin Core (cookie auth), Frigate and ord on the same machine. Settings come from the environment:
`PORT`, `BITCOIN_COOKIE`, `ORD_URL`, `FRIGATE_PORT`, `UNISAT_API_KEY` (BRC-20 balances), `ALLOW_ORIGINS`.
To point the wallet at your node, change `NODE` in `src/node.js`.

## License

MIT
