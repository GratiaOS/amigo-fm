#!/usr/bin/env node
// amigo-fm — leave a tape in the garden. No dependencies.
//   amigo-fm garden | listen | leave | prepare | connect
// Preparing a tape from a link needs yt-dlp + ffmpeg (brew install yt-dlp ffmpeg).
// Everything stays on this machine: the frequency and the key are local, the band keeps no account, no history.

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

// ---------- words ----------
const WORDS = {
  en: {
    awake: '🪴 The garden is awake — a tape is waiting.',
    awakeSize: (s) => `🪴 The garden is awake — a tape is waiting (${s}).`,
    quiet: '🌱 The garden is quiet — no tape right now.',
    unreachable: '🌫 The garden is out of reach — check the frequency and your connection.',
    badKey: "🔑 The key doesn't open this garden.",
    tooLarge: '📦 This tape is too large — the garden takes up to 100 MB. Try `amigo-fm help --advanced` for how to cut it.',
    left: (n, s) => `🪴 Tape left in the garden — ${n} (${s}). It stays 24 hours, then it's gone.`,
    ready: (p) => `🌱 Tape ready: ${p}`,
    listening: '🎧 Listening — ctrl-c to leave.',
    openUrl: 'No player found. Open this in a browser:',
    replace: 'A tape is already in the garden. Replace it? [y/N] ',
    replaceNo: 'Fine — the tape stays where it is.',
    replaceNeedsYes: 'A tape is already in the garden. Run again with --yes to replace it.',
    yes: /^(y|yes)$/i,
    needConnect: 'No garden yet. Run `amigo-fm connect` first.',
    needTools: 'To prepare a tape from a link I need yt-dlp and ffmpeg. Install them with: brew install yt-dlp ffmpeg',
    ytFailed: "I couldn't get that tape. If the link is right, YouTube may have changed something: brew upgrade yt-dlp",
    noLeave: 'Leave what? Give me a link or an audio file.',
    noPrepare: 'Prepare what? Give me a link.',
    noFile: (f) => `I can't find ${f}.`,
    gaveNothing: 'That playlist gave no tracks.',
    unsure: "I made the tape but can't tell which file it is — look in the folder.",
    unknown: (c) => `I don't know "${c}". Try \`amigo-fm help\`.`,
    putting: 'leaving',
    otherAnswer: (c) => `The garden answered ${c}.`,
    askFrequency: "The garden's frequency (https://amigo-fm.<you>.workers.dev): ",
    askKey: 'Your key (hidden): ',
    bothNeeded: 'I need both the frequency and the key.',
    saved: (p) => `🌱 Connected. Saved only on this machine: ${p}`,
    help: `amigo-fm 📻  leave a tape in a garden

  amigo-fm garden             is there a tape?
  amigo-fm listen             listen to the garden
  amigo-fm leave <link|file>  prepare a tape and leave it (asks before replacing one)
  amigo-fm prepare <link>     prepare a tape without leaving it
  amigo-fm connect            set the frequency and your key

  --yes   don't ask before replacing   --lang en|es   language

Your frequency and key stay on this machine.
More: amigo-fm help --advanced`,
    advanced: `Advanced

  amigo-fm prepare <link> --mix [-n name]   a whole playlist, glued into one mp3
  amigo-fm split <file>                     over 100 MB: cut into ~86 MB parts (90 min)
  -n, --name NAME    name of the tape file     -d, --dir DIR   where prepared tapes land (default ~/Downloads)

Old names still work: status = garden · make = prepare · put = leave (a file) · air = leave (a link) · login = connect

Environment: AMIGO_FM_URL, AMIGO_FM_KEY, AMIGO_FM_DIR, AMIGO_FM_LANG, AMIGO_FM_SEGMENT, NO_COLOR`,
  },
  es: {
    awake: '🪴 El jardín está despierto — hay una cinta esperando.',
    awakeSize: (s) => `🪴 El jardín está despierto — hay una cinta esperando (${s}).`,
    quiet: '🌱 El jardín está en silencio — no hay cinta por ahora.',
    unreachable: '🌫 El jardín está fuera de alcance — revisa la frecuencia y tu conexión.',
    badKey: '🔑 La llave no abre este jardín.',
    tooLarge: '📦 Esta cinta es demasiado grande — el jardín admite hasta 100 MB. Mira `amigo-fm help --advanced` para saber cómo cortarla.',
    left: (n, s) => `🪴 Cinta dejada en el jardín — ${n} (${s}). Se queda 24 horas y luego desaparece.`,
    ready: (p) => `🌱 Cinta lista: ${p}`,
    listening: '🎧 Escuchando — ctrl-c para salir.',
    openUrl: 'No encontré un reproductor. Abre esto en el navegador:',
    replace: 'Ya hay una cinta en el jardín. ¿Reemplazarla? [s/N] ',
    replaceNo: 'Bien — la cinta se queda donde está.',
    replaceNeedsYes: 'Ya hay una cinta en el jardín. Vuelve a ejecutar con --yes para reemplazarla.',
    yes: /^(s|si|sí|y|yes)$/i,
    needConnect: 'Todavía no hay jardín. Ejecuta primero `amigo-fm connect`.',
    needTools: 'Para preparar una cinta desde un enlace necesito yt-dlp y ffmpeg. Instálalos con: brew install yt-dlp ffmpeg',
    ytFailed: 'No pude conseguir esa cinta. Si el enlace es correcto, puede que YouTube haya cambiado algo: brew upgrade yt-dlp',
    noLeave: '¿Dejar qué? Dame un enlace o un archivo de audio.',
    noPrepare: '¿Preparar qué? Dame un enlace.',
    noFile: (f) => `No encuentro ${f}.`,
    gaveNothing: 'Esa lista no trajo canciones.',
    unsure: 'Hice la cinta pero no sé cuál es el archivo — mira en la carpeta.',
    unknown: (c) => `No conozco "${c}". Prueba \`amigo-fm help\`.`,
    putting: 'dejando',
    otherAnswer: (c) => `El jardín respondió ${c}.`,
    askFrequency: 'La frecuencia del jardín (https://amigo-fm.<tú>.workers.dev): ',
    askKey: 'Tu llave (oculta): ',
    bothNeeded: 'Necesito la frecuencia y la llave.',
    saved: (p) => `🌱 Conectado. Guardado solo en esta máquina: ${p}`,
    help: `amigo-fm 📻  deja una cinta en un jardín

  amigo-fm garden             ¿hay una cinta?
  amigo-fm listen             escucha el jardín
  amigo-fm leave <enlace|archivo>  prepara una cinta y la deja (pregunta antes de reemplazar)
  amigo-fm prepare <enlace>   prepara una cinta sin dejarla
  amigo-fm connect            configura la frecuencia y tu llave

  --yes   no preguntar antes de reemplazar   --lang en|es   idioma

Tu frecuencia y tu llave se quedan en esta máquina.
Más: amigo-fm help --advanced`,
    advanced: `Avanzado

  amigo-fm prepare <enlace> --mix [-n nombre]   una lista entera, unida en un solo mp3
  amigo-fm split <archivo>                      más de 100 MB: cortar en partes de ~86 MB (90 min)
  -n, --name NOMBRE   nombre del archivo       -d, --dir DIR   dónde caen las cintas preparadas (por defecto ~/Downloads)

Los nombres antiguos siguen funcionando: status = garden · make = prepare · put = leave (un archivo) · air = leave (un enlace) · login = connect

Entorno: AMIGO_FM_URL, AMIGO_FM_KEY, AMIGO_FM_DIR, AMIGO_FM_LANG, AMIGO_FM_SEGMENT, NO_COLOR`,
  },
};
let W = WORDS.en;

