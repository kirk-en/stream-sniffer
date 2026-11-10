// The commercial detector in a real player: makes a video with a fake scorebug and network logo
// that vanish for a "commercial", plays it in Chrome with the extension, and checks that the
// break and the return are logged, with why. Also reports what the detector costs per look.
//   cd test && node detector-smoke.mjs        (HEADFUL=1 to watch it)
// Needs ffmpeg and the installed Chrome. Takes about 100 s: the video plays in real time.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '../extension');
const dir = path.join(here, 'fixtures/detector');
// The overlays go for a replay (the field stays), then for an ad (no field), then come back.
const REPLAY = [50, 60];
const GAME_END = 66; // the ad starts...
const BREAK_END = 81; // ...and ends
const LENGTH = 92;

let failed = 0;
function assert(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}

// A moving picture (testsrc2, scrolling, tinted green like a field) with a scorebug (a dark bar
// of light "text" blocks, bottom middle) and a logo (top right). Both go in the replay, which
// keeps the field, and in the ad, which is tinted red.
function makeVideo() {
  const stamp = path.join(dir, 'made-with.json');
  const madeWith = JSON.stringify({ REPLAY, GAME_END, BREAK_END, LENGTH, v: 2 });
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === madeWith) return;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const on = `enable='not(between(t,${REPLAY[0]},${REPLAY[1]})+between(t,${GAME_END},${BREAK_END}))'`;
  const boxes = [
    'hue=s=0,colorchannelmixer=rr=0.35:gg=0.9:bb=0.3', // the field's green
    `drawbox=x=0:y=0:w=iw:h=ih:color=0xd03020@0.75:t=fill:enable='between(t,${GAME_END},${BREAK_END})'`, // the ad
    `drawbox=x=300:y=610:w=680:h=64:color=black@0.85:t=fill:${on}`,
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `drawbox=x=${320 + i * 80}:y=628:w=56:h=28:color=white:t=fill:${on}`),
    `drawbox=x=1110:y=40:w=120:h=70:color=white@0.9:t=6:${on}`,
    `drawbox=x=1135:y=60:w=70:h=30:color=white@0.9:t=fill:${on}`,
  ].join(',');
  const r = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30,scroll=h=0.004:v=0.002,${boxes}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(LENGTH),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, 'seg%d.ts'),
    path.join(dir, 'index.m3u8'),
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  fs.writeFileSync(stamp, madeWith);
}

