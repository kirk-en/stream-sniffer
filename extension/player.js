const form = document.getElementById('form');
const problemsEl = document.getElementById('problems');
const streamsEl = document.getElementById('streams');
const menu = document.getElementById('menu');
const settingsBtn = document.getElementById('settings');
const removeSmallBtn = document.getElementById('remove-small');
const castStatus = document.getElementById('cast-status');
const resolutionEl = document.getElementById('resolution');
const params = new URLSearchParams(location.search);
const videos = [...document.querySelectorAll('video')];

// The streams on screen, big one first. The page shows at most two (one fills the tab, one
// floats small); background.js gives each stream its own header rule, with no fixed limit.
const MAX_STREAMS = 2;
let streams = [];
let pageError = ''; // a problem that isn't about one stream
const big = () => streams[0];
const streamOf = (video) => streams.find((s) => s.video === video);

const browserCodecs = {
  inflate: (b) => decompress(b, 'deflate'),
  gunzip: (b) => decompress(b, 'gzip'),
};
async function decompress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Each stream's requests can need their own Referer/Origin. The browser only applies them to
// hosts the stream has registered with background.js, so register each host before its first
// request.
async function allowHost(stream, url) {
  const host = new URL(url).hostname;
  if (stream.hosts.has(host)) return;
  const res = await chrome.runtime.sendMessage({ type: 'stream-host', streamId: stream.id, url });
  if (!res?.ok) throw new Error(`Could not set up request headers for ${host}: ${res?.error ?? 'no response from background'}`);
  stream.hosts.add(host);
}

// hls.js loader for every request of one stream: registers the host first (see allowHost), and
// decodes image-disguised segments (see disguise.js) before the demuxer sees them. A segment
// that's an image we can't decode fails loudly with the reason.
function loaderFor(stream) {
  return class extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      this.cancelled = false;
      allowHost(stream, context.url).then(
        () => {
          if (!this.cancelled) super.load(context, config, unwrapping(stream, callbacks));
        },
        (err) => {
          fail(stream, err.message);
          callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
        }
      );
    }
    abort() {
      this.cancelled = true;
      super.abort();
    }
  };
}

function unwrapping(stream, callbacks) {
  return {
    ...callbacks,
    onSuccess: (response, stats, ctx, details) => {
      // A "playlist" that isn't one (an HTML error page, an empty body) fails as a load error, so
      // hls.js retries it like any failed request. Playlist problems it skips are another matter
      // (see hlsLogger).
      if (typeof response.data === 'string' && !response.data.trimStart().startsWith('#EXTM3U')) {
        const text = response.data.replace(/\s+/g, ' ').trim();
        const sent = text ? `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"` : 'an empty body';
        return callbacks.onError({ code: response.code, text: `not a playlist (no #EXTM3U); server sent ${sent}` }, ctx, details, stats);
      }
      const bytes = response.data instanceof ArrayBuffer ? new Uint8Array(response.data) : null;
      if (!bytes || !StreamSnifferDisguise.isPng(bytes)) return callbacks.onSuccess(response, stats, ctx, details);
      StreamSnifferDisguise.decodeDisguisedSegment(bytes, browserCodecs).then(
        (ts) => {
          response.data = ts.buffer.slice(ts.byteOffset, ts.byteOffset + ts.byteLength);
          if (stream.unwrapped++ === 0) {
            stream.status += ' · segments are disguised as images; decoding them';
            render();
          }
          callbacks.onSuccess(response, stats, ctx, details);
        },
        (err) => {
          fail(stream, `Couldn't decode a segment: ${err.message}`);
          callbacks.onError({ code: 0, text: err.message }, ctx, details, stats);
        }
      );
    },
  };
}

// Some live CDNs put a fresh token in segment paths on every playlist refresh. hls.js calls
// that a "media sequence mismatch" and, with one quality level, stops the stream for good, while
// the site's own player carries on. So hls.js skips playlist problems
// (ignorePlaylistParsingErrors), and since it reports what it skipped only as a log warning, its
// warnings come here: each skipped problem is counted in the stream's status, and shown over
// the video if the stream stalls.
const PLAYLIST_PROBLEM = /sequence mismatch|EXTM3U|EXT-X-|Target Duration|no levels found/;
function hlsLogger(stream) {
  const quiet = () => {}; // hls.js's routine chatter, which it doesn't print by default either
  return {
    debug: quiet,
    log: quiet,
    info: quiet,
    warn: (...args) => {
      console.warn('[stream-sniffer] hls.js:', ...args);
      const text = args.map(String).join(' ');
      if (!PLAYLIST_PROBLEM.test(text)) return;
      stream.skipped++;
      // The message goes on to quote both playlists; the first line says what was wrong.
      stream.lastSkipped = `${new Date().toLocaleTimeString()}: ${text.split('\n')[0].slice(0, 200)}`;
      render();
    },
    error: (...args) => console.error('[stream-sniffer] hls.js:', ...args),
  };
}

function fail(stream, msg) {
  console.error('[stream-sniffer]', msg);
  stream.error = msg;
  render();
}

function failPage(msg) {
  console.error('[stream-sniffer]', msg);
  pageError = msg;
  render();
}

