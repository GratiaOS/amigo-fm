#!/usr/bin/env node
// amigo-fm — the radio, from the terminal. PLAY · REC · TUNE. No dependencies.
// REC from a link needs yt-dlp + ffmpeg (brew install yt-dlp ffmpeg).
// Everything stays on this machine: the band URL and the key are local; the band keeps no account, no history.

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
    title: '📻 Amigo FM — PLAY · REC · TUNE',
    onAir: (s) => `● On air — a tape is playing${s ? ` (${s})` : ''}.`,
    quiet: '○ The band is quiet — no tape right now.',
    unreachable: "✗ Can't reach the band — check the URL and your connection.",
    badKey: "✗ That key doesn't open this band.",
    tooLarge: '✗ This tape is too large — the band takes up to 100 MB. See `amigo-fm help --advanced` to cut it.',
    notTuned: '○ Not tuned yet — run `amigo-fm tune`.',
    needTune: 'Not tuned yet. Run `amigo-fm tune` first.',
    radioOn: '📻 Radio is on.',
    listening: '♫ Listening to the band...',
    turnOff: 'Ctrl+C to turn off.',
    nothingToPlay: '○ The band is quiet — nothing to play right now.',
    openUrl: 'No player found. Open this in a browser:',
    preparing: '📼 Preparing your tape...',
    stepFind: 'Finding audio',
    stepRecord: 'Recording tape',
    stepCheck: 'Checking the tape',
    tracks: (n) => `${n} tracks`,
    replaceWarn: '⚠ A tape is already playing.',
    replaceAsk: '  Replace it? [y/N] ',
    replaceNo: '  OK — the tape keeps playing.',
    replaceNeedsYes: '  Run again with --yes to replace it.',
    yes: /^(y|yes)$/i,
    onAirDone: '✓ Tape is on air.',
    stays: '  It will stay for 24 hours.',
    ready: (p) => `✓ Tape ready: ${p}`,
    tuneHello: "📻 Let's tune your radio.",
    askUrl: 'Band URL: ',
    askKey: 'Operator key: ',
    bothNeeded: 'I need both the band URL and the key.',
    tuned: '✓ Tuned in.',
    needTools: 'To record from a link I need yt-dlp and ffmpeg. Install them with: brew install yt-dlp ffmpeg',
    ytFailed: "I couldn't get that audio. If the link is right, YouTube may have changed something: brew upgrade yt-dlp",
    noRec: 'Record what? Give me a link or an audio file.',
    noMake: 'Make what? Give me a link.',
    noFile: (f) => `I can't find ${f}.`,
    gaveNothing: 'That playlist gave no tracks.',
    unsure: "I made the tape but can't tell which file it is — look in the folder.",
    unknown: (c) => `I don't know "${c}". Try \`amigo-fm help\`.`,
    otherAnswer: (c) => `The band answered ${c}.`,
    help: `Your band URL and key stay on this machine.
More: amigo-fm help --advanced`,
    commands: [
      ['play', '', 'listen to the band'],
      ['rec', '<link|file>', 'record a tape and put it on air'],
      ['tune', '', 'set your band URL and operator key'],
    ],
    advanced: `Advanced

  amigo-fm status                           how the band is (the main screen shows it too)
  amigo-fm make <link> [-n name]            make the mp3 and keep it (in ~/Downloads), don't put it on air
  amigo-fm make <link> --mix [-n name]      a whole playlist, glued into one mp3
  amigo-fm split <file>                     over 100 MB: cut into ~86 MB parts (90 min)
  --yes  don't ask before replacing   -d, --dir DIR  where "make" saves   --lang en|es

Other names still work: listen = play · air, put, leave = rec · login = tune · garden = status · prepare = make

Environment: AMIGO_FM_URL, AMIGO_FM_KEY, AMIGO_FM_DIR, AMIGO_FM_LANG, AMIGO_FM_SEGMENT, NO_COLOR`,
  },
  es: {
    title: '📻 Amigo FM — PLAY · REC · TUNE',
    onAir: (s) => `● Al aire — suena una cinta${s ? ` (${s})` : ''}.`,
    quiet: '○ La banda está en silencio — no hay cinta por ahora.',
    unreachable: '✗ No llego a la banda — revisa la URL y tu conexión.',
    badKey: '✗ Esa llave no abre esta banda.',
    tooLarge: '✗ Esta cinta es demasiado grande — la banda admite hasta 100 MB. Mira `amigo-fm help --advanced` para cortarla.',
    notTuned: '○ Aún sin sintonizar — ejecuta `amigo-fm tune`.',
    needTune: 'Aún sin sintonizar. Ejecuta primero `amigo-fm tune`.',
    radioOn: '📻 Radio encendida.',
    listening: '♫ Escuchando la banda...',
    turnOff: 'Ctrl+C para apagar.',
    nothingToPlay: '○ La banda está en silencio — no hay nada que reproducir.',
    openUrl: 'No encontré un reproductor. Abre esto en el navegador:',
    preparing: '📼 Preparando tu cinta...',
    stepFind: 'Buscando el audio',
    stepRecord: 'Grabando la cinta',
    stepCheck: 'Revisando la cinta',
    tracks: (n) => `${n} canciones`,
    replaceWarn: '⚠ Ya hay una cinta sonando.',
    replaceAsk: '  ¿Reemplazarla? [s/N] ',
    replaceNo: '  Bien — la cinta sigue sonando.',
    replaceNeedsYes: '  Vuelve a ejecutar con --yes para reemplazarla.',
    yes: /^(s|si|sí|y|yes)$/i,
    onAirDone: '✓ La cinta está al aire.',
    stays: '  Se quedará 24 horas.',
    ready: (p) => `✓ Cinta lista: ${p}`,
    tuneHello: '📻 Vamos a sintonizar tu radio.',
    askUrl: 'URL de la banda: ',
    askKey: 'Llave del operador: ',
    bothNeeded: 'Necesito la URL de la banda y la llave.',
    tuned: '✓ Sintonizado.',
    needTools: 'Para grabar desde un enlace necesito yt-dlp y ffmpeg. Instálalos con: brew install yt-dlp ffmpeg',
    ytFailed: 'No pude conseguir ese audio. Si el enlace es correcto, puede que YouTube haya cambiado algo: brew upgrade yt-dlp',
    noRec: '¿Grabar qué? Dame un enlace o un archivo de audio.',
    noMake: '¿Hacer qué? Dame un enlace.',
    noFile: (f) => `No encuentro ${f}.`,
    gaveNothing: 'Esa lista no trajo canciones.',
    unsure: 'Hice la cinta pero no sé cuál es el archivo — mira en la carpeta.',
    unknown: (c) => `No conozco "${c}". Prueba \`amigo-fm help\`.`,
    otherAnswer: (c) => `La banda respondió ${c}.`,
    help: `Tu URL de banda y tu llave se quedan en esta máquina.
Más: amigo-fm help --advanced`,
    commands: [
      ['play', '', 'escucha la banda'],
      ['rec', '<enlace|archivo>', 'graba una cinta y la pone al aire'],
      ['tune', '', 'configura la URL de la banda y la llave del operador'],
    ],
    advanced: `Avanzado

  amigo-fm status                           cómo está la banda (la pantalla principal también lo muestra)
  amigo-fm make <enlace> [-n nombre]        hace el mp3 y lo guarda (en ~/Downloads), sin ponerlo al aire
  amigo-fm make <enlace> --mix [-n nombre]  una lista entera, unida en un solo mp3
  amigo-fm split <archivo>                  más de 100 MB: cortar en partes de ~86 MB (90 min)
  --yes  no preguntar antes de reemplazar   -d, --dir DIR  dónde guarda "make"   --lang en|es

Otros nombres siguen funcionando: listen = play · air, put, leave = rec · login = tune · garden = status · prepare = make

Entorno: AMIGO_FM_URL, AMIGO_FM_KEY, AMIGO_FM_DIR, AMIGO_FM_LANG, AMIGO_FM_SEGMENT, NO_COLOR`,
  },
};
let W = WORDS.en;

