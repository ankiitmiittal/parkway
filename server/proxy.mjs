/* ==========================================================================
   proxy.mjs — optional. Keeps your Anthropic API key server-side so the app
   can be used by people you would not hand a key to.

   Requires Node 18+ (for built-in fetch). Nothing to install.

     set ANTHROPIC_API_KEY=sk-ant-...      (PowerShell: $env:ANTHROPIC_API_KEY="...")
     node server/proxy.mjs

   Then in the app: Settings → "Through my own proxy" → http://localhost:8787/api/messages

   It also serves the app itself on http://localhost:8787/ , which sidesteps
   any file:// restrictions your browser applies.
   ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only these may be requested through the proxy — an open relay to a paid
// API is not something you want on your network.
const ALLOWED_MODELS = new Set([
  'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — the /api/messages route will return 500.');
}

const server = http.createServer(async (req, res) => {
  // Same-origin by default; widen only if you serve the app from elsewhere.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (req.url.startsWith('/api/messages')) {
    if (req.method !== 'POST') return send(res, 405, { error: { message: 'POST only' } });
    if (!API_KEY) return send(res, 500, { error: { message: 'Server has no ANTHROPIC_API_KEY set.' } });

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 32 * 1024 * 1024) {           // photos are big; 32 MB is the API limit
        return send(res, 413, { error: { message: 'Request too large.' } });
      }
    }

    let body;
    try { body = JSON.parse(raw); }
    catch { return send(res, 400, { error: { message: 'Body was not valid JSON.' } }); }

    if (!ALLOWED_MODELS.has(body.model)) {
      return send(res, 400, { error: { message: `Model ${body.model} is not allowed by this proxy.` } });
    }

    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(text);
    } catch (err) {
      send(res, 502, { error: { message: 'Upstream request failed: ' + err.message } });
    }
    return;
  }

  // Static files.
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`Parkway running at http://localhost:${PORT}/`);
  console.log(`Proxy endpoint:     http://localhost:${PORT}/api/messages`);
});