// Plays source in slot 0 (big) or 1 (small), replacing whatever was there.
async function startStream(source, slot) {
  const old = streams[slot];
  if (old) await stopStream(old);
  const video = old?.video ?? videos.find((v) => !streamOf(v));
  const stream = {
    id: crypto.randomUUID(),
    source,
    video,
    hls: null,
    hosts: new Set(),
    status: 'Loading…',
    error: '',
    bufferingSince: null,
    lastProblem: '',
    problemKind: null, // 'playlist' or 'segment': a later load of that kind ends lastProblem
    resumes: 0, // pauses undone (see the 'pause' listener)
    lastResume: '',
    resumedAt: 0, // performance.now()
    unwrapped: 0,
    autoMuted: false, // muted by us for the autoplay policy, not by the user
    casting: false,
    skipped: 0, // playlist problems hls.js skipped (see hlsLogger)
    lastSkipped: '',
    playingLevel: -1, // index into hls.levels of the picture on screen; -1 until the first one
    quality: -1, // the quality picked in the menu: an index into hls.levels, or -1 for Auto
  };
  streams[slot] = stream;
  pageError = '';
  layout();
  persist();
  if (slot === 0) fillForm();
  render();

  if (!Hls.isSupported()) return fail(stream, 'hls.js is not supported in this browser (no Media Source Extensions).');
  const res = await chrome.runtime.sendMessage({
    type: 'stream-headers',
    streamId: stream.id,
    referer: source.referer,
    origin: source.origin,
  });
  if (!streams.includes(stream)) return; // replaced while we waited
  if (!res?.ok) return fail(stream, `Could not set up request headers: ${res?.error ?? 'no response from background'}`);
  stream.status = `Loading… (${res.mode})`;
  render();

  const hls = (stream.hls = new Hls({
    loader: loaderFor(stream),
    ignorePlaylistParsingErrors: true,
    debug: hlsLogger(stream),
  }));
  hls.on(Hls.Events.ERROR, (_e, data) => {
    const code = data.response?.code;
    const why = data.response?.text ? ` (${data.response.text})` : parseProblem(data);
    const detail = `${data.type} / ${data.details}${why}${code ? ` — HTTP ${code}` : ''}${data.url ? ` — ${data.url}` : ''}${serverSent(data)}`;
    if (data.fatal) {
      stream.status = 'Stopped';
      // Keep a more specific message (e.g. from allowHost) if one is already showing.
      fail(stream, stream.error || `Playback failed: ${detail}`);
    } else {
      // hls.js retries these itself, but a stall with no explanation looks like a frozen
      // picture; show the latest one until playback is healthy again.
      console.warn('[stream-sniffer] non-fatal hls.js error:', detail);
      stream.lastProblem = `${new Date().toLocaleTimeString()}: ${detail} (retrying)`;
      stream.problemKind = /^(frag|key)Load/.test(data.details)
        ? 'segment'
        : /^(manifest|level|audioTrack|subtitleTrack)Load/.test(data.details)
          ? 'playlist'
          : null; // e.g. a stalled buffer: over when the video plays again
      render();
    }
  });
  // A retried load that then works ends the problem it showed.
  const recovered = (kind) => () => {
    if (stream.problemKind !== kind) return;
    stream.lastProblem = '';
    stream.problemKind = null;
    render();
  };
  hls.on(Hls.Events.FRAG_LOADED, recovered('segment'));
  for (const e of [Hls.Events.MANIFEST_LOADED, Hls.Events.LEVEL_LOADED, Hls.Events.AUDIO_TRACK_LOADED, Hls.Events.SUBTITLE_TRACK_LOADED]) {
    hls.on(e, recovered('playlist'));
  }
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    stream.status = `Playing · ${res.mode}${stream.unwrapped ? ' · segments are disguised as images; decoding them' : ''}`;
    render();
    startPlayback(stream);
  });
  // FRAG_CHANGED fires when a segment starts playing, so this is the quality on screen, not the
  // one being downloaded ahead.
  hls.on(Hls.Events.FRAG_CHANGED, (_e, { frag }) => {
    if (frag.level === stream.playingLevel) return;
    stream.playingLevel = frag.level;
    render();
  });
  hls.on(Hls.Events.LEVELS_UPDATED, () => render());
  hls.loadSource(source.url);
  hls.attachMedia(video);
}

// For a playlist hls.js couldn't parse: its reason ("no EXTM3U delimiter", "media sequence
// mismatch"...) and the start of what the server actually sent.
function parseProblem(data) {
  return /ParsingError$/.test(data.details) && data.reason ? ` (${data.reason})` : '';
}
function serverSent(data) {
  if (!/ParsingError$/.test(data.details)) return '';
  const xhr = data.networkDetails;
  // responseText throws for binary responses; playlists are loaded as text.
  if (!(xhr instanceof XMLHttpRequest) || !['', 'text'].includes(xhr.responseType)) return '';
  const text = xhr.responseText.replace(/\s+/g, ' ').trim();
  return ` — server sent ${text ? `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"` : 'an empty body'}`;
}

async function stopStream(s) {
  s.hls?.destroy();
  s.hls = null;
  s.video.removeAttribute('src');
  s.video.load();
  // The relay bridge still fetches through this stream's header rule while it casts.
  if (bridge?.stream === s && !bridge.stopped) return;
  const res = await chrome.runtime.sendMessage({ type: 'stream-remove', streamId: s.id });
  if (!res?.ok) failPage(`Could not remove the old stream's header rule: ${res?.error ?? 'no response from background'}`);
}

