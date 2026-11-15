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
- **Same learning for everyone, strictly validated.** Tasks are parameterised per player (own branch names, own files) and verified from repository *state*, so any valid way of typing a command counts, **but the result must match the instructions exactly**: exact branch names, exact file contents, exact commit and tag messages, and only the expected files in each commit. A task does not turn green until everything matches, and the player gets a red "Not accepted yet" box that says what is wrong and how to fix it (e.g. `git commit --amend -m "…"`, `git reset --soft HEAD~1`, delete and re-create a tag). Each stage is a barrier: the next stage starts when everybody finished the current one. A teammate bot ("Sam") only sets the scene (new commits, bug reports); it never causes your conflicts.
- **Conflicts come from your teammates (relay).** Everyone changes the *same line* of `team/settings.txt`, then players integrate **one after another**: player 1 merges/rebases cleanly and pushes, player 2 conflicts with player 1's change, player 3 conflicts with player 2's resolution, and so on. Conflicts are resolved by a **team rule** that has exactly one correct result: the teammate's value stays and you add `# <Name> wanted: field=value` right below it. The instructions show the exact expected file. The server keeps `fetch/pull/merge/push/rebase` locked until everyone ahead of you finished (the host can unlock it if someone is AFK). **Round 2 runs in reverse order** (on the `language=` line), so whoever went first conflict-free in round 1 resolves conflicts in round 2.
- **Progressive hints** (concept first, exact command last) and a short "why it matters" on key tasks. A cheat sheet and team stats are shown at the end.

## Workflows

| Flow | Stages |
|---|---|
| **Git Flow** (56 tasks) | clone/inspect · feature branch off `develop` · integrate (pull, merge, push, delete branches) · prepare change · **2-round merge-conflict relay** · **hotfix** (stash, `hotfix/*` from `main`, tag, back-merge to `develop`) · **release** (`release/*`, `--no-ff` into `main`, tag, back-merge) |
| **Trunk-based** (42 tasks) | clone/inspect · short-lived branch with small commits · `fetch` + **rebase** + `--force-with-lease` · prepare change · **2-round conflict relay during rebase** · **revert** a bad commit on `main` (with stash) · release by tag |

## Adding or changing a scenario

Everything lives in `server/scenario.js`. A stage is `{ id, title, intro, setup?(origin, meta, players), tasks(player) }`. A task is `V(id, title, goal, hints, issue, { why })`: `goal` may be a function of the context (to show the exact expected content), and `issue({ r, o, p, meta, ran })` returns `null` when everything is exactly right, a string explaining what to fix, or `''` for "not done yet". It receives the player's repo `r`, the shared origin `o`, their variables `p`, shared bot data `meta`, and `ran(/regex/)` for read-only commands. `test/scenario.test.js` plays every task for several interleaved players using each task's final hint, so a scenario that cannot be completed fails the test.

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
