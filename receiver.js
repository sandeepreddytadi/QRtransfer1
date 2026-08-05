'use strict';

const SCAN_W = 720;

class QRReceiver {
  constructor() {
    this.session = null;
    this.decoder = null;
    this.sourceBlocks = 0;
    this.blockLen = 0;
    this.expectedPayloadCrc = 0;
    this.totalPayloadLen = 0;
    this.solvedCount = 0;

    this.scanning = true;
    this.locked = false;
    this.videoStream = null;
    this.workers = [];
    this.workerBusy = [];
    this.workerCount = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

    this.transferStart = null;
    this.bytesTotal = 0;
    this.targetCamFps = 60;
    this.actualCamFps = 0;

    this.capCount = 0;
    this.decCount = 0;
    this.lastStatTs = 0;

    this.fpsSamples = [];
    this.lastSeenSeq = null;
    this.lastSeenTime = null;

    const canvas = document.getElementById('scanCanvas');
    this.scanCtx = canvas.getContext('2d', { willReadFrequently: true });

    document.getElementById('startBtn').addEventListener('click', () => this._startCamera());
    document.getElementById('tryAgainBtn').addEventListener('click', () => location.reload());
  }

  async _initWorkerPool() {
    try {
      const jsqrSrc = await fetch('libs/jsQR.min.js').then(r => r.text());
      const src = jsqrSrc + `
self.onmessage = function(e) {
  const r = jsQR(new Uint8ClampedArray(e.data.buf), e.data.w, e.data.h,
                 { inversionAttempts: 'attemptBoth' });
  if (!r) {
    self.postMessage({ hit: false });
    return;
  }
  self.postMessage({ hit: true, data: r.data, bin: r.binaryData || null });
};`;
      const blob = new Blob([src], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      for (let i = 0; i < this.workerCount; i++) {
        const worker = new Worker(url);
        this.workers.push(worker);
        this.workerBusy.push(false);
        worker.onmessage = (e) => {
          this.workerBusy[i] = false;
          this.decCount++;
          if (e.data?.hit) this._processFrame(e.data.data, e.data.bin);
        };
        worker.onerror = () => { this.workerBusy[i] = false; };
      }
      URL.revokeObjectURL(url);
    } catch {
      this.workers = [];
      this.workerBusy = [];
    }
  }

  async _startCamera() {
    try {
      const baseVideo = {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      };
      try {
        this.videoStream = await navigator.mediaDevices.getUserMedia({
          video: { ...baseVideo, frameRate: { exact: this.targetCamFps } }
        });
      } catch {
        try {
          this.videoStream = await navigator.mediaDevices.getUserMedia({
            video: { ...baseVideo, frameRate: { ideal: this.targetCamFps } }
          });
        } catch {
          this.videoStream = await navigator.mediaDevices.getUserMedia({ video: baseVideo });
        }
      }

      const v = document.getElementById('video');
      v.srcObject = this.videoStream;
      await v.play();
      this.actualCamFps = this._readActualCameraFps();

      await this._initWorkerPool();
      this._setPhase('scanning');
      requestAnimationFrame(ts => this._scanLoop(ts));
    } catch (e) {
      const hint = location.protocol === 'file:'
        ? ' - Open via HTTPS or use Firefox for file:// camera access.' : '';
      this._showError('Camera error: ' + e.message + hint);
    }
  }

  _scanLoop(ts) {
    if (!this.scanning) return;

    const v = document.getElementById('video');
    const c = document.getElementById('scanCanvas');

    if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
      this.capCount++;
      const sw = Math.min(v.videoWidth, SCAN_W);
      const sh = Math.round(v.videoHeight * sw / v.videoWidth);
      if (c.width !== sw) c.width = sw;
      if (c.height !== sh) c.height = sh;

      if (this.workers.length) {
        const slot = this.workerBusy.indexOf(false);
        if (slot !== -1) {
          this.scanCtx.drawImage(v, 0, 0, sw, sh);
          const img = this.scanCtx.getImageData(0, 0, sw, sh);
          this.workerBusy[slot] = true;
          this.workers[slot].postMessage({ buf: img.data.buffer, w: sw, h: sh }, [img.data.buffer]);
        }
      } else {
        this.scanCtx.drawImage(v, 0, 0, sw, sh);
        const img = this.scanCtx.getImageData(0, 0, sw, sh);
        this.decCount++;
        const code = jsQR(img.data, sw, sh, { inversionAttempts: 'attemptBoth' });
        if (code) this._processFrame(code.data, code.binaryData || null);
      }
    }

    if (!this.lastStatTs) this.lastStatTs = ts;
    if (ts - this.lastStatTs >= 1000) {
      const dt = ts - this.lastStatTs;
      this._refreshStats(
        Math.round(this.capCount * 1000 / dt),
        Math.round(this.decCount * 1000 / dt)
      );
      this.capCount = 0;
      this.decCount = 0;
      this.lastStatTs = ts;
    }

    requestAnimationFrame(ts2 => this._scanLoop(ts2));
  }