// Autoplay with sound needs a user gesture on this tab; fall back to muted and say so.
// The small picture is always muted: the sound follows the big one.
async function startPlayback(s) {
  const v = s.video;
  v.muted = s !== big();
  try {
    await v.play();
  } catch (err) {
    if (err.name !== 'NotAllowedError') return fail(s, `video.play() failed: ${err.message}`);
    v.muted = true;
    s.autoMuted = true;
    try {
      await v.play();
      s.status += ' · muted (autoplay policy), unmute with the speaker button';
      render();
    } catch (err2) {
      fail(s, `video.play() failed even muted: ${err2.message}`);
    }
  }
}

// Big and small trade places, and the sound moves to the new big picture. Neither reloads.
function swap() {
  if (streams.length < 2) return;
  const [oldBig, oldSmall] = streams;
  const sound = !oldBig.video.muted || oldBig.autoMuted;
  oldSmall.video.volume = oldBig.video.volume;
  streams = [oldSmall, oldBig];
  layout();
  oldBig.video.muted = true;
  oldSmall.video.muted = !sound;
  oldBig.autoMuted = oldSmall.autoMuted = false;
  for (const s of streams) {
    if (s.hls && s.video.paused) s.video.play().catch((err) => fail(s, `video.play() failed: ${err.message}`));
  }
  persist();
  fillForm();
  render();
}

// Which video element is big, which is small, and which is unused.
function layout() {
  for (const v of videos) {
    const i = streams.findIndex((s) => s.video === v);
    v.classList.toggle('big', i === 0);
    v.classList.toggle('small', i > 0);
    v.hidden = i === -1 || streams[i].casting;
    v.removeAttribute('style'); // the big one fills the tab; the small one is placed below
    if (i > 0) placeSmall(v);
  }
  placeRemoveBtn();
}

// The × sits inside the small picture's top-right, clear of the corner that resizes it.
function placeRemoveBtn() {
  const small = streams[1];
  removeSmallBtn.hidden = !small || small.casting;
  if (removeSmallBtn.hidden) return;
  const r = small.video.getBoundingClientRect();
  Object.assign(removeSmallBtn.style, { left: `${r.right - CORNER - 30}px`, top: `${r.top + 6}px` });
}
removeSmallBtn.addEventListener('click', async () => {
  const s = streams[1];
  if (!s) return;
  streams.splice(1, 1);
  layout();
  persist();
  render();
  await stopStream(s);
});

// The small picture can be dragged anywhere and resized from any corner (keeping its shape and
// the opposite corner). A press that doesn't move is a click, which swaps. Its place and size
// are remembered for every player tab; until it's first moved, the stylesheet places it.
const CORNER = 16; // px from a corner that grabs it for resizing
const MIN_WIDTH = 160;
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag, not a click
let smallBox = null; // { x, y, w } in px
chrome.storage.local
  .get('smallBox')
  .then(({ smallBox: saved }) => {
    if (saved) smallBox = saved;
    layout();
  })
  .catch((err) => failPage(`Couldn't read the small window's saved place: ${err.message}`));

const smallHeight = (w) => (w * 9) / 16;
function clampBox({ x, y, w }) {
  w = Math.max(MIN_WIDTH, Math.min(w, innerWidth - 16));
  const h = smallHeight(w);
  return { x: Math.max(0, Math.min(x, innerWidth - w)), y: Math.max(0, Math.min(y, innerHeight - h)), w };
}
function placeSmall(v) {
  if (!smallBox) return;
  const { x, y, w } = clampBox(smallBox);
  Object.assign(v.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, right: 'auto', bottom: 'auto', maxWidth: 'none' });
}
addEventListener('resize', layout);

// Which corner (if any) a point near the small video's edge grabs: [dx sign, dy sign].
function cornerAt(v, e) {
  const r = v.getBoundingClientRect();
  const left = e.clientX - r.left < CORNER;
  const right = r.right - e.clientX < CORNER;
  const top = e.clientY - r.top < CORNER;
  const bottom = r.bottom - e.clientY < CORNER;
  if ((left || right) && (top || bottom)) return [right ? 1 : -1, bottom ? 1 : -1];
  return null;
}

