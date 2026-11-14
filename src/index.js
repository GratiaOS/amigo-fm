// amigo-fm: one tape, one band, 24 hours.
//   PUT /tape  (operator, X-Tape-Key) -> 204
//   GET /tape  (public)               -> 200/206 audio stream, or 404

const KEY = 'tape';
const CORS = { 'Access-Control-Allow-Origin': '*' };

const reply = (status, extra = {}) =>
  new Response(null, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });

async function sameKey(given, secret) {
  if (!given || !secret) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function putTape(request, env) {
  if (!(await sameKey(request.headers.get('X-Tape-Key'), env.TAPE_KEY))) return reply(401);
  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('audio/')) return reply(415);
  const size = Number(request.headers.get('Content-Length'));
  if (!size) return reply(411);
  if (size > Number(env.MAX_BYTES)) return reply(413);
  await env.TAPES.put(KEY, request.body, { httpMetadata: { contentType: type } });
  return reply(204);
}

// One byte range, or none: "bytes=a-b", "bytes=a-", "bytes=-n".
function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (!m[2]) return { offset };
  return Number(m[2]) < offset ? null : { offset, length: Number(m[2]) - offset + 1 };
}

async function getTape(request, env, ctx) {
  const range = parseRange(request.headers.get('Range'));
  let tape;
  try {
    tape = await env.TAPES.get(KEY, range ? { range } : undefined);
  } catch {
    tape = await env.TAPES.head(KEY);
    return tape ? reply(416, { 'Content-Range': `bytes */${tape.size}` }) : reply(404);
  }
  if (!tape) return reply(404);

  if (Date.now() - tape.uploaded.getTime() > Number(env.TTL_SECONDS) * 1000) {
    ctx.waitUntil(Promise.all([tape.body.cancel(), env.TAPES.delete(KEY)]));
    return reply(404);
  }

  let offset = 0;
  let length = tape.size;
  if (range) {
    if ('suffix' in range) {
      length = Math.min(range.suffix, tape.size);
      offset = tape.size - length;
    } else {
      offset = range.offset;
      length = Math.min(range.length ?? Infinity, tape.size - offset);
    }
    if (length <= 0) {
      ctx.waitUntil(tape.body.cancel());
      return reply(416, { 'Content-Range': `bytes */${tape.size}` });
    }
  }

  const headers = new Headers({ ...CORS, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
  tape.writeHttpMetadata(headers);
  // No ETag: it is the hash of the tape, and nothing of what is on it leaves with the answer but the tape itself.
  headers.set('Content-Length', String(length));
  if (range) headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${tape.size}`);

  const status = range ? 206 : 200;
  if (request.method === 'HEAD') {
    ctx.waitUntil(tape.body.cancel());
    return new Response(null, { status, headers });
  }
  return new Response(tape.body, { status, headers });
}

// A browser page may only leave a tape if it is one the operator named (UPLOAD_ORIGINS, comma separated). Anyone may listen from
// anywhere; this is only about which pages a browser lets send the key. The key is still what opens the band.
function preflight(request, env) {
  const origin = request.headers.get('Origin');
  const wants = request.headers.get('Access-Control-Request-Method');
  const allowed = (env.UPLOAD_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (wants === 'PUT' && origin && allowed.includes(origin)) {
    return reply(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'PUT',
      'Access-Control-Allow-Headers': 'X-Tape-Key, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
  }
  return reply(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range', Vary: 'Origin' });
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/tape') return reply(404);
    if (request.method === 'PUT') return putTape(request, env);
    if (request.method === 'GET' || request.method === 'HEAD') return getTape(request, env, ctx);
    if (request.method === 'OPTIONS') return preflight(request, env);
    return reply(405, { Allow: 'GET, HEAD, PUT' });
  },
};
