// Real-geometry layout verifier for ChunkyMatrix. Dev tooling only; the app itself has no dependencies.
//
// Why this exists: an earlier "ink stripe" check read the canvas's OWN pixel buffer, which is internally
// consistent even when the canvas ELEMENT is the wrong size on the page, so it false-passed twice on the
// real mobile bug. This one never trusts the app's own variables. It records what is actually drawn
// (fillRect/fillText, mapped to CSS px with a fresh devicePixelRatio) and compares it to a FRESH
// getBoundingClientRect taken at assertion time, in real Chromium and real WebKit, with real DPR emulation,
// through a simulated rotation. It also rebuilds the visible boot text from the draw calls, so it can prove
// every boot line prints in full (no truncation, nothing off the bottom).
//
// Setup (once, in the repo root; node_modules/ is gitignored):
//   npm i --no-save playwright-core && npx playwright install chromium webkit
// Run from the repo root:
//   node tests/verify-layout.mjs --root . [--engines chromium,webkit] [--dprs 1,2,3]
//                                [--set all|phones|desktop] [--only 390x844] [--expect-desktop] [--json out.json]
// Exit code is non-zero if any assertion fails. Boot time is driven by Playwright's mocked clock, so a full
// run takes about 5 minutes for 66 cases. If playwright-core wants a WebKit build you don't have, set
// WEBKIT_EXE to the pw_run.sh of one you do (~/Library/Caches/ms-playwright/webkit-*/pw_run.sh).
//
// Proven to discriminate: re-introducing the round-2 canvas-box bug, the round-3 stale-measurement bug (no
// ResizeObserver) or the ceil() overflow each makes it fail with a specific message.
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, webkit } from 'playwright-core';
// Use the newest cached WebKit build. Playwright may ask for a slightly different revision than the one installed
// (same protocol), so point at the installed one explicitly.
const WK = process.env.WEBKIT_EXE || (() => { const d = os.homedir() + '/Library/Caches/ms-playwright'; const v = fs.readdirSync(d).filter((x) => /^webkit-\d+$/.test(x)).sort().pop(); return v ? `${d}/${v}/pw_run.sh` : undefined; })();

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1]?.startsWith('--') || i + 1 >= argv.length ? true : argv[i + 1]); };
const ROOT = path.resolve(opt('root', '.'));
const ENGINES = String(opt('engines', 'chromium,webkit')).split(',');
const DPRS = String(opt('dprs', '1,2,3')).split(',').map(Number);
const SET = opt('set', 'all');
const EXPECT_DESKTOP = argv.includes('--expect-desktop');
const ONLY = opt('only', null);
const JSON_OUT = opt('json', null);
const HEADER = '**** C64 BASIC V2 ****';

const PHONES = [[320, 568], [375, 667], [390, 844], [414, 896], [430, 932]];
const DESKTOPS = [[1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]];
let cases = [];
if (SET !== 'desktop') cases.push(...PHONES.map(([w, h]) => ({ w, h, mobile: true, kind: 'phone' })));
if (SET !== 'phones') cases.push(...DESKTOPS.map(([w, h]) => ({ w, h, mobile: false, kind: 'desktop' })));
if (ONLY) cases = cases.filter((c) => `${c.w}x${c.h}` === ONLY);

// ── static server ───────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── in-page recorder: what is ACTUALLY drawn, in CSS px ─────────────
const INSTRUMENT = `(() => {
  window.__ev = [];
  const P = CanvasRenderingContext2D.prototype;
  const fr = P.fillRect, ft = P.fillText;
  const css = (ctx, x, y) => { const m = ctx.getTransform(), d = window.devicePixelRatio || 1;
    return [(m.a * x + m.c * y + m.e) / d, (m.b * x + m.d * y + m.f) / d, m.a / d]; };
  P.fillRect = function (x, y, w, h) {
    const [X, Y, s] = css(this, x, y); window.__ev.push(['r', X, Y, w * s, h * s]);
    return fr.call(this, x, y, w, h); };
  P.fillText = function (t, x, y, mw) {
    const [X, Y] = css(this, x, y); window.__ev.push(['t', X, Y, String(t)]);
    return ft.call(this, t, x, y); };
})();`;

