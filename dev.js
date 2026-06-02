#!/usr/bin/env node
'use strict';
/* Zero-dependency live-reload dev server for the Reckon PWA.
   NOT for production — a local tool so you can see changes without committing.

   It serves your working tree, so it is hardened deliberately:
   - Binds 127.0.0.1 by default (no network exposure). Pass --lan to ALSO listen
     on your LAN so a phone can load it; it prints a warning and the URL. Only
     use --lan on a network you trust.
   - GET/HEAD only; serves files INSIDE the project dir only (path-traversal
     safe); never dotfiles or .git; no directory listings; no write/exec.
   - Host-header allowlist, to block DNS-rebinding from a malicious web page.
   - Cache-Control: no-store + a neutralizing dev service worker, so you always
     get the latest bytes. Live-reload is injected into HTML responses only, so
     the on-disk index.html stays clean (production is untouched).

   Usage:  node dev.js [--lan] [--port 8000]
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* canonicalize so the symlink containment check below compares like-for-like */
const ROOT = fs.realpathSync(__dirname);

/* ---- security-critical: map a URL path to a safe absolute file path ----
   Returns the absolute path inside `root`, or null to reject. Rejects null
   bytes, '..' traversal (raw or %-encoded), and any dotfile/dotdir (.git,
   .env, .DS_Store, ...). Pure — exported for unit tests. */
function safeResolve(root, urlPath) {
  if (typeof urlPath !== 'string' || urlPath.indexOf('\0') !== -1) return null;
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); }
  catch (_) { return null; }                  // malformed %-encoding
  if (p.indexOf('\0') !== -1) return null;     // decoded null byte
  if (!p.startsWith('/')) p = '/' + p;
  if (p.endsWith('/')) p += 'index.html';
  const segs = p.split('/').filter(Boolean);
  for (const s of segs) {
    if (s === '.' || s === '..') return null;  // traversal
    if (s[0] === '.') return null;             // dotfiles / dotdirs (.git, .env)
  }
  const abs = path.resolve(root, segs.join(path.sep));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;  // escaped root
  return abs;
}

/* host-header allowlist — blocks DNS-rebinding / unexpected vhosts. Pure. */
function hostAllowed(hostHeader, allowed) {
  if (!hostHeader) return false;
  const h = String(hostHeader).toLowerCase().replace(/:\d+$/, '');   // strip :port
  return allowed.has(h);
}

/* this Mac's Bonjour name (e.g. my-mac.local) — stable across sessions, so it's
   a nicer thing to bookmark on the phone than the IP, which can change. */
function bonjourHost() {
  try {
    if (process.platform === 'darwin') {
      const n = require('child_process').execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (n) return n + '.local';
    }
  } catch (_) { /* fall back to os.hostname() */ }
  const h = String(os.hostname() || '').split('.')[0];
  return h ? h + '.local' : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* a service worker that neutralizes caching in dev: clears any caches a prior
   (production) visit left and never intercepts fetches, so every request is
   fresh from this server. Served in place of the real sw.js. */
const DEV_SW = [
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', e => e.waitUntil(",
  "  caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => self.clients.claim())",
  "));",
  "/* no fetch handler: dev requests always hit the network */",
].join('\n');

const LIVERELOAD =
  "<script>(function(){try{var es=new EventSource('/__livereload');" +
  "es.onmessage=function(e){if(e.data==='reload')location.reload();};}catch(_){}})();</script>";

function startServer() {
  const args = process.argv.slice(2);
  const lan = args.includes('--lan');
  const pi = args.indexOf('--port');
  const PORT = pi !== -1 ? (parseInt(args[pi + 1], 10) || 8000) : 8000;
  const HOST = lan ? '0.0.0.0' : '127.0.0.1';

  const lanIPs = [];
  if (lan) {
    const ifs = os.networkInterfaces();
    for (const name in ifs) for (const ni of ifs[name])
      if (ni.family === 'IPv4' && !ni.internal) lanIPs.push(ni.address);
  }
  const localName = lan ? bonjourHost() : null;   // e.g. my-mac.local
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  lanIPs.forEach(ip => allowedHosts.add(ip));
  if (localName) allowedHosts.add(localName.toLowerCase());   // allow the .local name (a specific host, not a wildcard)

  const clients = new Set();   // open SSE responses (live-reload listeners)

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method Not Allowed'); return;
    }
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      res.writeHead(403); res.end('Forbidden host'); return;
    }
    const urlPath = req.url.split('?')[0];

    if (urlPath === '/__livereload') {           // live-reload event stream
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (urlPath === '/sw.js') {                   // dev service worker (neutralized)
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : DEV_SW);
      return;
    }

    const abs = safeResolve(ROOT, urlPath);
    if (!abs) { res.writeHead(404); res.end('Not found'); return; }

    fs.realpath(abs, (err, real) => {             // defense-in-depth: resolve symlinks, re-check containment
      if (err || (real !== ROOT && !real.startsWith(ROOT + path.sep))) { res.writeHead(404); res.end('Not found'); return; }
      fs.stat(real, (e2, st) => {
        if (e2 || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }   // no directory listings
        const ext = path.extname(real).toLowerCase();
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
        if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
        if (ext === '.html') {                    // inject live-reload (response only; file on disk is untouched)
          fs.readFile(real, 'utf8', (e3, html) => {
            if (e3) { res.writeHead(500); res.end('Read error'); return; }
            const out = html.includes('</body>') ? html.replace('</body>', LIVERELOAD + '</body>') : html + LIVERELOAD;
            res.writeHead(200, headers); res.end(out);
          });
        } else {
          res.writeHead(200, headers);
          fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
        }
      });
    });
  });

  let timer = null;
  const broadcast = () => { for (const res of clients) { try { res.write('data: reload\n\n'); } catch (_) { clients.delete(res); } } };
  try {
    fs.watch(ROOT, { recursive: true }, (_ev, file) => {
      const f = (file || '').replace(/\\/g, '/');
      if (/(^|\/)(\.git|node_modules|_site)(\/|$)|(^|\/)\./.test(f)) return;   // ignore .git / node_modules / dotfiles
      clearTimeout(timer); timer = setTimeout(broadcast, 120);                 // debounce noisy fs events
    });
  } catch (e) { console.warn('file watch unavailable (' + e.code + ') — live reload disabled'); }

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error('Port ' + PORT + ' is in use. Try: node dev.js --port 8080'); process.exit(1); }
    throw e;
  });
  server.listen(PORT, HOST, () => {
    console.log('\n  Reckon dev server - live reload on\n');
    console.log('  Local:   http://localhost:' + PORT);
    if (lan) {
      console.log('\n  On your phone (same Wi-Fi):');
      if (localName) console.log('    http://' + localName + ':' + PORT + '   <- bookmark this; it stays the same');
      lanIPs.forEach(ip => console.log('    http://' + ip + ':' + PORT + (localName ? '   (fallback if .local does not resolve)' : '   (open this on your phone)')));
      console.log('\n  WARNING: --lan exposes this server to everyone on your Wi-Fi.');
      console.log('  It serves only this folder, read-only, no dotfiles/.git - but only');
      console.log('  run it on a network you trust.\n');
    } else {
      console.log('\n  Localhost only (no network exposure). Add --lan to test on your phone.\n');
    }
  });
}

module.exports = { safeResolve, hostAllowed };
if (require.main === module) startServer();