const tty = process.stderr.isTTY && !process.env.NO_COLOR;
const color = (c) => (s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = color(2), red = color(31), green = color(32), amber = color(33);
const say = (s = '') => console.error(s);
const die = (s, code = 1) => (say(s), process.exit(code));
const mb = (n) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const which = (n) => spawnSync('which', [n], { stdio: 'ignore' }).status === 0;
const soft = (message, detail) => Object.assign(new Error(message), { detail });

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
const needTune = (cfg, ...f) => f.some((k) => !cfg[k]) && die(W.needTune);
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
  const lines = [];
  let waiting = null;
  rl.on('line', (l) => (waiting ? waiting(l) : lines.push(l)));
  rl.on('close', () => waiting?.(''));
  return {
    ask: (q) =>
      new Promise((ok) => {
        process.stderr.write(q);
        const done = (l) => ((waiting = null), ok(l.trim()));
        lines.length ? done(lines.shift()) : (waiting = done);
      }),
    close: () => rl.close(),
  };
}
async function askOnce(q) {
  const r = asker();
  const a = await r.ask(q);
  r.close();
  return a;
}
// A secret on a real terminal: dots as you type, nothing kept anywhere.
function askSecret(q) {
  return new Promise((ok) => {
    process.stderr.write(q);
    let secret = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stderr.write('\n');
          return ok(secret.trim());
        }
        if (ch === '\x03') { process.stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (ch === '\x7f' || ch === '\b') { if (secret) { secret = secret.slice(0, -1); process.stderr.write('\b \b'); } }
        else if (ch >= ' ') { secret += ch; process.stderr.write('•'); }
      }
    };
    process.stdin.on('data', onData);
  });
}