for (const v of videos) {
  let press = null;
  v.addEventListener('pointerdown', (e) => {
    if (!streamOf(v) || streamOf(v) === big() || e.button !== 0) return;
    const r = v.getBoundingClientRect();
    press = { x0: e.clientX, y0: e.clientY, box: { x: r.left, y: r.top, w: r.width }, corner: cornerAt(v, e), dragging: false };
    v.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  v.addEventListener('pointermove', (e) => {
    if (!press) {
      if (streamOf(v) && streamOf(v) !== big()) {
        const c = cornerAt(v, e);
        v.style.cursor = c ? (c[0] === c[1] ? 'nwse-resize' : 'nesw-resize') : 'grab';
      }
      return;
    }
    const dx = e.clientX - press.x0;
    const dy = e.clientY - press.y0;
    if (!press.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    press.dragging = true;
    const { box, corner } = press;
    if (!corner) {
      smallBox = clampBox({ x: box.x + dx, y: box.y + dy, w: box.w });
    } else {
      const w = Math.max(MIN_WIDTH, Math.min(box.w + corner[0] * dx, innerWidth - 16));
      smallBox = clampBox({
        x: corner[0] < 0 ? box.x + box.w - w : box.x,
        y: corner[1] < 0 ? box.y + smallHeight(box.w) - smallHeight(w) : box.y,
        w,
      });
    }
    placeSmall(v);
    placeRemoveBtn();
  });
  v.addEventListener('pointerup', () => {
    if (!press) return;
    const dragged = press.dragging;
    press = null;
    if (!dragged) return swap();
    chrome.storage.local.set({ smallBox }).catch((err) => failPage(`Couldn't save the small window's place: ${err.message}`));
  });
  v.addEventListener('pointercancel', () => (press = null));
  // Buffering and recent stream problems show over the video so a stall is never silent.
  v.addEventListener('waiting', () => {
    const s = streamOf(v);
    if (!s) return;
    s.bufferingSince ??= new Date().toLocaleTimeString();
    render();
  });
  v.addEventListener('playing', () => {
    const s = streamOf(v);
    if (!s) return;
    s.bufferingSince = null;
    s.lastProblem = '';
    s.problemKind = null;
    render();
  });
  // These are live streams, so they just play: a pause (the controls, the browser) is undone at
  // once and noted in the status. One that comes right back after a resume is reported, not
  // fought in a loop.
  v.addEventListener('pause', () => {
    const s = streamOf(v);
    if (!s?.hls || v.ended) return; // stopped or replaced on purpose, or the end of a video
    const now = performance.now();
    const at = new Date().toLocaleTimeString();
    if (now - s.resumedAt < 1000) {
      return fail(s, `The video keeps pausing (again at ${at}, right after the player resumed it). Press play to try again.`);
    }
    s.resumedAt = now;
    s.resumes++;
    s.lastResume = at;
    render();
    v.play().catch((err) => fail(s, `Couldn't resume after a pause: video.play() failed: ${err.message}`));
  });
  v.addEventListener('resize', render); // the picture's size changed: the quality readout follows
  for (const e of ['play', 'pause', 'volumechange', 'timeupdate', 'durationchange']) {
    v.addEventListener(e, () => streamOf(v) === big() && renderBar());
  }
  v.addEventListener('dblclick', (e) => {
    if (streamOf(v) !== big()) return; // the small one swaps on click instead
    e.preventDefault();
    toggleFullscreen();
  });
  v.addEventListener('enterpictureinpicture', syncPopout);
  v.addEventListener('leavepictureinpicture', syncPopout);
}

// Media keys and Chrome's media controls ask the page to pause through the Media Session API.
// Chrome has also sent this right after a swap, unasked. Live streams just play, so the request
// is ignored, and the ignoring is noted in each stream's status.
let ignoredPauses = 0;
let lastIgnoredPause = '';
navigator.mediaSession.setActionHandler('pause', () => {
  ignoredPauses++;
  lastIgnoredPause = new Date().toLocaleTimeString();
  console.log(`[stream-sniffer] ignored a pause request from Chrome's media controls at ${lastIgnoredPause}`);
  render();
});
navigator.mediaSession.setActionHandler('play', () => {
  for (const s of streams) {
    if (s.hls) s.video.play().catch((err) => fail(s, `video.play() failed: ${err.message}`));
  }
});

// "1080p", or the bitrate for a stream that doesn't say its resolution. A playlist linked
// directly (no list of qualities) says neither.
function levelName(l) {
  if (l?.height) return `${l.height}p`;
  if (l?.bitrate) return `${Math.round(l.bitrate / 1000)} kbps`;
  return 'unknown quality';
}

// Which quality is on screen and why, e.g. "720p, picked automatically from 2 quality levels".
function qualityText(s) {
  const levels = s.hls?.levels ?? [];
  if (!levels.length) return '';
  const n = levels.length;
  const count = `${n} quality level${n === 1 ? '' : 's'}`;
  if (s.playingLevel < 0) return count;
  // The decoded picture's real height beats what the playlist claims, and works when it claims
  // nothing.
  const now = s.video.videoHeight ? `${s.video.videoHeight}p` : levelName(levels[s.playingLevel]);
  if (n === 1) return `${now}, the only quality level`;
  if (s.quality < 0) return `${now}, picked automatically from ${count}`;
  if (s.quality !== s.playingLevel) return `${now}, switching to ${levelName(levels[s.quality])} (of ${count})`;
  return `${now}, picked by you (of ${count})`;
}

// The bar's quality menu. Auto lets hls.js follow the connection speed; a picked level stays
// until changed. The switch happens at the next segment, so the picture doesn't stop.
function setQuality(streamId, level) {
  const s = streams.find((x) => x.id === streamId);
  if (!s?.hls) return;
  s.quality = level;
  s.hls.nextLevel = level;
  render();
}

function health(s) {
  const parts = [];
  if (s.bufferingSince) parts.push(`Buffering since ${s.bufferingSince}, waiting for video data`);
  if (s.lastProblem) parts.push(`Last problem ${s.lastProblem}`);
  if (s.bufferingSince && s.lastSkipped) parts.push(`Last skipped playlist problem ${s.lastSkipped}`);
  return parts.join(' · ');
}

// A message over the video, with an × that hides it.
const dismissed = new Set();
let renderedProblems = '';
function problemLine([cls, text]) {
  const p = document.createElement('p');
  p.className = cls;
  const span = document.createElement('span');
  span.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dismiss';
  close.textContent = '×';
  close.title = close.ariaLabel = 'Dismiss this message';
  close.addEventListener('click', () => {
    dismissed.add(text);
    render();
  });
  p.append(span, close);
  return p;
}

let renderedEntries = '';
function render() {
  const label = (s) => (streams.length > 1 ? (s === big() ? 'Big: ' : 'Small: ') : '');
  const lines = [];
  if (pageError) lines.push(['error', pageError]);
  for (const s of streams) {
    if (s.error) lines.push(['error', label(s) + s.error]);
    if (health(s)) lines.push(['warn', label(s) + health(s)]);
  }
  // Hidden messages are remembered by their text, so a new or changed message (they carry a time)
  // still shows. Forgetting the ones that are gone keeps the set small.
  const texts = new Set(lines.map(([, text]) => text));
  for (const t of dismissed) if (!texts.has(t)) dismissed.delete(t);
  const shown = lines.filter(([, text]) => !dismissed.has(text));
  // Rebuilt only when the messages change, so an × isn't swapped out from under a click.
  if (JSON.stringify(shown) !== renderedProblems) {
    renderedProblems = JSON.stringify(shown);
    problemsEl.replaceChildren(...shown.map(problemLine));
  }

  // Rebuilt only when its text changes, so a link isn't swapped out from under a click.
  const entries = streams.map((s, i) => ({
    heading: streams.length > 1 ? (i === 0 ? 'Big screen' : 'Small screen (click it to swap)') : 'Now playing',
    pageUrl: s.source.pageUrl,
    pageTitle: s.source.pageTitle,
    status: [
      s.status,
      qualityText(s),
      s.skipped && `hls.js skipped ${s.skipped} playlist problem${s.skipped === 1 ? '' : 's'} (last ${s.lastSkipped})`,
      s.resumes && `resumed after ${s.resumes} pause${s.resumes === 1 ? '' : 's'} (last ${s.lastResume})`,
      ignoredPauses && `ignored ${ignoredPauses} pause request${ignoredPauses === 1 ? '' : 's'} from Chrome's media controls (last ${lastIgnoredPause})`,
    ]
      .filter(Boolean)
      .join(' · '),
    url: s.source.url,
  }));
  if (JSON.stringify(entries) !== renderedEntries) {
    renderedEntries = JSON.stringify(entries);
    streamsEl.replaceChildren(...entries.map(streamEntry));
  }

  renderBar();

  const b = big()?.source;
  document.title = b?.pageUrl ? `▶ ${b.pageTitle || b.pageUrl}` : 'Stream Sniffer Player';
}

// Shows which page a stream came from, its status, and its URL.
function streamEntry(e) {
  const el = document.createElement('div');
  el.className = 'stream';
  const h = document.createElement('h2');
  h.textContent = e.heading;
  el.append(h);
  if (e.pageUrl) {
    const p = document.createElement('p');
    p.className = 'small';
    const a = document.createElement('a');
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = e.pageUrl;
    a.textContent = e.pageTitle ? `${e.pageTitle} (${e.pageUrl})` : e.pageUrl;
    p.append('From ', a);
    el.append(p);
  }
  const status = document.createElement('p');
  status.className = 'muted small';
  status.textContent = e.status;
  el.append(status);
  const url = document.createElement('code');
  url.textContent = e.url;
  el.append(url);
  return el;
}

function openMenu(open) {
  menu.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
}
settingsBtn.addEventListener('click', () => openMenu(menu.hidden));

// Every stream's source (URL, headers, source page) lives in session storage under cap:<id>,
// and the page URL lists the ids big first, so a reload brings back both pictures. Session
// storage keeps cookies out of the URL and browser history.
async function saveSource(source) {
  const capId = crypto.randomUUID();
  await chrome.storage.session.set({ [`cap:${capId}`]: source });
  return { ...source, capId };
}

async function loadSource(capId) {
  const { [`cap:${capId}`]: c } = await chrome.storage.session.get(`cap:${capId}`);
  if (!c) throw new Error('This player link has expired (its captured headers are gone). Reopen it from the popup.');
  return { ...c, capId };
}

function persist() {
  history.replaceState(null, '', `?${new URLSearchParams(streams.map((s) => ['cap', s.source.capId]))}`);
}

// Pop the big video out into Chrome's floating picture-in-picture window, or bring it back.
// The label follows the real state, so closing the floating window by hand updates it too.
const popoutBtn = document.getElementById('popout');
function syncPopout() {
  const out = !!document.pictureInPictureElement;
  popoutBtn.ariaLabel = out ? 'Back to tab' : 'Pop out';
  popoutBtn.title = out ? 'Back to tab' : 'Pop out: play in a floating window that stays on top';
}
popoutBtn.addEventListener('click', async () => {
  pageError = '';
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (!big()?.hls) failPage('Start a stream first, then pop it out.');
    else await big().video.requestPictureInPicture();
  } catch (err) {
    failPage(`Couldn't pop out the video: ${err.name}: ${err.message}`);
  }
  render();
});

// The control bar for the big picture, in place of Chrome's (see player.html). Icons are
// Material Design icons, as in Chrome's own controls.
const ICONS = {
  play: 'M8 5v14l11-7z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  muted: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  popout: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  exitFullscreen: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
};
function setIcon(btn, name) {
  if (btn.dataset.icon === name) return;
  btn.dataset.icon = name;
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}
const bar = document.getElementById('bar');
const playBtn = document.getElementById('play');
const muteBtn = document.getElementById('mute');
const volumeEl = document.getElementById('volume');
const liveBtn = document.getElementById('live');
const timeEl = document.getElementById('time');
const qualityWrap = document.getElementById('quality-wrap');
const qualityBtn = document.getElementById('quality');
const qualityMenu = document.getElementById('quality-menu');
const fullscreenBtn = document.getElementById('fullscreen');
setIcon(playBtn, 'play');
setIcon(popoutBtn, 'popout');
setIcon(fullscreenBtn, 'fullscreen');

function clock(t) {
  t = Math.floor(t);
  const [h, m, sec] = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60];
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
}

// How far behind the live edge counts as "behind": a few segments.
function behindLive(s) {
  const edge = s.hls.liveSyncPosition;
  const target = s.hls.latestLevelDetails?.targetduration || 2;
  return edge != null && edge - s.video.currentTime > Math.max(10, 3 * target);
}

function renderBar() {
  const s = big();
  bar.hidden = !s?.hls;
  if (bar.hidden) return closeQualityMenu();
  const v = s.video;
  // Live streams just play (see the 'pause' listener), so there's no pause button; play shows
  // only for a video that stopped and needs a press to start again.
  playBtn.hidden = !v.paused;
  const silent = v.muted || v.volume === 0;
  setIcon(muteBtn, silent ? 'muted' : 'volume');
  muteBtn.ariaLabel = silent ? 'Unmute' : 'Mute';
  muteBtn.title = `${muteBtn.ariaLabel} (M)`;
  volumeEl.value = silent ? 0 : v.volume;

  const live = !!s.hls.latestLevelDetails?.live;
  liveBtn.hidden = !live;
  timeEl.hidden = live;
  if (live) {
    const behind = behindLive(s);
    liveBtn.textContent = 'LIVE';
    liveBtn.classList.toggle('at-edge', !behind);
    liveBtn.title = behind ? 'Behind live: click to jump to live' : 'Playing live';
  } else {
    timeEl.textContent = Number.isFinite(v.duration) ? `${clock(v.currentTime)} / ${clock(v.duration)}` : clock(v.currentTime);
  }

  // The resolution on screen; with more than one quality it opens the quality menu.
  const levels = s.hls.levels ?? [];
  const playing = levels[s.playingLevel];
  resolutionEl.textContent = v.videoHeight ? `${v.videoHeight}p` : playing ? levelName(playing) : '';
  qualityWrap.hidden = !resolutionEl.textContent;
  qualityBtn.disabled = levels.length < 2;
  qualityBtn.title = levels.length < 2 ? 'Resolution (this stream has only one quality)' : `Quality: ${s.quality < 0 ? 'Auto' : 'picked by you'}`;
  if (qualityBtn.disabled) closeQualityMenu();
  else if (!qualityMenu.hidden) fillQualityMenu(s);
}

// Auto first, then each quality, highest first. Rebuilt only when it changes, so an item isn't
// swapped out from under a click.
function fillQualityMenu(s) {
  const h = s.video.videoHeight;
  const items = [
    { index: -1, name: s.quality < 0 && h ? `Auto (${h}p)` : 'Auto', rate: '' },
    ...s.hls.levels
      .map((l, index) => ({ index, name: levelName(l), rate: l.bitrate ? `${(l.bitrate / 1e6).toFixed(1)} Mbps` : '', bitrate: l.bitrate }))
      .sort((a, b) => b.bitrate - a.bitrate),
  ];
  const key = JSON.stringify([s.id, s.quality, items]);
  if (qualityMenu.dataset.key === key) return;
  qualityMenu.dataset.key = key;
  qualityMenu.replaceChildren(
    ...items.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'menuitemradio';
      b.setAttribute('aria-checked', String(it.index === s.quality));
      const name = document.createElement('span');
      name.textContent = it.name;
      b.append(name);
      if (it.rate) {
        const rate = document.createElement('span');
        rate.className = 'rate';
        rate.textContent = it.rate;
        b.append(rate);
      }
      b.addEventListener('click', () => {
        closeQualityMenu();
        setQuality(s.id, it.index);
      });
      return b;
    })
  );
}
function openQualityMenu() {
  qualityMenu.hidden = false;
  qualityBtn.ariaExpanded = 'true';
  fillQualityMenu(big());
}
function closeQualityMenu() {
  qualityMenu.hidden = true;
  qualityBtn.ariaExpanded = 'false';
}
qualityBtn.addEventListener('click', () => (qualityMenu.hidden ? openQualityMenu() : closeQualityMenu()));
addEventListener('pointerdown', (e) => {
  if (!qualityWrap.contains(e.target)) closeQualityMenu();
});

