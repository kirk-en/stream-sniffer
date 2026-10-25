// Shared by the player and the popup's quality check: the hls.js loader for one stream's
// requests, and how measurements read.
(() => {
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
  // request. hosts is the stream's Set of hosts registered so far.
  async function allowHost(streamId, hosts, url) {
    const host = new URL(url).hostname;
    if (hosts.has(host)) return;
    const res = await chrome.runtime.sendMessage({ type: 'stream-host', streamId, url });
    if (!res?.ok) throw new Error(`Could not set up request headers for ${host}: ${res?.error ?? 'no response from background'}`);
    hosts.add(host);
  }

  // hls.js loader for every request of one stream: registers the host first (allowHost: url =>
  // Promise), and decodes image-disguised segments (see disguise.js) before the demuxer sees
  // them, calling onDisguised for each. A segment that's an image we can't decode, or a host we
  // can't register, fails loudly with the reason (onFail: message =>).
  function makeLoader({ allowHost, onDisguised, onFail }) {
    const unwrapping = (callbacks) => ({
      ...callbacks,
      onSuccess: (response, stats, ctx, details) => {
        // A "playlist" that isn't one (an HTML error page, an empty body) fails as a load error,
        // so hls.js retries it like any failed request.
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
            onDisguised();
            callbacks.onSuccess(response, stats, ctx, details);
          },
          (err) => {
            onFail(`Couldn't decode a segment: ${err.message}`);
            callbacks.onError({ code: 0, text: err.message }, ctx, details, stats);
          }
        );
      },
    });
    return class extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        this.cancelled = false;
        allowHost(context.url).then(
          () => {
            if (!this.cancelled) super.load(context, config, unwrapping(callbacks));
          },
          (err) => {
            onFail(err.message);
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

  // A frame rate counted over a couple of seconds wobbles by a frame or so; snap it to the
  // usual rate it's close to.
  const COMMON_FPS = [24, 25, 30, 48, 50, 60, 120];
  function snapFps(fps) {
    const closest = COMMON_FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
    return Math.abs(closest - fps) <= 1.5 ? closest : Math.round(fps);
  }

  // "6.2 Mbps", or "850 kbps" under 1 Mbps.
  function rateText(mbps) {
    if (!mbps) return '';
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${Math.round(mbps * 1000)} kbps`;
  }

  globalThis.StreamSnifferShared = { allowHost, makeLoader, snapFps, rateText };
})();