async function main() {
  makeVideo();
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(new URL(req.url, 'http://x').pathname));
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, {
      'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'access-control-allow-origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/index.m3u8`;

  const browser = await puppeteer.launch({ channel: 'chrome', headless: !process.env.HEADFUL, pipe: true, enableExtensions: [extDir] });
  try {
    await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 10000 });
    const ext = [...(await browser.extensions()).values()].find((e) => e.path === extDir);
    const [sw] = await ext.workers();
    await sw.evaluate(() => chrome.storage.local.set({ detect: { on: true, draw: true, field: true, log: true, missingS: 4 } }));
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`chrome-extension://${ext.id}/player.html?url=${encodeURIComponent(url)}`);

    // Each look's cost, and what's in the boxes, while the game plays with its overlays.
    const at = async (t) => page.waitForFunction((t) => document.querySelector('video.big')?.currentTime >= t, { timeout: (t + 30) * 1000, polling: 500 }, t);

    // Nothing is learned by itself: the Learn button at the top left starts it.
    await at(8);
    const idle = await page.evaluate(() => ({
      overlays: document.querySelectorAll('#overlay-boxes div').length,
      button: document.getElementById('learn-btn').textContent,
      shown: !document.getElementById('learn-btn').hidden,
      tip: document.getElementById('learn-btn').title,
    }));
    assert(idle.shown && /Learn scorebug/.test(idle.button) && /normal play/.test(idle.tip), `a Learn button is on screen, with a tip to use it in normal play ("${idle.button}")`);
    assert(idle.overlays === 0, `before it's pressed, nothing is learned (${idle.overlays} boxes at 8 s)`);
    await page.click('#learn-btn');
    await page.waitForFunction(() => /Learning…/.test(document.getElementById('learn-btn').textContent), { timeout: 5000 });
    const counting = await page.evaluate(() => ({ text: document.getElementById('learn-btn').textContent, tip: document.getElementById('learn-btn').title }));
    assert(/click to cancel/.test(counting.text) && /cancel/.test(counting.tip), `the countdown says it can be clicked to cancel ("${counting.text}")`);
    // A commercial came on, say: cancel.
    await page.click('#learn-btn');
    await page.waitForFunction(() => /Learn scorebug/.test(document.getElementById('learn-btn').textContent), { timeout: 5000 });
    await page.waitForFunction(() => /🛑 detector: learning cancelled/.test(document.getElementById('cue-list').textContent), { timeout: 5000 });
    assert(true, 'clicking the countdown cancels learning, and the log says so');
    await page.click('#learn-btn');
    await page.waitForFunction(() => /Learning…/.test(document.getElementById('learn-btn').textContent), { timeout: 5000 });
    console.log('     pressed Learn at 8 s, cancelled it, pressed it again');
    await at(GAME_END - 3);
    const during = await page.evaluate(() => ({
      boxes: [...document.querySelectorAll('#overlay-boxes div')].map((d) => `${d.classList.contains('gone') ? 'gone' : d.classList.contains('watermark') ? 'watermark' : 'present'}: ${d.textContent}`),
      status: document.getElementById('detect-status').textContent,
    }));
    console.log(`     boxes at ${GAME_END - 3} s: ${during.boxes.join(' | ')}`);
    console.log(`     status: ${during.status}`);
    assert(during.boxes.some((b) => /^present: scorebug/.test(b)), 'a green box on the scorebug');
    assert(during.boxes.some((b) => /^present: logo/.test(b)), 'a green box on the logo');

    // The field share, bottom right.
    const meter = await page.evaluate(() => {
      const m = document.getElementById('field-meter');
      const r = m.getBoundingClientRect();
      return { text: m.textContent, on: m.classList.contains('on'), shown: !m.hidden, right: innerWidth - r.right, bottom: innerHeight - r.bottom };
    });
    assert(meter.shown && /^🌱 \d+% · cut-off 30% · play \d+%$/.test(meter.text) && meter.on, `the field share shows at the bottom right ("${meter.text}", ${Math.round(meter.right)} px from the right, ${Math.round(meter.bottom)} px from the bottom)`);
    assert(meter.right < 40 && meter.bottom < 100, 'in the bottom right corner');
    const sug = await page.evaluate(() => ({
      hint: document.getElementById('field-suggest').textContent,
      tip: document.getElementById('field-suggest').title,
      marked: [...document.getElementById('detect-cutoff').options].filter((o) => /\(suggested\)/.test(o.textContent)).map((o) => ({ text: o.textContent, tip: o.title })),
    }));
    assert(/💡 Suggested: \d+%/.test(sug.hint) && /Suggested grass cut-off, based on the field sampled/.test(sug.tip), `a suggested cut-off next to the menu, with a tip on where it's from ("${sug.hint}")`);
    assert(sug.marked.length === 1 && /Suggested grass cut-off/.test(sug.marked[0].tip), `and one choice marked "(suggested)", with the same tip ("${sug.marked[0]?.text}")`);

    // The replay: both overlays gone, the field still there. Not a break.
    await at(REPLAY[1] - 1);
    const inReplay = await page.evaluate(() => ({ badge: document.getElementById('detect-state').textContent, log: document.getElementById('cue-list').textContent }));
    assert(/🏈 GAME/.test(inReplay.badge) && /🌱.*likely a replay/.test(inReplay.log), `in the replay (overlays gone, field on screen) it stays the game, and says why ("${inReplay.badge}")`);
    assert(/🌱 detector: field check on/.test(inReplay.log), "it learned the field's green while learning");

    await at(BREAK_END - 2);
    const badge = () => page.evaluate(() => document.getElementById('detect-state').textContent);
    const breakBadge = await badge();
    assert(/📺 COMMERCIAL/.test(breakBadge), `in the break, the log's badge says so ("${breakBadge}")`);
    const where = await page.evaluate(() => document.getElementById('cues').getBoundingClientRect().toJSON());
    assert(where.top < 100 && where.left < 100, `the ad-break log is at the top left (${Math.round(where.left)}, ${Math.round(where.top)})`);
    const adMeter = await page.evaluate(() => ({ text: document.getElementById('field-meter').textContent, on: document.getElementById('field-meter').classList.contains('on') }));
    assert(!adMeter.on && /^🌱 \d% /.test(adMeter.text), `in the ad, the field share drops and turns grey ("${adMeter.text}")`);
    const inBreak = await page.evaluate(() => [...document.querySelectorAll('#overlay-boxes div')].map((d) => d.className));
    assert(inBreak.length && inBreak.every((c) => c.split(' ').includes('gone')), `in the break, the boxes say gone (${inBreak.join(', ')})`);

    await at(BREAK_END + 6);
    const log = await page.evaluate(() => [...document.querySelectorAll('#cue-list li')].map((li) => li.textContent).reverse());
    for (const l of log) console.log(`     log: ${l}`);
    const start = log.find((l) => /📺 COMMERCIAL: is_commercial = true/.test(l));
    const end = log.find((l) => /🏈 GAME BACK: is_commercial = false/.test(l));
    const afterBadge = await badge();
    const btn = await page.evaluate(() => document.getElementById('learn-btn').textContent);
    assert(/Relearn/.test(btn), `once learned, the button offers Relearn ("${btn}")`);
    assert(/🏈 GAME/.test(afterBadge), `after it, the badge says the game ("${afterBadge}")`);
    const highlighted = await page.evaluate(() => [...document.querySelectorAll('#cue-list li.commercial, #cue-list li.game')].length);
    assert(highlighted === 2, `the two changes are highlighted lines (${highlighted})`);
    assert(!!start && /scorebug .* gone/.test(start) && /logo .* gone/.test(start), 'the break is logged, with the scorebug and logo gone as why');
    assert(!!start && /of the picture is field/.test(start), 'and with how little of the picture is field');
    assert(!!end && /back for/.test(end) && /the break lasted/.test(end), 'the return is logged, with what came back and how long the break was');
    const quality = await page.evaluate(() => {
      const q = document.querySelector('video.big').getVideoPlaybackQuality();
      return { totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames };
    });
    console.log(`     frames: ${quality.totalVideoFrames} shown, ${quality.droppedVideoFrames} dropped`);
    const status = await page.evaluate(() => document.getElementById('detect-status').textContent);
    console.log(`     status: ${status}`);
    // "Watch the picture" off: the settings under it, and the Learn button, go away.
    const offState = await page.evaluate(() => {
      const shown = (id) => !document.getElementById(id).hidden;
      const before = shown('detect-options');
      const box = document.getElementById('detect-on');
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      return { before, options: shown('detect-options'), learn: shown('learn-btn'), meter: shown('field-meter'), boxes: document.querySelectorAll('#overlay-boxes div').length };
    });
    assert(offState.before && !offState.options && !offState.learn && !offState.meter && !offState.boxes, `turning it off hides its settings, the Learn button and the boxes (${JSON.stringify(offState)})`);
    assert(!errors.length, `no page errors (${errors.join(' | ')})`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(
  () => {
    if (failed) {
      console.error(`\n${failed} failed`);
      process.exit(1);
    }
    console.log('\nall passed');
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