  _processFrame(raw, rawBinary) {
    let frame = null;
    if (rawBinary && rawBinary.length) {
      frame = QRFT.parseFountainFrameBytes(rawBinary instanceof Uint8Array ? rawBinary : new Uint8Array(rawBinary));
    }
    if (!frame && raw) frame = QRFT.parseFountainFrame(raw);
    if (!frame) return;

    const now = performance.now();
    if (this.lastSeenSeq !== null) {
      const seqGap = frame.seq !== this.lastSeenSeq ? 1 : 0;
      if (seqGap) {
        const iv = now - this.lastSeenTime;
        if (iv > 5 && iv < 5000) {
          this.fpsSamples.push(iv);
          if (this.fpsSamples.length > 10) this.fpsSamples.shift();
          if (this.fpsSamples.length >= 3) {
            const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
            this._setPill('pillSenderFps', `TX ~${Math.round(1000 / avg)} fps`, true);
          }
        }
      }
    }
    this.lastSeenSeq = frame.seq;
    this.lastSeenTime = now;

    if (!this.session || this.session !== frame.session) {
      this.session = frame.session;
      this.sourceBlocks = frame.k;
      this.blockLen = frame.blockLen;
      this.totalPayloadLen = frame.totalLen;
      this.expectedPayloadCrc = frame.payloadCrc >>> 0;
      this.decoder = new QRFT.LTDecoder(frame.k, frame.blockLen, frame.session, frame.totalLen);
      this.transferStart = performance.now();
      this.bytesTotal = 0;
      this.solvedCount = 0;
      this._buildGrid(frame.k);
      this._lockOn(frame.session);
      document.getElementById('rxFileName').textContent = 'Detecting...';
      document.getElementById('rxFileSize').textContent = '';
      document.getElementById('crcFailCount').textContent = '0';
    }

    if (!this.decoder) return;
    const solvedNow = this.decoder.addFrame(frame.seq, frame.block);
    if (solvedNow.length) {
      this._flash();
      solvedNow.forEach(idx => this._setCell(idx, 'received'));
      this.solvedCount = this.decoder.solvedCount;
      this.bytesTotal = Math.min(this.totalPayloadLen, this.decoder.framesNew * this.blockLen / QRFT.FOUNTAIN_OVER);
      this._updateProgress();
    }

    if (this.decoder.isComplete) this._finalize();
  }

