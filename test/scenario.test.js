import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.js';
import { hasMarkers } from '../server/gitsim.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function setup(flow, names) {
  const g = new Game();
  const { room, player } = g.createRoom(names[0], flow);
  const players = [player];
  for (const n of names.slice(1)) players.push(g.joinRoom(room.code, n).player);
  const inbox = new Map();
  for (const p of players) g.connect(room, p, (m) => inbox.set(p.id, m));
  assert.ok(!g.start(room, player).error);
  return { g, room, players, inbox };
}

function step(g, room, pl) {
  const task = g.tasksOf(room, pl)[pl.taskIdx];
  const last = task.hints[task.hints.length - 1];
  const cmd = last.cmd || '';
  const run = (l) => { const r = g.runCommand(room, pl, l); if (/CONFLICT/.test(r.out)) pl.conflicts = (pl.conflicts || 0) + 1; return { ...r, out: strip(r.out) }; };
  const logs = [];
  for (let line of cmd.split('\n').filter(Boolean)) {
    if (line.includes('<id>')) {
      const lg = run('git log --oneline').out;
      const m = lg.split('\n').find((l) => l.includes(`speed up ${pl.vars.slug} service`));
      line = line.replace('<id>', m.split(' ')[0]);
    }
    const em = line.match(/^edit (\S+)/);
    if (em) {
      // the player only knows what the instructions say: take the exact content from the task text
      const goal = typeof task.goal === 'function' ? task.goal(g.ctx(room, pl)) : task.goal;
      const m = goal.match(/```\n([\s\S]*?)```/);
      assert.ok(m, `task ${task.id} says "edit" but its instructions contain no exact content`);
      g.saveFile(room, pl, em[1], m[1]);
      continue;
    }
    let r = run(line);
    let tries = 0;
    while (r.code && /^git push/.test(line) && /rejected/.test(r.out) && tries++ < 6) {
      const pr = run(/--force-with-lease/.test(line) ? 'git fetch' : 'git pull --no-rebase');
      if (pr.code) logs.push('PULL FAILED ' + pr.out);
      if (/--force-with-lease/.test(line)) break;
      r = run(line);
    }
    if (r.code && !/^git (merge|rebase|pull)/.test(line)) logs.push(`${pl.name}: "${line}" -> ${r.out}`);
  }
  return logs;
}

function playAll(flow, names) {
  const { g, room, players } = setup(flow, names);
  let guard = 0;
  while (room.status === 'playing' && guard++ < 4000) {
    let moved = false;
    for (const pl of players) {
      if (pl.finished || pl.waiting) continue;
      if (g.relayInfo(room, pl)?.blockedBy.length) continue; // not this player's turn
      const before = pl.doneTasks;
      const id = g.tasksOf(room, pl)[pl.taskIdx].id;
      const logs = step(g, room, pl);
      if (pl.doneTasks === before) {
        // allow one retry loop before failing: e.g. a second conflict after racing pushes
        const again = step(g, room, pl);
        if (pl.doneTasks === before) assert.fail(`FB: ${g.view(room, pl).progress.task?.feedback}\n`+`${pl.name} stuck on "${id}" (stage ${pl.stageIdx}) logs=${logs.join(' | ')} / ${again.join(' | ')}\nstatus: ${JSON.stringify(pl.repo.state)}`);
      }
      moved = true;
    }
    if (!moved) { const w = players.filter((p) => p.waiting); assert.fail('deadlock; waiting: ' + w.map((p) => p.name + '@' + p.stageIdx)); }
  }
  assert.equal(room.status, 'done');
  const counts = new Set(players.map((p) => p.doneTasks));
  assert.equal(counts.size, 1, 'everyone does the same number of tasks');
  // the relay makes everybody (except the very first/last in each round) conflict with a teammate
  for (const p of players) assert.ok((p.conflicts || 0) >= 1, `${p.name} never hit a conflict`);
  const first = players[0], last = players[players.length - 1];
  assert.ok(first.conflicts >= 1 && last.conflicts >= 1);
  return { room, players };
}

test('git flow, 3 players, full run', () => { playAll('gitflow', ['Alice', 'Bob', 'Carol']); });
test('git flow, 5 players, full run', () => { playAll('gitflow', ['Alice', 'Bob', 'Carol', 'Dan', 'Eve']); });
test('trunk based, 2 players, full run', () => { playAll('trunk', ['Alice', 'Bob']); });
test('trunk based, 5 players, full run', () => { playAll('trunk', ['Alice', 'Bob', 'Carol', 'Dan', 'Eve']); });

