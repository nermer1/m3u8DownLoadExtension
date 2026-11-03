// Rebuilds a fragmented MP4 (init segment + moof/mdat fragments, as mux.js or fMP4 HLS produce)
// into a regular MP4 with the whole sample index (moov) in front of one mdat — the layout
// `ffmpeg -c copy -movflags faststart` writes. Players seek in it directly instead of scanning fragments.
// Media bytes are never copied: the mdat is made of Blob slices of the fragments.
//
//   const mp4 = new FaststartMp4();
//   mp4.setInit(initSegment);          // ftyp + moov (with mvex)
//   mp4.addFragment(bytes);            // any number of moof + mdat pairs, in order
//   const blob = mp4.toBlob();         // throws if the input could not be read: use mp4.fragmentBlobs()

class FaststartMp4 {
  constructor() {
    this.init = null;
    this.tracks = {};      // { [trackId]: { timescale, durations, sizes, cts, syncs, chunks, nextDts } }
    this.trex = {};        // { [trackId]: defaults for fragments }
    this.chunks = [];      // mdat contents in file order: { track, blob, start, size, count }
    this.fragments = [];   // Blob of each fragment (fallback: fragmented MP4 as received)
    this.error = null;
  }

  setInit(initSegment) {
    if (this.init) {
      if (!sameBytes(this.init, initSegment)) this.fail(new Error('init segment changed in the middle'));
      return;
    }
    this.init = new Uint8Array(initSegment);
    try {
      const view = viewOf(this.init);
      const moov = findBox(view, 0, this.init.byteLength, 'moov');
      if (!moov) throw new Error('no moov in init segment');
      for (const trak of boxesOf(view, moov.body, moov.end, 'trak')) {
        const tkhd = findBox(view, trak.body, trak.end, 'tkhd');
        const mdhd = findPath(view, trak, ['mdia', 'mdhd']);
        if (!tkhd || !mdhd) continue;
        const id = view.getUint32(tkhd.start + (view.getUint8(tkhd.start + 8) === 1 ? 28 : 20));
        const timescale = view.getUint32(mdhd.start + (view.getUint8(mdhd.start + 8) === 1 ? 28 : 20));
        this.tracks[id] = { id, timescale, durations: [], sizes: [], cts: [], syncs: [], chunks: [], nextDts: null };
      }
      const mvex = findBox(view, moov.body, moov.end, 'mvex');
      if (mvex) {
        for (const trex of boxesOf(view, mvex.body, mvex.end, 'trex')) {
          const o = trex.start + 12;
          this.trex[view.getUint32(o)] = { duration: view.getUint32(o + 8), size: view.getUint32(o + 12), flags: view.getUint32(o + 16) };
        }
      }
    } catch (e) {
      this.fail(e);
    }
  }