// ── screen model rebuilt purely from draw events ────────────────────
class Screen {
  constructor() { this.cw = 0; this.ch = 0; this.cells = new Map(); this.appW = 0; this.appH = 0; this.maxR = 0; this.maxB = 0; this.cols = new Set(); this.sizes = new Map(); this.textMaxX = 0; this.textMaxY = 0; this.firstSnap = null; this.vw = 320; this.vh = 320; }
  // A full-canvas fill is a rect at the origin covering most of the VIEWPORT. Never an absolute size: a chunky
  // desktop cell is >100px, so any fixed threshold would mistake the first cell for a full fill.
  isFull(e) { return e[0] === 'r' && e[1] < 0.5 && e[2] < 0.5 && e[3] > this.vw * 0.5 && e[4] > this.vh * 0.5; }
  resetStats() { this.maxR = 0; this.maxB = 0; this.cols = new Set(); this.textMaxX = 0; this.textMaxY = 0; }
  apply(evs) {
    // pass 1: the app's full-canvas fill (its idea of the drawable) and the dominant cell size
    for (const e of evs) if (this.isFull(e)) { this.appW = e[3]; this.appH = e[4]; }
    const cand = new Map();
    for (const e of evs) if (e[0] === 'r' && e[3] > 3 && e[3] < (this.appW || 1e9) / 2 && e[4] > 3) { const k = e[3].toFixed(2) + 'x' + e[4].toFixed(2); cand.set(k, (cand.get(k) || 0) + 1); }
    // Sprite glyphs draw many tiny pixel rects that outnumber cell fills. The cell is the LARGEST rect size
    // that occurs often (cell fills come one per drawn glyph), not merely the most common one.
    let top = 0; for (const n of cand.values()) top = Math.max(top, n);
    let best = null;
    for (const [k, n] of cand) { const [a, b] = k.split('x').map(Number); if (n >= Math.max(3, top * 0.05) && (!best || a * b > best[2])) best = [k, n, a * b]; }
    if (best) { const [a, b] = best[0].split('x').map(Number); this.cw = a; this.ch = b; }
    // pass 2: replay
    for (const e of evs) {
      if (e[0] === 'r') {
        const [, x, y, w, h] = e;
        if (this.isFull(e)) { if (!this.firstSnap && this.cw && this.cells.size) { const snap = this.rows(Math.floor(this.appW / this.cw), Math.floor(this.appH / this.ch)); if (snap.join('').replace(/ /g, '').length >= 8) this.firstSnap = snap; } this.cells.clear(); continue; }
        if (this.cw && Math.abs(w - this.cw) < 0.05 && Math.abs(h - this.ch) < 0.05) {
          this.cells.delete(Math.round(x / this.cw) + ',' + Math.round(y / this.ch));
          this.maxR = Math.max(this.maxR, x + w); this.maxB = Math.max(this.maxB, y + h);
          this.cols.add(Math.round(x / this.cw));
        }
      } else if (this.cw) {
        const [, x, y, t] = e; if (x < 0 || y < 0) continue; const c = Math.floor(x / this.cw), r = Math.floor(y / this.ch);
        this.cells.set(c + ',' + r, t);
        this.textMaxX = Math.max(this.textMaxX, x + this.cw / 2); this.textMaxY = Math.max(this.textMaxY, y);
      }
    }
  }
  rows(cols, rows) {
    const out = [];
    for (let r = 0; r < rows; r++) { let s = ''; for (let c = 0; c < cols; c++) s += this.cells.get(c + ',' + r) || ' '; out.push(s); }
    return out;
  }
}

const EPS = 0.51;
async function fresh(page) {
  return page.evaluate(() => {
    const R = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; };
    const cvs = document.getElementById('matrix-cvs');
    return { wrap: R('c64-screen-wrapper'), cvs: R('matrix-cvs'), ctl: R('c64-controls'), bw: cvs.width, bh: cvs.height,
      dpr: window.devicePixelRatio, iw: window.innerWidth, ih: window.innerHeight };
  });
}