// ---------- steps ----------
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
async function step(label, fn) {
  process.stderr.write(`   ${label.padEnd(20)}`);
  let timer, i = 0;
  if (tty) {
    process.stderr.write(' ');
    timer = setInterval(() => process.stderr.write(`\b${FRAMES[i++ % FRAMES.length]}`), 90);
  }
  try {
    const detail = await fn();
    clearInterval(timer);
    process.stderr.write(`${tty ? '\b' : ''}${green('✓')}${detail ? ' ' + dim(detail) : ''}\n`);
  } catch (e) {
    clearInterval(timer);
    process.stderr.write(`${tty ? '\b' : ''}${red('✗')}\n`);
    throw e;
  }
}

// ---------- tools ----------
const capture = (cmd, args) =>
  new Promise((ok) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => ok({ ok: false, out, err: e.message }));
    p.on('close', (c) => ok({ ok: c === 0, out, err }));
  });
const lastLine = (s) => s.trim().split('\n').filter(Boolean).pop()?.slice(0, 200);
const needTools = (...names) => names.every(which) || die(W.needTools);
const YT = ['-q', '--no-warnings', '-x', '--audio-format', 'mp3', '--audio-quality', '128k', '--postprocessor-args', 'ffmpeg:-map_metadata -1'];

// ---------- the band ----------
// -> { state: 'awake' | 'quiet' | 'unreachable', size }
async function look(cfg) {
  let res;
  try { res = await fetch(bandUrl(cfg.url), { method: 'HEAD' }); } catch { return { state: 'unreachable' }; }
  if (res.status === 404) return { state: 'quiet' };
  if (!res.ok) return { state: 'unreachable' };
  return { state: 'awake', size: Number(res.headers.get('content-length')) || 0 };
}
const statusLine = (g) => (g.state === 'awake' ? W.onAir(g.size ? mb(g.size) : '') : W[g.state]);

async function status(cfg) {
  needTune(cfg, 'url');
  say(statusLine(await look(cfg)));
}

async function home(cfg) {
  say(W.title);
  say();
  say(cfg.url ? statusLine(await look(cfg)) : W.notTuned);
  say();
  for (const [c, arg, what] of W.commands) say(`  amigo-fm ${(c + ' ' + arg).trim().padEnd(20)} ${what}`);
  say();
  say(dim(W.help));
}

async function play(cfg) {
  needTune(cfg, 'url');
  const g = await look(cfg);
  if (g.state === 'unreachable') die(W.unreachable);
  if (g.state === 'quiet') return say(W.nothingToPlay);
  const url = bandUrl(cfg.url);
  const player = ['ffplay', 'mpv'].find(which);
  if (!player) return say(W.openUrl), console.log(url);
  const args = player === 'ffplay' ? ['-nodisp', '-autoexit', '-loglevel', 'error', url] : ['--no-video', '--really-quiet', url];
  say(W.radioOn);
  say();
  say(W.listening);
  say();
  say(dim(W.turnOff));
  await new Promise((ok) => spawn(player, args, { stdio: 'ignore' }).on('close', ok));
}

