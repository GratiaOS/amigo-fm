# amigo-fm 📻

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
- 24 hours after the `PUT`, `GET` answers `404` and the tape is deleted.
- `GET` honours `Range`, so `<audio>` can seek. `HEAD` works too.
- `PUT` needs `Content-Type: audio/*` and a `Content-Length` (max 100 MB).
- Wrong or missing key: `401`. Not audio: `415`. Too big: `413`.
- CORS is open for reading. Nothing is cached.

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
wrangler deploy
```

Put a tape:

```bash
curl -X PUT https://amigo-fm.<you>.workers.dev/tape \
  -H "X-Tape-Key: <secret>" \
  -H "Content-Type: audio/mpeg" \
  --data-binary @tape.mp3
```

`204`. It's flowing. 24h. Gone.

Until `TAPE_KEY` is set, every `PUT` is refused.

## Rules

- No accounts. No dashboard. No catalog.
- No "now playing". No analytics. No history.
- No takedown interface. The operator is responsible for what they put on the tape.
- One tape. If you want two, deploy two.

## License

MIT