  addFragment(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const blob = new Blob([data]);
    this.fragments.push(blob);
    if (this.error) return;
    try {
      const view = viewOf(data);
      for (const box of boxesOf(view, 0, data.byteLength)) {
        if (box.type === 'moov') throw new Error('init segment inside the media');
        if (box.type === 'moof') this.readMoof(view, box, blob, data.byteLength);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  // A downloaded segment of fMP4 HLS: the init segment (EXT-X-MAP, possibly repeated) or media fragments
  addSegment(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let types = [];
    try { types = boxesOf(viewOf(data), 0, data.byteLength).map(b => b.type); } catch (e) {}
    if (types.includes('moov') && !types.includes('moof')) this.setInit(data);
    else this.addFragment(data);
  }

  readMoof(view, moof, blob, length) {
    let prevEnd = moof.start; // data base of a traf without explicit base: moof start, then end of the previous traf's data
    for (const traf of boxesOf(view, moof.body, moof.end, 'traf')) {
      const tfhd = findBox(view, traf.body, traf.end, 'tfhd');
      if (!tfhd) throw new Error('traf without tfhd');
      const tfFlags = view.getUint32(tfhd.start + 8) & 0xFFFFFF;
      const id = view.getUint32(tfhd.start + 12);
      const track = this.tracks[id];
      if (!track) throw new Error(`fragment of unknown track ${id}`);
      const defaults = { ...(this.trex[id] || { duration: 0, size: 0, flags: 0 }) };
      let p = tfhd.start + 16;
      let base = (tfFlags & 0x20000) ? moof.start : prevEnd;
      if (tfFlags & 0x1) { base = Number(view.getBigUint64(p)); p += 8; }
      if (tfFlags & 0x2) p += 4;
      if (tfFlags & 0x8) { defaults.duration = view.getUint32(p); p += 4; }
      if (tfFlags & 0x10) { defaults.size = view.getUint32(p); p += 4; }
      if (tfFlags & 0x20) { defaults.flags = view.getUint32(p); p += 4; }

      const tfdt = findBox(view, traf.body, traf.end, 'tfdt');
      if (tfdt) {
        const dts = view.getUint8(tfdt.start + 8) === 1 ? Number(view.getBigUint64(tfdt.start + 12)) : view.getUint32(tfdt.start + 12);
        this.alignTo(track, dts);
      } else if (track.nextDts === null) {
        track.nextDts = 0;
      }

      for (const trun of boxesOf(view, traf.body, traf.end, 'trun')) {
        const version = view.getUint8(trun.start + 8);
        const flags = view.getUint32(trun.start + 8) & 0xFFFFFF;
        const count = view.getUint32(trun.start + 12);
        let q = trun.start + 16;
        let dataStart = base;
        if (flags & 0x1) { dataStart = base + view.getInt32(q); q += 4; }
        let firstFlags = null;
        if (flags & 0x4) { firstFlags = view.getUint32(q); q += 4; }

        let size = 0;
        for (let i = 0; i < count; i++) {
          let d = defaults.duration, s = defaults.size, f = defaults.flags, c = 0;
          if (flags & 0x100) { d = view.getUint32(q); q += 4; }
          if (flags & 0x200) { s = view.getUint32(q); q += 4; }
          if (flags & 0x400) { f = view.getUint32(q); q += 4; }
          if (flags & 0x800) { c = version === 1 ? view.getInt32(q) : view.getUint32(q); q += 4; }
          if (i === 0 && firstFlags !== null) f = firstFlags;
          track.durations.push(d);
          track.sizes.push(s);
          track.cts.push(c);
          if (!(f & 0x10000)) track.syncs.push(track.sizes.length); // sample_is_non_sync_sample not set
          track.nextDts += d;
          size += s;
        }
        if (count === 0) continue;
        if (dataStart < 0 || dataStart + size > length) throw new Error('sample data outside the fragment');
        const chunk = { track: id, blob, start: dataStart, size, count };
        this.chunks.push(chunk);
        track.chunks.push(chunk);
        base = prevEnd = dataStart + size;
      }
    }
  }

  // Fragments carry their own start time; a regular MP4 only has durations.
  // Close gaps/overlaps between fragments by stretching/shrinking the previous sample.
  alignTo(track, dts) {
    if (track.nextDts === null) {
      track.nextDts = dts;
      return;
    }
    const diff = dts - track.nextDts;
    if (diff !== 0 && track.durations.length) {
      const last = track.durations.length - 1;
      const fixed = Math.max(1, track.durations[last] + diff);
      track.nextDts += fixed - track.durations[last];
      track.durations[last] = fixed;
    }
  }

  fail(e) {
    if (!this.error) this.error = e;
  }

  fragmentBlobs() {
    return this.init ? [this.init, ...this.fragments] : this.fragments;
  }

  toBlob() {
    if (this.error) throw this.error;
    if (!this.init) throw new Error('no init segment');
    if (!this.chunks.length) throw new Error('no samples');
    const ftyp = box('ftyp', strBytes('isom'), u32(0x200), strBytes('isom'), strBytes('iso2'), strBytes('avc1'), strBytes('mp41'));
    const mediaSize = this.chunks.reduce((sum, c) => sum + c.size, 0);

    // Chunk offsets depend on the moov size, which does not depend on their values (co64 is fixed size)
    const placeholder = this.buildMoov();
    let offset = ftyp.byteLength + placeholder.byteLength + 16;
    for (const c of this.chunks) {
      c.offset = offset;
      offset += c.size;
    }
    const moov = this.buildMoov();
    const mdatHeader = concat([u32(1), strBytes('mdat'), u64(16 + mediaSize)]);
    return new Blob([ftyp, moov, mdatHeader, ...this.chunks.map(c => c.blob.slice(c.start, c.start + c.size))], { type: 'video/mp4' });
  }

  // The init segment's moov without mvex, with durations and a sample table per track
  buildMoov() {
    const view = viewOf(this.init);
    const moov = findBox(view, 0, this.init.byteLength, 'moov');
    let movieScale = 90000;
    const mvhd = findBox(view, moov.body, moov.end, 'mvhd');
    if (mvhd) movieScale = view.getUint32(mvhd.start + (view.getUint8(mvhd.start + 8) === 1 ? 28 : 20));
    const mediaDuration = (t) => t.durations.reduce((a, b) => a + b, 0);
    const movieDuration = (t) => Math.round(mediaDuration(t) * movieScale / t.timescale);
    const movieTotal = Math.max(0, ...Object.values(this.tracks).map(movieDuration));

    let track = null;
    const rebuild = (start, end) => {
      const out = [];
      for (const b of boxesOf(view, start, end)) {
        if (b.type === 'mvex') continue;
        if (b.type === 'trak') {
          const tkhd = findBox(view, b.body, b.end, 'tkhd');
          const id = view.getUint32(tkhd.start + (view.getUint8(tkhd.start + 8) === 1 ? 28 : 20));
          track = this.tracks[id];
          if (!track || !track.sizes.length) continue; // declared but no samples: drop the track
          out.push(box('trak', ...rebuild(b.body, b.end)));
        } else if (b.type === 'mdia' || b.type === 'minf') {
          out.push(box(b.type, ...rebuild(b.body, b.end)));
        } else if (b.type === 'stbl') {
          const stsd = findBox(view, b.body, b.end, 'stsd');
          out.push(box('stbl', this.init.slice(stsd.start, stsd.end), ...sampleTable(track)));
        } else if (b.type === 'mvhd') {
          out.push(withField(this.init, b, 24, 32, movieTotal));
        } else if (b.type === 'tkhd') {
          out.push(withField(this.init, b, 28, 36, movieDuration(track)));
        } else if (b.type === 'mdhd') {
          out.push(withField(this.init, b, 24, 32, mediaDuration(track)));
        } else if (b.type === 'edts') {
          out.push(withEditDurations(this.init, b, movieDuration(track)));
        } else {
          out.push(this.init.slice(b.start, b.end));
        }
      }
      return out;
    };
    return box('moov', ...rebuild(moov.body, moov.end));
  }
}

// stts / ctts / stss / stsz / stsc / co64 of one track
function sampleTable(t) {
  const n = t.sizes.length;
  const runs = (values) => {
    const r = [];
    for (const v of values) {
      if (r.length && r[r.length - 1][1] === v) r[r.length - 1][0]++;
      else r.push([1, v]);
    }
    return r;
  };
  const out = [];
  const stts = runs(t.durations);
  out.push(fullBox('stts', 0, 0, u32(stts.length), ...stts.map(([c, d]) => concat([u32(c), u32(d)]))));
  if (t.cts.some(c => c !== 0)) {
    const ctts = runs(t.cts);
    const signed = t.cts.some(c => c < 0);
    out.push(fullBox('ctts', signed ? 1 : 0, 0, u32(ctts.length), ...ctts.map(([c, o]) => concat([u32(c), signed ? i32(o) : u32(o)]))));
  }
  if (t.syncs.length < n) {
    out.push(fullBox('stss', 0, 0, u32(t.syncs.length), ...t.syncs.map(u32)));
  }
  const sizes = new Uint8Array(n * 4);
  const sv = new DataView(sizes.buffer);
  t.sizes.forEach((s, i) => sv.setUint32(i * 4, s));
  out.push(fullBox('stsz', 0, 0, u32(0), u32(n), sizes));
  const stsc = [];
  t.chunks.forEach((c, i) => {
    if (!stsc.length || stsc[stsc.length - 1][1] !== c.count) stsc.push([i + 1, c.count]);
  });
  out.push(fullBox('stsc', 0, 0, u32(stsc.length), ...stsc.map(([first, count]) => concat([u32(first), u32(count), u32(1)]))));
  out.push(fullBox('co64', 0, 0, u32(t.chunks.length), ...t.chunks.map(c => u64(c.offset || 0))));
  return out;
}

// ---- box helpers

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Child boxes in [start, end): { type, start, body, end }
function boxesOf(view, start, end, type) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = view.getUint32(o);
    const t = String.fromCharCode(view.getUint8(o + 4), view.getUint8(o + 5), view.getUint8(o + 6), view.getUint8(o + 7));
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(o + 8)); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header || o + size > end) throw new Error(`broken box ${t}`);
    if (!type || t === type) out.push({ type: t, start: o, body: o + header, end: o + size });
    o += size;
  }
  return out;
}

