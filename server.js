'use strict';
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const PORT       = 3000;
const HTTPS_PORT = 3443;
const PFX_PATH   = path.join(__dirname, 'server.pfx');
const PFX_PASS   = 'qrft2026';

/* ── MIME types ─────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
  '.pfx':  null,   // block cert file
};

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const iface of ifaces)
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

/* ── General static file server ─────────────────────────────── */
function serveStatic(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (mime === null) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime || 'application/octet-stream' });
    res.end(data);
  });
}

/* ── Request handler ─────────────────────────────────────────── */
function requestHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Only handle GET for static files
  if (req.method === 'GET') {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.resolve(__dirname, '.' + urlPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    serveStatic(res, filePath);
    return;
  }

  res.writeHead(405); res.end('Method not allowed');
}

/* ── HTTP server ─────────────────────────────────────────────── */
const server = http.createServer(requestHandler);
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║            QR File Transfer v2                    ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  This PC  →  http://localhost:${PORT}                ║`);
  console.log(`║  Phone    →  https://${ip}:${HTTPS_PORT}        ║`);
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log('\n  Open the https:// URL on the phone (tap Advanced → Proceed)\n');
});

/* ── HTTPS server (allows camera in Chrome on phones) ───────── */
if (fs.existsSync(PFX_PATH)) {
  https.createServer(
    { pfx: fs.readFileSync(PFX_PATH), passphrase: PFX_PASS },
    requestHandler
  ).listen(HTTPS_PORT, '0.0.0.0');
} else {
  console.warn('⚠  server.pfx not found — HTTPS disabled (camera may not work in Chrome on phone).');
}