playBtn.addEventListener('click', () => {
  const s = big();
  s?.video.play().catch((err) => fail(s, `video.play() failed: ${err.message}`));
});
function toggleMute() {
  const s = big();
  if (!s?.hls) return;
  const v = s.video;
  if (v.muted || v.volume === 0) {
    v.muted = false;
    if (v.volume === 0) v.volume = 0.5;
  } else {
    v.muted = true;
  }
  s.autoMuted = false;
}
muteBtn.addEventListener('click', toggleMute);
volumeEl.addEventListener('input', () => {
  const s = big();
  if (!s?.hls) return;
  s.video.volume = Number(volumeEl.value);
  s.video.muted = s.video.volume === 0;
  s.autoMuted = false;
});
liveBtn.addEventListener('click', () => {
  const s = big();
  if (s?.hls && behindLive(s)) s.video.currentTime = s.hls.liveSyncPosition;
});

// Full screen takes the whole page, so the small picture and messages stay. (Chrome's own
// would take just the video, and won't let the page switch it over afterwards.) The button,
// F, and a double-click on the big picture all toggle it.
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) {
    failPage(`Couldn't change full screen: ${err.message}`);
  }
}
fullscreenBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  setIcon(fullscreenBtn, on ? 'exitFullscreen' : 'fullscreen');
  fullscreenBtn.ariaLabel = on ? 'Exit full screen' : 'Full screen';
  fullscreenBtn.title = on ? 'Exit full screen (F or Esc)' : 'Full screen (F, or double-click the video)';
});