function findBox(view, start, end, type) {
  return boxesOf(view, start, end, type)[0] || null;
}

function findPath(view, parent, path) {
  let cur = parent;
  for (const type of path) {
    cur = findBox(view, cur.body, cur.end, type);
    if (!cur) return null;
  }
  return cur;
}

// Copy of a full box with its duration field set (offset for version 0 / version 1)
function withField(bytes, b, offset0, offset1, value) {
  const out = bytes.slice(b.start, b.end);
  const view = viewOf(out);
  if (view.getUint8(8) === 1) view.setBigUint64(offset1, BigInt(value));
  else view.setUint32(offset0, Math.min(value, 0xFFFFFFFF));
  return out;
}

// Fragmented files leave edit durations 0 ("until the end"); a regular MP4 needs the real length
function withEditDurations(bytes, edts, duration) {
  const out = bytes.slice(edts.start, edts.end);
  const view = viewOf(out);
  const elst = findBox(view, 8, out.byteLength, 'elst');
  if (!elst) return out;
  const version = view.getUint8(elst.start + 8);
  const count = view.getUint32(elst.start + 12);
  for (let i = 0, o = elst.start + 16; i < count; i++, o += version === 1 ? 20 : 12) {
    if (i !== count - 1) continue;
    if (version === 1 && view.getBigUint64(o) === 0n) view.setBigUint64(o, BigInt(duration));
    if (version === 0 && view.getUint32(o) === 0) view.setUint32(o, Math.min(duration, 0xFFFFFFFF));
  }
  return out;
}

function box(type, ...parts) {
  const body = concat(parts);
  return concat([u32(8 + body.byteLength), strBytes(type), body]);
}

function fullBox(type, version, flags, ...parts) {
  return box(type, u32(((version & 0xFF) << 24 | (flags & 0xFFFFFF)) >>> 0), ...parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}

function i32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
}

function u64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v));
  return b;
}

function strBytes(s) {
  return new Uint8Array([...s].map(ch => ch.charCodeAt(0)));
}

function sameBytes(a, b) {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false;
  return true;
}

if (typeof module !== 'undefined') module.exports = { FaststartMp4 };
