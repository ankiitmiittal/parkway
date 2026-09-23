/* ==========================================================================
   Netlify Function: the site's own Claude key.

   Without this, every visitor has to bring their own API key before the app
   can read a map — which is fine for one person testing and hopeless for
   anyone you share the link with. With it, the button just works.

   YOU PAY FOR EVERY REQUEST. Anyone who can reach this URL is spending your
   Anthropic credits, so the limits below are not decoration:
     - only the models this app actually uses
     - a ceiling on max_tokens
     - a ceiling on request size
     - a crude per-IP rate limit

   SETUP: in Netlify, Site configuration -> Environment variables, add
     ANTHROPIC_API_KEY = sk-ant-...
   then redeploy. The key lives only there; it is never sent to the browser.
   ========================================================================== */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const ALLOWED_MODELS = new Set([
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5'
]);

const MAX_TOKENS_CEILING = 16000;
const MAX_BODY_BYTES = 26 * 1024 * 1024;   // the API caps requests at 32 MB

/* Rate limit. In-memory, so it resets whenever the function goes cold and is
   per-instance rather than global — this slows down casual abuse, it does not
   stop a determined one. Put the site behind auth if that matters. */
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 6;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const seen = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(ip, seen);
  if (hits.size > 500) {            // keep the map from growing forever
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  }
  return seen.length > MAX_PER_WINDOW;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };

  /* Health check. Lets the app find out on load whether this site can read
     maps at all, instead of letting someone upload a 5 MB PDF, wait, and only
     then be told the site has no key. Reports nothing about the key itself. */
  if (event.httpMethod === 'GET') {
    return json(200, { ok: true, keyConfigured: !!process.env.ANTHROPIC_API_KEY });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: { message: 'POST only' } });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json(500, { error: { message:
      'This site has no ANTHROPIC_API_KEY set. Add it in Netlify under Site ' +
      'configuration → Environment variables, then redeploy. Or add your own ' +
      'key in Settings.' } });
  }

  const raw = event.body || '';
  const size = event.isBase64Encoded ? Math.floor(raw.length * 0.75) : Buffer.byteLength(raw);
  if (size > MAX_BODY_BYTES) {
    return json(413, { error: { message: 'That is too large to send. Use fewer pages or smaller photos.' } });
  }

  const ip = (event.headers['x-nf-client-connection-ip'] ||
              (event.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
  if (rateLimited(ip)) {
    return json(429, { error: { message: 'Too many requests in a row. Wait a minute and try again.' } });
  }

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw);
  } catch {
    return json(400, { error: { message: 'Body was not valid JSON.' } });
  }

  if (!ALLOWED_MODELS.has(body.model)) {
    return json(400, { error: { message: `Model ${body.model} is not allowed by this site.` } });
  }
  if (typeof body.max_tokens !== 'number' || body.max_tokens > MAX_TOKENS_CEILING) {
    body.max_tokens = Math.min(body.max_tokens || MAX_TOKENS_CEILING, MAX_TOKENS_CEILING);
  }

  try {
    const upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION
      },
      body: JSON.stringify(body)
    });
    const text = await upstream.text();
    return { statusCode: upstream.status, headers: cors(), body: text };
  } catch (err) {
    return json(502, { error: { message: 'Upstream request failed: ' + (err && err.message || err) } });
  }
};

function cors() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS'
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: cors(), body: JSON.stringify(obj) };
}
