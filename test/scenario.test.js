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
  const run = (l) => { const r = g.runCommand(room, pl, l); return { ...r, out: strip(r.out) }; };
  const logs = [];
  for (let line of cmd.split('\n').filter(Boolean)) {
    if (line.includes('<id>')) {
      const lg = run('git log --oneline').out;
      const m = lg.split('\n').find((l) => l.includes(`speed up ${pl.vars.slug} service`));
      line = line.replace('<id>', m.split(' ')[0]);
    }
    const em = line.match(/^edit (\S+)/);
    if (em) {
      const path = em[1];
      const cur = pl.repo.work[path] ?? '';
      let neu;
      if (/VERSION$/.test(path)) neu = '1.0.0\n';
      else if (/profile\.txt$/.test(path)) neu = hasMarkers(cur) ? `name=${pl.name}\ntheme=${pl.vars.theme}\n` : cur.replace('theme=light', `theme=${pl.vars.theme}`);
      else if (/bugs\//.test(path)) neu = cur.replace('status=broken', 'status=fixed');
      else neu = cur + 'x\n';
      g.saveFile(room, pl, path, neu);
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
      const before = pl.doneTasks;
      const id = g.tasksOf(room, pl)[pl.taskIdx].id;
      const logs = step(g, room, pl);
      if (pl.doneTasks === before) {
        // allow one retry loop before failing: e.g. a second conflict after racing pushes
        const again = step(g, room, pl);
        if (pl.doneTasks === before) assert.fail(`${pl.name} stuck on "${id}" (stage ${pl.stageIdx}) logs=${logs.join(' | ')} / ${again.join(' | ')}\nstatus: ${JSON.stringify(pl.repo.state)}`);
      }
      moved = true;
    }
    if (!moved) { const w = players.filter((p) => p.waiting); assert.fail('deadlock; waiting: ' + w.map((p) => p.name + '@' + p.stageIdx)); }
  }
  assert.equal(room.status, 'done');
  const counts = new Set(players.map((p) => p.doneTasks));
  assert.equal(counts.size, 1, 'everyone does the same number of tasks');
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