// Layout assertions against FRESH measurements. Returns list of failures.
function assertLayout(tag, F, S, phone) {
  const bad = []; const chk = (ok, msg) => { if (!ok) bad.push(`${tag}: ${msg}`); };
  const cols = S.cw ? Math.floor(F.cvs.w / S.cw) : 0, rows = S.ch ? Math.floor(F.cvs.h / S.ch) : 0;
  chk(S.cw > 0, 'no cell-size draws observed (renderer produced nothing)');
  // 1. canvas element box == wrapper (the replaced-element bug: box was DPR x too large)
  chk(Math.abs(F.cvs.w - F.wrap.w) <= EPS && Math.abs(F.cvs.h - F.wrap.h) <= EPS, `canvas box ${F.cvs.w.toFixed(1)}x${F.cvs.h.toFixed(1)} != wrapper ${F.wrap.w.toFixed(1)}x${F.wrap.h.toFixed(1)}`);
  // 2. what the app thinks is drawable == a FRESH canvas rect (the stale-measure-after-rotation bug)
  chk(Math.abs(S.appW - F.cvs.w) <= EPS && Math.abs(S.appH - F.cvs.h) <= EPS, `app drawable ${S.appW.toFixed(1)}x${S.appH.toFixed(1)} != fresh canvas rect ${F.cvs.w.toFixed(1)}x${F.cvs.h.toFixed(1)}`);
  // 3. backing store is exactly CSS size x DPR
  chk(Math.abs(F.bw - Math.round(F.cvs.w * F.dpr)) <= 1 && Math.abs(F.bh - Math.round(F.cvs.h * F.dpr)) <= 1, `backing ${F.bw}x${F.bh} != ${(F.cvs.w * F.dpr).toFixed(1)}x${(F.cvs.h * F.dpr).toFixed(1)} (dpr ${F.dpr})`);
  // 4. rendered content never exceeds the drawable area (rendered pitch x cells, and every cell actually painted)
  chk(cols * S.cw <= F.cvs.w + 0.01, `COLS*CELL_W ${(cols * S.cw).toFixed(2)} > drawable width ${F.cvs.w.toFixed(2)}`);
  chk(rows * S.ch <= F.cvs.h + 0.01, `ROWS*CELL_H ${(rows * S.ch).toFixed(2)} > drawable height ${F.cvs.h.toFixed(2)}`);
  chk(S.maxR <= F.cvs.w + 0.01, `painted cells reach x=${S.maxR.toFixed(2)} > canvas width ${F.cvs.w.toFixed(2)}`);
  chk(S.maxB <= F.cvs.h + 0.01, `painted cells reach y=${S.maxB.toFixed(2)} > canvas height ${F.cvs.h.toFixed(2)}`);
  chk(S.textMaxX <= F.cvs.w + 0.01, `glyph centres reach x=${S.textMaxX.toFixed(2)} > canvas width`);
  chk(S.textMaxY <= F.cvs.h + 0.01, `glyph baselines reach y=${S.textMaxY.toFixed(2)} > canvas height`);
  // 5. HUD: drawable area sits above the controls row and everything is inside the viewport
  chk(F.wrap.b <= F.ctl.y + EPS, `wrapper bottom ${F.wrap.b.toFixed(1)} overlaps controls top ${F.ctl.y.toFixed(1)}`);
  chk(F.ctl.b <= F.ih + EPS && F.wrap.r <= F.iw + EPS, `layout overflows viewport (controls bottom ${F.ctl.b.toFixed(1)} vs ${F.ih}, wrap right ${F.wrap.r.toFixed(1)} vs ${F.iw})`);
  // 6. rendered columns actually reach (nearly) the right edge: no big dead strip
  chk(S.cols.size >= cols - 1, `only ${S.cols.size} of ${cols} columns painted`);
  return { bad, cols, rows };
}

const norm = (rows) => rows.map((r) => r.trim()).filter(Boolean).join(' ');

