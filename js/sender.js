'use strict';

class QRSender {
  constructor() {
    this.frames          = [];   // pre-rendered canvases
    this.frameIdx        = 0;
    this.cycleNum        = 1;
    this.fps             = 10;
    this.paused          = false;
    this.rafHandle       = null;
    this.lastAdvanceTime = 0;
    this.totalFrames     = 0;
    this.session         = '';
    this.qrSize          = 480;
    this.startTime       = null;

    this._bind();
  }

  _bind() {
    const dz = document.getElementById('dropzone');
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', ()  => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); this._onFile(e.dataTransfer.files[0]); });
    dz.addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', e => this._onFile(e.target.files[0]));

    document.querySelectorAll('.fps-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        this.fps = +btn.dataset.fps;
        document.querySelectorAll('.fps-btn').forEach(b => b.classList.toggle('active', b === btn));
        if (this.totalFrames) this._updateThroughput();
        if (!this.paused) this._scheduleNext();
      })
    );

    document.getElementById('pauseBtn').addEventListener('click',   () => this._togglePause());
    document.getElementById('restartBtn').addEventListener('click', () => this._restart());
  }

  async _onFile(file) {
    if (!file) return;
    this._clearError();
    this._setPhase('generating');

    this.session = QRFT.newSessionId();
    this.frames  = [];

    // Responsive QR size
    this.qrSize = Math.min(
      Math.floor(window.innerHeight * 0.72),
      Math.floor(window.innerWidth  * 0.90),
      520
    );
    const dst = document.getElementById('qrCanvas');
    dst.width = dst.height = this.qrSize;

    document.getElementById('genFileName').textContent = file.name;
    document.getElementById('genFileSize').textContent = this._fmtBytes(file.size);

    try {
      let data = new Uint8Array(await file.arrayBuffer());
      let compressed = false;

      if (document.getElementById('compressCheck').checked && typeof pako !== 'undefined') {
        const deflated = pako.deflate(data, { level: 6 });
        if (deflated.length < data.length) {          // only use if smaller
          data       = deflated;
          compressed = true;
          document.getElementById('compressInfo').textContent =
            `Compressed → ${this._fmtBytes(data.length)} (${Math.round(data.length/file.size*100)}%)`;
        }
      }

      const CHUNK = QRFT.CHUNK_BYTES;
      const total = Math.ceil(data.length / CHUNK);
      this.totalFrames = total;

      const meta = { name: file.name, size: file.size, comp: compressed, mime: file.type || 'application/octet-stream' };

      for (let i = 0; i < total; i++) {
        const chunk    = data.slice(i * CHUNK, (i + 1) * CHUNK);
        const payload  = QRFT.encodeFrame(i, total, this.session, i === 0 ? meta : null, chunk);
        let   canvas;
        try   { canvas = await this._makeQR(payload); }
        catch (e) { throw new Error(`QR gen failed frame ${i}: ${e.message}`); }
        this.frames.push(canvas);

        const pct = Math.round((i + 1) / total * 100);
        document.getElementById('genFill').style.width    = pct + '%';
        document.getElementById('genFill').textContent    = pct + '%';
        document.getElementById('genStatus').textContent  = `Frame ${i + 1} / ${total}`;

        if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
      }

      this._setPhase('streaming');
      this._startStream(file.name, file.size, total);

    } catch (err) {
      this._showError(err.message);
      this._setPhase('idle');
    }
  }

  _makeQR(data) {
    return new Promise((ok, fail) => {
      const c = document.createElement('canvas');
      QRCode.toCanvas(c, data, { errorCorrectionLevel: 'L', margin: 1, width: this.qrSize },
        err => err ? fail(err) : ok(c));
    });
  }

  _startStream(name, size, total) {
    this.frameIdx        = 0;
    this.cycleNum        = 1;
    this.paused          = false;
    this.startTime       = performance.now();
    this.lastAdvanceTime = performance.now();

    document.getElementById('streamName').textContent    = name;
    document.getElementById('streamSize').textContent    = this._fmtBytes(size);
    document.getElementById('streamTotal').textContent   = total;
    document.getElementById('sessionBadge').textContent  = this.session;
    document.getElementById('pauseBtn').innerHTML        = '<i class="bi bi-pause-fill"></i> Pause';

    this._updateThroughput();
    this._showFrame(0);
    this._scheduleNext();
  }

  _scheduleNext() {
    if (this.rafHandle) { cancelAnimationFrame(this.rafHandle); this.rafHandle = null; }
    if (!this.paused)   this.rafHandle = requestAnimationFrame(ts => this._rafLoop(ts));
  }

  _rafLoop(ts) {
    if (this.paused) { this.rafHandle = null; return; }
    if (ts - this.lastAdvanceTime >= 1000 / this.fps) {
      this.lastAdvanceTime = ts;
      this.frameIdx++;
      if (this.frameIdx >= this.totalFrames) { this.frameIdx = 0; this.cycleNum++; }
      this._showFrame(this.frameIdx);
    }
    this.rafHandle = requestAnimationFrame(ts2 => this._rafLoop(ts2));
  }

  _showFrame(idx) {
    const dst = document.getElementById('qrCanvas');
    const ctx = dst.getContext('2d');
    ctx.clearRect(0, 0, dst.width, dst.height);
    ctx.drawImage(this.frames[idx], 0, 0, dst.width, dst.height);

    const pad = String(this.totalFrames).length;
    document.getElementById('frameCounter').textContent =
      `${String(idx + 1).padStart(pad, '0')} / ${this.totalFrames}`;
    document.getElementById('cycleCounter').textContent  = `Cycle ${this.cycleNum}`;
    document.getElementById('cycleFill').style.width     = ((idx + 1) / this.totalFrames * 100) + '%';

    const elapsed = (performance.now() - this.startTime) / 1000;
    const kbs     = (QRFT.CHUNK_BYTES * this.fps / 1024).toFixed(1);
    const etaSec  = this.totalFrames / this.fps;
    document.getElementById('speedStat').textContent = `~${kbs} KB/s`;
    document.getElementById('etaStat').textContent   = `~${this._fmtSec(etaSec)}`;
    document.getElementById('fpsStat').textContent   = `${this.fps} fps`;
    document.getElementById('elapsedStat').textContent = `${elapsed.toFixed(0)}s`;

    const wrap = document.getElementById('qrWrap');
    wrap.classList.remove('qr-flash');
    void wrap.offsetWidth;
    wrap.classList.add('qr-flash');
  }

  _updateThroughput() {
    const kbs    = (QRFT.CHUNK_BYTES * this.fps / 1024).toFixed(1);
    const etaSec = this.totalFrames / this.fps;
    document.getElementById('throughputInfo').textContent =
      `Session ${this.session} · ~${kbs} KB/s · ETA ~${this._fmtSec(etaSec)}`;
  }

  _togglePause() {
    this.paused = !this.paused;
    document.getElementById('pauseBtn').innerHTML = this.paused
      ? '<i class="bi bi-play-fill"></i> Resume'
      : '<i class="bi bi-pause-fill"></i> Pause';
    if (!this.paused) { this.lastAdvanceTime = performance.now(); this._scheduleNext(); }
  }

  _restart() {
    if (this.rafHandle) { cancelAnimationFrame(this.rafHandle); this.rafHandle = null; }
    this.frames = [];  this.frameIdx = 0;  this.cycleNum = 1;  this.paused = false;
    document.getElementById('fileInput').value = '';
    document.getElementById('compressInfo').textContent = '';
    this._setPhase('idle');
  }

  _setPhase(p) {
    ['idle','generating','streaming'].forEach(ph =>
      document.getElementById(ph + 'Phase').style.display = p === ph ? '' : 'none');
  }
  _showError(msg) {
    const el = document.getElementById('errorMsg');
    el.style.display = msg ? '' : 'none';
    el.textContent   = msg;
  }
  _clearError() { this._showError(''); }

  _fmtBytes(b) {
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

document.addEventListener('DOMContentLoaded', () => new QRSender());