test('lobby rules', () => {
  const g = new Game();
  const { room, player } = g.createRoom('Host', 'gitflow');
  g.connect(room, player, () => {});
  assert.match(g.start(room, player).error, /at least 2/);
  for (const n of ['A', 'B', 'C', 'D']) { const j = g.joinRoom(room.code, n); g.connect(room, j.player, () => {}); }
  assert.match(g.joinRoom(room.code, 'F').error, /full/);
  assert.match(g.joinRoom(room.code, 'a').error ?? 'ok', /full|taken/);
});

/* ---------------------------------------------------------------- strictness */
test('wrong content / message / files / tags are rejected with an explanation', () => {
  const { g, room, players } = setup('gitflow', ['Alice', 'Bob']);
  const [a, b] = players;
  const run = (pl, l) => g.runCommand(room, pl, l);
  const fb = (pl) => g.view(room, pl).progress.task?.feedback || '';
  const cur = (pl) => g.tasksOf(room, pl)[pl.taskIdx].id;
  for (const l of ['git clone https://git.sim/team/shop.git', 'git log --oneline', 'git branch -a', 'git status']) run(a, l);
  for (const l of ['git clone https://git.sim/team/shop.git', 'git log --oneline', 'git branch -a', 'git status']) run(b, l);
  run(a, 'git switch develop');
  assert.equal(cur(a), 'new-feature');
  run(a, 'git switch -c feature/wrong-name');
  assert.equal(cur(a), 'new-feature');
  assert.match(fb(a), /named exactly/);
  run(a, 'git branch -m feature/alice-profile');
  assert.equal(cur(a), 'create-file');
  // wrong content
  g.saveFile(room, a, 'features/alice.txt', 'hello');
  assert.equal(cur(a), 'create-file');
  assert.match(fb(a), /must contain exactly this/);
  g.saveFile(room, a, 'features/alice.txt', 'Feature: profile page\nOwner: Alice\n');
  assert.equal(cur(a), 'stage');
  run(a, 'git add features/alice.txt');
  assert.equal(cur(a), 'commit');
  // an extra file in the commit is rejected
  g.saveFile(room, a, 'extra.txt', 'x');
  run(a, 'git add extra.txt');
  run(a, 'git commit -m "feat: add alice profile page"');
  assert.equal(cur(a), 'commit');
  assert.match(fb(a), /must change only/);
  run(a, 'git reset --soft HEAD~1');
  run(a, 'git restore --staged extra.txt');
  // wrong message
  run(a, 'git commit -m "added stuff"');
  assert.equal(cur(a), 'commit');
  assert.match(fb(a), /must be exactly.*feat: add alice profile page[\s\S]*--amend/);
  run(a, 'git commit --amend -m "feat: add alice profile page"');
  assert.equal(cur(a), 'push-feature');
});

test('conflict resolution must follow the team rule exactly', () => {
  const { g, room, players } = setup('gitflow', ['Alice', 'Bob']);
  // play both quickly until the first relay stage using the normal solver
  let guard = 0;
  while (guard++ < 500 && !players.every((p) => p.stageIdx >= 4)) {
    for (const pl of players) { if (pl.waiting || pl.finished || pl.stageIdx >= 4) continue; step(g, room, pl); }
  }
  const [a, b] = players; // Alice goes first in round 1
  const task = (pl) => g.tasksOf(room, pl)[pl.taskIdx].id;
  while (task(a) !== 'conf1-push') step(g, room, a);
  step(g, room, a); // Alice pushes
  assert.equal(a.waiting, true);
  // Bob: pull, merge -> conflict
  while (task(b) !== 'conf1-resolve') step(g, room, b);
  assert.match(b.repo.work['team/settings.txt'], /<<<<<<</);
  // keeping only his own value (wrong): not accepted
  g.saveFile(room, b, 'team/settings.txt', '# Team settings (everybody edits this file!)\ntheme=green\n\nlanguage=en\n');
  assert.equal(task(b), 'conf1-resolve');
  assert.match(g.view(room, b).progress.task.feedback, /# Bob wanted: theme=green/);
  // following the rule exactly: accepted
  const goal = g.view(room, b).progress.task.goal;
  g.saveFile(room, b, 'team/settings.txt', goal.match(/```\n([\s\S]*?)```/)[1]);
  assert.equal(task(b), 'conf1-add');
  assert.equal(b.repo.work['team/settings.txt'].includes('# Bob wanted: theme=green'), true);
});
