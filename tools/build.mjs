// Bundle the wallet into ./dist (static files: index.html, app.js, worker.js, logo).
import { build } from 'esbuild';
import fs from 'node:fs';
const out = new URL('../dist/', import.meta.url).pathname;
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
await build({ entryPoints: { app: 'src/app.js', worker: 'src/worker.js' }, bundle: true, format: 'esm', target: 'es2022',
              minify: true, sourcemap: false, outdir: out, legalComments: 'none' });
fs.copyFileSync('web/index.html', out + 'index.html');
fs.copyFileSync('web/logo.png', out + 'logo.png'); fs.copyFileSync('web/favicon.png', out + 'favicon.png');
for (const f of fs.readdirSync(out)) console.log(f.padEnd(14), (fs.statSync(out + f).size / 1024).toFixed(0) + ' KB');
