// Tests for extension/scte35.js, the SCTE-35 (ad-break cue) decoder. No browser needed:
//   node test/scte35.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(fs.readFileSync(path.join(here, '../extension/scte35.js'), 'utf8'));
const { parseSection, fromText, findInTs, breakEdge, describe, crc32 } = globalThis.Scte35;

let failed = 0;
function assert(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}
const near = (a, b) => Math.abs(a - b) < 0.001;

// The SCTE-35 standard's own sample cues.
// A splice_insert: an ad break of 60.3 s starts at video time 21514.559 s.
const insert = fromText('/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=');
assert(insert && insert.crcOk, 'splice_insert sample: decoded, checksum right');
assert(insert.command === 'splice_insert' && insert.outOfNetwork === true, 'splice_insert sample: leaves the network (ad break starts)');
assert(insert.eventId === 0x4800008f, `splice_insert sample: event id (${insert.eventId})`);
assert(near(insert.pts, 0x07369c02e / 90000), `splice_insert sample: splice time (${insert.pts})`);
assert(near(insert.duration, 0x00052ccf5 / 90000) && insert.autoReturn, `splice_insert sample: lasts 60.3 s, returns by itself (${insert.duration})`);
assert(breakEdge(insert) === true, 'splice_insert sample: counts as a break start');
assert(/^AD BREAK STARTS; splice_insert; event \d+; lasts 60\.3 s/.test(describe(insert)), `described: ${describe(insert)}`);

// A time_signal with a segmentation descriptor: a Provider Placement Opportunity of 307 s.
const signal = fromText('/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg==');
assert(signal && signal.crcOk, 'time_signal sample: decoded, checksum right');
assert(signal.command === 'time_signal' && near(signal.pts, 0x072bd0050 / 90000), `time_signal sample: time (${signal.pts})`);
const seg = signal.segmentations?.[0];
assert(seg?.type === 0x34 && seg.typeName === 'Provider Placement Opportunity Start', `time_signal sample: segmentation type (${seg?.typeName})`);
assert(near(seg.duration, 307), `time_signal sample: lasts 307 s (${seg.duration})`);
assert(breakEdge(signal) === true, 'time_signal sample: counts as a break start');
console.log(`     described: ${describe(signal)}`);

// The same cue written in hex, as #EXT-X-DATERANGE's SCTE35-OUT attribute has it.
const asHex = '0x' + Buffer.from('/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=', 'base64').toString('hex').toUpperCase();
assert(fromText(asHex)?.eventId === 0x4800008f, 'a hex cue decodes the same as base64');
assert(fromText('120') === null && fromText('YES') === null, 'plain tag values (a duration, a word) are not taken for cues');

// A damaged cue is reported, not thrown.
const bad = parseSection(Buffer.from('/DAvAAAAAAAA', 'base64'));
assert(bad.error && /unreadable/.test(describe(bad)), `a cut-short cue says so (${bad.error})`);
const flipped = Buffer.from('/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=', 'base64');
flipped[20] ^= 1;
assert(parseSection(flipped).crcOk === false, 'a corrupted cue fails its checksum');

// An MPEG-TS segment with a SCTE-35 track: PAT -> PMT (video 0x100, SCTE-35 0x1f0), a video
// packet, and the splice_insert cue split over two packets of its track.
function section(tableId, body) {
  // Section header + body + CRC, with section_length covering body and CRC.
  const len = body.length + 4;
  const s = Buffer.concat([Buffer.from([tableId, 0xb0 | (len >> 8), len & 0xff]), body, Buffer.alloc(4)]);
  s.writeUInt32BE(crc32(s.subarray(0, s.length - 4)), s.length - 4);
  return s;
}
// A TS packet. A payload shorter than the packet is padded in front of it, in an adaptation
// field, as encoders do, so the payload runs to the packet's end.
function packet(pid, start, payload) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = (start ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  const n = Math.min(payload.length, 184);
  if (n === 184) {
    p[3] = 0x10;
  } else {
    p[3] = 0x30;
    p[4] = 183 - n; // adaptation field length
    if (p[4]) p[5] = 0x00; // its flags; the rest is 0xff stuffing
  }
  payload.copy(p, 188 - n, 0, n);
  return p;
}
const pat = section(0x00, Buffer.from([0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | 0x10, 0x00]));
const pmt = section(0x02, Buffer.from([0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0x86, 0xe1, 0xf0, 0xf0, 0x00]));
const cue = Buffer.from('/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=', 'base64');
const ts = Buffer.concat([
  packet(0, true, Buffer.concat([Buffer.from([0]), pat])),
  packet(0x1000, true, Buffer.concat([Buffer.from([0]), pmt])),
  packet(0x100, true, Buffer.alloc(184, 0x00)),
  packet(0x1f0, true, Buffer.concat([Buffer.from([0]), cue.subarray(0, 30)])), // the cue's first 30 bytes
  packet(0x1f0, false, cue.subarray(30)), // and the rest
]);
const found = findInTs(ts);
assert(found.pid === 0x1f0, `finds the SCTE-35 track in the PMT (pid ${found.pid})`);
assert(found.sections.length === 1 && parseSection(found.sections[0]).eventId === 0x4800008f, `reassembles a cue split over two packets (${found.sections.length} found)`);
const plain = findInTs(Buffer.concat([ts.subarray(0, 188 * 3)]));
assert(plain.pid === 0x1f0 && plain.sections.length === 0, 'a segment with the track but no cue has none');
const noTrack = section(0x02, Buffer.from([0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00]));
const noTs = Buffer.concat([ts.subarray(0, 188), packet(0x1000, true, Buffer.concat([Buffer.from([0]), noTrack]))]);
assert(findInTs(noTs).pid === null, 'a segment without the track says so');

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
