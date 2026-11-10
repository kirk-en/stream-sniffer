// SCTE-35: the cues broadcasters put in a stream to say "an ad break starts here, for 120 s" and
// "back to the program". They come two ways:
//   - in the playlist, as tags (#EXT-X-CUE-OUT, #EXT-X-DATERANGE with SCTE35-OUT=0x…,
//     #EXT-OATCLS-SCTE35:<base64>), sometimes carrying the binary cue as hex or base64;
//   - inside MPEG-TS segments, as their own data track (stream type 0x86 in the PMT).
// This file decodes the binary cue (a splice_info_section) and finds it in TS segments. It has
// no dependencies, so the player loads it as a plain script and the tests load it in Node.
'use strict';

(() => {
  const PACKET = 188;
  const SECOND = 90000; // SCTE-35 times count a 90 kHz clock
  const WRAP = 2 ** 33;

  // The CRC every MPEG section ends with (CRC-32/MPEG-2). Over a whole section, including its own
  // CRC, it comes out 0.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
    return c;
  }

  // A 33-bit time: the low bit of the first byte, then four more bytes.
  const read33 = (b, i) => (b[i] & 1) * 2 ** 32 + ((b[i + 1] << 24) >>> 0) + (b[i + 2] << 16) + (b[i + 3] << 8) + b[i + 4];
  const read32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  const COMMANDS = {
    0x00: 'splice_null',
    0x04: 'splice_schedule',
    0x05: 'splice_insert',
    0x06: 'time_signal',
    0x07: 'bandwidth_reservation',
    0xff: 'private_command',
  };

  // What a segmentation descriptor says is starting or ending. The ad-related ones are what
  // commercial detection cares about.
  const SEGMENTATION_TYPES = {
    0x00: 'Not Indicated',
    0x01: 'Content Identification',
    0x10: 'Program Start',
    0x11: 'Program End',
    0x12: 'Program Early Termination',
    0x13: 'Program Breakaway',
    0x14: 'Program Resumption',
    0x15: 'Program Runover Planned',
    0x16: 'Program Runover Unplanned',
    0x17: 'Program Overlap Start',
    0x18: 'Program Blackout Override',
    0x19: 'Program Join',
    0x20: 'Chapter Start',
    0x21: 'Chapter End',
    0x22: 'Break Start',
    0x23: 'Break End',
    0x24: 'Opening Credit Start',
    0x25: 'Opening Credit End',
    0x26: 'Closing Credit Start',
    0x27: 'Closing Credit End',
    0x30: 'Provider Advertisement Start',
    0x31: 'Provider Advertisement End',
    0x32: 'Distributor Advertisement Start',
    0x33: 'Distributor Advertisement End',
    0x34: 'Provider Placement Opportunity Start',
    0x35: 'Provider Placement Opportunity End',
    0x36: 'Distributor Placement Opportunity Start',
    0x37: 'Distributor Placement Opportunity End',
    0x38: 'Provider Overlay Placement Opportunity Start',
    0x39: 'Provider Overlay Placement Opportunity End',
    0x3a: 'Distributor Overlay Placement Opportunity Start',
    0x3b: 'Distributor Overlay Placement Opportunity End',
    0x3c: 'Provider Promo Start',
    0x3d: 'Provider Promo End',
    0x3e: 'Distributor Promo Start',
    0x3f: 'Distributor Promo End',
    0x40: 'Unscheduled Event Start',
    0x41: 'Unscheduled Event End',
    0x42: 'Alternate Content Opportunity Start',
    0x43: 'Alternate Content Opportunity End',
    0x44: 'Provider Ad Block Start',
    0x45: 'Provider Ad Block End',
    0x46: 'Distributor Ad Block Start',
    0x47: 'Distributor Ad Block End',
    0x50: 'Network Start',
    0x51: 'Network End',
  };
  // Segmentation types that start an ad break, and that end one.
  const BREAK_STARTS = new Set([0x22, 0x30, 0x32, 0x34, 0x36, 0x44, 0x46]);
  const BREAK_ENDS = new Set([0x23, 0x31, 0x33, 0x35, 0x37, 0x45, 0x47]);

  // splice_time(): a flag, then a 33-bit time if the flag is set. Returns [pts or null, length].
  function spliceTime(b, i) {
    if (b[i] & 0x80) return [read33(b, i), 5];
    return [null, 1];
  }

  function spliceInsert(b, i, cue) {
    cue.eventId = read32(b, i);
    cue.cancel = !!(b[i + 4] & 0x80);
    i += 5;
    if (cue.cancel) return;
    const f = b[i++];
    cue.outOfNetwork = !!(f & 0x80);
    const programSplice = !!(f & 0x40);
    const durationFlag = !!(f & 0x20);
    cue.immediate = !!(f & 0x10);
    if (programSplice && !cue.immediate) {
      const [pts, n] = spliceTime(b, i);
      cue.pts = pts;
      i += n;
    }
    if (!programSplice) {
      const count = b[i++];
      for (let k = 0; k < count; k++) {
        i++; // component_tag
        if (!cue.immediate) i += spliceTime(b, i)[1];
      }
    }
    if (durationFlag) {
      cue.autoReturn = !!(b[i] & 0x80);
      cue.duration = read33(b, i) / SECOND;
      i += 5;
    }
    cue.uniqueProgramId = (b[i] << 8) | b[i + 1];
    cue.availNum = b[i + 2];
    cue.availsExpected = b[i + 3];
  }

  // A segmentation_descriptor (tag 0x02, "CUEI"): what's starting or ending, and for how long.
  function segmentation(b, i, end) {
    const seg = { eventId: read32(b, i), cancel: !!(b[i + 4] & 0x80) };
    i += 5;
    if (seg.cancel) return seg;
    const f = b[i++];
    const programSegmentation = !!(f & 0x80);
    const durationFlag = !!(f & 0x40);
    if (!programSegmentation) i += 1 + b[i] * 6; // component_count, then 6 bytes per component
    if (durationFlag) {
      seg.duration = (b[i] * 2 ** 32 + read32(b, i + 1)) / SECOND;
      i += 5;
    }
    seg.upidType = b[i];
    const upidLength = b[i + 1];
    seg.upid = hex(b.subarray(i + 2, i + 2 + upidLength));
    i += 2 + upidLength;
    if (i >= end) return seg;
    seg.type = b[i];
    seg.typeName = SEGMENTATION_TYPES[seg.type] ?? `type 0x${seg.type.toString(16)}`;
    seg.segmentNum = b[i + 1];
    seg.segmentsExpected = b[i + 2];
    return seg;
  }

  // Decodes one splice_info_section. Never throws: a cue that can't be read comes back with
  // `error` saying why, so the log still shows something was there.
  function parseSection(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const cue = { hex: hex(b) };
    try {
      if (b[0] !== 0xfc) throw new Error(`not a SCTE-35 cue (table 0x${(b[0] ?? 0).toString(16)})`);
      const length = 3 + (((b[1] & 0x0f) << 8) | b[2]);
      if (b.length < length) throw new Error(`cut short (${b.length} of ${length} bytes)`);
      const s = b.subarray(0, length);
      cue.crcOk = crc32(s) === 0;
      cue.encrypted = !!(s[4] & 0x80);
      const ptsAdjustment = read33(s, 4);
      const commandLength = ((s[11] & 0x0f) << 8) | s[12];
      cue.commandType = s[13];
      cue.command = COMMANDS[cue.commandType] ?? `command 0x${cue.commandType.toString(16)}`;
      if (cue.encrypted) return cue; // the rest is scrambled
      let i = 14;
      if (cue.commandType === 0x05) spliceInsert(s, i, cue);
      else if (cue.commandType === 0x06) cue.pts = spliceTime(s, i)[0];
      if (cue.pts != null) cue.pts = ((cue.pts + ptsAdjustment) % WRAP) / SECOND;
      // Older encoders send 0xfff ("unknown") as the command length; then only the commands read
      // above can be skipped past to reach the descriptors.
      if (commandLength !== 0xfff) i += commandLength;
      else if (cue.commandType === 0x06) i += spliceTime(s, i)[1];
      else if (cue.commandType === 0x00 || cue.commandType === 0x07) i += 0;
      else if (cue.commandType === 0x05) i = skipInsert(s, i);
      else return cue;
      const loopEnd = i + 2 + ((s[i] << 8) | s[i + 1]);
      i += 2;
      cue.segmentations = [];
      while (i + 6 <= loopEnd && i + 6 <= length - 4) {
        const tag = s[i];
        const len = s[i + 1];
        const id = String.fromCharCode(s[i + 2], s[i + 3], s[i + 4], s[i + 5]);
        if (tag === 0x02 && id === 'CUEI') cue.segmentations.push(segmentation(s, i + 6, i + 2 + len));
        i += 2 + len;
      }
    } catch (err) {
      cue.error = err.message;
    }
    return cue;
  }
  // Where a splice_insert ends, for a section that doesn't say its command length.
  function skipInsert(b, i) {
    const cancel = b[i + 4] & 0x80;
    i += 5;
    if (cancel) return i;
    const f = b[i++];
    const programSplice = f & 0x40;
    const immediate = f & 0x10;
    if (programSplice && !immediate) i += spliceTime(b, i)[1];
    if (!programSplice) {
      const count = b[i++];
      for (let k = 0; k < count; k++) {
        i++;
        if (!immediate) i += spliceTime(b, i)[1];
      }
    }
    if (f & 0x20) i += 5;
    return i + 4;
  }

  // A cue written in a playlist: hex ("0xFC30…") or base64 ("/DA…"). Returns null for text that
  // isn't either.
  function fromText(text) {
    const t = String(text).trim().replace(/^"|"$/g, '');
    let bytes;
    if (/^0x[0-9a-f]+$/i.test(t)) {
      bytes = new Uint8Array(t.slice(2).match(/../g).map((h) => parseInt(h, 16)));
    } else if (/^[A-Za-z0-9+/=_-]{8,}$/.test(t)) {
      try {
        bytes = Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      } catch {
        return null;
      }
    } else {
      return null;
    }
    return bytes[0] === 0xfc ? parseSection(bytes) : null;
  }

  // Finds the SCTE-35 track of an MPEG-TS segment and the cues in it. Returns { pid, sections }:
  // pid is null when the segment has no SCTE-35 track. Tables are read from this segment alone
  // (segments normally start with them).
  function findInTs(data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    const out = { pid: null, sections: [] };
    let pmtPids = new Set();
    const partial = new Map(); // pid -> bytes of a cue still coming in
    const sectionsFrom = (pid, payload, start) => {
      // A cue can spill over into the next packets of its track; collect until it's whole.
      let i = 0;
      let buf = partial.get(pid);
      if (!start && !buf) return; // the middle of a cue whose start came before this segment
      if (start) {
        const pointer = payload[0];
        if (buf) partial.set(pid, concat(buf, payload.subarray(1, 1 + pointer)));
        flush(pid);
        i = 1 + pointer;
        buf = null;
      }
      const rest = payload.subarray(i);
      partial.set(pid, buf ? concat(buf, rest) : rest.slice());
      flush(pid);
    };
    const flush = (pid) => {
      let buf = partial.get(pid);
      while (buf && buf.length >= 3 && buf[0] !== 0xff) {
        const len = 3 + (((buf[1] & 0x0f) << 8) | buf[2]);
        if (buf.length < len) break;
        out.sections.push(buf.slice(0, len));
        buf = buf.subarray(len);
      }
      partial.set(pid, buf && buf.length && buf[0] !== 0xff ? buf : null);
    };
    for (let p = 0; p + PACKET <= b.length; p += PACKET) {
      if (b[p] !== 0x47) continue;
      const start = !!(b[p + 1] & 0x40);
      const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
      const afc = (b[p + 3] >> 4) & 3;
      if (!(afc & 1)) continue; // no payload
      const at = p + 4 + (afc & 2 ? 1 + b[p + 4] : 0);
      if (at >= p + PACKET) continue;
      const payload = b.subarray(at, p + PACKET);
      if (pid === 0 && start) {
        // PAT: which PIDs hold the program tables.
        const t = payload.subarray(1 + payload[0]);
        const end = Math.min(t.length, 3 + (((t[1] & 0x0f) << 8) | t[2])) - 4;
        pmtPids = new Set();
        for (let i = 8; i + 4 <= end; i += 4) {
          if ((t[i] << 8) | t[i + 1]) pmtPids.add(((t[i + 2] & 0x1f) << 8) | t[i + 3]);
        }
      } else if (pmtPids.has(pid) && start) {
        // PMT: the tracks, and which one (if any) is SCTE-35.
        const t = payload.subarray(1 + payload[0]);
        if (t[0] !== 0x02) continue;
        const end = Math.min(t.length, 3 + (((t[1] & 0x0f) << 8) | t[2])) - 4;
        let i = 12 + (((t[10] & 0x0f) << 8) | t[11]);
        while (i + 5 <= end) {
          if (t[i] === 0x86) out.pid = ((t[i + 1] & 0x1f) << 8) | t[i + 2];
          i += 5 + (((t[i + 3] & 0x0f) << 8) | t[i + 4]);
        }
      } else if (pid === out.pid) {
        sectionsFrom(pid, payload, start);
      }
    }
    return out;
  }
  function concat(a, b) {
    const c = new Uint8Array(a.length + b.length);
    c.set(a);
    c.set(b, a.length);
    return c;
  }

  // Whether a cue starts an ad break (true), ends one (false), or says neither (null).
  function breakEdge(cue) {
    if (cue.cancel) return null;
    if (cue.commandType === 0x05) return cue.outOfNetwork;
    for (const s of cue.segmentations ?? []) {
      if (BREAK_STARTS.has(s.type)) return true;
      if (BREAK_ENDS.has(s.type)) return false;
    }
    return null;
  }

  const secs = (t) => `${Math.round(t * 10) / 10} s`;
  // One line about a cue, for the log.
  function describe(cue) {
    if (cue.error) return `unreadable SCTE-35 cue (${cue.error}): ${cue.hex.slice(0, 120)}`;
    const edge = breakEdge(cue);
    const parts = [edge === true ? 'AD BREAK STARTS' : edge === false ? 'AD BREAK ENDS' : 'cue'];
    parts.push(cue.command);
    if (cue.encrypted) parts.push('encrypted, not readable');
    if (cue.cancel) parts.push(`cancels event ${cue.eventId}`);
    else if (cue.eventId != null) parts.push(`event ${cue.eventId}`);
    if (cue.duration != null) parts.push(`lasts ${secs(cue.duration)}${cue.autoReturn ? ' (returns by itself)' : ''}`);
    if (cue.immediate) parts.push('immediately');
    else if (cue.pts != null) parts.push(`at video time ${cue.pts.toFixed(3)} s`);
    for (const s of cue.segmentations ?? []) {
      const bits = [s.cancel ? `cancels segmentation ${s.eventId}` : s.typeName ?? 'segmentation'];
      if (s.duration != null) bits.push(`lasts ${secs(s.duration)}`);
      if (s.segmentsExpected) bits.push(`${s.segmentNum} of ${s.segmentsExpected}`);
      parts.push(`[${bits.join(', ')}]`);
    }
    if (cue.crcOk === false) parts.push('checksum wrong');
    return parts.join('; ');
  }

  globalThis.Scte35 = { parseSection, fromText, findInTs, breakEdge, describe, crc32 };
})();
