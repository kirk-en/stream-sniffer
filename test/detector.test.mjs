// Tests for extension/detector-core.js, the picture-based commercial detector, on made-up frames:
// a busy, always-changing "game" with a scorebug and a network logo laid over it. No browser:
//   node test/detector.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(fs.readFileSync(path.join(here, '../extension/detector-core.js'), 'utf8'));
const { Analyzer, W, H } = globalThis.DetectorCore;

let failed = 0;
function assert(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

// A seeded random source, so every run sees the same frames.
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// The game: blocks of random gray, new and moved every frame (busier than any real
// picture, which also moves: a grid in the same place every frame would be a steady overlay).
function background(px) {
  // Blocks of a size that changes each frame: a fixed grid could line up with a graphic's
  // evenly spaced letters, which real pictures don't do frame after frame.
  const size = 5 + Math.floor(rand() * 7);
  const ox = Math.floor(rand() * size);
  const oy = Math.floor(rand() * size);
  for (let by = -oy; by < H; by += size) {
    for (let bx = -ox; bx < W; bx += size) {
      const v = Math.floor(rand() * 110) + 60; // about as busy as a crowd shot
      for (let y = Math.max(0, by); y < Math.min(H, by + size); y++) for (let x = Math.max(0, bx); x < Math.min(W, bx + size); x++) px(x, y, v);
    }
  }
}
// A graphic: a dark panel with light "text" bars in it.
function graphic(px, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const inText = (y - y0) % 8 >= 2 && (y - y0) % 8 <= 4 && (x - x0) % 12 >= 2 && (x - x0) % 12 <= 8;
      px(x, y, inText ? 235 : 25);
    }
  }
}
function frame({ bug = true, logo = true, watermark = false, black = false } = {}) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const px = (x, y, v) => {
    const j = (y * W + x) * 4;
    rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
    rgba[j + 3] = 255;
  };
  if (black) {
    for (let j = 3; j < rgba.length; j += 4) rgba[j] = 255;
    return rgba;
  }
  background(px);
  if (bug) graphic(px, 80, 180, 220, 22); // bottom middle
  if (logo) graphic(px, 330, 12, 36, 20); // top right
  if (watermark) graphic(px, 10, 190, 30, 14); // bottom left, never goes
  return rgba;
}

function run(a, seconds, opts, out = []) {
  for (let i = 0; i < seconds * 2; i++) {
    const r = a.push(frame(opts), 0.5);
    for (const e of r.events) out.push(`${r.t.toFixed(1)} ${e}`);
    if (r.change) out.push({ t: r.t, ...r.change });
    out.last = r;
  }
  return out;
}
const changes = (out) => out.filter((x) => typeof x === 'object');

// 1. Learning, a break, and the game coming back.
{
  const a = new Analyzer();
  const out = run(a, 60, {});
  const r = out.last;
  const bug = r.overlays.find((o) => o.kind === 'scorebug');
  const logo = r.overlays.find((o) => o.kind === 'logo');
  assert(!!bug && bug.place === 'bottom-middle', `learns the scorebug at the bottom (${bug?.place})`);
  assert(!!logo && logo.place === 'top-right', `learns the logo at the top right (${logo?.place})`);
  assert(r.overlays.length === 2, `and nothing else, over a busy picture (${r.overlays.length} overlays)`);
  assert(r.state === 'game' && bug.present && logo.present, `state game, both on screen (${r.state}, match ${bug.score} / ${logo.score})`);
  const learnedAt = changes(out).find((c) => c.to === 'game')?.t;
  assert(learnedAt < 45, `watching within 45 s of starting (${learnedAt} s)`);
  const box = bug.box;
  assert(Math.abs(box.x - 80 / W) < 0.02 && Math.abs(box.w - 220 / W) < 0.03, `the scorebug's box fits it (${JSON.stringify(box)})`);

  // A short dip (a replay wipe) isn't a break.
  run(a, 2, { bug: false, logo: false }, out);
  run(a, 3, {}, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'both gone for 2 s: not a break');

  const before = changes(out).length;
  run(a, 1, { black: true }, out);
  run(a, 30, { bug: false, logo: false }, out);
  const start = changes(out).slice(before).find((c) => c.to === 'commercial');
  assert(!!start, 'both gone: a break is called');
  // They went at 65 s (the black frame first). 4 s gone, plus about a second of smoothing.
  assert(start && start.t - 65 <= 6, `within a few seconds (${start && (start.t - 65).toFixed(1)} s after they went)`);
  assert(start?.reasons.some((x) => /scorebug \(bottom-middle\) gone/.test(x)) && start.reasons.some((x) => /logo \(top-right\) gone/.test(x)), `it says why: ${start?.reasons.join('; ')}`);
  assert(start?.reasons.some((x) => /black frame/.test(x)), 'and mentions the black frame');

  // Only the logo back (a network promo): ends the break too; only scorebug back: ends it.
  run(a, 4, { logo: false }, out);
  const end = changes(out).slice(before).find((c) => c.to === 'game');
  assert(!!end, 'the scorebug back: the game is back');
  assert(end?.reasons.some((x) => /scorebug \(bottom-middle\) back/.test(x)) && end.reasons.some((x) => /the break lasted/.test(x)), `it says why: ${end?.reasons.join('; ')}`);
}