const tty = process.stderr.isTTY && !process.env.NO_COLOR;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = '') => console.error(s);
const die = (s, code = 1) => (say(s), process.exit(code));
const mb = (n) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const which = (n) => spawnSync('which', [n], { stdio: 'ignore' }).status === 0;

// ---------- config ----------
async function config(lang) {
  let file = {};
  try { file = JSON.parse(await readFile(CONFIG, 'utf8')); } catch {}
  const env = process.env;
  const guess = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').slice(0, 2);
  const l = (lang || env.AMIGO_FM_LANG || file.lang || guess || 'en').slice(0, 2).toLowerCase();
  return {
    url: env.AMIGO_FM_URL || file.url,
    key: env.AMIGO_FM_KEY || file.key,
    dir: env.AMIGO_FM_DIR || file.dir || join(homedir(), 'Downloads'),
    lang: WORDS[l] ? l : 'en',
    savedLang: file.lang,
  };
}
const needConnect = (cfg, ...f) => f.some((k) => !cfg[k]) && die(W.needConnect);
const bandUrl = (u) => (/\/tape\/?$/.test(u) ? u.replace(/\/$/, '') : u.replace(/\/$/, '') + '/tape');

// ---------- args ----------
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mix') o.mix = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--advanced') o.advanced = true;
    else if (a === '-n' || a === '--name') o.name = argv[++i];
    else if (a === '-d' || a === '--dir') o.dir = argv[++i];
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else o._.push(a);
  }
  return o;
}

