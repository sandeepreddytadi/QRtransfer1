/**
 * QRFT Protocol v2 — shared constants, CRC32, encode/decode helpers
 */
'use strict';

const QRFT = (() => {

  /* ── CRC32 (IEEE 802.3) ──────────────────────────────────────── */
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++)
      crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ── Binary ↔ Base64 ────────────────────────────────────────── */
  function u8ToB64(bytes) {
    // Use chunks to avoid call-stack overflow on large arrays
    const CHUNK = 8192;
    let s = '';
    for (let i = 0; i < bytes.length; i += CHUNK)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ── Protocol constants ─────────────────────────────────────── */
  const PREFIX      = 'QRFT2';
  const VERSION     = 2;
  const CHUNK_BYTES = 800; // max bytes of (compressed) data per QR frame

  /* ── Frame format ───────────────────────────────────────────────
   * QRFT2|{idx4hex}/{tot4hex}|{session8hex}|{metaB64_or_empty}|{crc8hex}|{dataB64}
   * ─────────────────────────────────────────────────────────────── */

  /**
   * @param {number}      idx        0-based frame index
   * @param {number}      total      total frame count
   * @param {string}      session    8-char hex session ID
   * @param {object|null} meta       JSON meta object (frame 0 only), or null
   * @param {Uint8Array}  chunkBytes raw chunk bytes
   * @returns {string} QR payload string
   */
  function encodeFrame(idx, total, session, meta, chunkBytes) {
    const idxHex  = idx.toString(16).padStart(4, '0');
    const totHex  = total.toString(16).padStart(4, '0');
    const crcHex  = crc32(chunkBytes).toString(16).padStart(8, '0');
    const metaStr = meta ? btoa(JSON.stringify(meta)) : '';
    const dataB64 = u8ToB64(chunkBytes);
    return `${PREFIX}|${idxHex}/${totHex}|${session}|${metaStr}|${crcHex}|${dataB64}`;
  }

  /**
   * Parse a QR payload string.
   * @returns {{ idx, total, session, meta, chunkBytes, crcValid, raw }} or null
   */
  function parseFrame(raw) {
    if (!raw.startsWith(PREFIX + '|')) return null;
    const parts = raw.split('|');
    if (parts.length < 6) return null;

    const [, indices, session, metaB64, crcHex, dataB64] = parts;
    const slash = indices.indexOf('/');
    if (slash < 0) return null;

    const idx   = parseInt(indices.slice(0, slash), 16);
    const total = parseInt(indices.slice(slash + 1), 16);
    if (isNaN(idx) || isNaN(total) || total === 0) return null;

    let meta = null;
    if (metaB64) { try { meta = JSON.parse(atob(metaB64)); } catch {} }

    let chunkBytes = null, crcValid = false;
    try {
      chunkBytes = b64ToU8(dataB64);
      crcValid   = crc32(chunkBytes).toString(16).padStart(8, '0') === crcHex.toLowerCase();
    } catch {}

    return { idx, total, session, meta, chunkBytes, crcValid };
  }

  /** 8-char random hex session ID */
  function newSessionId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  /* ── Public API ─────────────────────────────────────────────── */
  return { PREFIX, VERSION, CHUNK_BYTES, crc32, u8ToB64, b64ToU8, encodeFrame, parseFrame, newSessionId };
})();