// A link -> a 128k mp3 without metadata, in `dir`. Shows the three steps. Returns the file path.
async function prepare(link, o, dir, enforce) {
  needTools('yt-dlp', 'ffmpeg');
  await mkdir(dir, { recursive: true });
  const name = o.name ? o.name.replace(/\.mp3$/i, '') : null;
  let file = null;

  say(W.preparing);
  await step(W.stepFind, async () => {
    const r = await capture('yt-dlp', [o.mix ? '--yes-playlist' : '--no-playlist', ...(o.mix ? ['--flat-playlist'] : []), '--simulate', '--print', '%(title)s', link]);
    if (!r.ok) throw soft(W.ytFailed, lastLine(r.err));
    const titles = r.out.trim().split('\n').filter(Boolean);
    if (!titles.length) throw soft(W.gaveNothing);
    return o.mix ? W.tracks(titles.length) : titles[0].slice(0, 48);
  });

  await step(W.stepRecord, async () => {
    if (!o.mix) {
      const before = new Set(await readdir(dir));
      const r = await capture('yt-dlp', ['--no-playlist', ...YT, '--print', 'after_move:filepath', '-P', dir, '-o', `${name || '%(title)s'}.%(ext)s`, link]);
      if (!r.ok) throw soft(W.ytFailed, lastLine(r.err));
      const printed = lastLine(r.out);
      if (printed && printed.endsWith('.mp3')) file = printed;
      else if (name) file = join(dir, `${name}.mp3`);
      else {
        const fresh = (await readdir(dir)).filter((f) => f.endsWith('.mp3') && !before.has(f));
        if (fresh.length === 1) file = join(dir, fresh[0]);
      }
      return;
    }
    const tmp = await mkdtemp(join(tmpdir(), 'amigo-fm-'));
    try {
      const r = await capture('yt-dlp', ['--yes-playlist', ...YT, '-P', tmp, '-o', '%(playlist_index)03d.%(ext)s', link]);
      if (!r.ok) throw soft(W.ytFailed, lastLine(r.err));
      const parts = (await readdir(tmp)).filter((f) => f.endsWith('.mp3')).sort();
      if (!parts.length) throw soft(W.gaveNothing);
      await writeFile(join(tmp, 'list.txt'), parts.map((f) => `file '${join(tmp, f)}'\n`).join(''));
      const out = join(dir, `${name || 'playlist_mix'}.mp3`);
      const c = await capture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'), '-c', 'copy', '-map_metadata', '-1', out]);
      if (!c.ok) throw soft(W.ytFailed, lastLine(c.err));
      file = out;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  await check(file, enforce);
  return file;
}

// The last step of every tape, from a link or a file.
async function check(file, enforce) {
  await step(W.stepCheck, async () => {
    if (!file) throw soft(W.unsure);
    let size;
    try { size = (await stat(file)).size; } catch { throw soft(W.noFile(file)); }
    if (!size) throw soft(W.ytFailed);
    if (enforce && size > MAX_BYTES) throw soft(W.tooLarge);
    return mb(size);
  });
}

async function split(file) {
  if (!file) die(W.noRec);
  needTools('ffmpeg');
  const f = resolve(file);
  try { await stat(f); } catch { die(W.noFile(file)); }
  const base = join(dirname(f), basename(f, extname(f)));
  const r = await capture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 'segment', '-segment_time', String(process.env.AMIGO_FM_SEGMENT || SEGMENT), '-c', 'copy', '-map_metadata', '-1', '-reset_timestamps', '1', `${base}_part%02d.mp3`]);
  if (!r.ok) die(`${W.ytFailed}\n${dim(lastLine(r.err) || '')}`);
  await rm(f); // only after the cut worked
  const parts = (await readdir(dirname(f))).filter((n) => n.startsWith(basename(base) + '_part') && n.endsWith('.mp3')).sort();
  for (const p of parts) say(`  ${p} ${dim(mb((await stat(join(dirname(f), p))).size))}`);
  return parts.map((p) => join(dirname(f), p));
}

// The file -> the band, with a REC bar.
async function put(cfg, f) {
  const size = (await stat(f)).size;
  let sent = 0;
  const bar = () => {
    const p = sent / size, n = Math.round(p * 20);
    process.stderr.write(`\r${red('●')} REC ${'━'.repeat(n)}${dim('─'.repeat(20 - n))} ${Math.round(p * 100)}%`);
  };
  const stream = Readable.toWeb(createReadStream(f)).pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        sent += chunk.length;
        if (tty) bar();
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
  if (res.status === 401) { if (tty) process.stderr.write('\r\x1b[K'); die(W.badKey); }
  if (res.status === 413) { if (tty) process.stderr.write('\r\x1b[K'); die(W.tooLarge); }
  if (res.status !== 204) { if (tty) process.stderr.write('\r\x1b[K'); die(W.otherAnswer(res.status)); }
  if (tty) { say(); say(); } // end the REC bar, then one blank line
  say(green(W.onAirDone));
  say(W.stays);
}

const LINK = /^(https?:\/\/|(www\.|music\.)?(youtube\.com|youtu\.be)\/)/i;

async function rec(cfg, o) {
  const target = o._[0];
  if (!target) die(W.noRec);
  needTune(cfg, 'url', 'key');

  const isLink = LINK.test(target);
  if (!isLink) { try { await stat(resolve(target)); } catch { die(W.noFile(target)); } }

  // Ask before replacing, before any waiting. Default: No.
  const g = await look(cfg);
  if (g.state === 'unreachable') die(W.unreachable);
  if (g.state === 'awake' && !o.yes) {
    say(amber(W.replaceWarn));
    if (!process.stdin.isTTY) die(W.replaceNeedsYes);
    if (!W.yes.test(await askOnce(W.replaceAsk))) die(W.replaceNo, 0);
    say();
  }

  if (!isLink) {
    say(W.preparing);
    const f = resolve(target);
    await check(f, true);
    say();
    return put(cfg, f);
  }

  // A link is prepared in a temporary folder and nothing is left behind.
  const tmp = await mkdtemp(join(tmpdir(), 'amigo-fm-'));
  try {
    const f = await prepare(target.startsWith('http') ? target : `https://${target}`, o, tmp, true);
    say();
    await put(cfg, f);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function tune(cfg, o) {
  say(W.tuneHello);
  say();
  let url, key;
  if (process.stdin.isTTY) {
    url = await askOnce(W.askUrl);
    key = await askSecret(W.askKey);
  } else {
    const r = asker();
    url = await r.ask(W.askUrl);
    key = await r.ask(W.askKey);
    r.close();
  }
  if (!url || !key) die(W.bothNeeded);
  const file = { url, key };
  const lang = o.lang && WORDS[o.lang.slice(0, 2)] ? o.lang.slice(0, 2) : cfg.savedLang;
  if (lang) file.lang = lang;
  await mkdir(dirname(CONFIG), { recursive: true });
  await writeFile(CONFIG, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  await chmod(CONFIG, 0o600);
  say();
  say(green(W.tuned));
  say(dim(`  ${statusLine(await look({ url }))}`));
}

// ---------- main ----------
const o = parse(process.argv.slice(2));
const cmd = o._.shift();
const cfg = await config(o.lang);
W = WORDS[cfg.lang];

try {
  if (!cmd) await home(cfg);
  else if (cmd === 'help' || o.help) {
    if (o.advanced) console.log(W.advanced);
    else { console.log(`${W.title}\n\n${W.commands.map(([c, arg, what]) => `  amigo-fm ${(c + ' ' + arg).trim().padEnd(20)} ${what}`).join('\n')}\n\n${W.help}`); }
  } else switch (cmd) {
    case 'play': case 'listen': await play(cfg); break;
    case 'rec': case 'air': case 'put': case 'leave': await rec(cfg, o); break;
    case 'tune': case 'login': case 'connect': await tune(cfg, o); break;
    case 'status': case 'garden': await status(cfg); break;
    case 'make': case 'prepare': {
      if (!o._[0]) die(W.noMake);
      const out = await prepare(o._[0], o, resolve(o.dir || cfg.dir), false);
      say();
      say(green(W.ready(out)));
      console.log(out);
      break;
    }
    case 'split': for (const p of await split(o._[0])) console.log(p); break;
    default: die(W.unknown(cmd), 2);
  }
} catch (e) {
  say(`${e.message}${e.detail ? `\n${dim('  ' + e.detail)}` : ''}`);
  process.exit(1);
}