// F: full screen. M: mute. Esc: close the quality menu. Not while typing in the form.
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input:not([type=range]), select, textarea')) return;
  const key = e.key.toLowerCase();
  if (key === 'escape') return closeQualityMenu();
  if (key === 'f') toggleFullscreen();
  else if (key === 'm') toggleMute();
  else return;
  e.preventDefault();
});

// The bar and the mouse pointer fade out once the mouse has rested for a few seconds, as with
// Chrome's controls. Not while the pointer is on the bar or a menu is open.
let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (big()?.hls && menu.hidden && qualityMenu.hidden && !bar.matches(':hover')) document.body.classList.add('idle');
    else wake();
  }, 3000);
}
for (const e of ['pointermove', 'pointerdown', 'keydown']) addEventListener(e, wake);
wake();

// The popup's "Add to player" sends this to the player tab used last.
const myTabId = chrome.tabs.getCurrent().then((t) => t.id);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'add-stream') return false;
  myTabId.then(async (id) => {
    if (msg.tabId !== id) return;
    try {
      const source = await loadSource(msg.capId);
      await startStream(source, Math.min(streams.length, MAX_STREAMS - 1));
      sendResponse({ ok: true });
    } catch (err) {
      failPage(err.message);
      sendResponse({ error: err.message });
    }
  });
  return true; // async response; only the addressed tab ever sends one
});

