#!/usr/bin/env node
// amigo-fm — the radio, from the terminal. PLAY · REC · TUNE. No dependencies.
// REC from a link needs yt-dlp + ffmpeg (brew install yt-dlp ffmpeg).
// Everything stays on this machine: the band URL and the key are local; the band keeps no account, no history.

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

const MAX_BYTES = 100_000_000; // what the band takes (wrangler.toml MAX_BYTES)
const SEGMENT = 5400; // 90 min of 128k ≈ 86 MB
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'amigo-fm', 'config.json');

// ---------- words ----------
// Objects: tape / frequency / radio. EN says "the band" (the protocol's word); ES "frecuencia"; RO "frecvență", "casetă", "aparat".
const WORDS = {
  en: {
    title: '📻 AMIGO FM',
    onAir: (s) => `● On air — a tape is on the band${s ? ` (${s})` : ''}.`,
    quiet: '○ The band is quiet — no tape right now.',
    unreachable: "✗ Can't reach the band — check the URL and your connection.",
    badKey: "✗ That key doesn't open this band.",
    tooLarge: '✗ This tape is too large — the band takes up to 100 MB. See `amigo-fm help --advanced` to cut it.',
    notAudio: "✗ That isn't an audio file I can leave (mp3, wav, flac, ogg, m4a or aac).",
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
    replaceWarn: '⚠ A tape is already on the band.',
    replaceAsk: '  Replace it? [y/N] ',
    replaceNo: '  OK — the tape stays.',
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
    needTools: 'I need yt-dlp and ffmpeg for this. Install them with: brew install yt-dlp ffmpeg',
    ytFailed: "I couldn't get that audio. If the link is right, YouTube may have changed something: brew upgrade yt-dlp",
    ytBot: "YouTube wants to be sure you're not a bot right now. Try again in a while, or set AMIGO_FM_COOKIES=chrome (or safari, firefox) to use your browser's session.",
    ffFailed: 'ffmpeg could not do that.',
    noRec: 'Record what? Give me a link or an audio file.',
    noMake: 'Make what? Give me a link.',
    noFile: (f) => `I can't find ${f}.`,
    gaveNothing: 'That playlist gave no tracks.',
    unsure: "I made the tape but can't tell which file it is — look in the folder.",
    unknown: (c) => `I don't know "${c}". Try \`amigo-fm help\`.`,
    otherAnswer: (c) => `The band answered ${c}.`,
    splitTooBig: (f) => `A part came out over 100 MB (${f}). Nothing was cut; your file is untouched.`,
    splitNote: 'These are separate tapes. The band holds one at a time and plays no queue: leave them one by one, each with `amigo-fm rec`.',
    help: `Your band URL and key stay on this machine.
More: amigo-fm help --advanced`,
    commands: [
      ['play', '', 'Listen to the band'],
      ['rec', '<link|file>', 'Leave a tape'],
      ['tune', '', 'Set up your radio'],
    ],
    advanced: `Advanced

  amigo-fm status                           how the band is (the main screen shows it too)
  amigo-fm make <link> [-n name]            make the mp3 and keep it (in ~/Downloads), don't put it on air
  amigo-fm make <link> --mix [-n name]      a whole playlist, glued into one mp3
  amigo-fm split <file>                     over 100 MB: cut into parts under 100 MB, one tape each (the band holds one at a time, no queue)
  --yes  don't ask before replacing   -d, --dir DIR  where "make" saves   --lang en|es|ro

Other names still work: listen = play · air, put, leave = rec · login = tune · garden = status · prepare = make

Environment: AMIGO_FM_URL, AMIGO_FM_KEY, AMIGO_FM_DIR, AMIGO_FM_LANG, AMIGO_FM_SEGMENT (seconds per part), AMIGO_FM_COOKIES (chrome | safari | firefox: let yt-dlp use your browser's YouTube session), NO_COLOR`,
  },
  es: {
    title: '📻 AMIGO FM',
    onAir: (s) => `● Al aire — hay una cinta en la frecuencia${s ? ` (${s})` : ''}.`,
    quiet: '○ La frecuencia está en silencio — no hay cinta por ahora.',
    unreachable: '✗ No llego a la frecuencia — revisa la URL y tu conexión.',
    badKey: '✗ Esa llave no abre esta frecuencia.',
    tooLarge: '✗ Esta cinta es demasiado grande — la frecuencia admite hasta 100 MB. Mira `amigo-fm help --advanced` para cortarla.',
    notAudio: '✗ Eso no es un archivo de audio que pueda dejar (mp3, wav, flac, ogg, m4a o aac).',
    notTuned: '○ Aún sin sintonizar — ejecuta `amigo-fm tune`.',
    needTune: 'Aún sin sintonizar. Ejecuta primero `amigo-fm tune`.',
    radioOn: '📻 Radio encendida.',
    listening: '♫ Escuchando la frecuencia...',
    turnOff: 'Ctrl+C para apagar.',
    nothingToPlay: '○ La frecuencia está en silencio — no hay nada que reproducir.',
    openUrl: 'No encontré un reproductor. Abre esto en el navegador:',
    preparing: '📼 Preparando tu cinta...',
    stepFind: 'Buscando el audio',
    stepRecord: 'Grabando la cinta',
    stepCheck: 'Revisando la cinta',
    tracks: (n) => `${n} canciones`,
    replaceWarn: '⚠ Ya hay una cinta en la frecuencia.',
    replaceAsk: '  ¿Reemplazarla? [s/N] ',
    replaceNo: '  Bien — la cinta se queda.',
    replaceNeedsYes: '  Vuelve a ejecutar con --yes para reemplazarla.',
    yes: /^(s|si|sí|y|yes)$/i,
    onAirDone: '✓ La cinta está al aire.',
    stays: '  Se quedará 24 horas.',
    ready: (p) => `✓ Cinta lista: ${p}`,
    tuneHello: '📻 Vamos a sintonizar tu radio.',
    askUrl: 'URL de la frecuencia: ',
    askKey: 'Llave del operador: ',
    bothNeeded: 'Necesito la URL de la frecuencia y la llave.',
    tuned: '✓ Sintonizado.',
    needTools: 'Para esto necesito yt-dlp y ffmpeg. Instálalos con: brew install yt-dlp ffmpeg',
    ytFailed: 'No pude conseguir ese audio. Si el enlace es correcto, puede que YouTube haya cambiado algo: brew upgrade yt-dlp',
    ytBot: 'YouTube quiere comprobar que no eres un bot. Prueba otra vez en un rato, o define AMIGO_FM_COOKIES=chrome (o safari, firefox) para usar la sesión de tu navegador.',
    ffFailed: 'ffmpeg no pudo hacerlo.',
    noRec: '¿Grabar qué? Dame un enlace o un archivo de audio.',
    noMake: '¿Hacer qué? Dame un enlace.',
    noFile: (f) => `No encuentro ${f}.`,
    gaveNothing: 'Esa lista no trajo canciones.',
    unsure: 'Hice la cinta pero no sé cuál es el archivo — mira en la carpeta.',
    unknown: (c) => `No conozco "${c}". Prueba \`amigo-fm help\`.`,
    otherAnswer: (c) => `La frecuencia respondió ${c}.`,
    splitTooBig: (f) => `Una parte salió de más de 100 MB (${f}). No se cortó nada; tu archivo está intacto.`,
    splitNote: 'Son cintas separadas. La frecuencia guarda una a la vez y no hace cola: déjalas una por una, cada una con `amigo-fm rec`.',
    help: `Tu URL y tu llave se quedan en esta máquina.
Más: amigo-fm help --advanced`,
    commands: [
      ['play', '', 'Escucha la frecuencia'],
      ['rec', '<enlace|archivo>', 'Deja una cinta'],
      ['tune', '', 'Configura tu radio'],
    ],
    advanced: `Avanzado

  amigo-fm status                           cómo está la frecuencia (la pantalla principal también lo muestra)
  amigo-fm make <enlace> [-n nombre]        hace el mp3 y lo guarda (en ~/Downloads), sin ponerlo al aire
  amigo-fm make <enlace> --mix [-n nombre]  una lista entera, unida en un solo mp3
  amigo-fm split <archivo>                  más de 100 MB: cortar en partes de menos de 100 MB, una cinta cada una (la frecuencia guarda una a la vez, sin cola)
  --yes  no preguntar antes de reemplazar   -d, --dir DIR  dónde guarda "make"   --lang en|es|ro

Otros nombres siguen funcionando: listen = play · air, put, leave = rec · login = tune · garden = status · prepare = make

Entorno: AMIGO_FM_URL, AMIGO_FM_KEY, AMIGO_FM_DIR, AMIGO_FM_LANG, AMIGO_FM_SEGMENT (segundos por parte), AMIGO_FM_COOKIES (chrome | safari | firefox: que yt-dlp use la sesión de YouTube de tu navegador), NO_COLOR`,
  },
  ro: {
    title: '📻 AMIGO FM',
    onAir: (s) => `● În emisie — o casetă e pe frecvență${s ? ` (${s})` : ''}.`,
    quiet: '○ Frecvența e liniștită — nicio casetă acum.',
    unreachable: '✗ Nu ajung la frecvență — verifică adresa și conexiunea.',
    badKey: '✗ Cheia aceea nu deschide această frecvență.',
    tooLarge: '✗ Caseta e prea mare — frecvența primește până la 100 MB. Vezi `amigo-fm help --advanced` ca s-o tai.',
    notAudio: '✗ Ăsta nu e un fișier audio pe care îl pot lăsa (mp3, wav, flac, ogg, m4a sau aac).',
    notTuned: '○ Nesintonizat încă — rulează `amigo-fm tune`.',
    needTune: 'Nesintonizat încă. Rulează întâi `amigo-fm tune`.',
    radioOn: '📻 Aparatul e pornit.',
    listening: '♫ Ascult frecvența...',
    turnOff: 'Ctrl+C ca să oprești.',
    nothingToPlay: '○ Frecvența e liniștită — nu e nimic de ascultat.',
    openUrl: 'Nu am găsit un player. Deschide asta în browser:',
    preparing: '📼 Îți pregătesc caseta...',
    stepFind: 'Caut sunetul',
    stepRecord: 'Înregistrez caseta',
    stepCheck: 'Verific caseta',
    tracks: (n) => `${n} piese`,
    replaceWarn: '⚠ E deja o casetă pe frecvență.',
    replaceAsk: '  O înlocuiesc? [d/N] ',
    replaceNo: '  Bine — caseta rămâne.',
    replaceNeedsYes: '  Rulează din nou cu --yes ca s-o înlocuiești.',
    yes: /^(d|da|y|yes)$/i,
    onAirDone: '✓ Caseta e în emisie.',
    stays: '  Rămâne 24 de ore.',
    ready: (p) => `✓ Casetă gata: ${p}`,
    tuneHello: '📻 Să sintonizăm aparatul.',
    askUrl: 'Adresa frecvenței: ',
    askKey: 'Cheia operatorului: ',
    bothNeeded: 'Am nevoie și de adresă, și de cheie.',
    tuned: '✓ Sintonizat.',
    needTools: 'Pentru asta am nevoie de yt-dlp și ffmpeg. Instalează-le cu: brew install yt-dlp ffmpeg',
    ytFailed: 'Nu am putut lua sunetul acela. Dacă link-ul e bun, poate YouTube a schimbat ceva: brew upgrade yt-dlp',
    ytBot: 'YouTube vrea să se asigure că nu ești un robot. Mai încearcă peste puțin timp sau setează AMIGO_FM_COOKIES=chrome (sau safari, firefox) ca să folosească sesiunea browserului tău.',
    ffFailed: 'ffmpeg nu a putut face asta.',
    noRec: 'Ce înregistrez? Dă-mi un link sau un fișier audio.',
    noMake: 'Ce fac? Dă-mi un link.',
    noFile: (f) => `Nu găsesc ${f}.`,
    gaveNothing: 'Lista aceea nu a dat nicio piesă.',
    unsure: 'Am făcut caseta, dar nu știu care e fișierul — uită-te în folder.',
    unknown: (c) => `Nu cunosc „${c}". Încearcă \`amigo-fm help\`.`,
    otherAnswer: (c) => `Frecvența a răspuns ${c}.`,
    splitTooBig: (f) => `O parte a ieșit de peste 100 MB (${f}). Nu s-a tăiat nimic; fișierul tău e neatins.`,
    splitNote: 'Sunt casete separate. Frecvența ține una singură și nu are coadă: las-o pe rând, pe fiecare cu `amigo-fm rec`.',
    help: `Adresa și cheia rămân pe acest calculator.
Mai mult: amigo-fm help --advanced`,
    commands: [
      ['play', '', 'Ascultă frecvența'],
      ['rec', '<link|fișier>', 'Lasă o casetă'],
      ['tune', '', 'Pune aparatul la punct'],
    ],
    advanced: `Avansat

  amigo-fm status                           cum e frecvența (și ecranul principal o arată)
  amigo-fm make <link> [-n nume]            face mp3-ul și îl păstrează (în ~/Downloads), fără să-l pună în emisie
  amigo-fm make <link> --mix [-n nume]      o listă întreagă, lipită într-un singur mp3
  amigo-fm split <fișier>                   peste 100 MB: tăiat în părți sub 100 MB, câte o casetă (frecvența ține una singură, fără coadă)
  --yes  nu întreba înainte de înlocuire   -d, --dir DIR  unde salvează „make"   --lang en|es|ro

Numele vechi merg în continuare: listen = play · air, put, leave = rec · login = tune · garden = status · prepare = make

Mediu: AMIGO_FM_URL, AMIGO_FM_KEY, AMIGO_FM_DIR, AMIGO_FM_LANG, AMIGO_FM_SEGMENT (secunde pe parte), AMIGO_FM_COOKIES (chrome | safari | firefox: yt-dlp folosește sesiunea ta YouTube din browser), NO_COLOR`,
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
// Opt-in only: the user names a browser, yt-dlp reads its YouTube session. Nothing is read otherwise.
const cookies = () => (process.env.AMIGO_FM_COOKIES ? ['--cookies-from-browser', process.env.AMIGO_FM_COOKIES] : []);
const ytError = (r) => soft(/not a bot|sign in to confirm/i.test(r.err) ? W.ytBot : W.ytFailed, lastLine(r.err));
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

// How long the tape is, in seconds (ffprobe reads it from the stream); null if it can't be told.
async function duration(src) {
  if (!which('ffprobe')) return null;
  const r = await capture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]);
  const n = parseFloat(r.out);
  return n > 0 ? n : null;
}

