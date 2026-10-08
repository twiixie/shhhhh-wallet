// Public status page for node.shhhhh.site (served at /). Reads /v1/status every 10 s. Self-contained: no external files.
export const STATUS_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>shhhhh node status</title>
<meta name="description" content="Live health of the shhhhh node: Bitcoin Core, Frigate silent payments scanning and ord.">
<style>
:root{--bg:#0e0e0f;--card:#18181a;--card2:#222225;--line:#2a2a2e;--ink:#f5f3ef;--mute:#98969c;--acc:#f0a03c;--ok:#3fd68f;--warn:#f0c03c;--bad:#ff6b6b;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,"SF Pro Text",Segoe UI,sans-serif}
main{max-width:920px;margin:0 auto;padding:28px 16px 48px}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}
h1{font-size:24px;margin:0;letter-spacing:-.3px}h1 b{color:var(--acc)}
.sub{color:var(--mute);font-size:13.5px;margin-top:2px}
.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:7px 14px;font-weight:700;font-size:14px;background:var(--card)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--mute);box-shadow:0 0 0 0 currentColor}
.ok .dot{background:var(--ok);animation:pulse 2s infinite}.warn .dot{background:var(--warn)}.bad .dot{background:var(--bad)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,214,143,.5)}70%{box-shadow:0 0 0 8px rgba(63,214,143,0)}100%{box-shadow:0 0 0 0 rgba(63,214,143,0)}}
.hero{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
.stat{background:var(--card);border-radius:14px;padding:14px}
.stat small{display:block;color:var(--mute);font-size:12.5px}.stat b{font-size:22px;letter-spacing:-.3px;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.card{background:var(--card);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:8px}
.card h2{font-size:15px;margin:0;display:flex;align-items:center;justify-content:space-between}
.row{display:flex;justify-content:space-between;gap:10px;font-size:14px}.row span:first-child{color:var(--mute)}.row span:last-child{font-variant-numeric:tabular-nums;text-align:right;min-width:0;overflow-wrap:anywhere}
.wide{grid-column:span 3}
.bars{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.bar{height:8px;border-radius:5px;background:var(--card2);overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--acc);border-radius:5px;transition:width .6s}
.bar.hi i{background:var(--warn)}.bar.crit i{background:var(--bad)}
footer{color:var(--mute);font-size:12.5px;margin-top:18px;text-align:center}
a{color:var(--acc);text-decoration:none}
@media(max-width:760px){.hero{grid-template-columns:repeat(3,minmax(0,1fr))}.grid{grid-template-columns:minmax(0,1fr)}.wide{grid-column:auto}.bars{grid-template-columns:repeat(2,minmax(0,1fr))}.stat b{font-size:19px}}
html,body{overflow-x:hidden}
</style></head>
<body><main>
<header>
  <div><h1><b>shhhhh</b> node</h1><div class="sub">Bitcoin full node · silent payments scanning · inscriptions</div></div>
  <div class="pill" id="overall"><span class="dot"></span><span>Checking…</span></div>
</header>
<section class="hero">
  <div class="stat"><small>Block height</small><b id="h">–</b></div>
  <div class="stat"><small>Last block</small><b id="lb">–</b></div>
  <div class="stat"><small>Mempool</small><b id="mp">–</b></div>
</section>
<section class="grid">
  <div class="card"><h2>Bitcoin Core <span class="pill" id="s-btc"><span class="dot"></span></span></h2>
    <div class="row"><span>Height</span><span id="btc-h">–</span></div><div class="row"><span>Peers</span><span id="btc-p">–</span></div>
    <div class="row"><span>Version</span><span id="btc-v">–</span></div><div class="row"><span>Blockchain</span><span id="btc-s">–</span></div></div>
  <div class="card"><h2>Frigate <span class="pill" id="s-fr"><span class="dot"></span></span></h2>
    <div class="row"><span>Indexed to</span><span id="fr-h">–</span></div><div class="row"><span>Role</span><span>Silent payments scanning</span></div>
    <div class="row"><span>Version</span><span id="fr-v">–</span></div><div class="row"><span>Up for</span><span id="fr-u">–</span></div></div>
  <div class="card"><h2>ord <span class="pill" id="s-ord"><span class="dot"></span></span></h2>
    <div class="row"><span>Indexed to</span><span id="ord-h">–</span></div><div class="row"><span>Role</span><span>Inscriptions</span></div>
    <div class="row"><span>Inscriptions</span><span id="ord-i">–</span></div><div class="row"><span>&nbsp;</span><span></span></div></div>
  <div class="card wide"><h2>Machine <span class="sub" id="up"></span></h2>
    <div class="bars">
      <div><div class="row"><span>CPU load</span><span id="cpu">–</span></div><div class="bar" id="cpu-b"><i style="width:0"></i></div></div>
      <div><div class="row"><span>Memory</span><span id="mem">–</span></div><div class="bar" id="mem-b"><i style="width:0"></i></div></div>
      <div><div class="row"><span>System disk</span><span id="d1">–</span></div><div class="bar" id="d1-b"><i style="width:0"></i></div></div>
      <div><div class="row"><span>Data disk</span><span id="d2">–</span></div><div class="bar" id="d2-b"><i style="width:0"></i></div></div>
    </div></div>
</section>
<footer>Updated <span id="at">–</span> · refreshes every 10 s · <a href="https://shhhhh.site">shhhhh.site</a></footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
const n = (x) => (x == null ? '–' : Number(x).toLocaleString('en-US'));
const gb = (b) => (b / 1e9 >= 1000 ? (b / 1e12).toFixed(2) + ' TB' : Math.round(b / 1e9) + ' GB');
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm'; };
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.round(s) + 's ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : dur(s) + ' ago'; };
function pill(el, ok, text) { el.className = 'pill ' + (ok ? 'ok' : 'bad'); el.lastChild.nodeType === 3 ? (el.lastChild.textContent = text) : el.append(text); }
function bar(id, frac) { const b = $(id); b.firstChild.style.width = Math.min(100, frac * 100) + '%'; b.className = 'bar' + (frac > .9 ? ' crit' : frac > .75 ? ' hi' : ''); }
let lastBlock = 0;
async function load() {
  try {
    const s = await (await fetch('/v1/status', { cache: 'no-store' })).json();
    const allOk = s.bitcoin.ok && s.frigate.ok && s.ord.ok;
    const o = $('overall'); o.className = 'pill ' + (allOk ? 'ok' : 'warn'); o.lastChild.textContent = allOk ? 'All systems operational' : 'Partially available';
    $('h').textContent = n(s.bitcoin.height); lastBlock = s.bitcoin.lastBlockTime; $('lb').textContent = ago(lastBlock);
    $('mp').textContent = n(s.bitcoin.mempoolTxs) + ' tx';
    pill($('s-btc'), s.bitcoin.ok, s.bitcoin.ok ? 'Synced' : 'Syncing'); $('btc-h').textContent = n(s.bitcoin.height); $('btc-p').textContent = s.bitcoin.peers;
    $('btc-v').textContent = s.bitcoin.version; $('btc-s').textContent = s.bitcoin.sizeGB + ' GB';
    pill($('s-fr'), s.frigate.ok, s.frigate.ok ? 'Synced' : 'Down'); $('fr-h').textContent = n(s.frigate.height); $('fr-v').textContent = s.frigate.version || '–';
    $('fr-u').textContent = s.frigate.uptime ? dur(s.frigate.uptime) : '–';
    pill($('s-ord'), s.ord.ok, s.ord.ok ? 'Synced' : 'Catching up'); $('ord-h').textContent = n(s.ord.height); $('ord-i').textContent = n(s.ord.inscriptions);
    const m = s.machine, load1 = m.load[0] / m.cpus; $('cpu').textContent = Math.round(load1 * 100) + '%'; bar('cpu-b', load1);
    const used = (m.memTotal - m.memFree) / m.memTotal; $('mem').textContent = gb(m.memTotal - m.memFree) + ' / ' + gb(m.memTotal); bar('mem-b', used);
    for (const [k, id] of [['system', 'd1'], ['data', 'd2']]) { const d = m.disks[k]; if (!d) continue; const u = (d.total - d.free) / d.total; $(id).textContent = gb(d.total - d.free) + ' / ' + gb(d.total); bar(id + '-b', u); }
    $('up').textContent = 'up ' + dur(m.uptime); $('at').textContent = new Date(s.at).toLocaleTimeString();
  } catch (e) { const o = $('overall'); o.className = 'pill bad'; o.lastChild.textContent = 'Node unreachable'; }
}
load(); setInterval(load, 10000); setInterval(() => { if (lastBlock) $('lb').textContent = ago(lastBlock); }, 1000);
</script></body></html>`;