// Cast via the relay. Some stream servers only answer Chrome itself, so this tab does all the
// fetching: it long-polls the relay for URLs the TV wants, fetches them here (where the
// Referer/Origin rewrite applies), and posts the bytes back. The relay serves them to the TV.
// That's why this tab has to stay open while casting. It casts the big picture's stream.
// Where the relay listens. Override with chrome.storage.local.relayUrl (the E2E test uses this
// to run its own relay next to yours); the active address shows in every relay message.
const DEFAULT_RELAY = 'http://localhost:8788';
let RELAY = DEFAULT_RELAY;
const relayReady = chrome.storage.local.get('relayUrl').then(({ relayUrl }) => {
  if (relayUrl) {
    RELAY = relayUrl;
    console.log(`[stream-sniffer] using relay at ${RELAY} (from storage, not the default)`);
  }
});
const relayBtn = document.getElementById('relay');
const setRelay = (msg) => (castStatus.textContent = `Relay: ${msg}`);
let bridge = null;

function startBridge(id, stream) {
  const b = { id, stream, stopped: false, served: 0 };
  b.fail = (msg) => {
    if (b.stopped) return;
    b.stopped = true;
    console.error('[stream-sniffer] bridge stopped:', msg);
    setRelay(`stopped feeding the TV: ${msg}`);
  };
  bridgeLoop(b).catch((err) => b.fail(err.message));
  return b;
}

// One long-poll at a time (Chrome allows only 6 connections to localhost:8788 across all tabs),
// with each job fetched in parallel so playlist refreshes don't wait behind segments.
async function bridgeLoop(b) {
  while (!b.stopped) {
    let res;
    try {
      res = await fetch(`${RELAY}/api/streams/${b.id}/next`, { cache: 'no-store' });
    } catch (err) {
      return b.fail(`lost contact with the relay (${err.message}). Is it still running?`);
    }
    if (b.stopped) return;
    if (res.status === 204) continue; // nothing to fetch during this poll
    if (res.status === 404) return b.fail('the relay no longer knows this stream (did it restart?). Click "Cast via relay" again.');
    if (res.status === 410) return b.fail((await res.json().catch(() => ({}))).error || 'stream retired by the relay');
    if (!res.ok) return b.fail(`relay error HTTP ${res.status}: ${await res.text()}`);
    const job = await res.json();
    runJob(b, job).catch((err) => b.fail(err.message));
  }
}

