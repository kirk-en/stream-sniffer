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
// An analyzer with learning started, as the player's Learn button does.
function learner(options) {
  const a = new Analyzer(options);
  a.relearn();
  return a;
}

let failed = 0;
const pct = (n) => `${Math.round(n * 100)}%`;
function assert(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

// A seeded random source, so every run sees the same frames.
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// The game: blocks of random gray, new and moved every frame (busier than any real
// picture, which also moves: a grid in the same place every frame would be a steady overlay).
function background(px, calm, look) {
  // Blocks of a size that changes each frame: a fixed grid could line up with a graphic's
  // evenly spaced letters, which real pictures don't do frame after frame.
  const size = 5 + Math.floor(rand() * 7);
  const ox = Math.floor(rand() * size);
  const oy = Math.floor(rand() * size);
  for (let by = -oy; by < H; by += size) {
    for (let bx = -ox; bx < W; bx += size) {
      // About as busy as a crowd shot; calm: a field, under a gentle camera.
      const v = calm ? Math.floor(rand() * 24) + 90 : Math.floor(rand() * 110) + 60;
      // pitch: shades of grass; ad: anything but green.
      const ADS = [[200, 40, 40], [40, 60, 200], [220, 200, 40], [160, 40, 160], [230, 230, 230]];
      const rgb = look === 'pitch' ? [v * 0.45, v + 30, v * 0.35] : look === 'ad' ? ADS[Math.floor(rand() * ADS.length)].map((c) => c * (0.6 + rand() * 0.4)) : null;
      for (let y = Math.max(0, by); y < Math.min(H, by + size); y++) for (let x = Math.max(0, bx); x < Math.min(W, bx + size); x++) px(x, y, v, rgb);
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
function frame({ bug = true, logo = true, watermark = false, team = false, calm = false, look = null, black = false } = {}) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const px = (x, y, v, rgb) => {
    const j = (y * W + x) * 4;
    if (rgb) [rgba[j], rgba[j + 1], rgba[j + 2]] = rgb.map((c) => Math.min(255, Math.max(0, c)));
    else rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
    rgba[j + 3] = 255;
  };
  if (black) {
    for (let j = 3; j < rgba.length; j += 4) rgba[j] = 255;
    return rgba;
  }
  background(px, calm, look);
  if (bug) graphic(px, 80, 180, 220, 22); // bottom middle
  if (logo) graphic(px, 330, 12, 36, 20); // top right
  if (watermark) graphic(px, 10, 12, 30, 14); // top left, never goes
  if (team) graphic(px, 20, 182, 30, 18); // a team's logo on the scorebug's row, left of it
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
  const a = learner();
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
  const a = learner({ missingS: 4 });
  const out = run(a, 60, {});
  run(a, 30, { bug: false }, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'scorebug gone 30 s, logo still on screen: no break');
  run(a, 30, { logo: false }, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'logo gone 30 s, scorebug still on screen: no break');
  // Gone one after the other, never both for 4 s: still no break.
  for (let i = 0; i < 2; i++) {
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
  const a = learner();
  const out = run(a, 60, { logo: false });
  assert(out.last.state === 'learning' && out.last.waitingFor === 'the network logo', `waits for the logo (${out.last.state}, waiting for ${out.last.waitingFor})`);
  run(a, 30, { bug: false, logo: false }, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'the scorebug gone with no logo learned: no break');
  const ended = out.find((x) => typeof x === 'string' && /learning ended without finding the network logo/.test(x));
  assert(!!ended, `when learning ends it says what it didn't find: ${ended}`);
}

// 4. A site's watermark that never leaves: ignored after it stays through 3 break-length
// stretches without the scorebug, while the network's logo goes in each.
{
  const a = learner();
  const out = run(a, 60, { watermark: true });
  assert(out.last.overlays.length === 3, `learns scorebug, logo and the watermark (${out.last.overlays.map((o) => o.place).join(', ')})`);
  for (let i = 0; i < 3; i++) {
    run(a, 70, { bug: false, logo: false, watermark: true }, out);
    run(a, 20, { watermark: true }, out);
  }
  assert(!changes(out).some((c) => c.to === 'commercial'), 'while the watermark counts, breaks are held back (it is still on screen)');
  const flagged = out.find((x) => typeof x === 'string' && /ignoring the logo \(top-left\)/.test(x));
  assert(!!flagged, `spots the watermark after 3 breaks: ${flagged}`);
  assert(!out.last.overlays.find((o) => o.place === 'top-right').watermark, "the network's logo isn't taken for a watermark");
  run(a, 10, { bug: false, logo: false, watermark: true }, out);
  assert(changes(out).some((c) => c.to === 'commercial'), 'then breaks are called');
  run(a, 10, { watermark: true }, out);
  a.relearn();
  run(a, 45, { watermark: true }, out);
  const kept = out.last.overlays.map((o) => o.place).sort().join(', ');
  assert(kept === 'bottom-middle, top-right', `after Learn again, the watermark isn't learned again (${kept})`);

  // Halftime: a long stretch without the scorebug, network logo up the whole time. Not a watermark.
  const h = learner();
  const out2 = run(h, 60, {});
  run(h, 600, { bug: false }, out2);
  run(h, 10, {}, out2);
  assert(!out2.last.overlays.some((o) => o.watermark), "10 min of halftime with the network's logo up: still not a watermark");
}

// 4b. A team's logo at the end of the scorebug isn't taken for the network's logo.
{
  const a = learner();
  const out = run(a, 60, { team: true });
  const places = out.last.overlays.map((o) => `${o.kind} ${o.place}`).sort().join(', ');
  assert(places === 'logo top-right, scorebug bottom-middle', `learns the scorebug and the network logo, not the team's logo (${places})`);
}

// 4c. Back from a break: both back is the best sign; one alone, if it matches clearly.
{
  const a = learner();
  const out = run(a, 60, {});
  run(a, 20, { bug: false, logo: false }, out);
  run(a, 4, {}, out);
  const both = changes(out).find((c) => c.to === 'game' && c.from === 'commercial');
  assert(!!both && both.reasons[0] === 'both back', `both back: the game is back (${both?.reasons.join('; ')})`);

  // Over a calmer picture, either one alone matches clearly.
  for (const [kind, opts] of [['logo', { bug: false, calm: true }], ['scorebug', { logo: false, calm: true }]]) {
    const b = learner();
    const out2 = run(b, 60, { calm: true });
    run(b, 20, { bug: false, logo: false, calm: true }, out2);
    run(b, 1.5, opts, out2);
    assert(!changes(out2).some((c) => c.to === 'game' && c.from === 'commercial'), `only the ${kind} back for 1.5 s: still a break`);
    run(b, 3, opts, out2);
    const one = changes(out2).find((c) => c.to === 'game' && c.from === 'commercial');
    assert(!!one && new RegExp(`only the ${kind} .* back, but clearly`).test(one.reasons[0]), `only the ${kind} back, clearly, for 2 s: the game is back (${one?.reasons.join('; ')})`);
  }
}

// 4d. The field: with both overlays gone, a picture still full of this game's green is a replay.
{
  const a = learner();
  const out = run(a, 45, { look: 'pitch' });
  const on = out.find((x) => typeof x === 'string' && /field check on/.test(x));
  assert(!!on && out.last.field?.baseline > 0.5, `learns the field's green while learning: ${on}`);
  run(a, 30, { bug: false, logo: false, look: 'pitch' }, out); // a replay
  assert(!changes(out).some((c) => c.to === 'commercial'), 'both gone 30 s over the field: not a break');
  const replay = out.find((x) => typeof x === 'string' && /likely a replay/.test(x));
  assert(!!replay, `and it says why: ${replay}`);
  run(a, 5, { look: 'pitch' }, out);
  run(a, 10, { bug: false, logo: false, look: 'ad' }, out); // an ad
  const brk = changes(out).find((c) => c.to === 'commercial');
  assert(!!brk && brk.reasons.some((x) => /only \d+% of the picture is field/.test(x)), `both gone over an ad: a break (${brk?.reasons.join('; ')})`);

  // The share: high on this field, near nothing on an ad.
  const b = learner();
  run(b, 45, { look: 'pitch' });
  const share = (look) => {
    for (let i = 0; i < 6; i++) b.push(frame({ look }), 0.5);
    return b.fieldShare;
  };
  assert(share('pitch') > 0.5 && share('ad') < 0.1, `field share: ${pct(share('pitch'))} on the pitch, ${pct(share('ad'))} on an ad`);

  // Learned over no field at all: the check stays off and says so.
  const c = learner();
  const out3 = run(c, 45, {});
  assert(out3.some((x) => typeof x === 'string' && /field check off/.test(x)) && !out3.last.field, 'learned over no field: the field check is off, and it says so');
}

// 4e. Learning the field: stops when done, from clean frames only, and suggests a cut-off.
{
  // Close-ups (no field) mixed in while learning are left out, not averaged in.
  const a = learner();
  const out = [];
  for (let i = 0; i < 30; i++) {
    run(a, 1, { look: 'pitch' }, out);
    run(a, 1, { look: i % 2 ? 'ad' : 'pitch', bug: true, logo: true }, out); // every other second: a close-up
  }
  const f = out.last.field;
  assert(f && f.baseline > 0.8, `close-ups while learning don't drag the field in play down (${pct(f?.baseline ?? 0)})`);
  const done = out.find((x) => typeof x === 'string' && /learning done in/.test(x));
  assert(!!done && parseFloat(done) < 40, `learning stops when it has the overlays and the field: ${done}`);
  assert(f.suggested === 0.5 && f.cutoff === 0.3, `suggests a cut-off of about half the field in play (${pct(f.suggested)}), and uses the chosen one (${pct(f.cutoff)})`);

  // The cut-off is the viewer's: one higher than a replay's field share calls it a break.
  const b = learner({ fieldCutoff: 1.01 }); // above any picture's share
  const out2 = run(b, 45, { look: 'pitch' });
  run(b, 10, { bug: false, logo: false, look: 'pitch' }, out2);
  assert(changes(out2).some((c) => c.to === 'commercial'), "with a cut-off above the replay's field share, it is a break");
}

// 4f. Raw output: what's seen now, and the countdown to a switch.
{
  const a = learner();
  const out = run(a, 45, { look: 'pitch' });
  const raw = out.last.raw;
  assert(raw.logo === true && raw.scorebug === true && raw.grass === true && !out.last.countdown, `in play: logo, scorebug and grass all seen, no countdown (${JSON.stringify(raw)})`);
  run(a, 2, { bug: false, logo: false, look: 'pitch' }, out);
  assert(out.last.raw.logo === false && out.last.raw.scorebug === false && out.last.countdown?.to === 'held', `overlays gone over the field: both false, held as a replay (${JSON.stringify(out.last.countdown)})`);
  run(a, 2, { bug: false, logo: false, look: 'ad' }, out);
  const c = out.last.countdown;
  assert(c?.to === 'commercial' && c.left > 0 && c.left < 4 && out.last.raw.grass === false, `over an ad: a countdown to the commercial (${c?.left.toFixed(1)} s left), grass false`);
  run(a, 10, { bug: false, logo: false, look: 'ad' }, out);
  run(a, 1, { look: 'pitch' }, out);
  const back = out.last.countdown;
  assert(back?.to === 'game' && back.left > 0 && back.left <= 2, `both back for a moment: a countdown to the game (${back?.left.toFixed(1)} s left)`);
  const fresh = new Analyzer().push(frame({}), 0.5).raw;
  assert(fresh.logo === null && fresh.scorebug === null && fresh.grass === null, 'before learning: nothing to say (null)');
}

// 5. Nothing is learned until Learn is pressed, and learning stops after 40 s.
{
  const a = new Analyzer();
  const out = run(a, 60, {});
  assert(out.last.overlays.length === 0 && out.last.state === 'learning' && out.last.learnLeft === 0, `60 s of game without pressing Learn: nothing learned (${out.last.overlays.length})`);
  a.relearn();
  const r = a.push(frame({}), 0.5);
  assert(r.learnLeft > 39, `Learn starts 40 s of learning (${r.learnLeft} s left)`);
  run(a, 10, {}, out);
  assert(out.last.overlays.length === 2 && out.last.state === 'game', `with the overlays already steady, it finds both within 10 s (${out.last.overlays.length}, ${out.last.state})`);
  run(a, 40, {}, out);
  assert(out.some((x) => typeof x === 'string' && /learning done/.test(x)) && out.last.learnLeft === 0, 'and says when learning is done');
}

// 5b. Learn pressed, then a commercial starts: cancelling drops what it found.
{
  // Nothing learned before: back to nothing.
  const a = new Analyzer();
  const out = run(a, 20, {});
  a.relearn();
  run(a, 3, {}, out);
  run(a, 5, { bug: false, logo: false }, out); // the commercial
  a.cancelLearning();
  run(a, 1, { bug: false, logo: false }, out);
  const said = out.find((x) => typeof x === 'string' && /learning cancelled: nothing kept/.test(x));
  assert(!!said && out.last.learnLeft === 0, `cancel stops learning and says so: ${said}`);
  run(a, 60, {}, out);
  assert(out.last.overlays.length === 0 && out.last.state === 'learning', `and nothing more is learned until Learn again (${out.last.overlays.length})`);

  // Learned well before: back to that, and the commercial is called with it.
  const b = learner();
  const out2 = run(b, 60, {});
  b.relearn(); // pressed again...
  run(b, 2, {}, out2);
  run(b, 2, { bug: false, logo: false }, out2); // ...and a commercial starts
  b.cancelLearning();
  run(b, 10, { bug: false, logo: false }, out2);
  const back = out2.find((x) => typeof x === 'string' && /learning cancelled: back to the/.test(x));
  assert(!!back, `cancel goes back to what was learned before: ${back}`);
  assert(changes(out2).some((c) => c.to === 'commercial') && !changes(out2).some((c) => c.to === 'unsure'), `that commercial is then called, with no "unreliable" (${changes(out2).map((c) => c.to).join(' -> ')})`);
}

// 6. Shaky detection: flagged, and no more breaks until relearned.
{
  // An overlay that keeps flickering.
  const a = learner();
  const out = run(a, 60, {});
  for (let i = 0; i < 6; i++) {
    run(a, 2, { logo: false }, out);
    run(a, 3, {}, out);
  }
  const flag = changes(out).find((c) => c.to === 'unsure');
  assert(!!flag && /flickering/.test(flag.reasons[0]), `a flickering logo is flagged: ${flag?.reasons[0]}`);
  run(a, 20, { bug: false, logo: false }, out);
  assert(!changes(out).some((c) => c.to === 'commercial'), 'and no break is called after that');
  a.relearn();
  run(a, 30, {}, out);
  assert(out.last.state === 'game', `Relearn clears it (${out.last.state})`);

  // Two breaks too short to be real.
  const b = learner();
  const out2 = run(b, 60, {});
  for (let i = 0; i < 2; i++) {
    run(b, 12, { bug: false, logo: false }, out2);
    run(b, 40, {}, out2);
  }
  const flag2 = changes(out2).find((c) => c.to === 'unsure');
  assert(!!flag2 && /under 20 s/.test(flag2.reasons[0]), `two 10 s "breaks" are flagged: ${flag2?.reasons[0]}`);

}

// 7. A break with no learning yet: nothing is called before anything is learned.
{
  const a = learner();
  const out = run(a, 20, { bug: false, logo: false });
  assert(!changes(out).length && out.last.state === 'learning', `no overlays yet: still learning (${out.last.state})`);
}

// 8. Cost: one frame's analysis, on this machine.
{
  const a = learner();
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
