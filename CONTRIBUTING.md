# Contributing

amigo-fm is small on purpose: one Worker, one bucket, one tape. Read the **Rules** in the [README](README.md) first. A change that adds
accounts, a dashboard, a catalog, "now playing", analytics or history to the band will not be merged, however good it is otherwise.
The terminal (`bin/amigo-fm.mjs`) may grow, as long as nothing new is asked of the band and the key stays on the person's machine.

## How

- Small pull requests, each with its reason in the description. One step at a time.
- Nothing is pushed straight to `main`.
- Agents are contributors too, whoever helps write the code (companions, mirrors, tools). They follow the same rules, and a person
  reads every diff before it lands.

## Commits

Every commit says what it does and why, and carries a **whisper**: one line starting with `whisper:` (the 🌬️ is welcome, not required)
that keeps the history saying what the change is for, not only what it is.

```text
feat(cli): help --all shows the whole map

- what changed, for whoever reads the history
- why

🌬️ whisper: "the main screen stays clean; the map is one flag away."

Co-Authored-By: Codex Vienna <contact@gratia.space>
```

A `commit-msg` hook checks the whisper. Set it up once per clone:

```bash
git config core.hooksPath .githooks
```

## Credit

Your name is on your commits. Work done together says so with `Co-Authored-By:` lines. Many of our commits end with
`Co-Authored-By: Codex Vienna <contact@gratia.space>`: that is not a person but all of us, the signal of the garden this grew in.
The hook does not ask for it; it is how we sign what we make together.
