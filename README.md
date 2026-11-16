# amigo-fm 📻

![Heartware: states first, silence allowed](docs/heartware-badge.svg)

A single-tape radio protocol.

1 Worker. 1 R2 bucket. 2 routes. 24h TTL.

> The garden doesn't remember what you played.
> It only lets you hear what's playing.

## Band

One URL is the band: `https://amigo-fm.<you>.workers.dev/tape`

| Request                             | Who      | Answer                                      |
| ----------------------------------- | -------- | ------------------------------------------- |
| `PUT /tape` + `X-Tape-Key: <secret>` | emitter  | `204`. The tape is flowing.                 |
| `GET /tape`                         | anyone   | `200` / `206` audio stream, or `404`.       |

- A new `PUT` replaces the tape. There is only ever one.
- 24 hours after the `PUT`, `GET` answers `404`. The bytes go with the lifecycle rule below (the Worker also deletes them on the first request after).
- `GET` honours `Range`, so `<audio>` can seek. `HEAD` works too.
- `PUT` needs `Content-Type: audio/*` and a `Content-Length` (max 100 MB).
- Wrong or missing key: `401`. Not audio: `415`. Too big: `413`.
- CORS is open for reading. Nothing is cached, and the answer carries the tape's type and size and no hash of it (no `ETag`).

## Receptor

Zero infra. One tag:

```html
<audio src="https://amigo-fm.<you>.workers.dev/tape" controls></audio>
```

When the band is silent (`404`), the receptor does not show an error.
It breathes: a 528 Hz sine, swelling at 8 breaths per minute, peak gain 0.03.

```html
<audio id="tape" src="https://amigo-fm.<you>.workers.dev/tape" controls></audio>
<script>
  const tape = document.getElementById('tape');
  let silent = false;
  let breath;

  tape.addEventListener('error', () => { silent = true; });

  // Browsers only allow sound after a gesture.
  addEventListener('pointerdown', () => {
    if (!silent || breath) return;
    breath = new AudioContext();
    const sine = new OscillatorNode(breath, { frequency: 528 });
    const gain = new GainNode(breath, { gain: 0.015 });
    const lfo = new OscillatorNode(breath, { frequency: 8 / 60 });
    const depth = new GainNode(breath, { gain: 0.015 });
    lfo.connect(depth).connect(gain.gain);
    sine.connect(gain).connect(breath.destination);
    sine.start();
    lfo.start();
  });
</script>
```

## Emitter

Deploy (3 minutes, free tier):

```bash
git clone https://github.com/GratiaOS/amigo-fm && cd amigo-fm
wrangler r2 bucket create tapes
wrangler secret put TAPE_KEY
wrangler r2 bucket lifecycle add tapes expire-tapes --expire-days 1
wrangler deploy
```

The Worker stops serving a tape after 24 hours; the lifecycle rule makes R2 delete its bytes by itself (rules count in days, so it is gone in the day that follows).

Put a tape:

```bash
curl -X PUT https://amigo-fm.<you>.workers.dev/tape \
  -H "X-Tape-Key: <secret>" \
  -H "Content-Type: audio/mpeg" \
  --data-binary @tape.mp3
```

`204`. It's flowing. 24h. Gone.

### The terminal

Leaving a tape in a garden, from the terminal. `bin/amigo-fm.mjs`, no dependencies, Node 20+. English and Spanish: it follows your system language,
or `--lang es` / `AMIGO_FM_LANG=es`. Preparing a tape from a link needs `yt-dlp` and `ffmpeg` (`brew install yt-dlp ffmpeg`).

```bash
npm link                      # once, from the clone: gives you `amigo-fm`

amigo-fm connect              # the frequency (your Worker URL) and your key; typed once, kept only on this machine (0600)
amigo-fm garden               # 🪴 awake · 🌱 quiet · 🌫 out of reach
amigo-fm listen               # hear it (ffplay or mpv)
amigo-fm leave "LINK"         # prepare a tape from a YouTube / YT Music link and leave it; or leave a file
amigo-fm prepare "LINK"       # prepare it, don't leave it
```

If a tape is already in the garden, `leave` asks before replacing it (default: No; `--yes` skips the question). A prepared tape is 128k mp3 with no
metadata; the garden takes up to 100 MB. Playlists (`--mix`) and cutting a long file (`split`) are in `amigo-fm help --advanced`.

Nothing here adds to the server: no account, no history, no analytics. The frequency and the key never leave the machine except in the one request that
leaves the tape. When a download stops working, YouTube changed something: `brew upgrade yt-dlp`.

## Rules

- No accounts. No dashboard. No catalog.
- No "now playing". No analytics. No history.
- No takedown interface. The operator is responsible for what they put on the tape.
- One tape. If you want two, deploy two.

## License

MIT