// The tape plays round and round, counted from the epoch, so whoever tunes in joins at the second everyone else hears:
// position = the clock modulo the tape's length, the same as the receiver at amigo.sh/fm. Nothing is asked of the band
// but the tape itself (no start time, no header). When it ends we look again and join by the clock; a new tape is a new length.
async function play(cfg) {
  needTune(cfg, 'url');
  const g = await look(cfg);
  if (g.state === 'unreachable') die(W.unreachable);
  if (g.state === 'quiet') return say(W.nothingToPlay);
  const url = bandUrl(cfg.url);
  const player = ['ffplay', 'mpv'].find(which);
  if (!player) return say(W.openUrl), console.log(url);

  say(W.radioOn);
  say();
  say(W.listening);
  say();
  say(dim(W.turnOff));

  let child, stopping = false;
  process.on('SIGINT', () => { stopping = true; child?.kill(); });
  for (let len = await duration(url); !stopping; ) {
    const pos = len ? ((Date.now() / 1000) % len).toFixed(2) : null;
    const args = player === 'ffplay'
      ? ['-nodisp', '-autoexit', '-loglevel', 'error', ...(pos ? ['-ss', pos] : []), url]
      : ['--no-video', '--really-quiet', ...(pos ? [`--start=${pos}`] : []), url];
    const t0 = Date.now();
    await new Promise((ok) => (child = spawn(player, args, { stdio: 'ignore' })).on('close', ok));
    if (stopping || !len || Date.now() - t0 < 1500) break; // no length to count by, or the player fell over: don't spin
    if ((await look(cfg)).state !== 'awake') return say(W.nothingToPlay);
    len = await duration(url);
  }
}

