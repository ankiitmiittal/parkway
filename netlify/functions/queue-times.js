/* ==========================================================================
   Netlify Function: same-origin proxy for queue-times.com.

   Why this exists: queue-times.com does not send Access-Control-Allow-Origin
   for real web origins, so a browser on https://yoursite.netlify.app cannot
   read its responses directly. (It appears to work from file:// because the
   origin is null there — which is why this was missed until deployment.)
   Routing through a function makes the request same-origin, so CORS no
   longer applies.

   Netlify builds and hosts this for you; nothing to install locally. Drop the
   folder in the deploy and it is live at:
     /.netlify/functions/queue-times?path=/parks.json

   Deliberately NOT an open proxy: only the two endpoints the app actually
   needs are permitted, so this cannot be used to bounce arbitrary traffic
   through your site.
   ========================================================================== */

const UPSTREAM = 'https://queue-times.com';

// /parks.json  or  /parks/<id>/queue_times.json
const ALLOWED_PATH = /^\/(parks\.json|parks\/[0-9]{1,7}\/queue_times\.json)$/;

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'GET only' });
  }

  const path = (event.queryStringParameters || {}).path || '';
  if (!ALLOWED_PATH.test(path)) {
    return json(400, { error: 'That path is not proxied. Allowed: /parks.json, /parks/<id>/queue_times.json' });
  }

  try {
    const res = await fetch(UPSTREAM + path, {
      headers: {
        accept: 'application/json',
        // Identify the caller rather than pretending to be a browser.
        'user-agent': 'Parkway/1.0 (park route planner; via Netlify Function)'
      }
    });

    const body = await res.text();

    if (!res.ok) {
      return json(res.status, { error: 'Upstream returned ' + res.status });
    }

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // Queue times go stale fast — a minute is plenty and spares the
        // upstream service from one request per visitor per refresh.
        'cache-control': 'public, max-age=60',
        'access-control-allow-origin': '*'
      },
      body
    };
  } catch (err) {
    return json(502, { error: 'Could not reach queue-times.com: ' + String(err && err.message || err) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*'
    },
    body: JSON.stringify(obj)
  };
}
