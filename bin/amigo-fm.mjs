#!/usr/bin/env node
// amigo-fm — the terminal side of the band. No dependencies.
//   amigo-fm status | listen | make | split | put | air | login
// Needs yt-dlp + ffmpeg for make/split (brew install yt-dlp ffmpeg).

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

const MAX_BYTES = 100_000_000; // what the band takes (wrangler.toml MAX_BYTES)
const SEGMENT = 5400; // 90 min of 128k ≈ 86 MB
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'amigo-fm', 'config.json');

const tty = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = (s) => paint(2, s);
const green = (s) => paint(32, s);
const amber = (s) => paint(33, s);
const say = (s = '') => console.error(s);
const die = (s, code = 1) => (say(`${amber('amigo-fm')} ${s}`), process.exit(code));
const mb = (n) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

const HELP = `amigo-fm 📻  one tape, one band, 24 hours

  amigo-fm status                  is the band on air?
  amigo-fm listen                  hear it (ffplay or mpv)
  amigo-fm make LINK [-n name]     YouTube / YT Music -> 128k mp3, no metadata
  amigo-fm make LINK --mix [-n x]  a whole playlist, glued into one mp3
  amigo-fm split FILE              over 100 MB: cut into ~86 MB parts
  amigo-fm put FILE                put the tape on the band
  amigo-fm air LINK [-n name]      make + put, in one go
  amigo-fm login                   save the band URL and key (key typed hidden)

  -d, --dir DIR    where files land (default ~/Downloads, or AMIGO_FM_DIR)

The band and key: AMIGO_FM_URL / AMIGO_FM_KEY, or \`amigo-fm login\`.
When a download stops working: brew upgrade yt-dlp`;

// ---------- config ----------
async function config() {
  let file = {};
  try { file = JSON.parse(await readFile(CONFIG, 'utf8')); } catch {}
  return {
    url: process.env.AMIGO_FM_URL || file.url,
    key: process.env.AMIGO_FM_KEY || file.key,
    dir: process.env.AMIGO_FM_DIR || file.dir || join(homedir(), 'Downloads'),
  };
}
const need = (cfg, ...fields) => {
  for (const f of fields) if (!cfg[f]) die(`no ${f}: set AMIGO_FM_${f.toUpperCase()} or run \`amigo-fm login\``);
};
const bandUrl = (u) => (/\/tape\/?$/.test(u) ? u.replace(/\/$/, '') : u.replace(/\/$/, '') + '/tape');

// ---------- args ----------
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mix') o.mix = true;
    else if (a === '-n' || a === '--name') o.name = argv[++i];
    else if (a === '-d' || a === '--dir') o.dir = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else o._.push(a);
  }
  return o;
}

// ---------- tools ----------
function haveTools(...names) {
  for (const n of names) {
    if (spawnSync('which', [n], { stdio: 'ignore' }).status !== 0) die(`missing '${n}' (brew install ${n})`);
  }
}
const run = (cmd, args) =>
  new Promise((ok) => spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] }).on('close', (c) => ok(c === 0)));

const YT = ['-x', '--audio-format', 'mp3', '--audio-quality', '128k', '--postprocessor-args', 'ffmpeg:-map_metadata -1'];

// ---------- commands ----------
async function status(cfg) {
  need(cfg, 'url');
  let res;
  try { res = await fetch(bandUrl(cfg.url), { method: 'HEAD' }); } catch (e) { die(`cannot reach the band: ${e.cause?.code || e.message}`); }
  if (res.status === 404) return say(`${dim('●')} silent ${dim('— the band breathes')}`);
  if (!res.ok) die(`the band answered ${res.status}`);
  const size = Number(res.headers.get('content-length'));
  say(`${green('●')} on air ${dim(`— ${res.headers.get('content-type')}, ${mb(size)}`)}`);
}

async function listen(cfg) {
  need(cfg, 'url');
  const url = bandUrl(cfg.url);
  const player = ['ffplay', 'mpv'].find((p) => spawnSync('which', [p], { stdio: 'ignore' }).status === 0);
  if (!player) return console.log(url), say(dim('no ffplay or mpv: open that in a browser'));
  const args = player === 'ffplay' ? ['-nodisp', '-autoexit', '-loglevel', 'error', url] : ['--no-video', url];
  say(`${green('●')} listening ${dim('(ctrl-c to leave)')}`);
  await run(player, args);
}

