// Room / player / progression logic. Transport-agnostic (index.js wires websockets to it).
import crypto from 'node:crypto';
import { Repo, run, writeFile, fileStatuses, graphData, aheadBehind, headId, short, normPath } from './gitsim.js';
import { buildScenario, seedOrigin, makePlayerVars, FLOWS, URL, CHEATSHEET } from './scenario.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

const rid = () => crypto.randomBytes(12).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export class Game {
  constructor() {
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref?.();
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const anyone = [...room.players.values()].some((p) => p.connected);
      if (!anyone && now - room.lastActive > 2 * 3600 * 1000) this.rooms.delete(code);
    }
  }

  newCode() {
    for (;;) {
      const c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
      if (!this.rooms.has(c)) return c;
    }
  }

  cleanName(n) {
    return String(n || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 14);
  }

  createRoom(name, flow) {
    name = this.cleanName(name);
    if (!name) return { error: 'Please enter a name.' };
    const room = {
      code: this.newCode(),
      flow: FLOWS[flow] ? flow : 'gitflow',
      status: 'lobby',
      hostId: null,
      players: new Map(),
      origin: null,
      stages: null,
      meta: {},
      stageStarted: new Set(),
      feed: [],
      lastActive: Date.now(),
      startedAt: null,
    };
    this.rooms.set(room.code, room);
    const pl = this.addPlayer(room, name);
    room.hostId = pl.id;
    return { room, player: pl };
  }

  addPlayer(room, name) {
    const pl = {
      id: rid().slice(0, 8),
      token: rid(),
      name,
      vars: null,
      connected: false,
      send: null,
      repo: new Repo({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@team.dev` }),
      hist: [],
      cmdCount: 0,
      stageIdx: 0,
      taskIdx: 0,
      taskHistStart: 0,
      waiting: false,
      finished: false,
      finishedAt: null,
      doneTasks: 0,
      tasksCache: {},
      hintShown: {},
      hintsUsed: 0,
      stageTimes: [],
    };
    room.players.set(pl.id, pl);
    return pl;
  }

  joinRoom(code, name) {
    const room = this.rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return { error: 'Room not found. Check the code.' };
    name = this.cleanName(name);
    if (!name) return { error: 'Please enter a name.' };
    if (room.status !== 'lobby') return { error: 'That game already started.' };
    if (room.players.size >= MAX_PLAYERS) return { error: `Room is full (max ${MAX_PLAYERS} players).` };
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return { error: 'That name is taken in this room.' };
    return { room, player: this.addPlayer(room, name) };
  }

  resume(code, token) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) return null;
    const player = [...room.players.values()].find((p) => p.token === token);
    return player ? { room, player } : null;
  }

  setFlow(room, pl, flow) {
    if (room.status !== 'lobby' || pl.id !== room.hostId || !FLOWS[flow]) return;
    room.flow = flow;
    this.broadcast(room);
  }

  start(room, pl) {
    if (room.status !== 'lobby' || pl.id !== room.hostId) return { error: 'Only the host can start.' };
    const list = [...room.players.values()].filter((p) => p.connected);
    if (list.length < MIN_PLAYERS) return { error: `Need at least ${MIN_PLAYERS} players in the room.` };
    for (const p of [...room.players.values()]) if (!p.connected) room.players.delete(p.id);
    const taken = new Set();
    let i = 0;
    for (const p of room.players.values()) { p.vars = { name: p.name, ...makePlayerVars(p.name, i++, taken) }; }
    room.origin = seedOrigin([...room.players.values()].map((p) => p.vars), room.flow);
    room.stages = buildScenario(room.flow);
    room.status = 'playing';
    room.startedAt = Date.now();
    room.stageStarted.add(0);
    room.stageStartAt = { 0: Date.now() };
    this.say(room, `Game started: ${FLOWS[room.flow].name}. ${room.players.size} players. Same tasks for everyone!`);
    for (const p of room.players.values()) { p.taskHistStart = 0; this.advance(room, p); }
    this.broadcast(room);
    return {};
  }

  say(room, text, kind = 'info') {
    room.feed.push({ t: Date.now(), text, kind });
    if (room.feed.length > 40) room.feed.shift();
  }

  /* ----------------------------------------------------------- progression */

  tasksOf(room, pl, stageIdx = pl.stageIdx) {
    if (!pl.tasksCache[stageIdx]) pl.tasksCache[stageIdx] = room.stages[stageIdx].tasks(pl.vars, { meta: room.meta });
    return pl.tasksCache[stageIdx];
  }

  ctx(room, pl) {
    const start = pl.taskHistStart;
    return {
      r: pl.repo,
      o: room.origin,
      p: pl.vars,
      meta: room.meta,
      ran: (re) => pl.hist.slice(start).some((h) => h.code === 0 && re.test(h.line)),
    };
  }

  advance(room, pl) {
    if (pl.finished || pl.waiting || room.status !== 'playing') return;
    for (let guard = 0; guard < 60; guard++) {
      const tasks = this.tasksOf(room, pl);
      const task = tasks[pl.taskIdx];
      let pass = false;
      try { pass = !!task.check(this.ctx(room, pl)); } catch { pass = false; }
      if (!pass) return;
      pl.doneTasks++;
      pl.taskIdx++;
      pl.taskHistStart = pl.hist.length;
      if (pl.taskIdx >= tasks.length) {
        pl.stageTimes[pl.stageIdx] = Date.now();
        if (pl.stageIdx >= room.stages.length - 1) {
          pl.finished = true;
          pl.finishedAt = Date.now();
          this.say(room, `🏁 ${pl.name} finished all tasks!`, 'good');
          this.checkDone(room);
        } else {
          pl.waiting = true;
          this.say(room, `✅ ${pl.name} completed "${room.stages[pl.stageIdx].title}"`, 'good');
          this.checkBarrier(room);
        }
        return;
      }
    }
  }

  checkDone(room) {
    if ([...room.players.values()].every((p) => p.finished || !p.connected) && [...room.players.values()].some((p) => p.finished)) {
      room.status = 'done';
      this.say(room, '🎉 Everyone finished. Great teamwork!', 'good');
    }
  }

  checkBarrier(room) {
    const members = [...room.players.values()].filter((p) => p.connected && !p.finished);
    if (!members.length) return;
    for (let s = 0; s < room.stages.length - 1; s++) {
      const here = members.filter((p) => p.stageIdx === s && p.waiting);
      if (!here.length) continue;
      const blocked = members.some((p) => p.stageIdx < s || (p.stageIdx === s && !p.waiting));
      if (blocked) continue;
      this.release(room, s, here);
    }
  }

  release(room, s, players) {
    const next = s + 1;
    if (!room.stageStarted.has(next)) {
      room.stageStarted.add(next);
      room.stageStartAt[next] = Date.now();
      const st = room.stages[next];
      this.say(room, `➡️ Stage ${next + 1}: ${st.title}`, 'stage');
      if (st.setup) for (const msg of st.setup(room.origin, room.meta, [...room.players.values()].map((p) => p.vars)) || []) this.say(room, `🤖 ${msg}`, 'bot');
    }
    for (const p of players) { p.stageIdx = next; p.taskIdx = 0; p.waiting = false; p.taskHistStart = p.hist.length; }
    for (const p of players) this.advance(room, p);
  }

  forceRelease(room, pl) {
    if (pl.id !== room.hostId || room.status !== 'playing') return;
    const waiting = [...room.players.values()].filter((p) => p.waiting && !p.finished);
    if (!waiting.length) return;
    const s = Math.min(...waiting.map((p) => p.stageIdx));
    this.say(room, `${pl.name} (host) moved the group on to the next stage.`);
    this.release(room, s, waiting.filter((p) => p.stageIdx === s));
    this.broadcast(room);
  }

  /* --------------------------------------------------------------- actions */

  runCommand(room, pl, line) {
    if (room.status === 'lobby') return { out: 'The game has not started yet.', code: 1 };
    line = String(line || '').slice(0, 400);
    const res = run(pl.repo, room.origin, line);
    pl.hist.push({ line: line.trim(), code: res.code });
    if (pl.hist.length > 400) { pl.hist.splice(0, 100); pl.taskHistStart = Math.max(0, pl.taskHistStart - 100); }
    pl.cmdCount++;
    for (const ev of res.events || []) {
      if (ev.type === 'push' && ev.branch) this.say(room, ev.deleted ? `${pl.name} deleted origin/${ev.branch}` : `${pl.name} pushed ${ev.branch}${ev.isNew ? ' (new branch)' : ''}`);
      if (ev.type === 'push' && ev.tag) this.say(room, `${pl.name} pushed tag ${ev.tag}`);
    }
    this.advance(room, pl);
    room.lastActive = Date.now();
    this.broadcast(room);
    return res;
  }

  saveFile(room, pl, path, content) {
    if (room.status === 'lobby') return { ok: false, error: 'Game not started.' };
    const res = writeFile(pl.repo, path, content);
    if (res.ok) { pl.hist.push({ line: `[editor] saved ${res.path}`, code: 0 }); this.advance(room, pl); }
    this.broadcast(room);
    return res;
  }

  deleteFile(room, pl, path) {
    const p = normPath(path);
    if (p && pl.repo.work[p] !== undefined) { delete pl.repo.work[p]; pl.hist.push({ line: `[editor] deleted ${p}`, code: 0 }); this.advance(room, pl); }
    this.broadcast(room);
  }

  hint(room, pl) {
    if (room.status !== 'playing' || pl.waiting || pl.finished) return;
    const task = this.tasksOf(room, pl)[pl.taskIdx];
    const shown = pl.hintShown[task.id] || 0;
    if (shown < task.hints.length) { pl.hintShown[task.id] = shown + 1; pl.hintsUsed++; }
    this.sendState(room, pl);
  }

  /* ----------------------------------------------------------------- views */

  connect(room, pl, send) {
    pl.send = send;
    pl.connected = true;
    room.lastActive = Date.now();
    this.say(room, `${pl.name} joined`);
    if (room.status === 'playing') { this.checkBarrier(room); }
    this.broadcast(room);
  }

  disconnect(room, pl, send) {
    if (pl.send !== send) return;
    pl.connected = false;
    pl.send = null;
    if (room.status === 'lobby') {
      room.players.delete(pl.id);
      if (room.hostId === pl.id) {
        const next = [...room.players.values()].find((p) => p.connected);
        if (next) room.hostId = next.id; else this.rooms.delete(room.code);
      }
    } else {
      this.say(room, `${pl.name} disconnected (their progress is saved, they can rejoin)`);
      this.checkBarrier(room);
      this.checkDone(room);
    }
    this.broadcast(room);
  }

  broadcast(room) {
    for (const p of room.players.values()) this.sendState(room, p);
  }

  sendState(room, pl) {
    if (pl.send) pl.send({ t: 'state', ...this.view(room, pl) });
  }

  view(room, pl) {
    const players = [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      host: p.id === room.hostId,
      you: p.id === pl.id,
      stage: room.stages ? p.stageIdx : 0,
      stageTitle: room.stages ? room.stages[p.stageIdx].title : '',
      done: p.doneTasks,
      waiting: p.waiting,
      finished: p.finished,
    }));
    const base = {
      room: {
        code: room.code,
        flow: room.flow,
        flows: Object.values(FLOWS),
        flowName: FLOWS[room.flow].name,
        status: room.status,
        players,
        feed: room.feed.slice(-25),
        min: MIN_PLAYERS,
        max: MAX_PLAYERS,
        url: URL,
        outline: buildScenario(room.flow).map((s) => s.title),
      },
      you: { id: pl.id, name: pl.name, host: pl.id === room.hostId },
    };
    if (room.status === 'lobby') return base;
    const stage = room.stages[pl.stageIdx];
    const tasks = this.tasksOf(room, pl);
    const total = room.stages.reduce((n, _s, i) => n + this.tasksOf(room, pl, i).length, 0);
    base.progress = {
      stageIdx: pl.stageIdx,
      stageCount: room.stages.length,
      stageTitle: stage.title,
      stageIntro: stage.intro,
      stages: room.stages.map((s, i) => ({ title: s.title, tasks: this.tasksOf(room, pl, i).length, done: i < pl.stageIdx || (i === pl.stageIdx && pl.waiting) || pl.finished ? this.tasksOf(room, pl, i).length : i === pl.stageIdx ? pl.taskIdx : 0 })),
      taskIdx: pl.taskIdx,
      taskCount: tasks.length,
      waiting: pl.waiting,
      waitingOn: pl.waiting ? [...room.players.values()].filter((p) => p.connected && !p.finished && !(p.stageIdx > pl.stageIdx || (p.stageIdx === pl.stageIdx && p.waiting))).map((p) => p.name) : [],
      finished: pl.finished,
      done: pl.doneTasks,
      total,
      task: null,
      allTasks: tasks.map((t, i) => ({ id: t.id, title: t.title, state: pl.waiting || pl.finished || i < pl.taskIdx ? 'done' : i === pl.taskIdx ? 'current' : 'todo' })),
    };
    if (!pl.waiting && !pl.finished) {
      const t = tasks[pl.taskIdx];
      const shown = pl.hintShown[t.id] || 0;
      base.progress.task = { id: t.id, title: t.title, goal: t.goal, why: t.why || null, hints: t.hints.slice(0, shown), hintsTotal: t.hints.length };
    }
    const r = pl.repo;
    const refs = {};
    for (const [n, id] of Object.entries(r.branches)) refs[n] = id;
    for (const [n, id] of Object.entries(r.remote)) refs[n] = id;
    for (const [n, t] of Object.entries(r.tags)) refs['tag: ' + n] = t.id;
    const orefs = { ...room.origin.branches };
    for (const [n, t] of Object.entries(room.origin.tags)) orefs['tag: ' + n] = t.id;
    base.repo = {
      cloned: r.cloned,
      dir: r.dir,
      head: r.head,
      branches: Object.keys(r.branches).sort().map((n) => {
        const up = r.upstream[n];
        const ab = up && r.remote[up] ? aheadBehind(r, r.branches[n], r.remote[up]) : null;
        return { name: n, current: r.head?.branch === n, upstream: up || null, ahead: ab?.ahead || 0, behind: ab?.behind || 0 };
      }),
      remoteBranches: Object.keys(r.remote).sort(),
      tags: Object.keys(r.tags).sort(),
      files: fileStatuses(r),
      stash: r.stash.length,
      state: r.state ? { type: r.state.type, conflicts: r.state.conflicts || [] } : null,
      local: r.cloned ? graphData(r, refs, headId(r)) : [],
      origin: graphData(room.origin, orefs),
      originBranches: Object.keys(room.origin.branches).sort(),
    };
    if (room.status === 'done' || pl.finished) {
      base.summary = {
        cheatsheet: CHEATSHEET[room.flow],
        players: [...room.players.values()].map((p) => ({ name: p.name, tasks: p.doneTasks, hints: p.hintsUsed, commands: p.cmdCount, minutes: p.finishedAt ? Math.max(1, Math.round((p.finishedAt - room.startedAt) / 60000)) : null })),
      };
    }
    return base;
  }
}