// ---------- asking ----------
// One reader per conversation: two readers on the same stdin lose what is piped in.
function asker() {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
  let hide = false;
  const write = rl._writeToOutput;
  rl._writeToOutput = (s) => (hide && process.stdin.isTTY ? write.call(rl, '') : write.call(rl, s));
  const lines = [];
  let waiting = null;
  rl.on('line', (l) => (waiting ? waiting(l) : lines.push(l)));
  rl.on('close', () => waiting?.(''));
  return {
    ask: (q, { hidden = false } = {}) =>
      new Promise((ok) => {
        process.stderr.write(q);
        hide = hidden;
        const done = (l) => ((waiting = null), (hide = false), hidden && process.stdin.isTTY && say(), ok(l.trim()));
        lines.length ? done(lines.shift()) : (waiting = done);
      }),
    close: () => rl.close(),
  };
}

// ---------- tools ----------
const run = (cmd, args) =>
  new Promise((ok) => spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] }).on('close', (c) => ok(c === 0)));
const needTools = (...names) => names.every(which) || die(W.needTools);
const YT = ['-q', '--no-warnings', '--progress', '-x', '--audio-format', 'mp3', '--audio-quality', '128k', '--postprocessor-args', 'ffmpeg:-map_metadata -1'];

// ---------- the garden ----------
// -> { state: 'awake' | 'quiet' | 'unreachable', size?, type? }
async function look(cfg) {
  let res;
  try { res = await fetch(bandUrl(cfg.url), { method: 'HEAD' }); } catch { return { state: 'unreachable' }; }
  if (res.status === 404) return { state: 'quiet' };
  if (!res.ok) return { state: 'unreachable' };
  return { state: 'awake', size: Number(res.headers.get('content-length')) || 0 };
}

async function garden(cfg) {
  needConnect(cfg, 'url');
  const g = await look(cfg);
  say(g.state === 'awake' ? (g.size ? W.awakeSize(mb(g.size)) : W.awake) : W[g.state]);
}

async function listen(cfg) {
  needConnect(cfg, 'url');
  const url = bandUrl(cfg.url);
  const player = ['ffplay', 'mpv'].find(which);
  if (!player) return say(W.openUrl), console.log(url);
  const args = player === 'ffplay' ? ['-nodisp', '-autoexit', '-loglevel', 'error', url] : ['--no-video', url];
  say(W.listening);
  await run(player, args);
}

// A link -> a 128k mp3 without metadata. Returns the file path, or null if it can't be known.
async function prepare(link, o, dir) {
  needTools('yt-dlp', 'ffmpeg');
  await mkdir(dir, { recursive: true });
  const name = o.name ? o.name.replace(/\.mp3$/i, '') : null;

  if (!o.mix) {
    const before = new Set(await readdir(dir));
    if (!(await run('yt-dlp', ['--no-playlist', ...YT, '-P', dir, '-o', `${name || '%(title)s'}.%(ext)s`, link]))) die(W.ytFailed);
    if (name) return join(dir, `${name}.mp3`);
    const fresh = (await readdir(dir)).filter((f) => f.endsWith('.mp3') && !before.has(f));
    return fresh.length === 1 ? join(dir, fresh[0]) : null; // a title already there: yt-dlp skipped it
  }

  const tmp = await mkdtemp(join(tmpdir(), 'amigo-fm-'));
  try {
    if (!(await run('yt-dlp', ['--yes-playlist', ...YT, '-P', tmp, '-o', '%(playlist_index)03d.%(ext)s', link]))) die(W.ytFailed);
    const parts = (await readdir(tmp)).filter((f) => f.endsWith('.mp3')).sort();
    if (!parts.length) die(W.gaveNothing);
    await writeFile(join(tmp, 'list.txt'), parts.map((f) => `file '${join(tmp, f)}'\n`).join(''));
    const out = join(dir, `${name || 'playlist_mix'}.mp3`);
    const ok = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'), '-c', 'copy', '-map_metadata', '-1', out]);
    if (!ok) die(W.ytFailed);
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function split(file) {
  if (!file) die(W.noLeave);
  needTools('ffmpeg');
  const f = resolve(file);
  try { await stat(f); } catch { die(W.noFile(file)); }
  const base = join(dirname(f), basename(f, extname(f)));
  const ok = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 'segment', '-segment_time', String(process.env.AMIGO_FM_SEGMENT || SEGMENT), '-c', 'copy', '-map_metadata', '-1', '-reset_timestamps', '1', `${base}_part%02d.mp3`]);
  if (!ok) die(W.ytFailed);
  await rm(f); // only after the cut worked
  const parts = (await readdir(dirname(f))).filter((n) => n.startsWith(basename(base) + '_part') && n.endsWith('.mp3')).sort();
  for (const p of parts) say(`  ${p} ${dim(mb((await stat(join(dirname(f), p))).size))}`);
  return parts.map((p) => join(dirname(f), p));
}