  _lockOn(session) {
    this.locked = true;
    const el = document.getElementById('lockStatus');
    el.className = 'alert alert-success py-2 mb-2';
    el.innerHTML = `Locked - Session <span class="badge-session">${session}</span>`;

    try {
      const track = this.videoStream?.getVideoTracks()[0];
      if (track?.getCapabilities) {
        const caps = track.getCapabilities();
        const adv = {};
        if (caps.focusMode?.includes('manual')) adv.focusMode = 'manual';
        if (caps.exposureMode?.includes('manual')) adv.exposureMode = 'manual';
        if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => {});
      }
    } catch {}
  }

  _finalize() {
    this.scanning = false;
    this.workers.forEach(w => w.terminate());
    this.workers = [];
    this.workerBusy = [];
    if (this.videoStream) this.videoStream.getTracks().forEach(t => t.stop());

    const payload = this.decoder?.assemble();
    if (!payload) {
      this._showError('Fountain decode incomplete.');
      return;
    }
    if ((QRFT.crc32(payload) >>> 0) !== this.expectedPayloadCrc) {
      this._showError('Payload CRC mismatch. Keep scanning a bit longer and retry.');
      return;
    }

    const unpacked = QRFT.unpackPayload(payload);
    if (!unpacked) {
      this._showError('Recovered payload format is invalid.');
      return;
    }

    const meta = unpacked.meta || {};
    let finalBuf = unpacked.dataBytes;
    if (meta.comp && typeof pako !== 'undefined') {
      try { finalBuf = pako.inflate(unpacked.dataBytes); }
      catch (e) { this._showError('Decompress failed: ' + e.message); return; }
    }

    const blob = new Blob([finalBuf], { type: meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name || 'received_file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 15000);

    const elapsed = ((performance.now() - this.transferStart) / 1000).toFixed(1);
    const speed = (finalBuf.length / 1024 / +elapsed).toFixed(1);
    document.getElementById('rxFileName').textContent = meta.name || 'received_file';
    document.getElementById('rxFileSize').textContent = this._fmtBytes(meta.size || finalBuf.length);
    document.getElementById('doneDetails').textContent =
      `${meta.name || 'file'} · ${this._fmtBytes(finalBuf.length)} · ` +
      `${this.decoder.framesNew} coded frames · ${elapsed}s · ${speed} KB/s avg`;
    this._setPhase('done');
  }

  _buildGrid(total) {
    const grid = document.getElementById('frameGrid');
    const small = total > 200;
    grid.innerHTML = '';

    const limit = Math.min(total, 2000);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < limit; i++) {
      const d = document.createElement('div');
      d.className = 'frame-cell' + (small ? ' sm' : '');
      d.id = `fc${i}`;
      d.title = `Block ${i + 1}`;
      if (!small) d.textContent = i + 1;
      frag.appendChild(d);
    }
    if (total > 2000) {
      const note = document.createElement('div');
      note.className = 'text-muted small mt-1 w-100';
      note.textContent = `+${total - 2000} blocks not shown`;
      frag.appendChild(note);
    }
    grid.appendChild(frag);

    document.getElementById('totalFramesCount').textContent = total;
    document.getElementById('missingCount').textContent = total;
  }

  _setCell(idx, status) {
    if (idx >= 2000) return;
    const el = document.getElementById(`fc${idx}`);
    if (!el) return;
    el.classList.remove('received', 'crc-fail', 'in-progress');
    el.classList.add(status);
  }

  _updateProgress() {
    const total = Math.max(1, this.sourceBlocks);
    const pct = Math.round(this.solvedCount / total * 100);
    const miss = Math.max(0, total - this.solvedCount);
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressBar').textContent = pct + '%';
    document.getElementById('receivedCount').textContent = this.solvedCount;
    document.getElementById('missingCount').textContent = miss;

    if (this.locked) {
      document.getElementById('lockStatus').innerHTML =
        `Locked ${this.solvedCount}/${total} blocks · ${pct}% · ` +
        `<span class="badge-session">${this.session}</span>`;
    }
  }

  _refreshStats(capFps, decFps) {
    const camInfo = this.actualCamFps > 0 ? `cam ${this.actualCamFps} fps` : 'cam ?';
    this._setPill('pillCap', `Capture ${capFps}/s · ${camInfo}`);
    this._setPill('pillDec', `Decode ${decFps}/s`, decFps > 0);

    if (this.transferStart && this.bytesTotal > 0) {
      const secs = (performance.now() - this.transferStart) / 1000;
      const kbs = (this.bytesTotal / 1024 / secs).toFixed(1);
      this._setPill('pillSpeed', `Speed ${kbs} KB/s`, true);
      if (this.sourceBlocks > 0) {
        const pct = this.solvedCount / this.sourceBlocks;
        const rem = pct > 0.01 ? secs / pct - secs : null;
        this._setPill('pillEta', rem > 0.5 ? `ETA ~${this._fmtSec(rem)}` : 'ETA finishing...', true);
      }
    }
  }

  _setPill(id, text, live = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('live', live);
  }

  _flash() {
    const el = document.getElementById('camFlash');
    if (!el) return;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  _setPhase(p) {
    const phaseIds = { idle: 'idlePhase', scanning: 'scanPhase', done: 'donePhase' };
    Object.entries(phaseIds).forEach(([phase, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = p === phase ? '' : 'none';
    });
  }

  _showError(msg) {
    const el = document.getElementById('errorMsg');
    el.style.display = msg ? '' : 'none';
    el.textContent = msg;
  }

  _readActualCameraFps() {
    const track = this.videoStream?.getVideoTracks?.()[0];
    const fps = track?.getSettings?.().frameRate;
    return fps ? Math.round(fps) : 0;
  }

  _fmtBytes(b) {
    if (!b || b < 0) return '?';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  _fmtSec(s) {
    s = Math.round(s);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
}

document.addEventListener('DOMContentLoaded', () => new QRReceiver());