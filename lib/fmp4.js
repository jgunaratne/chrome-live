/**
 * @fileoverview Regroups the Live Avatar fragmented-MP4 stream into whole
 * boxes.
 *
 * The Live Avatar model streams H.264 + AAC as fMP4 in `inlineData` slices.
 * Media Source Extensions can only start (or resume) at a box boundary, and a
 * player that joins late (the in-page video frame is recreated on every
 * navigation) needs the init segment (ftyp + moov). So the stream is regrouped
 * into the init segment, kept for late joiners, and whole fragments
 * (moof ... mdat).
 */

import {concatBytes} from './bytes.js';

/** Largest box accepted; anything bigger means the stream is corrupt. */
const MAX_BOX_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 8;
/** Box types a corrupt stream is resynchronized on. */
const RESYNC_TAGS = ['moof', 'ftyp'].map(
  (tag) => Array.from(tag, (c) => c.charCodeAt(0)),
);

export class Fmp4BoxAligner {
  constructor() {
    this.reset();
  }

  /** @return {?Uint8Array} The latest complete init segment (ftyp + moov). */
  get init() {
    return this._init;
  }

  reset() {
    /** Bytes not yet parsed into complete boxes. */
    this._pending = new Uint8Array(0);
    /** Complete boxes of the init segment being collected. */
    this._initParts = [];
    /** Complete media boxes waiting for the mdat that closes a fragment. */
    this._mediaParts = [];
    this._init = null;
    this._resyncing = false;
  }

  /**
   * @param {!Uint8Array} chunk The next slice of the stream.
   * @return {{init: ?Uint8Array, media: ?Uint8Array}} A newly completed init
   *     segment and/or whole fragments (both box-aligned), else nulls.
   */
  push(chunk) {
    if (chunk?.length) {
      this._pending = this._pending.length
        ? concatBytes([this._pending, chunk])
        : chunk;
    }
    const buf = this._pending;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let init = null;
    const media = [];
    let offset = 0;

    while (true) {
      if (this._resyncing) {
        const next = findResyncOffset(buf, offset);
        if (next < 0) {
          // Keep enough bytes for a box header split across slices.
          offset = Math.max(offset, buf.length - (HEADER_BYTES - 1));
          break;
        }
        offset = next;
        this._resyncing = false;
      }
      if (buf.length - offset < HEADER_BYTES) break;
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7],
      );
      if (size === 1) {
        if (buf.length - offset < 16) break;
        size = Number(view.getBigUint64(offset + 8));
        if (size < 16) size = 0;
      }
      if (size < HEADER_BYTES || size > MAX_BOX_BYTES) {
        console.warn(
          `[GLA] Corrupt MP4 box (type=${JSON.stringify(type)} size=${size}); resynchronizing`,
        );
        this._initParts = [];
        this._mediaParts = [];
        this._resyncing = true;
        offset += 1;
        continue;
      }
      if (buf.length - offset < size) break;
      const bytes = buf.subarray(offset, offset + size);
      offset += size;

      if (type === 'ftyp') {
        this._initParts = [bytes];
        this._mediaParts = [];
      } else if (type === 'moov') {
        this._initParts.push(bytes);
        init = concatBytes(this._initParts);
        this._init = init;
        this._initParts = [];
      } else {
        this._mediaParts.push(bytes);
        if (type === 'mdat') {
          media.push(...this._mediaParts);
          this._mediaParts = [];
        }
      }
    }

    // Copy the remainder so the (large) consumed buffer can be freed.
    this._pending = buf.slice(offset);
    return {init, media: media.length ? concatBytes(media) : null};
  }
}

/**
 * Offset of the next box header, after `from`, whose type the stream can
 * restart on; -1 if none yet.
 */
function findResyncOffset(buf, from) {
  let best = -1;
  for (const tag of RESYNC_TAGS) {
    for (let i = from + 4; i <= buf.length - 4; i++) {
      if (
        buf[i] === tag[0] && buf[i + 1] === tag[1] &&
        buf[i + 2] === tag[2] && buf[i + 3] === tag[3]
      ) {
        if (best < 0 || i - 4 < best) best = i - 4;
        break;
      }
    }
  }
  return best;
}
