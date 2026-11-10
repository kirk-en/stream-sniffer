// The player's side of commercial detection: about twice a second it takes a small copy of the
// big picture and hands it to the worker (detector-worker.js), which does the analysis.
//
// Kept light so playback isn't touched: the browser shrinks the frame (createImageBitmap with a
// size, done on the GPU) before anything reads its pixels, only one frame is in flight at a time,
// and nothing is sampled while the video is paused or the tab is hidden. grabMs and workMs in
// each result say what it cost, and the menu shows them.
'use strict';

(() => {
  const SAMPLE_MS = 500;

  // getVideo() says which <video> to watch now (or null); onResult gets each result.
  function createDetector({ getVideo, onResult, onError }) {
    const worker = new Worker('detector-worker.js');
    let timer = null;
    let busy = false;
    let video = null;
    let lastTime = null; // the video's own time at the last sample
    let id = 0;
    let grabMs = 0;

    worker.onmessage = ({ data }) => {
      busy = false;
      if (data.type === 'error') return onError(data.message);
      onResult({ ...data.result, grabMs, workMs: data.workMs });
    };
    worker.onerror = (e) => {
      busy = false;
      onError(e.message || 'the detector worker failed');
    };

    async function sample() {
      if (busy) return;
      const v = getVideo();
      if (v !== video) {
        // A different picture (a swap, a new stream): what was learned doesn't apply.
        video = v;
        lastTime = null;
        worker.postMessage({ type: 'reset' });
      }
      if (!v || v.paused || v.readyState < 2 || document.hidden || !v.videoWidth) {
        lastTime = null;
        return;
      }
      const t = v.currentTime;
      const dt = lastTime == null ? SAMPLE_MS / 1000 : t - lastTime;
      lastTime = t;
      if (!(dt > 0)) return; // the picture hasn't moved
      busy = true;
      const started = performance.now();
      let bitmap;
      try {
        bitmap = await createImageBitmap(v, { resizeWidth: DetectorCore.W, resizeHeight: DetectorCore.H, resizeQuality: 'low' });
      } catch (err) {
        busy = false;
        return onError(`couldn't copy the picture: ${err.message}`);
      }
      grabMs = performance.now() - started;
      // A long pause (a stall) counts as one sample's worth, so it doesn't look like a long absence.
      worker.postMessage({ type: 'frame', id: ++id, bitmap, dt: Math.min(dt, 1) }, [bitmap]);
    }

    return {
      start() {
        if (!timer) timer = setInterval(sample, SAMPLE_MS);
      },
      stop() {
        clearInterval(timer);
        timer = null;
        video = null;
        lastTime = null;
        worker.postMessage({ type: 'reset' });
      },
      relearn() {
        lastTime = null;
        worker.postMessage({ type: 'reset' });
      },
      setOptions(options) {
        worker.postMessage({ type: 'options', options });
      },
    };
  }

  globalThis.createDetector = createDetector;
})();
