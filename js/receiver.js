'use strict';

const SCAN_W = 640; // downsample width before jsQR — 4× faster than 1280

class QRReceiver {
  constructor() {
    this.session       = null;
    this.totalFrames   = null;
    this.received      = new Map();  // idx → Uint8Array (good frames)
    this.crcFailed     = new Set();  // idx of CRC-fail frames
    this.receivedCount = 0;
    this.scanning      = true;
    this.locked        = false;
    this.videoStream   = null;
    this.meta          = null;
    this.worker        = null;
    this.workerBusy    = false;
    this.transferStart = null;
    this.bytesTotal    = 0;

    this.capCount  = 0;
    this.decCount  = 0;
    this.lastStatTs = 0;

    this.fpsSamples  = [];
    this.lastSeenIdx  = null;
    this.lastSeenTime = null;

    const canvas   = document.getElementById('scanCanvas');
    this.scanCtx   = canvas.getContext('2d', { willReadFrequently: true });

    document.getElementById('startBtn').addEventListener('click', () => this._startCamera());
    document.getElementById('tryAgainBtn').addEventListener('click', () => location.reload());
  }

  /* ── Worker init ──────────────────────────────────────────── */
  async _initWorker() {
    try {
      // Fetch the jsQR source so we can run it inside a Blob worker
      const jsqrSrc = await fetch('libs/jsQR.min.js').then(r => r.text());
      const src = jsqrSrc + `
self.onmessage = function(e) {
  const r = jsQR(new Uint8ClampedArray(e.data.buf), e.data.w, e.data.h,
                 { inversionAttempts: 'attemptBoth' });
  self.postMessage(r ? r.data : null);
};`;
      const blob  = new Blob([src], { type: 'text/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob));
      this.worker.onmessage = e => {
        this.workerBusy = false;
        if (e.data) { this.decCount++; this._processFrame(e.data); }
      };
      this.worker.onerror = () => { this.worker = null; this.workerBusy = false; };
    } catch { this.worker = null; }
  }

  /* ── Camera ───────────────────────────────────────────────── */
  async _startCamera() {
    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' },
                 width: { ideal: 1280 }, height: { ideal: 720 },
                 frameRate: { ideal: 60 } }
      });
      const v = document.getElementById('video');
      v.srcObject = this.videoStream;
      await v.play();
      await this._initWorker();
      this._setPhase('scanning');
      requestAnimationFrame(ts => this._scanLoop(ts));
    } catch (e) {
      const hint = location.protocol === 'file:'
        ? ' — Open via HTTPS or use Firefox for file:// camera access.' : '';
      this._showError('Camera error: ' + e.message + hint);
    }
  }

  /* ── Scan loop ────────────────────────────────────────────── */
  _scanLoop(ts) {
    if (!this.scanning) return;

    const v = document.getElementById('video');
    const c = document.getElementById('scanCanvas');

    if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
      this.capCount++;
      const sw = Math.min(v.videoWidth, SCAN_W);
      const sh = Math.round(v.videoHeight * sw / v.videoWidth);
      if (c.width !== sw)  c.width  = sw;
      if (c.height !== sh) c.height = sh;

      if (!this.workerBusy) {
        this.scanCtx.drawImage(v, 0, 0, sw, sh);
        const img = this.scanCtx.getImageData(0, 0, sw, sh);
        if (this.worker) {
          this.workerBusy = true;
          this.worker.postMessage({ buf: img.data.buffer, w: sw, h: sh }, [img.data.buffer]);
        } else {
          // Main-thread fallback
          const code = jsQR(img.data, sw, sh, { inversionAttempts: 'attemptBoth' });
          if (code) { this.decCount++; this._processFrame(code.data); }
        }
      }
    }

    if (!this.lastStatTs) this.lastStatTs = ts;
    if (ts - this.lastStatTs >= 1000) {
      const dt = ts - this.lastStatTs;
      this._refreshStats(Math.round(this.capCount * 1000 / dt),
                         Math.round(this.decCount  * 1000 / dt));
      this.capCount = this.decCount = 0;
      this.lastStatTs = ts;
    }

    requestAnimationFrame(ts2 => this._scanLoop(ts2));
  }

  /* ── Frame processing ─────────────────────────────────────── */
  _processFrame(raw) {
    const frame = QRFT.parseFrame(raw);
    if (!frame) return;

    const { idx, total, session, meta, chunkBytes, crcValid } = frame;

    // Sender FPS detection
    const now = performance.now();
    if (this.lastSeenIdx !== null && this.totalFrames) {
      const gap = ((idx - this.lastSeenIdx) % this.totalFrames + this.totalFrames) % this.totalFrames;
      if (gap >= 1 && gap <= 4) {
        const iv = (now - this.lastSeenTime) / gap;
        if (iv > 5 && iv < 5000) {
          this.fpsSamples.push(iv);
          if (this.fpsSamples.length > 10) this.fpsSamples.shift();
          if (this.fpsSamples.length >= 3) {
            const avg = this.fpsSamples.reduce((a, b) => a + b) / this.fpsSamples.length;
            this._setPill('pillSenderFps', `📡 ~${Math.round(1000 / avg)} fps`, true);
          }
        }
      }
    }
    this.lastSeenIdx  = idx;
    this.lastSeenTime = now;

    // Bind session on first frame
    if (!this.session) {
      this.session     = session;
      this.totalFrames = total;
      this.transferStart = performance.now();
      this._buildGrid(total);
      if (meta) {
        this.meta = meta;
        document.getElementById('rxFileName').textContent = meta.name;
        document.getElementById('rxFileSize').textContent = this._fmtBytes(meta.size);
      }
      this._lockOn(session);
    } else if (this.session !== session) {
      return; // ignore different transfer
    }

    // Skip already-received good frame
    if (this.received.has(idx) && !this.crcFailed.has(idx)) return;

    // CRC verification
    if (!crcValid) {
      this.crcFailed.add(idx);
      this._setCell(idx, 'crc-fail');
      document.getElementById('crcFailCount').textContent = this.crcFailed.size;
      return;
    }

    // Store frame
    if (!this.received.has(idx)) {
      this.received.set(idx, chunkBytes);
      this.crcFailed.delete(idx);
      this.bytesTotal += chunkBytes.length;
      this.receivedCount++;
    }

    this._flash();
    this._setCell(idx, 'received');
    this._updateProgress();

    if (this.receivedCount >= total) this._finalize();
  }

  /* ── Lock (first frame received) ──────────────────────────── */
  _lockOn(session) {
    this.locked = true;
    const el = document.getElementById('lockStatus');
    el.className = 'alert alert-success py-2 mb-2';
    el.innerHTML = `🔒 <strong>Locked</strong> — Session <span class="badge-session">${session}</span>`;

    // Attempt to freeze autofocus to prevent hunting blur
    try {
      const track = this.videoStream?.getVideoTracks()[0];
      if (track?.getCapabilities) {
        const caps = track.getCapabilities();
        const adv = {};
        if (caps.focusMode?.includes('manual'))   adv.focusMode   = 'manual';
        if (caps.exposureMode?.includes('manual')) adv.exposureMode = 'manual';
        if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => {});
      }
    } catch {}
  }

  /* ── Finalize: reassemble → decompress → download ─────────── */
  _finalize() {
    this.scanning = false;
    if (this.worker)      { this.worker.terminate(); this.worker = null; }
    if (this.videoStream) this.videoStream.getTracks().forEach(t => t.stop());

    // Assemble chunks in order
    let sz = 0;
    for (let i = 0; i < this.totalFrames; i++) if (this.received.has(i)) sz += this.received.get(i).length;
    const buf = new Uint8Array(sz);
    let off = 0;
    for (let i = 0; i < this.totalFrames; i++) {
      if (this.received.has(i)) { buf.set(this.received.get(i), off); off += this.received.get(i).length; }
    }

    let finalBuf = buf;
    if (this.meta?.comp && typeof pako !== 'undefined') {
      try { finalBuf = pako.inflate(buf); }
      catch (e) { this._showError('Decompress failed: ' + e.message); return; }
    }

    const blob = new Blob([finalBuf], { type: this.meta?.mime || 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = this.meta?.name || 'received_file';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 15000);

    const elapsed = ((performance.now() - this.transferStart) / 1000).toFixed(1);
    const speed   = (sz / 1024 / +elapsed).toFixed(1);
    document.getElementById('doneDetails').textContent =
      `${this.meta?.name || 'file'} · ${this._fmtBytes(finalBuf.length)} · ` +
      `${this.totalFrames} frames · ${elapsed}s · ${speed} KB/s avg`;
    this._setPhase('done');
  }

  /* ── Frame grid ───────────────────────────────────────────── */
  _buildGrid(total) {
    const grid  = document.getElementById('frameGrid');
    const small = total > 200;
    grid.innerHTML = '';

    const limit = Math.min(total, 2000);
    const frag  = document.createDocumentFragment();

    for (let i = 0; i < limit; i++) {
      const d = document.createElement('div');
      d.className  = 'frame-cell' + (small ? ' sm' : '');
      d.id         = `fc${i}`;
      d.title      = `Frame ${i + 1}`;
      if (!small)  d.textContent = i + 1;
      frag.appendChild(d);
    }
    if (total > 2000) {
      const note = document.createElement('div');
      note.className = 'text-muted small mt-1 w-100';
      note.textContent = `+${total - 2000} frames not shown`;
      frag.appendChild(note);
    }
    grid.appendChild(frag);

    document.getElementById('totalFramesCount').textContent = total;
    document.getElementById('missingCount').textContent     = total;
  }

  _setCell(idx, status) {
    if (idx >= 2000) return;
    const el = document.getElementById(`fc${idx}`);
    if (!el) return;
    // Remove previous state classes
    el.classList.remove('received', 'crc-fail', 'in-progress');
    el.classList.add(status);
  }

  _updateProgress() {
    const pct  = Math.round(this.receivedCount / this.totalFrames * 100);
    const miss = this.totalFrames - this.receivedCount;
    document.getElementById('progressBar').style.width  = pct + '%';
    document.getElementById('progressBar').textContent  = pct + '%';
    document.getElementById('receivedCount').textContent = this.receivedCount;
    document.getElementById('missingCount').textContent  = miss;

    if (this.locked) {
      document.getElementById('lockStatus').innerHTML =
        `🔒 <strong>${this.receivedCount}/${this.totalFrames}</strong> frames · ${pct}% · ` +
        `<span class="badge-session">${this.session}</span>`;
    }
  }

  _refreshStats(capFps, decFps) {
    this._setPill('pillCap',   `📷 ${capFps}/s`);
    this._setPill('pillDec',   `🔍 ${decFps}/s`, decFps > 0);

    if (this.transferStart && this.bytesTotal > 0) {
      const secs = (performance.now() - this.transferStart) / 1000;
      const kbs  = (this.bytesTotal / 1024 / secs).toFixed(1);
      this._setPill('pillSpeed', `⚡ ${kbs} KB/s`, true);
      if (this.totalFrames) {
        const pct = this.receivedCount / this.totalFrames;
        const rem = pct > 0.01 ? secs / pct - secs : null;
        this._setPill('pillEta', rem > 0.5 ? `⏱ ~${this._fmtSec(rem)}` : '⏱ finishing…', true);
      }
    }
  }

  /* ── Helpers ──────────────────────────────────────────────── */
  _setPill(id, text, live = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('live', live);
  }

  _flash() {
    const el = document.getElementById('camFlash');
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }

  _setPhase(p) {
    ['idle','scanning','done'].forEach(ph =>
      document.getElementById(ph + 'Phase').style.display = p === ph ? '' : 'none');
  }

  _showError(msg) {
    const el = document.getElementById('errorMsg');
    el.style.display = msg ? '' : 'none';
    el.textContent   = msg;
  }

  _fmtBytes(b) {
    if (!b || b < 0) return '?';
    if (b < 1024)       return b + ' B';
    if (b < 1048576)    return (b/1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b/1048576).toFixed(2) + ' MB';
    return (b/1073741824).toFixed(2) + ' GB';
  }

  _fmtSec(s) {
    s = Math.round(s);
    if (s < 60)   return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
    return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
  }
}

document.addEventListener('DOMContentLoaded', () => new QRReceiver());
