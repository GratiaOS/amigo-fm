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
  headers.set('ETag', tape.httpEtag);
  headers.set('Content-Length', String(length));
  if (range) headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${tape.size}`);

  const status = range ? 206 : 200;
  if (request.method === 'HEAD') {
    ctx.waitUntil(tape.body.cancel());
    return new Response(null, { status, headers });
  }
  return new Response(tape.body, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/tape') return reply(404);
    if (request.method === 'PUT') return putTape(request, env);
    if (request.method === 'GET' || request.method === 'HEAD') return getTape(request, env, ctx);
    if (request.method === 'OPTIONS') {
      return reply(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range' });
    }
    return reply(405, { Allow: 'GET, HEAD, PUT' });
  },
};