// A link -> a 128k mp3 without metadata, in `dir`. Shows the three steps. Returns the file path.
async function prepare(link, o, dir, enforce) {
  needTools('yt-dlp', 'ffmpeg');
  await mkdir(dir, { recursive: true });
  const name = o.name ? o.name.replace(/\.mp3$/i, '') : null;
  let file = null;

  say(W.preparing);
  await step(W.stepFind, async () => {
    const r = await capture('yt-dlp', [...cookies(), o.mix ? '--yes-playlist' : '--no-playlist', ...(o.mix ? ['--flat-playlist'] : []), '--simulate', '--print', '%(title)s', link]);
    if (!r.ok) throw ytError(r);
    const titles = r.out.trim().split('\n').filter(Boolean);
    if (!titles.length) throw soft(W.gaveNothing);
    return o.mix ? W.tracks(titles.length) : titles[0].slice(0, 48);
  });

  await step(W.stepRecord, async () => {
    if (!o.mix) {
      const before = new Set(await readdir(dir));
      const r = await capture('yt-dlp', [...cookies(), '--no-playlist', ...YT, '--print', 'after_move:filepath', '-P', dir, '-o', `${name || '%(title)s'}.%(ext)s`, link]);
      if (!r.ok) throw ytError(r);
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
      const r = await capture('yt-dlp', [...cookies(), '--yes-playlist', ...YT, '-P', tmp, '-o', '%(playlist_index)03d.%(ext)s', link]);
      if (!r.ok) throw ytError(r);
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

  const type = await check(file, enforce);
  return { file, type };
}

// What a file really is, from its first bytes (not from its name): the band is told the truth about the type.
async function sniff(file) {
  const fh = await open(file, 'r');
  const b = Buffer.alloc(12);
  await fh.read(b, 0, 12, 0);
  await fh.close();
  const at = (i, n) => b.toString('latin1', i, i + n);
  if (at(0, 4) === 'RIFF' && at(8, 4) === 'WAVE') return 'audio/wav';
  if (at(0, 4) === 'fLaC') return 'audio/flac';
  if (at(0, 4) === 'OggS') return 'audio/ogg';
  if (at(4, 4) === 'ftyp') return 'audio/mp4';
  if (at(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return ((b[1] >> 1) & 3) === 0 ? 'audio/aac' : 'audio/mpeg'; // layer 0 is ADTS
  return null;
}

// The last step of every tape, from a link or a file. Returns the type to leave it as.
async function check(file, enforce) {
  let type;
  await step(W.stepCheck, async () => {
    if (!file) throw soft(W.unsure);
    let size;
    try { size = (await stat(file)).size; } catch { throw soft(W.noFile(file)); }
    if (!size) throw soft(W.ytFailed);
    if (enforce && size > MAX_BYTES) throw soft(W.tooLarge);
    type = await sniff(file);
    if (!type) throw soft(W.notAudio);
    return mb(size);
  });
  return type;
}

// Cut a long file into tapes the band takes. The size of every part is checked before the original is touched.
async function split(file) {
  if (!file) die(W.noRec);
  needTools('ffmpeg', 'ffprobe');
  const f = resolve(file);
  let size;
  try { size = (await stat(f)).size; } catch { die(W.noFile(file)); }
  const type = await sniff(f);
  if (!type) die(W.notAudio);

  // Seconds per part from the file's own bitrate, aiming at 90 MB, so a 320k file is cut sooner than a 128k one.
  const len = await duration(f);
  const seconds = process.env.AMIGO_FM_SEGMENT || (len ? Math.max(1, Math.floor(90_000_000 / (size / len))) : SEGMENT);
  const ext = extname(f) || '.mp3';
  const base = join(dirname(f), basename(f, extname(f)));
  const mine = (n) => n.startsWith(basename(base) + '_part') && n.endsWith(ext);
  for (const n of (await readdir(dirname(f))).filter(mine)) await rm(join(dirname(f), n)); // an earlier cut

  const r = await capture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 'segment', '-segment_time', String(seconds), '-c', 'copy', '-map_metadata', '-1', '-reset_timestamps', '1', `${base}_part%02d${ext}`]);
  const parts = (await readdir(dirname(f))).filter(mine).sort().map((n) => join(dirname(f), n));
  const undo = () => Promise.all(parts.map((p) => rm(p, { force: true })));
  if (!r.ok || !parts.length) { await undo(); die(`${W.ffFailed}\n${dim(lastLine(r.err) || '')}`); }

  const sizes = await Promise.all(parts.map(async (p) => (await stat(p)).size));
  const bad = parts.findIndex((_, i) => sizes[i] === 0 || sizes[i] > MAX_BYTES);
  if (bad !== -1) { await undo(); die(W.splitTooBig(basename(parts[bad]))); }

  await rm(f); // only now: every part is there and fits
  parts.forEach((p, i) => say(`  ${basename(p)} ${dim(mb(sizes[i]))}`));
  say();
  say(dim(W.splitNote));
  return parts;
}

// The file -> the band, with a REC bar.
async function put(cfg, f, type) {
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
      headers: { 'X-Tape-Key': cfg.key, 'Content-Type': type, 'Content-Length': String(size) },
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
    const type = await check(f, true);
    say();
    return put(cfg, f, type);
  }

  // A link is prepared in a temporary folder and nothing is left behind.
  const tmp = await mkdtemp(join(tmpdir(), 'amigo-fm-'));
  try {
    const { file, type } = await prepare(target.startsWith('http') ? target : `https://${target}`, o, tmp, true);
    say();
    await put(cfg, file, type);
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
      const { file: out } = await prepare(o._[0], o, resolve(o.dir || cfg.dir), false);
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