async function runCase(bt, name, c, dpr) {
  const browser = bt; const fails = []; const info = {};
  const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: dpr, isMobile: c.mobile, hasTouch: c.mobile });
  await ctx.route((u) => !u.href.startsWith(BASE), (r) => r.abort());
  await ctx.route('**/soundtrack.mp4', (r) => r.abort());
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|blocked/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(INSTRUMENT);
  await page.clock.install({ time: 0 });
  await page.goto(`${BASE}/index.html?debug=1`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const S = new Screen(); S.vw = c.w; S.vh = c.h;
  const step = async (ms) => { await page.clock.runFor(ms); const ev = await page.evaluate(() => { const e = window.__ev; window.__ev = []; return e; }); S.apply(ev); return ev.length; };
  const tag = (s) => `${name} ${c.w}x${c.h}@${dpr}x ${s}`;
  const dims = async () => { const F = await fresh(page); return { F, cols: S.cw ? Math.floor(F.cvs.w / S.cw) : 0, rows: S.ch ? Math.floor(F.cvs.h / S.ch) : 0 }; };

  // boot start
  let n = 0; for (let i = 0; i < 60 && !S.cw; i++) n += await step(50);
  let { F, cols, rows } = await dims();
  info.boot = { cols, rows, cellW: +S.cw.toFixed(2), cellH: +S.ch.toFixed(2), canvas: `${F.cvs.w.toFixed(1)}x${F.cvs.h.toFixed(1)}` };
  const live = S.rows(cols, rows); const s0 = norm(live) ? live : (S.firstSnap || live);
  const has = (txt) => norm(s0).includes(txt);
  if (!has(HEADER)) fails.push(tag(`boot: header not fully visible / truncated. screen="${norm(s0)}"`));
  if (!has('64K RAM SYSTEM')) fails.push(tag(`boot: "64K RAM SYSTEM" not visible. screen="${norm(s0)}"`));
  if (!has('READY.')) fails.push(tag(`boot: "READY." not visible. screen="${norm(s0)}"`));
  const headerRows = s0.filter((r) => /\*/.test(r)).length;
  info.headerRows = headerRows;
  if (c.w <= 430 && c.kind === 'phone') {
    // the hard floor: 22-char header on ONE row, untruncated, at every phone width
    const one = s0.some((r) => r.includes(HEADER));
    if (!one) fails.push(tag(`FLOOR: 22-char header is not on a single row (cols=${cols})`));
    if (cols < 22) fails.push(tag(`FLOOR: only ${cols} columns (< 22)`));
  }

  // drive the whole boot, checking every line prints in full at the moment it appears
  const seen = { load: false, search: false, loading: false, ready: false };
  let state = 'waiting', t = 0;
  while (t < 45000) {
    await step(100); t += 100;
    ({ F, cols, rows } = await dims());
    const all = S.rows(cols, rows), joined = all.join(''), nz = norm(all);
    if (!seen.load && joined.includes('LOAD "CHUNKY-MATRIX",8,1')) seen.load = true;
    if (!seen.search && joined.includes('SEARCHING FOR CHUNKY-MATRIX')) seen.search = true;
    if (!seen.loading && seen.search && joined.includes('LOADING')) seen.loading = true; // NOISE_CHARS contain no letters, so this string can only come from the print
    const dbg = await page.evaluate(() => (document.getElementById('debug-overlay') || {}).textContent || '');
    const m = /bootState: (\w+)/.exec(dbg); if (m) state = m[1];
    if (state === 'rain') break;
    if (state === 'ready') seen.ready = seen.ready || /READY\./.test(nz);
  }
  if (state !== 'rain') fails.push(tag(`boot never reached rain (stuck in "${state}" after ${t}ms)`));
  if (!seen.load) fails.push(tag('boot: LOAD command never appeared in full'));
  if (!seen.search) fails.push(tag('boot: "SEARCHING FOR CHUNKY-MATRIX" never appeared in full'));
  if (!seen.loading) fails.push(tag('boot: "LOADING" never visible before the sweep'));
  if (!seen.ready) fails.push(tag('boot: post-load "READY." never visible'));

  // Watch the rain for `ms`, extending (up to 6s more) until every column but one has painted. On a chunky
  // 7-row grid a column with a long trail (len up to 21) legitimately draws nothing for up to ~2.2s while the
  // trail drains, so a fixed short window flakes. A real dead strip never fills in, so it still fails.
  const paint = async (ms) => {
    S.resetStats(); await step(ms); let d = await dims();
    for (let i = 0; i < 3 && S.cw && S.cols.size < Math.floor(d.F.cvs.w / S.cw) - 1; i++) { await step(2000); d = await dims(); }
    return d;
  };
  // rain: layout assertions against FRESH rects
  const dRain = await paint(3000);
  let r1 = assertLayout(tag('rain'), dRain.F, S, c.kind === 'phone'); fails.push(...r1.bad);
  info.rain = { cols: r1.cols, rows: r1.rows, cellW: +S.cw.toFixed(2), cellH: +S.ch.toFixed(2), glyphPx: Math.floor(S.cw * 0.86) };

  // simulated rotation, twice (portrait -> landscape -> portrait), asserting after each settle
  for (const [i, [w, h]] of [[c.h, c.w], [c.w, c.h]].entries()) {
    await page.setViewportSize({ width: w, height: h }); S.vw = w; S.vh = h;
    await page.waitForTimeout(150);       // real time: let ResizeObserver deliver
    await step(200);
    const d = await paint(2500);
    const r = assertLayout(tag(i === 0 ? 'rotated' : 'rotated-back'), d.F, S, false); fails.push(...r.bad);
    info[i === 0 ? 'rotated' : 'back'] = { vp: `${w}x${h}`, cols: r.cols, rows: r.rows, cellW: +S.cw.toFixed(2), cellH: +S.ch.toFixed(2), canvas: `${d.F.cvs.w.toFixed(1)}x${d.F.cvs.h.toFixed(1)}` };
  }
  if (errs.length) fails.push(tag(`console/page errors: ${errs.slice(0, 2).join(' | ')}`));

  if (EXPECT_DESKTOP && c.kind === 'desktop' && c.w >= 1024 && c.h >= 600) {
    const rr = info.rain;
    if (!(rr.cols >= 14 && rr.cols <= 18)) fails.push(tag(`DESKTOP TARGET: ${rr.cols} columns (want 14-18)`));
    if (!(rr.cellW >= 55)) fails.push(tag(`DESKTOP TARGET: cell ${rr.cellW}px (want >= 55)`));
  }
  await ctx.close();
  return { fails, info };
}

