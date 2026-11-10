// Runs the commercial detector (detector-core.js) off the player's main thread, so the work never
// competes with drawing the video. Gets small frames from detector.js, sends back what it found.
'use strict';
importScripts('detector-core.js');

const { Analyzer, W, H } = DetectorCore;
const analyzer = new Analyzer();
const canvas = new OffscreenCanvas(W, H);
const ctx = canvas.getContext('2d', { willReadFrequently: true });

onmessage = ({ data }) => {
  if (data.type === 'reset') return analyzer.reset();
  if (data.type === 'options') return analyzer.setOptions(data.options);
  if (data.type !== 'frame') return;
  const started = performance.now();
  try {
    ctx.drawImage(data.bitmap, 0, 0, W, H);
    data.bitmap.close();
    const result = analyzer.push(ctx.getImageData(0, 0, W, H).data, data.dt);
    postMessage({ type: 'result', id: data.id, result, workMs: performance.now() - started });
  } catch (err) {
    postMessage({ type: 'error', id: data.id, message: err.message });
  }
};