async function make(cfg, o, dirOverride) {
  const link = o._[0];
  if (!link) die('make needs a LINK');
  haveTools('yt-dlp', 'ffmpeg');
  const dir = resolve(dirOverride || o.dir || cfg.dir);
  await mkdir(dir, { recursive: true });
  const name = o.name ? o.name.replace(/\.mp3$/i, '') : null;

  if (!o.mix) {
    const out = name || '%(title)s';
    const before = new Set(await readdir(dir));
    const ok = await run('yt-dlp', ['--no-playlist', ...YT, '-P', dir, '-o', `${out}.%(ext)s`, link]);
    if (!ok) die('yt-dlp failed');
    if (name) return join(dir, `${name}.mp3`);
    const fresh = (await readdir(dir)).filter((f) => f.endsWith('.mp3') && !before.has(f));
    return fresh.length === 1 ? join(dir, fresh[0]) : null; // existing title: yt-dlp skipped it
  }

  const tmp = await mkdtemp(join(tmpdir(), 'amigo-fm-'));
  try {
    if (!(await run('yt-dlp', ['--yes-playlist', ...YT, '-P', tmp, '-o', '%(playlist_index)03d.%(ext)s', link]))) die('yt-dlp failed');
    const parts = (await readdir(tmp)).filter((f) => f.endsWith('.mp3')).sort();
    if (!parts.length) die('the playlist gave no tracks');
    await writeFile(join(tmp, 'list.txt'), parts.map((f) => `file '${join(tmp, f)}'\n`).join(''));
    const out = join(dir, `${name || 'playlist_mix'}.mp3`);
    const ok = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'), '-c', 'copy', '-map_metadata', '-1', out]);
    if (!ok) die('ffmpeg failed');
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function split(file) {
  if (!file) die('split needs a FILE');
  haveTools('ffmpeg');
  const f = resolve(file);
  const base = join(dirname(f), basename(f, extname(f)));
  const ok = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 'segment', '-segment_time', String(process.env.AMIGO_FM_SEGMENT || SEGMENT), '-c', 'copy', '-map_metadata', '-1', '-reset_timestamps', '1', `${base}_part%02d.mp3`]);
  if (!ok) die('ffmpeg failed; the original is untouched');
  await rm(f); // only after the cut worked
  const parts = (await readdir(dirname(f))).filter((n) => n.startsWith(basename(base) + '_part') && n.endsWith('.mp3')).sort();
  for (const p of parts) say(`  ${p} ${dim(mb((await stat(join(dirname(f), p))).size))}`);
  return parts.map((p) => join(dirname(f), p));
}

async function put(cfg, file) {
  if (!file) die('put needs a FILE');
  need(cfg, 'url', 'key');
  const f = resolve(file);
  let size;
  try { size = (await stat(f)).size; } catch { die(`no such file: ${file}`); }
  if (size > MAX_BYTES) die(`${basename(f)} is ${mb(size)}, the band takes ${mb(MAX_BYTES)}. Run \`amigo-fm split\` first`);

  let sent = 0;
  const stream = Readable.toWeb(createReadStream(f)).pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        sent += chunk.length;
        if (tty) process.stderr.write(`\r${dim('putting')} ${Math.round((sent / size) * 100)}%  `);
        ctl.enqueue(chunk);
      },
    }),
  );
  let res;
  try {
    res = await fetch(bandUrl(cfg.url), {
      method: 'PUT',
      headers: { 'X-Tape-Key': cfg.key, 'Content-Type': 'audio/mpeg', 'Content-Length': String(size) },
      body: stream,
      duplex: 'half',
    });
  } catch (e) { if (tty) process.stderr.write('\n'); die(`cannot reach the band: ${e.cause?.code || e.message}`); }
  if (tty) process.stderr.write('\r\x1b[K');
  const why = { 401: 'wrong key', 411: 'no length', 413: 'too big', 415: 'not audio' }[res.status];
  if (res.status !== 204) die(`the band answered ${res.status}${why ? ` (${why})` : ''}`);
  say(`${green('●')} flowing ${dim(`— ${basename(f)}, ${mb(size)}. 24h, then gone.`)}`);
}

async function login() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q) => new Promise((ok) => rl.question(q, ok));
  const url = (await ask('band URL (https://amigo-fm.<you>.workers.dev/tape): ')).trim();
  // hide the key while typing
  const write = rl._writeToOutput;
  rl._writeToOutput = (s) => (s.includes('key') ? write.call(rl, s) : write.call(rl, ''));
  const key = (await ask('emitter key (hidden): ')).trim();
  rl.close();
  say();
  if (!url || !key) die('both are needed');
  await mkdir(dirname(CONFIG), { recursive: true });
  await writeFile(CONFIG, JSON.stringify({ url, key }, null, 2) + '\n', { mode: 0o600 });
  await chmod(CONFIG, 0o600);
  say(`${green('●')} saved ${dim(CONFIG)}`);
}

// ---------- main ----------
const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest);
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || o.help) {
  console.log(HELP);
  process.exit(0);
}
const cfg = await config();

switch (cmd) {
  case 'status': await status(cfg); break;
  case 'listen': await listen(cfg); break;
  case 'make': { const out = await make(cfg, o); if (out) console.log(out); break; }
  case 'split': for (const p of (await split(o._[0]))) console.log(p); break;
  case 'put': await put(cfg, o._[0]); break;
  case 'air': {
    need(cfg, 'url', 'key'); // fail before downloading anything
    const out = await make(cfg, o);
    if (!out) die('could not tell which file was made; use `make` then `put`');
    await put(cfg, out);
    break;
  }
  case 'login': await login(); break;
  default: die(`unknown command '${cmd}'. Try \`amigo-fm help\``, 2);
}