// A file -> the band. Says what the band answered, in garden words.
async function put(cfg, f) {
  let size;
  try { size = (await stat(f)).size; } catch { die(W.noFile(f)); }
  if (size > MAX_BYTES) die(W.tooLarge);

  let sent = 0;
  const stream = Readable.toWeb(createReadStream(f)).pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        sent += chunk.length;
        if (tty) process.stderr.write(`\r${dim(`${W.putting} ${Math.round((sent / size) * 100)}%`)}  `);
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
  } catch { if (tty) process.stderr.write('\r\x1b[K'); die(W.unreachable); }
  if (tty) process.stderr.write('\r\x1b[K');
  if (res.status === 401) die(W.badKey);
  if (res.status === 413) die(W.tooLarge);
  if (res.status !== 204) die(W.otherAnswer(res.status));
  say(W.left(basename(f), mb(size)));
}

async function askOnce(q) {
  const r = asker();
  const a = await r.ask(q);
  r.close();
  return a;
}

async function leave(cfg, o) {
  const target = o._[0];
  if (!target) die(W.noLeave);
  needConnect(cfg, 'url', 'key');

  const isLink = /^https?:\/\//i.test(target);
  if (!isLink) { try { await stat(resolve(target)); } catch { die(W.noFile(target)); } }

  // Ask before replacing, before any waiting. Default: No.
  const g = await look(cfg);
  if (g.state === 'unreachable') die(W.unreachable);
  if (g.state === 'awake' && !o.yes) {
    if (!process.stdin.isTTY) die(W.replaceNeedsYes);
    if (!W.yes.test(await askOnce(W.replace))) die(W.replaceNo, 0);
  }

  if (!isLink) return put(cfg, resolve(target));

  // A link is prepared in a temporary folder and nothing is left behind.
  const tmp = await mkdtemp(join(tmpdir(), 'amigo-fm-'));
  try {
    const file = await prepare(target, o, tmp);
    if (!file) die(W.unsure);
    await put(cfg, file);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function connect(cfg, o) {
  const r = asker();
  const url = await r.ask(W.askFrequency);
  const key = await r.ask(W.askKey, { hidden: true });
  r.close();
  if (!url || !key) die(W.bothNeeded);
  const file = { url, key };
  const lang = o.lang && WORDS[o.lang.slice(0, 2)] ? o.lang.slice(0, 2) : cfg.savedLang;
  if (lang) file.lang = lang;
  await mkdir(dirname(CONFIG), { recursive: true });
  await writeFile(CONFIG, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  await chmod(CONFIG, 0o600);
  say(W.saved(CONFIG));
}

// ---------- main ----------
const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest);
const cfg = await config(o.lang);
W = WORDS[cfg.lang];

if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || o.help) {
  console.log(o.advanced ? W.advanced : W.help);
  process.exit(0);
}

switch (cmd) {
  case 'garden': case 'status': await garden(cfg); break;
  case 'listen': await listen(cfg); break;
  case 'leave': await leave(cfg, o); break;
  case 'air': await leave(cfg, o); break;
  case 'put': await leave(cfg, o); break;
  case 'prepare': case 'make': {
    if (!o._[0]) die(W.noPrepare);
    const out = await prepare(o._[0], o, resolve(o.dir || cfg.dir));
    if (out) { say(W.ready(out)); console.log(out); }
    break;
  }
  case 'split': for (const p of await split(o._[0])) console.log(p); break;
  case 'connect': case 'login': await connect(cfg, o); break;
  default: die(W.unknown(cmd), 2);
}