// 2. The network logo still up while the scorebug is gone (a replay, halftime): not a break.
{
  const a = new Analyzer({ missingS: 4 });
  const out = run(a, 60, {});
  run(a, 30, { bug: false }, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'scorebug gone 30 s, logo still on screen: no break');
  run(a, 30, { logo: false }, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'logo gone 30 s, scorebug still on screen: no break');
  // Gone one after the other, never both for 4 s: still no break.
  for (let i = 0; i < 5; i++) {
    run(a, 3, { bug: false }, out);
    run(a, 3, { logo: false }, out);
  }
  assert(!changes(out).some((c) => c.to === 'commercial'), 'taking turns being gone, never both for 4 s: no break');
  run(a, 10, { bug: false, logo: false }, out);
  const brk = changes(out).find((c) => c.to === 'commercial');
  assert(!!brk, 'both gone: a break');
}

// 3. Only a scorebug (no logo learned): no break is called; it waits for the logo.
{
  const a = new Analyzer();
  const out = run(a, 60, { logo: false });
  assert(out.last.state === 'learning' && out.last.waitingFor === 'the network logo', `waits for the logo (${out.last.state}, waiting for ${out.last.waitingFor})`);
  run(a, 30, { bug: false, logo: false }, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'the scorebug gone with no logo learned: no break');
  const b = new Analyzer({ needBoth: false });
  const out2 = run(b, 60, { logo: false });
  run(b, 10, { bug: false, logo: false }, out2);
  assert(changes(out2).some((c) => c.to === 'commercial'), 'with needBoth off, the scorebug alone can call one');
}

// 4. A site's watermark that never leaves: ignored after it stays through 3 break-length
// stretches without the scorebug, while the network's logo goes in each.
{
  const a = new Analyzer();
  const out = run(a, 60, { watermark: true });
  assert(out.last.overlays.length === 3, `learns scorebug, logo and the watermark (${out.last.overlays.map((o) => o.place).join(', ')})`);
  for (let i = 0; i < 3; i++) {
    run(a, 70, { bug: false, logo: false, watermark: true }, out);
    run(a, 20, { watermark: true }, out);
  }
  assert(!changes(out).some((c) => c.to === 'commercial'), 'while the watermark counts, breaks are held back (it is still on screen)');
  const flagged = out.find((x) => typeof x === 'string' && /ignoring the logo \(bottom-left\)/.test(x));
  assert(!!flagged, `spots the watermark after 3 breaks: ${flagged}`);
  assert(!out.last.overlays.find((o) => o.place === 'top-right').watermark, "the network's logo isn't taken for a watermark");
  run(a, 10, { bug: false, logo: false, watermark: true }, out);
  assert(changes(out).some((c) => c.to === 'commercial'), 'then breaks are called');

  // Halftime: a long stretch without the scorebug, network logo up the whole time. Not a watermark.
  const h = new Analyzer();
  const out2 = run(h, 60, {});
  run(h, 600, { bug: false }, out2);
  run(h, 10, {}, out2);
  assert(!out2.last.overlays.some((o) => o.watermark), "10 min of halftime with the network's logo up: still not a watermark");
}

// 5. A break with no learning yet: nothing is called before anything is learned.
{
  const a = new Analyzer();
  const out = run(a, 20, { bug: false, logo: false });
  assert(!changes(out).length && out.last.state === 'learning', `no overlays yet: still learning (${out.last.state})`);
}

// 6. Cost: one frame's analysis, on this machine.
{
  const a = new Analyzer();
  run(a, 60, {});
  const f = frame({});
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) a.push(f, 0.5);
  const ms = (performance.now() - t0) / 40;
  console.log(`     analysis: ${ms.toFixed(2)} ms per frame (in the worker, not the main thread)`);
  assert(ms < 15, 'under 15 ms per frame');
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
