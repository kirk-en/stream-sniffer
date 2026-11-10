// Commercial detection from the picture: finds the overlays that stay on screen during the game
// (the scorebug, the network logo) and calls a commercial break when they're all gone.
//
// The method is Comskip's logo detection: a graphic laid over the game stays put while the game
// moves under it, so its outline (its edges) is in the same place frame after frame. Each frame
// is shrunk to W x H, turned into an edge map, and a slow running average of the edge maps says
// which pixels have had an edge nearly all the time. Clusters of those, in the corners or along
// the top or bottom, are learned as overlays. After that, each frame is checked for each learned
// overlay's outline.
//
// Plain JavaScript, no dependencies, no DOM: the player runs it in a worker (detector-worker.js)
// and the tests run it in Node.
'use strict';

(() => {
  const W = 384;
  const H = 216;
  const N = W * H;

  const EDGE_T = 40; // luma step that counts as an edge
  const PERSIST_TAU_S = 15; // the running average of edges forgets over about this long
  const PERSIST_T = 0.7; // an edge this much of the time is part of an overlay
  const DISCOVER_EVERY_S = 2;
  const CONFIRM_SIGHTINGS = 3; // a cluster found this many times running becomes an overlay
  const PRESENT_T = 0.35; // match score at or above: the overlay is on screen
  const ABSENT_T = 0.2; // below: it's gone (in between: as it was)
  const LEARN_S = 40; // how long learning runs after it's asked for (see relearn)
  // When the detection is too shaky to trust (see health): it stops calling breaks until relearned.
  const CHECK_S = 10; // after learning, each overlay is watched this long...
  const WEAK_T = 0.4; // ...and has to match at least this well on average
  const FLICKER_MAX = 8; // seen/gone changes in a minute that make an overlay untrustworthy
  const SHORT_BREAK_S = 20; // real ad breaks are longer than this...
  const SHORT_BREAKS_MAX = 2; // ...and this many shorter ones within 10 min means it's misreading
  const FORGET_AFTER_S = 15 * 60; // an overlay gone this long is forgotten (new channel, say)
  // A site's watermark: a logo that stays through breaks. Judged on stretches without the
  // scorebug that are break-length (a replay is shorter; halftime, with the network's logo up
  // in the studio, is longer): a logo there 90% of each of WATERMARK_BREAKS of them, and gone
  // through none, is the site's, not the network's.
  const BREAK_MIN_S = 60;
  const BREAK_MAX_S = 300;
  const WATERMARK_BREAKS = 3;

  // Where overlays are looked for: the top and bottom bands, and the four corners.
  const zone = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = x / W;
      const fy = y / H;
      const corner = (fx < 0.28 || fx > 0.72) && (fy < 0.25 || fy > 0.75);
      zone[y * W + x] = fy < 0.18 || fy > 0.7 || corner ? 1 : 0;
    }
  }

  function placeOf(b) {
    const cx = (b.x + b.w / 2) / W;
    const cy = (b.y + b.h / 2) / H;
    return `${cy < 0.5 ? 'top' : 'bottom'}-${cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'middle'}`;
  }
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = ix * iy;
    return inter / (a.w * a.h + b.w * b.h - inter);
  };
  // The pixels of an overlay's box well away from its outline (more than 2 px): inside a graphic
  // they're flat panel, so with the overlay on screen they have no edges.
  function farFrom(mask, w, h) {
    const far = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) {
          const rr = r + dy;
          if (rr < 0 || rr >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const cc = c + dx;
            if (cc >= 0 && cc < w && mask[rr * w + cc]) {
              near = true;
              break;
            }
          }
        }
        far[r * w + c] = near ? 0 : 1;
      }
    }
    return far;
  }
  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`);

  class Analyzer {
    constructor(options = {}) {
      this.y = new Uint8Array(N);
      this.hist = new Float32Array(16);
      this.prevHist = new Float32Array(16);
      this.edge = new Uint8Array(N);
      this.grad = new Uint8Array(N); // edge strength, for matching (see match)
      this.persist = new Float32Array(N);
      this.solid = new Uint8Array(N);
      this.grown = new Uint8Array(N);
      this.label = new Int32Array(N);
      this.queue = new Int32Array(N);
      this.options = { missingS: 4, returnS: 2, ...options };
      this.reset();
    }

    setOptions(o) {
      Object.assign(this.options, o);
    }

    reset() {
      this.persist.fill(0);
      this.overlays = []; // learned: { id, kind, place, box, mask, count, present, ... }
      this.candidates = []; // seen, not yet confirmed: { box, mask, count, kind, sightings }
      this.nextId = 1;
      this.t = 0; // seconds of video analyzed
      this.lastDiscover = -Infinity;
      this.hasPrev = false;
      this.state = 'learning';
      this.goneFor = 0; // every overlay gone, for this long
      this.backFor = 0; // some overlay back, for this long
      this.breakStart = 0;
      this.blacks = []; // times of black frames
      this.cuts = []; // times of scene cuts
      this.bugGone = null; // the current stretch without the scorebug: { length, logos: Map(logo -> time present) }
      this.learnUntil = 0; // new overlays are learned only until this time (see relearn)
      this.learnEndNoted = true;
      this.watermarks = []; // boxes of logos found to be a site's watermark, kept across relearning
      this.before = null; // what was learned before the current learning (see cancelLearning)
      this.pendingEvents = []; // said with the next frame's result
      this.clearHealth();
    }

    // Learns the overlays afresh, for the next LEARN_S seconds of video. Nothing is learned
    // otherwise: only the viewer knows the game is on (not a break, a replay, or halftime). The
    // running average of edges keeps going all along, so overlays that were already steady are
    // found within seconds. Watermarks already found stay ignored.
    relearn() {
      // What was learned before, for cancelLearning. A second Learn mid-learning keeps the first's.
      if (this.t >= this.learnUntil) this.before = { overlays: this.overlays, unreliable: this.unreliable, checkUntil: this.checkUntil };
      this.overlays = [];
      this.candidates = [];
      this.state = 'learning';
      this.goneFor = 0;
      this.bugGone = null;
      this.learnUntil = this.t + LEARN_S;
      this.learnEndNoted = false;
      this.clearHealth();
    }

    // Stops learning early and drops what it found: the viewer saw the game wasn't on (a
    // commercial came) after pressing Learn. Goes back to what was learned before, if anything.
    cancelLearning() {
      if (this.t >= this.learnUntil) return;
      const before = this.before ?? { overlays: [], unreliable: '', checkUntil: null };
      this.before = null;
      this.learnUntil = this.t;
      this.learnEndNoted = true;
      this.candidates = [];
      this.overlays = before.overlays;
      this.goneFor = 0;
      this.bugGone = null;
      this.clearHealth();
      this.unreliable = before.unreliable;
      this.checkUntil = before.checkUntil;
      this.state = 'learning'; // the next frame moves on from here, as after learning
      this.skipCheck = true; // they were checked when learned; now (in a break) they'd look weak
      for (const o of this.overlays) o.flips = [];
      this.pendingEvents.push(
        this.overlays.length
          ? `learning cancelled: back to the ${this.overlays.filter((o) => !o.watermark).map((o) => this.describe(o)).join(' and the ')} learned before`
          : 'learning cancelled: nothing kept. Press Learn when normal play is back',
      );
    }

    clearHealth() {
      this.unreliable = ''; // why the detection isn't trusted, or ''
      this.checkUntil = null; // the end of the check after learning
      this.checkScores = new Map(); // overlay -> { sum, n } during that check
      this.shortBreaks = []; // times of breaks shorter than SHORT_BREAK_S
    }

    // Decides whether the detection can be trusted. Shaky detection is worse than none: it would
    // call breaks that aren't there. Once untrusted, it stays so until relearned.
    health(watched) {
      if (this.unreliable) return;
      for (const o of watched) {
        while (o.flips.length && o.flips[0] < this.t - 60) o.flips.shift();
        if (o.flips.length >= FLICKER_MAX) {
          this.unreliable = `the ${this.describe(o)} kept flickering between seen and gone (${o.flips.length} times in a minute)`;
          return;
        }
      }
      if (this.checkUntil == null) return;
      if (this.t < this.checkUntil) {
        for (const o of watched) {
          const c = this.checkScores.get(o) ?? { sum: 0, n: 0 };
          c.sum += o.score;
          c.n++;
          this.checkScores.set(o, c);
        }
        return;
      }
      this.checkUntil = null;
      for (const o of watched) {
        const c = this.checkScores.get(o);
        const avg = c ? c.sum / c.n : 0;
        if (avg < WEAK_T) {
          this.unreliable = `the ${this.describe(o)} only matched weakly after learning (average ${avg.toFixed(2)}; it needs ${WEAK_T} or more)`;
          return;
        }
      }
    }

    // One frame: rgba is W x H x 4 bytes; dt is the seconds of video since the last frame.
    push(rgba, dt) {
      this.t += dt;
      const { y, edge } = this;
      let sum = 0;
      let bright = 0;
      for (let i = 0, j = 0; i < N; i++, j += 4) {
        const v = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
        y[i] = v;
        sum += v;
        if (v > 40) bright++;
      }
      const black = sum / N < 18 && bright < N * 0.02;
      if (black) this.blacks.push(this.t);
      // A scene cut: the mix of dark and light changes at once. Comparing the mix, not the
      // pixels, means a camera pan (the same scene, moved) isn't taken for a cut.
      const { hist, prevHist } = this;
      hist.fill(0);
      for (let i = 0; i < N; i += 3) hist[y[i] >> 4]++;
      let mixChange = 0;
      for (let b = 0; b < 16; b++) {
        hist[b] /= N / 3;
        mixChange += Math.abs(hist[b] - prevHist[b]);
      }
      const cut = this.hasPrev && mixChange > 0.6;
      if (cut) this.cuts.push(this.t);
      prevHist.set(hist);
      this.hasPrev = true;
      const keep = (list) => {
        while (list.length && list[0] < this.t - 60) list.shift();
      };
      keep(this.blacks);
      keep(this.cuts);

      // Edges, and their running average.
      edge.fill(0);
      const grad = this.grad;
      const k = Math.min(1, dt / PERSIST_TAU_S);
      const p = this.persist;
      for (let r = 1; r < H - 1; r++) {
        for (let c = 1, i = r * W + 1; c < W - 1; c++, i++) {
          const g = Math.abs(y[i + 1] - y[i - 1]) + Math.abs(y[i + W] - y[i - W]);
          const e = g > EDGE_T ? 1 : 0;
          edge[i] = e;
          grad[i] = g > 255 ? 255 : g;
          p[i] += (e - p[i]) * k;
        }
      }

      const events = this.pendingEvents.splice(0);
      if (this.t - this.lastDiscover >= DISCOVER_EVERY_S) {
        this.lastDiscover = this.t;
        this.discover(events);
      }
      for (const o of this.overlays) this.check(o, dt);
      this.forget(events);
      this.spotWatermarks(dt, events);
      const change = this.decide(dt);
      if (!this.learnEndNoted && this.t >= this.learnUntil) {
        this.learnEndNoted = true;
        const missing = this.missing(this.overlays.filter((o) => !o.watermark));
        events.push(missing
          ? `learning ended without finding ${missing}. Press Learn again during normal play, with the scorebug and the network logo on screen`
          : 'learning done');
      }
      return {
        t: this.t,
        state: this.state,
        black,
        cut,
        change,
        events,
        overlays: this.overlays.map((o) => ({
          id: o.id,
          kind: o.kind,
          place: o.place,
          // As fractions of the picture, for drawing over the video.
          box: { x: o.box.x / W, y: o.box.y / H, w: o.box.w / W, h: o.box.h / H },
          present: o.present,
          score: Math.round(o.score * 100) / 100,
          watermark: o.watermark,
        })),
        learning: this.candidates.map((c) => ({ kind: c.kind, sightings: c.sightings })),
        learnLeft: Math.max(0, this.learnUntil - this.t), // seconds of learning left
        unreliable: this.unreliable, // why it isn't trusted (state 'unsure'), or ''
        waitingFor: this.waitingFor ?? '',
      };
    }

    // Finds clusters of steady edges in the overlay zones.
    discover(events) {
      const { persist, solid, grown, label, queue } = this;
      for (let i = 0; i < N; i++) solid[i] = zone[i] && persist[i] > PERSIST_T ? 1 : 0;
      // Grow each steady pixel (more sideways, to join a graphic's letters into one), so a
      // graphic's pieces form one cluster.
      grown.fill(0);
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          if (!solid[r * W + c]) continue;
          for (let dy = -3; dy <= 3; dy++) {
            const rr = r + dy;
            if (rr < 0 || rr >= H) continue;
            for (let dx = -6; dx <= 6; dx++) {
              const cc = c + dx;
              if (cc >= 0 && cc < W) grown[rr * W + cc] = 1;
            }
          }
        }
      }
      label.fill(0);
      const found = [];
      let next = 1;
      for (let s = 0; s < N; s++) {
        if (!grown[s] || label[s]) continue;
        let head = 0;
        let tail = 0;
        queue[tail++] = s;
        label[s] = next;
        let x0 = W, y0 = H, x1 = -1, y1 = -1, count = 0;
        while (head < tail) {
          const i = queue[head++];
          const c = i % W;
          const r = (i - c) / W;
          if (solid[i]) {
            count++;
            if (c < x0) x0 = c;
            if (c > x1) x1 = c;
            if (r < y0) y0 = r;
            if (r > y1) y1 = r;
          }
          if (c > 0 && grown[i - 1] && !label[i - 1]) (label[i - 1] = next), (queue[tail++] = i - 1);
          if (c < W - 1 && grown[i + 1] && !label[i + 1]) (label[i + 1] = next), (queue[tail++] = i + 1);
          if (r > 0 && grown[i - W] && !label[i - W]) (label[i - W] = next), (queue[tail++] = i - W);
          if (r < H - 1 && grown[i + W] && !label[i + W]) (label[i + W] = next), (queue[tail++] = i + W);
        }
        next++;
        if (count < 30) continue;
        const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
        if (box.w < 6 || box.h < 4 || box.h > H * 0.3) continue;
        const cy = (y0 + y1) / 2 / H;
        const wide = box.w >= W * 0.22;
        const inBand = cy < 0.18 || cy > 0.7;
        const kind = wide && inBand ? 'scorebug' : !wide && box.w < W * 0.3 ? 'logo' : null;
        if (!kind) continue;
        // A logo has to sit in a corner; a long thin line (a field marking) isn't one.
        if (kind === 'logo') {
          const cx = (x0 + x1) / 2 / W;
          if (!((cx < 0.28 || cx > 0.72) && (cy < 0.25 || cy > 0.75))) continue;
        }
        if (count / (box.w * box.h) < 0.04) continue; // too sparse to be a graphic
        const mask = new Uint8Array(box.w * box.h);
        for (let r = 0; r < box.h; r++) for (let c = 0; c < box.w; c++) mask[r * box.w + c] = solid[(box.y + r) * W + box.x + c];
        found.push({ kind, box, mask, count });
      }

      for (const f of found) {
        // Known: follow its changes (a scorebug that grew a "down & distance" panel) while it's
        // on screen.
        const known = this.overlays.find((o) => o.kind === f.kind && iou(o.box, f.box) > 0.3);
        if (known) {
          // Only while it's clearly there (a moment's flicker in a break would swap in noise), and
          // only for an outline at least about as full: after a break the running average has
          // forgotten most of it, and a part would replace the whole.
          if (known.present && known.backFor >= 5 && known.score >= 0.6 && f.count >= known.count * 0.8) Object.assign(known, { box: f.box, mask: f.mask, far: farFrom(f.mask, f.box.w, f.box.h), count: f.count, place: placeOf(f.box) });
          continue;
        }
        // New ones only while learning was asked for, and never in a break (an ad's own steady
        // graphic would end it), and not a watermark already found.
        if (this.t >= this.learnUntil || this.state === 'commercial') continue;
        if (f.kind === 'logo' && this.watermarks.some((b) => iou(b, f.box) > 0.3)) continue;
        const cand = this.candidates.find((c) => c.kind === f.kind && iou(c.box, f.box) > 0.3);
        if (!cand) {
          this.candidates.push({ ...f, sightings: 1, seenAt: this.t });
          continue;
        }
        Object.assign(cand, { box: f.box, mask: f.mask, count: f.count, seenAt: this.t });
        if (++cand.sightings < CONFIRM_SIGHTINGS) continue;
        this.candidates.splice(this.candidates.indexOf(cand), 1);
        this.learn(cand, events);
      }
      // Candidates not seen this time start over.
      this.candidates = this.candidates.filter((c) => c.seenAt === this.t);
    }

    learn(c, events) {
      const o = {
        id: this.nextId++,
        kind: c.kind,
        place: placeOf(c.box),
        box: c.box,
        mask: c.mask,
        far: farFrom(c.mask, c.box.w, c.box.h),
        count: c.count,
        present: true,
        score: 1,
        goneFor: 0,
        backFor: 0,
        watermark: false,
        flips: [], // times it changed between seen and gone, for the last minute
        stayedThrough: 0, // break-length stretches without the scorebug this logo stayed through
        leftDuring: 0, // and ones it went during
      };
      if (o.kind === 'scorebug') {
        // One scorebug: a bigger one replaces a smaller (a ticker below it, say, is ignored).
        const old = this.overlays.find((x) => x.kind === 'scorebug');
        if (old && old.box.w * old.box.h >= o.box.w * o.box.h) return;
        if (old) this.overlays.splice(this.overlays.indexOf(old), 1);
      } else if (this.overlays.some((x) => x.kind === 'logo' && x.place === o.place)) {
        return; // one logo per corner
      }
      this.overlays.push(o);
      events.push(`learned the ${this.describe(o)} (${Math.round((o.box.w / W) * 100)}% x ${Math.round((o.box.h / H) * 100)}% of the picture)`);
    }

    describe(o) {
      return o.kind === 'scorebug' ? `scorebug (${o.place})` : `logo (${o.place})`;
    }

    // How strong the frame's edges are along an overlay's outline, against how strong they are in
    // the rest of its box (its flat panel). With the overlay on screen, its outline is sharp and
    // its panel smooth (a see-through panel shows the game only faintly). Without it, the same
    // game is under both, busy or calm, and they come out about even. The score runs from -1 to
    // 1: near 1 on screen, near 0 gone. A small graphic with no flat part (a logo) is compared
    // with a ring of picture just outside its box instead.
    match(o) {
      const { grad } = this;
      const { box, mask, far } = o;
      // The strongest edge within a pixel: the outline can wobble by one with scaling.
      const peak = (x, y) => {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < W && grad[yy * W + xx] > m) m = grad[yy * W + xx];
          }
        }
        return m;
      };
      let line = 0;
      let n = 0;
      let rest = 0;
      let nRest = 0;
      for (let r = 0; r < box.h; r++) {
        for (let c = 0; c < box.w; c++) {
          const i = r * box.w + c;
          if (mask[i]) {
            n++;
            line += peak(box.x + c, box.y + r);
          } else if (far[i]) {
            nRest++;
            rest += peak(box.x + c, box.y + r);
          }
        }
      }
      if (!n) return 0;
      // The ring: 3 to 5 px outside the box, inside the picture.
      let ring = 0;
      let nRing = 0;
      for (let y = box.y - 5; y < box.y + box.h + 5; y++) {
        if (y < 0 || y >= H) continue;
        for (let x = box.x - 5; x < box.x + box.w + 5; x++) {
          if (x < 0 || x >= W) continue;
          const out = Math.max(box.x - x, x - (box.x + box.w - 1), box.y - y, y - (box.y + box.h - 1));
          if (out < 3) continue;
          nRing++;
          ring += peak(x, y);
        }
      }
      if (!nRing && !nRest) return 0;
      // Compared with the panel and the ring alike, when there's enough panel to go by: no cut-off
      // to flip between, which a few pixels' difference in scaling would cross.
      const b = nRest >= 20 && nRing ? (rest / nRest + ring / nRing) / 2 : nRing ? ring / nRing : rest / nRest;
      const a = line / n;
      // A flat, dark moment (a fade) has no edges anywhere: that's not the overlay being there.
      if (a < EDGE_T) return Math.min(0, (a - b) / (a + b + 1));
      return (a - b) / (a + b + 1);
    }

    check(o, dt) {
      // Smoothed over about a second: one odd frame (a white logo over a white jersey, a
      // pattern that happens to line up with the outline) doesn't flip it.
      o.score = o.score * 0.5 + this.match(o) * 0.5;
      const was = o.present;
      if (o.score >= PRESENT_T) o.present = true;
      else if (o.score < ABSENT_T) o.present = false;
      if (o.present !== was) o.flips.push(this.t);
      if (o.present) {
        o.goneFor = 0;
        o.backFor = was ? o.backFor + dt : dt;
      } else {
        o.backFor = 0;
        o.goneFor = was ? dt : o.goneFor + dt;
      }
    }

    forget(events) {
      for (const o of [...this.overlays]) {
        if (o.goneFor < FORGET_AFTER_S) continue;
        this.overlays.splice(this.overlays.indexOf(o), 1);
        events.push(`forgot the ${this.describe(o)}: gone for ${fmt(o.goneFor)}`);
      }
    }

    // Spots a site's watermark (see BREAK_MIN_S): it would otherwise keep a break from ever
    // being called.
    spotWatermarks(dt, events) {
      const bug = this.overlays.find((o) => o.kind === 'scorebug');
      if (!bug) return;
      // Gone until it's been back 3 s: a moment's flicker doesn't end the stretch.
      if (!bug.present || bug.backFor < 3) {
        this.bugGone ??= { length: 0, logos: new Map() };
        this.bugGone.length += dt;
        for (const o of this.overlays) {
          if (o.kind === 'logo' && o.present) this.bugGone.logos.set(o, (this.bugGone.logos.get(o) ?? 0) + dt);
        }
        return;
      }
      const gone = this.bugGone;
      this.bugGone = null;
      if (!gone || gone.length < BREAK_MIN_S || gone.length > BREAK_MAX_S) return;
      for (const o of this.overlays) {
        if (o.kind !== 'logo' || o.watermark) continue;
        if ((gone.logos.get(o) ?? 0) >= gone.length * 0.9) o.stayedThrough++;
        else o.leftDuring++;
        if (o.stayedThrough >= WATERMARK_BREAKS && !o.leftDuring) {
          o.watermark = true;
          this.watermarks.push(o.box);
          events.push(`ignoring the ${this.describe(o)}: it stayed on screen through ${o.stayedThrough} breaks without the scorebug, so it's likely the site's watermark, not the network's logo`);
        }
      }
    }

    // What a break needs and doesn't have yet, or '' when breaks can be called. A break is only
    // called with both a scorebug and a network logo learned, and both gone.
    missing(watched) {
      const bug = watched.some((o) => o.kind === 'scorebug');
      const logo = watched.some((o) => o.kind === 'logo');
      if (!bug && !logo) return 'the scorebug and the network logo';
      if (!bug) return 'the scorebug';
      if (!logo) return 'the network logo';
      return '';
    }

    // is_commercial: everything watched (the scorebug and the network logo) gone for missingS
    // starts a break; any of them back for returnS ends it.
    decide(dt) {
      const watched = this.overlays.filter((o) => !o.watermark);
      this.health(watched);
      if (this.unreliable) {
        // No calls until relearned: say so once.
        if (this.state === 'unsure') return null;
        const was = this.state;
        this.state = 'unsure';
        this.goneFor = 0;
        return { to: 'unsure', from: was, reasons: [this.unreliable] };
      }
      const missing = this.missing(watched);
      this.waitingFor = missing;
      if (missing) {
        this.goneFor = 0;
        if (this.state === 'learning') return null;
        const was = this.state;
        this.state = 'learning';
        return { to: 'learning', from: was, reasons: [`no longer watching ${missing}`] };
      }
      if (this.state === 'learning') {
        this.state = 'game';
        if (!this.skipCheck) this.checkUntil = this.t + CHECK_S;
        this.skipCheck = false;
        this.checkScores = new Map();
        return { to: 'game', from: 'learning', reasons: [`watching the ${watched.map((o) => this.describe(o)).join(' and the ')}`] };
      }
      const allGone = watched.every((o) => !o.present);
      const back = watched.filter((o) => o.present && o.backFor >= this.options.returnS);
      if (this.state === 'game') {
        // Every one of them gone, each for the whole time: one still on screen resets the count.
        this.goneFor = allGone ? this.goneFor + dt : 0;
        if (this.goneFor < this.options.missingS) return null;
        this.state = 'commercial';
        this.breakStart = this.t - this.goneFor;
        const reasons = watched.map((o) => `${this.describe(o)} gone for ${fmt(o.goneFor)} (match ${o.score.toFixed(2)})`);
        const black = this.blacks.filter((t) => t >= this.t - this.goneFor - 10).length;
        if (black) reasons.push(`${black} black frame${black > 1 ? 's' : ''} around the change`);
        const cuts = this.cuts.filter((t) => t >= this.t - 30).length;
        if (cuts >= 5) reasons.push(`${cuts} scene cuts in the last 30 s (ads cut fast)`);
        return { to: 'commercial', from: 'game', reasons };
      }
      // In a break.
      if (!back.length) return null;
      this.state = 'game';
      this.goneFor = 0;
      const reasons = back.map((o) => `${this.describe(o)} back for ${fmt(o.backFor)} (match ${o.score.toFixed(2)})`);
      const lasted = this.t - this.breakStart - back[0].backFor;
      reasons.push(`the break lasted ${fmt(lasted)}`);
      if (lasted < SHORT_BREAK_S) {
        this.shortBreaks.push(this.t);
        this.shortBreaks = this.shortBreaks.filter((t) => t >= this.t - 600);
        if (this.shortBreaks.length >= SHORT_BREAKS_MAX) {
          this.unreliable = `${this.shortBreaks.length} "breaks" under ${SHORT_BREAK_S} s within 10 minutes; real ad breaks are longer`;
        }
      }
      return { to: 'game', from: 'commercial', reasons };
    }
  }

  globalThis.DetectorCore = { Analyzer, W, H };
})();
