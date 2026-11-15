# Git Simulation Online

A multiplayer training room for learning git the way it is used on the job: feature branches, hotfixes, releases and the dreaded **merge conflict**. 2 to 5 players join a room; the **server decides the scenario**, every player gets the **same tasks**, and nobody needs a GitHub account or a real repository.

```bash
npm install
npm start          # http://localhost:3000   (PORT=... to change)
npm test           # engine + full scenario runs (2, 3 and 5 simulated players)
```

## How it works

- **A real (simulated) git.** `server/gitsim.js` is an in-memory git: commits, branches, tags, staging area, `merge` (fast-forward / 3-way / `--no-ff`), `rebase` (incl. conflicts, `--continue`, `--abort`), `cherry-pick`, `revert`, `stash`, `reset`, `restore`, `fetch/pull/push` (with real rejections, `-u`, `--force-with-lease`, delete) and line-based 3-way merge with conflict markers.
- **Each player has a private clone; the room has one shared `origin`.** Pushes and pulls between players are real, so "rejected, fetch first" happens naturally.
- **Click or type.** A real-looking terminal (history, Tab completion, ANSI colours), quick-command buttons, a file editor with one-click conflict helpers, a branches panel, and commit graphs for your repo and for origin.
- **Same learning for everyone.** Tasks are parameterised per player (own branch names, own files) and verified from repository *state*, not by matching the exact command, so any valid way of doing it counts. Each stage is a barrier: the next stage starts when everybody finished the current one. At the start of a stage a teammate bot ("Sam") pushes to origin. That is what sets up your merge conflict. Each player conflicts on their *own* file, so everyone practises the same thing.
- **Progressive hints** (concept first, exact command last) and a short "why it matters" on key tasks. A cheat sheet and team stats are shown at the end.

## Workflows

| Flow | Stages |
|---|---|
| **Git Flow** (45 tasks) | clone/inspect · feature branch off `develop` · integrate (pull, merge, push, delete branches) · prepare change · **merge conflict** · **hotfix** (stash, `hotfix/*` from `main`, tag, back-merge to `develop`) · **release** (`release/*`, `--no-ff` into `main`, tag, back-merge) |
| **Trunk-based** (32 tasks) | clone/inspect · short-lived branch with small commits · `fetch` + **rebase** + `--force-with-lease` · prepare change · **conflict during rebase** · **revert** a bad commit on `main` (with stash) · release by tag |

## Adding or changing a scenario

Everything lives in `server/scenario.js`. A stage is `{ id, title, intro, setup?(origin, meta, players), tasks(player) }`. A task is `T(id, title, goal, hints, check, { why })`, where `check({ r, o, p, meta, ran })` receives the player's repo `r`, the shared origin `o`, their variables `p`, shared bot data `meta`, and `ran(/regex/)` for read-only commands. `test/scenario.test.js` plays every task for several interleaved players using each task's final hint, so a scenario that cannot be completed fails the test.

## Layout

```
server/gitsim.js    git engine
server/scenario.js  flows, stages, tasks, checks
server/game.js      rooms, barriers, progress, per-player views
server/index.js     HTTP + WebSocket
public/             vanilla JS client (no build step)
test/               node:test suites
```

State is in memory (rooms are dropped after ~2h without players). Refreshing the page rejoins your seat.