async function runJob(b, job) {
  let headers;
  let body;
  try {
    await allowHost(b.stream, job.url);
    const up = await fetch(job.url, { cache: 'no-store' });
    body = await up.arrayBuffer();
    headers = {
      'x-upstream-status': String(up.status),
      'x-upstream-type': encodeURIComponent(up.headers.get('content-type') || ''),
      'x-upstream-url': encodeURIComponent(up.url),
    };
  } catch (err) {
    // Reported to the relay, which shows it on the cast page and fails the TV's request.
    body = '';
    headers = { 'x-upstream-error': encodeURIComponent(err.message) };
  }
  let posted;
  try {
    posted = await fetch(`${RELAY}/api/streams/${b.id}/result/${job.id}`, { method: 'POST', headers, body });
  } catch (err) {
    return b.fail(`lost contact with the relay (${err.message}). Is it still running?`);
  }
  // 410 means the TV gave up waiting for this one; not fatal.
  if (!posted.ok && posted.status !== 410) return b.fail(`relay rejected a result: HTTP ${posted.status}`);
  b.served++;
  if (bridge === b && b.info && !b.stopped) setRelay(`feeding the TV — keep this tab open. ${b.served} requests fetched for it.`);
}

relayBtn.addEventListener('click', async () => {
  const s = big();
  if (!s) {
    setRelay('play a stream first.');
    return;
  }
  await relayReady;
  setRelay(`registering stream with the relay at ${RELAY}…`);
  let res;
  try {
    res = await fetch(`${RELAY}/api/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: s.source.url }),
    });
  } catch (err) {
    console.error('[stream-sniffer] relay unreachable', err);
    setRelay(`not running at ${RELAY}. Start it in a terminal from the stream-sniffer folder: node relay/server.mjs`);
    return;
  }
  const reg = await res.json().catch((err) => ({ error: `relay sent a non-JSON reply (HTTP ${res.status}): ${err.message}` }));
  if (!res.ok || reg.error) {
    setRelay(reg.error || `HTTP ${res.status}`);
    return;
  }

  if (bridge) bridge.stopped = true;
  const b = (bridge = startBridge(reg.id, s));
  setRelay('checking the stream through this tab…');
  const probeRes = await fetch(`${RELAY}/api/streams/${reg.id}/probe`, { method: 'POST' });
  const info = await probeRes.json().catch((err) => ({ error: `relay sent a non-JSON reply (HTTP ${probeRes.status}): ${err.message}` }));
  if (!probeRes.ok || info.error) {
    b.stopped = true;
    setRelay(info.error || `HTTP ${probeRes.status}`);
    return;
  }
  b.info = info;

  // The TV takes over; stop playing here so the stream isn't downloaded twice.
  if (s.hls) {
    s.hls.destroy();
    s.hls = null;
    s.video.removeAttribute('src');
    s.video.load();
    s.casting = true; // an empty player box while the TV plays is just dead space
    layout();
    s.status = 'Stopped here while casting. Press Play to watch on this computer again.';
    render();
  }
  const frame = document.getElementById('cast-frame');
  frame.src = `${info.castPageUrl}?embed=1`;
  frame.hidden = false;
  frame.style.height = '300px'; // until the cast page reports its real height
  setRelay('ready — click "Cast to TV" below. Keep this tab open; it fetches the stream for the TV.');
});

// The cast page reports its content height; grow the frame to match so it never scrolls.
window.addEventListener('message', (e) => {
  if (e.origin !== new URL(RELAY).origin || e.data?.type !== 'cast-frame-height') return;
  document.getElementById('cast-frame').style.height = `${Math.ceil(e.data.height)}px`;
});

function readForm() {
  const f = new FormData(form);
  return {
    url: f.get('url').trim(),
    referer: f.get('referer').trim(),
    origin: f.get('origin').trim(),
  };
}

function fillForm() {
  const s = big()?.source;
  for (const name of ['url', 'referer', 'origin']) form.elements[name].value = s?.[name] || '';
}

// "Play a URL" folds away, and stays as it was left. Only a click saves: init() opens it when
// there's nothing to play, which shouldn't count.
const playUrl = document.getElementById('play-url');
playUrl.querySelector('summary').addEventListener('click', () => {
  chrome.storage.local
    .set({ playUrlOpen: !playUrl.open }) // the click hasn't toggled it yet
    .catch((err) => failPage(`Couldn't save whether "Play a URL" is open: ${err.message}`));
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  saveSource(readForm())
    .then((source) => startStream(source, 0))
    .catch((err) => failPage(err.message));
});

// Bring back the streams listed in the URL (?cap=<id>, big first), or play a plain
// ?url=&referer=&origin= link. With nothing to play, open the menu at the form.
async function init() {
  const reset = await chrome.runtime.sendMessage({ type: 'player-reset' });
  if (!reset?.ok) throw new Error(`Could not clear this tab's old header rules: ${reset?.error ?? 'no response from background'}`);
  const sources = [];
  for (const id of params.getAll('cap').slice(0, MAX_STREAMS)) sources.push(await loadSource(id));
  if (!sources.length && params.get('url')) {
    sources.push(await saveSource({ url: params.get('url'), referer: params.get('referer') || '', origin: params.get('origin') || '' }));
  }
  if (!sources.length) return openMenu(true);
  const { playUrlOpen } = await chrome.storage.local.get('playUrlOpen');
  playUrl.open = playUrlOpen !== false;
  for (const [i, source] of sources.entries()) await startStream(source, i);
}
init().catch((err) => {
  playUrl.open = true;
  openMenu(true);
  failPage(err.message);
});