const results = []; let totalFails = 0;
for (const eng of ENGINES) {
  const bt = await (eng === 'webkit' ? webkit : chromium).launch(eng === 'webkit' ? { executablePath: WK } : {});
  for (const c of cases) for (const dpr of DPRS) {
    const t0 = Date.now(); let r;
    try { r = await runCase(bt, eng, c, dpr); } catch (e) { r = { fails: [`${eng} ${c.w}x${c.h}@${dpr}x CRASH: ${String(e).slice(0, 200)}`], info: {} }; }
    totalFails += r.fails.length; results.push({ eng, ...c, dpr, ...r });
    const i = r.info, b = i.boot || {}, ra = i.rain || {};
    console.log(`${r.fails.length ? 'FAIL' : ' ok '} ${eng.padEnd(8)} ${String(c.w).padStart(4)}x${String(c.h).padEnd(4)} @${dpr}x  rain ${String(ra.cols ?? '?').padStart(2)}c x${String(ra.rows ?? '?').padStart(2)}r cell ${ra.cellW ?? '?'}x${ra.cellH ?? '?'}  hdrRows ${i.headerRows ?? '?'}  rot ${i.rotated ? i.rotated.cols + 'c/' + i.rotated.rows + 'r' : '?'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    for (const f of r.fails) console.log('       - ' + f);
  }
  await bt.close();
}
server.close();
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
console.log(`\n${results.length} cases, ${totalFails} failure line(s)`);
process.exit(totalFails ? 1 : 0);
