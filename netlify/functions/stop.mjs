// netlify/functions/stop.mjs
// ---------------------------------------------------------------------------
// Metlink stop-predictions proxy for the wall board.
//   • hides the Metlink API key server-side (never ships to the tablet)
//   • adds CORS headers so the board (even from file://) can fetch it
//   • passes Metlink's JSON straight through — the board parses it as-is
//
// Reached at:  /api/stop?stop=5510   (see the redirect in netlify.toml)
// Needs env var:  METLINK_API_KEY
// ESM (.mjs) to match this project's "type": "module".
// ---------------------------------------------------------------------------

const METLINK_URL = 'https://api.opendata.metlink.org.nz/v1/stop-predictions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const handler = async (event) => {
  // CORS preflight — a plain GET won't trigger this, but answer it anyway
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const key = process.env.METLINK_API_KEY;
  if (!key) {
    return json(500, { error: 'METLINK_API_KEY is not set on the server' });
  }

  const stop = (event.queryStringParameters && event.queryStringParameters.stop) || '5510';

  // don't let a slow upstream hang the function
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${METLINK_URL}?stop_id=${encodeURIComponent(stop)}`, {
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return json(502, { error: 'Metlink upstream error', status: res.status });
    }

    const data = await res.json();
    // short edge cache: shields Metlink from bursts, invisible on a bus board
    return json(200, data, { 'Cache-Control': 'public, max-age=15' });

  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    return json(aborted ? 504 : 502,
      { error: aborted ? 'Metlink request timed out' : String(err && err.message || err) });
  }
};

function json(statusCode, obj, extra = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
    body: JSON.stringify(obj),
  };
}
