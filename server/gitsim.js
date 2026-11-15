// A small but faithful in-memory git simulator.
// Each player has a Repo (local clone); the room has one shared Origin (the "server").
// Trees are flat maps  path -> content  and commits are immutable.
import crypto from 'node:crypto';

const ESC = '\x1b[';
export const C = {
  red: (s) => `${ESC}31m${s}${ESC}0m`,
  green: (s) => `${ESC}32m${s}${ESC}0m`,
  yellow: (s) => `${ESC}33m${s}${ESC}0m`,
  blue: (s) => `${ESC}34m${s}${ESC}0m`,
  cyan: (s) => `${ESC}36m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
};

/* ------------------------------------------------------------------ objects */

let CLOCK = Math.floor(Date.UTC(2026, 0, 12, 9, 0, 0) / 1000);
const tick = () => (CLOCK += 137);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const short = (id) => (id ? id.slice(0, 7) : '0000000');

export class Store {
  constructor() {
    this.commits = {};
    this.branches = {};
    this.tags = {}; // name -> {id, msg|null}
  }
}

export class Origin extends Store {
  constructor(url) {
    super();
    this.url = url;
    this.defaultBranch = 'main';
    this.version = 0;
  }
}

export class Repo extends Store {
  constructor(user) {
    super();
    this.user = user; // {name,email}
    this.cloned = false;
    this.dir = null;
    this.url = null;
    this.remote = {}; // 'origin/main' -> id
    this.upstream = {}; // local branch -> 'origin/x'
    this.head = null; // {branch} | {detached}
    this.index = {};
    this.work = {};
    this.stash = [];
    this.state = null; // merge | rebase | revert | cherry-pick
  }
}

export function makeCommit(store, { parents, tree, msg, author }) {
  const ts = tick();
  const id = sha(JSON.stringify([parents, tree, msg, author, ts]));
  store.commits[id] = { id, parents, tree, msg, author, ts };
  return id;
}

/** Server-side helper (used for seeding and teammate-bot commits). */
export function originCommit(o, branch, changes, msg, author) {
  const tip = o.branches[branch];
  const tree = tip ? { ...o.commits[tip].tree } : {};
  for (const [p, c] of Object.entries(changes)) {
    if (c === null) delete tree[p];
    else tree[p] = c;
  }
  const id = makeCommit(o, { parents: tip ? [tip] : [], tree, msg, author });
  o.branches[branch] = id;
  o.version++;
  return id;
}
export function originBranch(o, name, from) {
  o.branches[name] = o.branches[from];
  o.version++;
}

export const treeOf = (store, id) => (id && store.commits[id] ? store.commits[id].tree : {});

export function ancestors(store, id) {
  const seen = new Set();
  const stack = id ? [id] : [];
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c) || !store.commits[c]) continue;
    seen.add(c);
    stack.push(...store.commits[c].parents);
  }
  return seen;
}
/** is `a` an ancestor of (or equal to) `b` */
export const isAncestor = (store, a, b) => !!a && !!b && ancestors(store, b).has(a);

export function mergeBase(store, a, b) {
  const A = ancestors(store, a);
  const common = [...ancestors(store, b)].filter((x) => A.has(x));
  const best = common.filter((c) => !common.some((d) => d !== c && isAncestor(store, c, d)));
  best.sort((x, y) => store.commits[y].ts - store.commits[x].ts);
  return best[0] || null;
}

function copyReachable(src, dst, id) {
  const stack = [id];
  while (stack.length) {
    const c = stack.pop();
    if (!c || dst.commits[c] || !src.commits[c]) continue;
    dst.commits[c] = src.commits[c];
    stack.push(...src.commits[c].parents);
  }
}

export const headId = (r) => (r.head ? (r.head.branch ? r.branches[r.head.branch] : r.head.detached) : null);
const headTree = (r) => treeOf(r, headId(r));
function moveHead(r, id) {
  if (r.head.branch) r.branches[r.head.branch] = id;
  else r.head.detached = id;
}

export function aheadBehind(store, local, remote) {
  const L = ancestors(store, local);
  const R = ancestors(store, remote);
  return { ahead: [...L].filter((x) => !R.has(x)).length, behind: [...R].filter((x) => !L.has(x)).length };
}

/* --------------------------------------------------------------- text / diff */

const lines = (t) => (t === '' || t == null ? [] : t.split('\n'));

function diffOps(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

function hunksFromOps(ops) {
  const hs = [];
  let i = 0, cur = null;
  for (const [op, line] of ops) {
    if (op === '=') { if (cur) { hs.push(cur); cur = null; } i++; }
    else if (op === '-') { if (!cur) cur = { s: i, e: i, lines: [] }; i++; cur.e = i; }
    else { if (!cur) cur = { s: i, e: i, lines: [] }; cur.lines.push(line); }
  }
  if (cur) hs.push(cur);
  return hs;
}

/** line based three-way merge (like diff3). Adjacent edits conflict, as in git. */
function merge3Text(base, ours, theirs, lo, lt) {
  const B = lines(base);
  const h1 = hunksFromOps(diffOps(B, lines(ours)));
  const h2 = hunksFromOps(diffOps(B, lines(theirs)));
  const out = [];
  let pos = 0, i = 0, j = 0, conflict = false;
  while (i < h1.length || j < h2.length) {
    const a = h1[i], b = h2[j];
    if (a && (!b || a.e < b.s)) { out.push(...B.slice(pos, a.s), ...a.lines); pos = a.e; i++; continue; }
    if (b && (!a || b.e < a.s)) { out.push(...B.slice(pos, b.s), ...b.lines); pos = b.e; j++; continue; }
    const ga = [a], gb = [b];
    let s = Math.min(a.s, b.s), e = Math.max(a.e, b.e);
    i++; j++;
    for (;;) {
      if (h1[i] && h1[i].s <= e) { ga.push(h1[i]); e = Math.max(e, h1[i].e); i++; }
      else if (h2[j] && h2[j].s <= e) { gb.push(h2[j]); e = Math.max(e, h2[j].e); j++; }
      else break;
    }
    const apply = (g) => { const res = []; let p = s; for (const h of g) { res.push(...B.slice(p, h.s), ...h.lines); p = h.e; } res.push(...B.slice(p, e)); return res; };
    const A = apply(ga), T = apply(gb);
    out.push(...B.slice(pos, s));
    if (A.join('\n') === T.join('\n')) out.push(...A);
    else { conflict = true; out.push(`<<<<<<< ${lo}`, ...A, '=======', ...T, `>>>>>>> ${lt}`); }
    pos = e;
  }
  out.push(...B.slice(pos));
  return { text: out.join('\n'), conflict };
}

export const hasMarkers = (t) => /^(<<<<<<<|=======|>>>>>>>)/m.test(t || '');

function mergeTrees(base, ours, theirs, lo, lt) {
  const tree = {};
  const conflicts = [];
  const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const p of paths) {
    const b = base[p], o = ours[p], t = theirs[p];
    let v;
    if (o === t) v = o;
    else if (b === o) v = t;
    else if (b === t) v = o;
    else if (o === undefined || t === undefined) { v = o ?? t; conflicts.push(p); }
    else {
      const m = merge3Text(b ?? '', o, t, lo, lt);
      v = m.text;
      if (m.conflict) conflicts.push(p);
    }
    if (v !== undefined) tree[p] = v;
  }
  return { tree, conflicts };
}

function unifiedHunks(ops) {
  const idx = [];
  ops.forEach((o, k) => { if (o[0] !== '=') idx.push(k); });
  if (!idx.length) return [];
  const ranges = [];
  let s = Math.max(0, idx[0] - 3), e = Math.min(ops.length, idx[0] + 4);
  for (const k of idx.slice(1)) {
    const ks = Math.max(0, k - 3), ke = Math.min(ops.length, k + 4);
    if (ks <= e) e = Math.max(e, ke);
    else { ranges.push([s, e]); s = ks; e = ke; }
  }
  ranges.push([s, e]);
  return ranges.map(([s, e]) => {
    let a0 = 1, b0 = 1;
    for (let k = 0; k < s; k++) { if (ops[k][0] !== '+') a0++; if (ops[k][0] !== '-') b0++; }
    let al = 0, bl = 0;
    const body = [];
    for (let k = s; k < e; k++) {
      const [op, l] = ops[k];
      if (op !== '+') al++;
      if (op !== '-') bl++;
      body.push(op === '=' ? ' ' + l : op === '-' ? C.red('-' + l) : C.green('+' + l));
    }
    return [C.cyan(`@@ -${al ? a0 : a0 - 1},${al} +${bl ? b0 : b0 - 1},${bl} @@`), ...body].join('\n');
  });
}

function diffFile(path, a, b) {
  const ops = diffOps(lines(a), lines(b));
  const hs = unifiedHunks(ops);
  if (!hs.length && a === b) return '';
  const head = [C.bold(`diff --git a/${path} b/${path}`)];
  if (a === undefined) head.push(C.bold('new file mode 100644'));
  if (b === undefined) head.push(C.bold('deleted file mode 100644'));
  head.push(C.bold(a === undefined ? '--- /dev/null' : `--- a/${path}`), C.bold(b === undefined ? '+++ /dev/null' : `+++ b/${path}`));
  return [...head, ...hs].join('\n');
}

function diffTreesText(a, b, only) {
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((p) => !only || only.includes(p));
  return paths.map((p) => (a[p] !== b[p] ? diffFile(p, a[p], b[p]) : '')).filter(Boolean).join('\n');
}

function statText(a, b) {
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((p) => a[p] !== b[p]);
  if (!paths.length) return '';
  let ins = 0, del = 0;
  const extra = [];
  for (const p of paths) {
    for (const [op] of diffOps(lines(a[p]), lines(b[p]))) { if (op === '+') ins++; else if (op === '-') del++; }
    if (a[p] === undefined) extra.push(` create mode 100644 ${p}`);
    if (b[p] === undefined) extra.push(` delete mode 100644 ${p}`);
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let s = ` ${plural(paths.length, 'file')} changed`;
  if (ins) s += `, ${plural(ins, 'insertion')}(+)`;
  if (del) s += `, ${plural(del, 'deletion')}(-)`;
  return [s, ...extra].join('\n');
}

/* -------------------------------------------------------------------- utils */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return `${DAYS[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()} +0000`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ok = (out = '', extra = {}) => ({ out, code: 0, ...extra });
const fail = (out, code = 1) => ({ out, code });
const fatal = (msg) => fail(`fatal: ${msg}`, 128);
const firstLine = (m) => m.split('\n')[0];

function setPath(tree, p, v) {
  if (v === undefined) delete tree[p];
  else tree[p] = v;
}

export function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (!s || s.split('/').some((seg) => seg === '..' || seg === '.git' || seg === '.') || s.length > 120) return null;
  return s;
}

export function tokenize(line) {
  const toks = [];
  let cur = '', q = null, has = false;
  const push = () => { if (has || cur) toks.push(cur); cur = ''; has = false; };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { q = ch; has = true; }
    else if (/\s/.test(ch)) push();
    else if (ch === '>') {
      push();
      if (line[i + 1] === '>') { toks.push({ redir: '>>' }); i++; } else toks.push({ redir: '>' });
    } else cur += ch;
  }
  if (q) return null;
  push();
  return toks;
}

/* -------------------------------------------------------------------- refs */

function lookupName(r, name) {
  if (r.branches[name]) return r.branches[name];
  if (name.startsWith('refs/heads/') && r.branches[name.slice(11)]) return r.branches[name.slice(11)];
  if (r.remote[name]) return r.remote[name];
  if (name.startsWith('remotes/') && r.remote[name.slice(8)]) return r.remote[name.slice(8)];
  if (r.tags[name]) return r.tags[name].id;
  if (/^[0-9a-f]{4,40}$/.test(name)) {
    const m = Object.keys(r.commits).filter((id) => id.startsWith(name));
    if (m.length === 1) return m[0];
  }
  return null;
}

export function resolve(r, spec) {
  if (!spec) return null;
  const m = spec.match(/^(.*?)((?:[~^]\d*)*)$/);
  const base = m[1] || 'HEAD';
  let id = base === 'HEAD' || base === '@' ? headId(r) : lookupName(r, base);
  if (!id) return null;
  for (const op of m[2].match(/[~^]\d*/g) || []) {
    const n = op.length > 1 ? parseInt(op.slice(1), 10) : 1;
    if (op[0] === '~') for (let k = 0; k < n && id; k++) id = r.commits[id]?.parents[0] || null;
    else id = n === 0 ? id : r.commits[id]?.parents[n - 1] || null;
    if (!id) return null;
  }
  return id;
}

const branchOk = (n) => /^[A-Za-z0-9._\-/]+$/.test(n) && !n.startsWith('-') && !n.endsWith('/') && !n.includes('..') && !n.endsWith('.lock');

/* ----------------------------------------------------------- status / trees */

function changesOf(r) {
  const H = headTree(r);
  const conflicted = new Set(r.state?.conflicts || []);
  const kind = (a, b) => (a === undefined ? 'new file' : b === undefined ? 'deleted' : 'modified');
  const staged = [], unstaged = [], untracked = [];
  for (const p of new Set([...Object.keys(H), ...Object.keys(r.index)])) {
    if (conflicted.has(p)) continue;
    if (H[p] !== r.index[p]) staged.push({ path: p, kind: kind(H[p], r.index[p]) });
  }
  for (const p of Object.keys(r.index)) {
    if (conflicted.has(p)) continue;
    if (r.index[p] !== r.work[p]) unstaged.push({ path: p, kind: r.work[p] === undefined ? 'deleted' : 'modified' });
  }
  for (const p of Object.keys(r.work)) if (!(p in r.index)) untracked.push(p);
  const bySort = (a, b) => a.path.localeCompare(b.path);
  return { staged: staged.sort(bySort), unstaged: unstaged.sort(bySort), untracked: untracked.sort(), conflicts: [...conflicted].sort() };
}

function untrackedDisplay(r, list) {
  const tracked = Object.keys(r.index);
  const out = new Set();
  for (const p of list) {
    const top = p.split('/')[0];
    if (p.includes('/') && !tracked.some((t) => t.startsWith(top + '/'))) out.add(top + '/');
    else out.add(p);
  }
  return [...out].sort();
}

function trackingLine(r) {
  if (!r.head?.branch) return '';
  const up = r.upstream[r.head.branch];
  if (!up) return '';
  const rid = r.remote[up];
  if (!rid) return `Your branch is based on '${up}', but the upstream is gone.`;
  const { ahead, behind } = aheadBehind(r, r.branches[r.head.branch], rid);
  if (!ahead && !behind) return `Your branch is up to date with '${up}'.`;
  if (ahead && !behind) return `Your branch is ahead of '${up}' by ${plural(ahead, 'commit')}.\n  (use "git push" to publish your local commits)`;
  if (!ahead && behind) return `Your branch is behind '${up}' by ${plural(behind, 'commit')}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)`;
  return `Your branch and '${up}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n  (use "git pull" if you want to integrate the remote branch with yours)`;
}

function statusText(r, { short: isShort } = {}) {
  const ch = changesOf(r);
  if (isShort) {
    const rows = [];
    for (const p of ch.conflicts) rows.push(C.red('UU') + ' ' + p);
    const seen = new Set();
    for (const c of ch.staged) { seen.add(c.path); rows.push(C.green(c.kind === 'new file' ? 'A' : c.kind === 'deleted' ? 'D' : 'M') + (ch.unstaged.find((u) => u.path === c.path) ? C.red('M') : ' ') + ' ' + c.path); }
    for (const c of ch.unstaged) if (!seen.has(c.path)) rows.push(' ' + C.red(c.kind === 'deleted' ? 'D' : 'M') + ' ' + c.path);
    for (const u of untrackedDisplay(r, ch.untracked)) rows.push(C.red('??') + ' ' + u);
    return rows.join('\n');
  }
  const L = [];
  L.push(r.head.branch ? `On branch ${r.head.branch}` : `HEAD detached at ${short(r.head.detached)}`);
  const tl = trackingLine(r);
  if (tl) L.push(tl);
  const st = r.state;
  if (st?.type === 'rebase') {
    L.push('', `interactive rebase in progress; onto ${short(st.onto)}`, `You are currently rebasing branch '${st.branch}' on '${short(st.onto)}'.`);
    L.push(ch.conflicts.length ? '  (fix conflicts and then run "git rebase --continue")' : '  (all conflicts fixed: run "git rebase --continue")', '  (use "git rebase --abort" to check out the original branch)');
  } else if (st?.type === 'merge') {
    L.push('');
    if (ch.conflicts.length) L.push('You have unmerged paths.', '  (fix conflicts and run "git commit")', '  (use "git merge --abort" to abort the merge)');
    else L.push('All conflicts fixed but you are still merging.', '  (use "git commit" to conclude merge)');
  } else if (st) {
    L.push('', `You are currently ${st.type === 'revert' ? 'reverting' : 'cherry-picking'} a commit.`, ch.conflicts.length ? '  (fix conflicts and run "git commit")' : '  (all conflicts fixed: run "git commit")');
  }
  if (ch.conflicts.length) {
    L.push('', 'Unmerged paths:', '  (use "git add <file>..." to mark resolution)');
    for (const p of ch.conflicts) L.push(C.red(`\tboth modified:   ${p}`));
  }
  if (ch.staged.length) {
    L.push('', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)');
    for (const c of ch.staged) L.push(C.green(`\t${(c.kind + ':').padEnd(12)}${c.path}`));
  }
  if (ch.unstaged.length) {
    L.push('', 'Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)');
    for (const c of ch.unstaged) L.push(C.red(`\t${(c.kind + ':').padEnd(12)}${c.path}`));
  }
  const ut = untrackedDisplay(r, ch.untracked);
  if (ut.length) {
    L.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const p of ut) L.push(C.red(`\t${p}`));
  }
  const dirty = ch.staged.length || ch.unstaged.length || ut.length || ch.conflicts.length;
  if (!dirty) L.push('', 'nothing to commit, working tree clean');
  else if (!ch.staged.length && !ch.conflicts.length) L.push('', ut.length && !ch.unstaged.length ? 'nothing added to commit but untracked files present (use "git add" to track)' : 'no changes added to commit (use "git add" and/or "git commit -a")');
  return L.join('\n');
}

/** paths whose local (uncommitted) state would be clobbered when moving from `old` to `neu` */
function guardOverwrite(r, old, neu, verb) {
  const tracked = [], untracked = [];
  for (const p of new Set([...Object.keys(old), ...Object.keys(neu)])) {
    if (old[p] === neu[p]) continue;
    if (r.work[p] === old[p] && r.index[p] === old[p]) continue;
    if (neu[p] === r.work[p] && r.index[p] === r.work[p]) continue;
    if (p in old || p in r.index) tracked.push(p);
    else untracked.push(p);
  }
  const after = verb === 'checkout' ? 'switch branches' : verb;
  if (tracked.length) return `error: Your local changes to the following files would be overwritten by ${verb}:\n${tracked.map((p) => '\t' + p).join('\n')}\nPlease commit your changes or stash them before you ${after}.\nAborting`;
  if (untracked.length) return `error: The following untracked working tree files would be overwritten by ${verb}:\n${untracked.map((p) => '\t' + p).join('\n')}\nPlease move or remove them before you ${after}.\nAborting`;
  return null;
}

function applyTreeChange(r, old, neu) {
  for (const p of new Set([...Object.keys(old), ...Object.keys(neu)])) {
    if (old[p] !== neu[p]) { setPath(r.work, p, neu[p]); setPath(r.index, p, neu[p]); }
  }
}

const dirtyTracked = (r) => {
  const ch = changesOf(r);
  return ch.staged.length || ch.unstaged.length || ch.conflicts.length;
};

/* -------------------------------------------------------------------- log */

function decorations(r) {
  const map = {};
  const add = (id, label, order) => { if (id) (map[id] ||= []).push({ label, order }); };
  const hid = headId(r);
  if (r.head?.branch) add(hid, `HEAD -> ${r.head.branch}`, 0);
  else add(hid, 'HEAD', 0);
  for (const [n, t] of Object.entries(r.tags)) add(t.id, `tag: ${n}`, 1);
  for (const [n, id] of Object.entries(r.branches)) if (n !== r.head?.branch) add(id, n, 2);
  for (const [n, id] of Object.entries(r.remote)) add(id, n, 3);
  return (id) => {
    const d = (map[id] || []).sort((a, b) => a.order - b.order);
    if (!d.length) return '';
    const col = (x) => (x.order === 0 ? C.bold(C.cyan(x.label)) : x.order === 1 ? C.yellow(x.label) : x.order === 2 ? C.green(x.label) : C.red(x.label));
    return ' ' + C.yellow('(') + d.map(col).join(C.yellow(', ')) + C.yellow(')');
  };
}

function cmdLog(r, args) {
  let oneline = false, graph = false, all = false, max = Infinity, revs = [], stat = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--oneline' || a === '--pretty=oneline' || a === '--format=oneline') oneline = true;
    else if (a === '--graph') graph = true;
    else if (a === '--all') all = true;
    else if (a === '--decorate' || a === '--no-decorate' || a === '--abbrev-commit') continue;
    else if (a === '--stat') stat = true;
    else if (a === '-n' || a === '--max-count') max = parseInt(args[++i], 10);
    else if (/^-\d+$/.test(a)) max = parseInt(a.slice(1), 10);
    else if (a.startsWith('--max-count=')) max = parseInt(a.slice(12), 10);
    else if (a === '--') break;
    else if (a.startsWith('-')) return fatal(`unrecognized argument: ${a}`);
    else revs.push(a);
  }
  let include = new Set(), exclude = new Set();
  const startIds = [];
  if (all) {
    startIds.push(...Object.values(r.branches), ...Object.values(r.remote), ...Object.values(r.tags).map((t) => t.id));
    if (headId(r)) startIds.push(headId(r));
  }
  for (const rev of revs) {
    if (rev.includes('..')) {
      const [x, y] = rev.split('..');
      const xi = resolve(r, x || 'HEAD'), yi = resolve(r, y || 'HEAD');
      if (!xi || !yi) return fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
      for (const id of ancestors(r, xi)) exclude.add(id);
      startIds.push(yi);
    } else {
      const id = resolve(r, rev);
      if (!id) return fatal(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
      startIds.push(id);
    }
  }
  if (!startIds.length) {
    if (!headId(r)) return fatal(`your current branch '${r.head?.branch}' does not have any commits yet`);
    startIds.push(headId(r));
  }
  for (const s of startIds) for (const id of ancestors(r, s)) if (!exclude.has(id)) include.add(id);
  let list = [...include].map((id) => r.commits[id]).sort((a, b) => b.ts - a.ts).slice(0, max);
  const dec = decorations(r);
  const out = [];
  const lanes = [];
  list.forEach((c) => {
    let prefix = '';
    let after = [];
    if (graph) {
      let idxs = lanes.map((l, i) => (l === c.id ? i : -1)).filter((i) => i >= 0);
      if (!idxs.length) { lanes.push(c.id); idxs = [lanes.length - 1]; }
      const col = idxs[0];
      prefix = lanes.map((l, i) => (i === col ? '*' : l == null ? ' ' : '|')).join(' ') + ' ';
      for (const k of idxs.slice(1)) lanes[k] = null;
      const ps = c.parents.filter((p) => include.has(p));
      if (!ps.length) lanes[col] = null;
      else {
        lanes[col] = ps[0];
        for (const p of ps.slice(1)) if (!lanes.includes(p)) lanes.splice(col + 1, 0, p);
        if (ps.length > 1) after.push(lanes.map((l, i) => (i === col + 1 ? '\\' : l == null ? ' ' : '|')).join(' '));
      }
      if (idxs.length > 1) after.push(lanes.map((l, i) => (i === idxs[1] ? '/' : l == null ? ' ' : '|')).join(' '));
      while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    }
    if (oneline) out.push(`${prefix}${C.yellow(short(c.id))}${dec(c.id)} ${firstLine(c.msg)}`);
    else {
      const pad = graph ? prefix.replace(/\*/g, '|') : '';
      out.push(`${prefix}${C.yellow('commit ' + c.id)}${dec(c.id)}`);
      if (c.parents.length > 1) out.push(`${pad}Merge: ${c.parents.map(short).join(' ')}`);
      out.push(`${pad}Author: ${c.author.name} <${c.author.email}>`, `${pad}Date:   ${fmtDate(c.ts)}`, pad.trimEnd(), ...c.msg.split('\n').map((l) => `${pad}    ${l}`));
      if (stat) { const s = statText(treeOf(r, c.parents[0]), c.tree); if (s) out.push(pad.trimEnd(), s); }
      if (!graph) out.push('');
    }
    out.push(...after);
  });
  return ok(out.join('\n').replace(/\n+$/, ''));
}

/* -------------------------------------------------------------- git: basic */

function cmdClone(r, o, args) {
  const url = args.find((a) => !a.startsWith('-'));
  if (!url) return fatal('You must specify a repository to clone.');
  const dir = (args.filter((a) => !a.startsWith('-'))[1]) || url.split('/').pop().replace(/\.git$/, '');
  if (r.cloned) return fatal(`destination path '${r.dir}' already exists and is not an empty directory.`);
  if (url !== o.url) return fatal(`repository '${url}' does not exist (try: git clone ${o.url})`);
  for (const id of Object.keys(o.commits)) r.commits[id] = o.commits[id];
  for (const [n, t] of Object.entries(o.tags)) r.tags[n] = { ...t };
  for (const [b, id] of Object.entries(o.branches)) r.remote['origin/' + b] = id;
  const def = o.defaultBranch;
  r.branches[def] = o.branches[def];
  r.upstream[def] = 'origin/' + def;
  r.head = { branch: def };
  r.index = { ...treeOf(r, r.branches[def]) };
  r.work = { ...r.index };
  r.cloned = true;
  r.dir = dir;
  r.url = url;
  const n = Object.keys(o.commits).length;
  return ok(`Cloning into '${dir}'...\nremote: Enumerating objects: ${n * 3}, done.\nremote: Total ${n * 3} (delta 0), reused 0 (delta 0)\nReceiving objects: 100% (${n * 3}/${n * 3}), done.`, { events: [{ type: 'clone' }] });
}

function pathMatches(all, spec) {
  if (spec === '.') return all;
  const s = normPath(spec);
  if (!s) return [];
  return all.filter((p) => p === s || p.startsWith(s + '/'));
}

function cmdAdd(r, args) {
  const flags = args.filter((a) => a.startsWith('-') && a !== '--');
  const specs = args.filter((a) => !a.startsWith('-') && a !== '--');
  const allMode = flags.includes('-A') || flags.includes('--all');
  const updateOnly = flags.includes('-u') || flags.includes('--update');
  if (!specs.length && !allMode && !updateOnly) return ok('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?');
  const universe = [...new Set([...Object.keys(r.work), ...Object.keys(r.index)])];
  const targets = new Set();
  if (allMode || updateOnly) universe.forEach((p) => targets.add(p));
  for (const s of specs) {
    const m = pathMatches(universe, s);
    if (!m.length) return fatal(`pathspec '${s}' did not match any files`);
    m.forEach((p) => targets.add(p));
  }
  for (const p of targets) {
    if (updateOnly && !(p in r.index)) continue;
    setPath(r.index, p, r.work[p]);
    if (r.state?.conflicts) r.state.conflicts = r.state.conflicts.filter((c) => c !== p);
  }
  return ok('');
}

function finishStats(r, before, after, msgLine) {
  const s = statText(before, after);
  return [msgLine, s].filter(Boolean).join('\n');
}

function cmdCommit(r, args) {
  let msg = null, all = false, amend = false, allowEmpty = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || a === '--message') msg = args[++i];
    else if (a.startsWith('--message=')) msg = a.slice(10);
    else if (a === '--all') all = true;
    else if (a === '--amend') amend = true;
    else if (a === '--allow-empty') allowEmpty = true;
    else if (a === '--no-edit' || a === '--no-verify' || a === '-q') continue;
    else if (/^-[a-z]+$/.test(a)) {
      if (a.includes('a')) all = true;
      if (a.endsWith('m')) msg = args[++i];
      if (a.includes('n') || a.includes('q')) continue;
    } else return fatal(`unrecognized argument ${a}`);
  }
  if (msg === undefined) return fail('error: switch `m\' requires a value');
  const st = r.state;
  if (st?.type === 'rebase') return fail('error: you are in the middle of a rebase.\nhint: Resolve the conflicts, `git add` them, then run "git rebase --continue".');
  if (st?.conflicts?.length) return fail(`error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.`, 128);
  if (all) for (const p of Object.keys(r.index)) if (r.index[p] !== r.work[p]) setPath(r.index, p, r.work[p]);
  const H = headTree(r);
  const hid = headId(r);
  const same = JSON.stringify(sortObj(H)) === JSON.stringify(sortObj(r.index));
  if (amend) {
    if (!hid) return fatal('You have nothing to amend.');
    const old = r.commits[hid];
    const id = makeCommit(r, { parents: old.parents, tree: { ...r.index }, msg: msg ?? old.msg, author: old.author });
    moveHead(r, id);
    return ok(finishStats(r, treeOf(r, old.parents[0]), r.index, `[${r.head.branch || 'detached HEAD'} ${short(id)}] ${firstLine(msg ?? old.msg)}`), { events: [{ type: 'commit', amend: true }] });
  }
  if (same && !st && !allowEmpty) {
    return fail(statusText(r));
  }
  if (!st && (msg === null || msg === '')) return fail(msg === '' ? 'Aborting commit due to empty commit message.' : 'Aborting commit: no message given. Use: git commit -m "your message"');
  const parents = hid ? [hid] : [];
  if (st?.type === 'merge') parents.push(st.theirs);
  const message = msg || st?.msg || '';
  const id = makeCommit(r, { parents, tree: { ...r.index }, msg: message, author: r.user });
  moveHead(r, id);
  r.state = null;
  return ok(finishStats(r, H, r.index, `[${r.head.branch || 'detached HEAD'} ${short(id)}] ${firstLine(message)}`), { events: [{ type: 'commit', merge: parents.length > 1 }] });
}
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/* -------------------------------------------------------- branch / switch */

function cmdBranch(r, args) {
  const flags = args.filter((a) => a.startsWith('-'));
  const pos = args.filter((a) => !a.startsWith('-'));
  const has = (...f) => f.some((x) => flags.includes(x));
  const cur = r.head?.branch;
  if (has('-d', '-D', '--delete')) {
    if (!pos.length) return fatal('branch name required');
    const out = [];
    let code = 0;
    for (const n of pos) {
      const id = r.branches[n];
      if (!id) { out.push(`error: branch '${n}' not found.`); code = 1; continue; }
      if (n === cur) { out.push(`error: Cannot delete branch '${n}' checked out at '/home/${r.user.name}/${r.dir}'`); code = 1; continue; }
      if (!has('-D')) {
        const up = r.upstream[n] && r.remote[r.upstream[n]];
        const merged = isAncestor(r, id, headId(r)) || (up && isAncestor(r, id, up));
        if (!merged) { out.push(`error: The branch '${n}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${n}'.`); code = 1; continue; }
      }
      delete r.branches[n];
      delete r.upstream[n];
      out.push(`Deleted branch ${n} (was ${short(id)}).`);
    }
    return { out: out.join('\n'), code };
  }
  if (has('-m', '-M')) {
    const [a, b] = pos.length === 1 ? [cur, pos[0]] : pos;
    if (!r.branches[a]) return fatal(`no branch named '${a}'`);
    if (!branchOk(b)) return fatal(`'${b}' is not a valid branch name`);
    if (r.branches[b]) return fatal(`a branch named '${b}' already exists`);
    r.branches[b] = r.branches[a]; delete r.branches[a];
    if (r.upstream[a]) { r.upstream[b] = r.upstream[a]; delete r.upstream[a]; }
    if (r.head.branch === a) r.head.branch = b;
    return ok('');
  }
  const upArg = args.find((a) => a.startsWith('--set-upstream-to='));
  if (upArg || has('-u', '--set-upstream-to')) {
    const target = upArg ? upArg.slice(18) : pos[0];
    const b = (upArg ? pos[0] : pos[1]) || cur;
    if (!r.remote[target]) return fatal(`the requested upstream branch '${target}' does not exist`);
    r.upstream[b] = target;
    return ok(`branch '${b}' set up to track '${target}'.`);
  }
  if (has('--unset-upstream')) { delete r.upstream[pos[0] || cur]; return ok(''); }
  if (pos.length) {
    const [name, start] = pos;
    if (!branchOk(name)) return fatal(`'${name}' is not a valid branch name`);
    if (r.branches[name]) return fatal(`a branch named '${name}' already exists`);
    const id = start ? resolve(r, start) : headId(r);
    if (!id) return fatal(`not a valid object name: '${start || 'HEAD'}'`);
    r.branches[name] = id;
    if (start && r.remote[start]) r.upstream[name] = start;
    return ok('');
  }
  const verbose = has('-v', '-vv', '--verbose');
  const rows = [];
  const showLocal = !has('-r', '--remotes');
  const showRemote = has('-a', '--all', '-r', '--remotes');
  if (showLocal)
    for (const n of Object.keys(r.branches).sort()) {
      const id = r.branches[n];
      let line = n === cur ? C.green(`* ${n}`) : `  ${n}`;
      if (verbose) {
        const up = r.upstream[n];
        line = line.padEnd(30) + ` ${short(id)} ` + (up ? `[${up}${(() => { const rid = r.remote[up]; if (!rid) return ': gone'; const ab = aheadBehind(r, id, rid); const bits = []; if (ab.ahead) bits.push(`ahead ${ab.ahead}`); if (ab.behind) bits.push(`behind ${ab.behind}`); return bits.length ? ': ' + bits.join(', ') : ''; })()}] ` : '') + firstLine(r.commits[id].msg);
      }
      rows.push(line);
    }
  if (!r.head?.branch && showLocal) rows.unshift(C.green(`* (HEAD detached at ${short(r.head.detached)})`));
  if (showRemote)
    for (const n of Object.keys(r.remote).sort()) rows.push(C.red(`  ${has('-r', '--remotes') ? '' : 'remotes/'}${n}`) + (verbose ? ` ${short(r.remote[n])} ${firstLine(r.commits[r.remote[n]].msg)}` : ''));
  return ok(rows.join('\n'));
}

function checkoutTree(r, newId) {
  const old = headTree(r);
  const neu = treeOf(r, newId);
  applyTreeChange(r, old, neu);
}

function switchMsgs(r) {
  if (!r.head.branch) return '';
  const t = trackingLine(r);
  return t ? '\n' + t : '';
}

function doSwitch(r, name, { create = false, start = null, detach = false, force = false } = {}) {
  if (r.state) return fail(`error: you need to resolve your current ${r.state.type === 'rebase' ? 'rebase' : 'index'} first${r.state.type === 'merge' ? '\nhint: finish the merge (git commit) or abort it (git merge --abort).' : ''}`);
  if (create) {
    if (!branchOk(name)) return fatal(`'${name}' is not a valid branch name`);
    if (r.branches[name]) return fatal(`a branch named '${name}' already exists`);
    const id = start ? resolve(r, start) : headId(r);
    if (!id) return fatal(`invalid reference: ${start}`);
    const g = guardOverwrite(r, headTree(r), treeOf(r, id), 'checkout');
    if (g) return fail(g);
    checkoutTree(r, id);
    r.branches[name] = id;
    if (start && r.remote[start]) r.upstream[name] = start;
    r.head = { branch: name };
    const note = start && r.remote[start] ? `branch '${name}' set up to track '${start}'.\n` : '';
    return ok(`${note}Switched to a new branch '${name}'`, { events: [{ type: 'branch', name }] });
  }
  if (r.head.branch === name && !detach) return ok(`Already on '${name}'` + switchMsgs(r));
  let id = r.branches[name];
  let track = null;
  if (!id && !detach && r.remote['origin/' + name]) { id = r.remote['origin/' + name]; track = 'origin/' + name; }
  if (!id) {
    const rid = resolve(r, name);
    if (rid && (detach || r.tags[name] || r.remote[name] || /^[0-9a-f]{4,}$/.test(name))) {
      const g = guardOverwrite(r, headTree(r), treeOf(r, rid), 'checkout');
      if (g) return fail(g);
      checkoutTree(r, rid);
      r.head = { detached: rid };
      return ok(`Note: switching to '${name}'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\nchanges and commit them, but they will be lost unless you switch back to a branch.\n\nHEAD is now at ${short(rid)} ${firstLine(r.commits[rid].msg)}`);
    }
    return fatal(`invalid reference: ${name}`);
  }
  const g = guardOverwrite(r, headTree(r), treeOf(r, id), 'checkout');
  if (g) return fail(g);
  checkoutTree(r, id);
  if (track) { r.branches[name] = id; r.upstream[name] = track; }
  r.head = { branch: name };
  return ok(`${track ? `branch '${name}' set up to track '${track}'.\n` : ''}Switched to ${track ? 'a new ' : ''}branch '${name}'${switchMsgs(r)}`);
}

function restorePaths(r, paths, { staged = false, source = null } = {}) {
  const H = headTree(r);
  const universe = [...new Set([...Object.keys(H), ...Object.keys(r.index), ...Object.keys(r.work)])];
  for (const s of paths) {
    const m = pathMatches(universe, s);
    if (!m.length) return fail(`error: pathspec '${s}' did not match any file(s) known to git`);
    for (const p of m) {
      if (staged) setPath(r.index, p, source ? treeOf(r, source)[p] : H[p]);
      else setPath(r.work, p, source ? treeOf(r, source)[p] : r.index[p]);
      if (!staged && source) setPath(r.index, p, treeOf(r, source)[p]);
    }
  }
  return ok('');
}

function cmdSwitch(r, args) {
  const pos = args.filter((a) => !a.startsWith('-'));
  const flag = (f) => args.includes(f);
  if (flag('-c') || flag('--create') || flag('-C')) return doSwitch(r, pos[0], { create: true, start: pos[1] });
  if (flag('--detach') || flag('-d')) return doSwitch(r, pos[0], { detach: true });
  if (!pos.length) return fatal('missing branch or commit argument');
  if (!r.branches[pos[0]] && !r.remote['origin/' + pos[0]]) return fatal(`invalid reference: ${pos[0]}`);
  return doSwitch(r, pos[0]);
}

function cmdCheckout(r, args) {
  const dd = args.indexOf('--');
  if (dd >= 0) return restorePaths(r, args.slice(dd + 1), { source: args[0] && dd > 0 && !args[0].startsWith('-') ? resolve(r, args[0]) : null });
  const bIdx = args.findIndex((a) => a === '-b' || a === '-B');
  if (bIdx >= 0) return doSwitch(r, args[bIdx + 1], { create: true, start: args.filter((a, i) => i > bIdx + 1 && !a.startsWith('-'))[0] });
  const pos = args.filter((a) => !a.startsWith('-'));
  if (!pos.length) return ok('');
  const name = pos[0];
  if (r.branches[name] || r.remote['origin/' + name]) return doSwitch(r, name);
  if (resolve(r, name)) return doSwitch(r, name, { detach: true });
  if (name in r.index || name in r.work || name in headTree(r)) return restorePaths(r, pos);
  return fail(`error: pathspec '${name}' did not match any file(s) known to git`);
}

function cmdRestore(r, args) {
  const staged = args.includes('--staged') || args.includes('-S');
  const worktree = args.includes('--worktree') || args.includes('-W');
  const si = args.indexOf('-s');
  const src = args.find((a) => a.startsWith('--source=')) || (si >= 0 ? '--source=' + args[si + 1] : null);
  const pos = args.filter((a, i) => !a.startsWith('-') && !(si >= 0 && i === si + 1));
  if (!pos.length) return fatal('you must specify path(s) to restore');
  const source = src ? resolve(r, src.slice(9)) : null;
  if (staged) restorePaths(r, pos, { staged: true, source });
  if (!staged || worktree) return restorePaths(r, pos, { source });
  return ok('');
}

/* ------------------------------------------------------------------ merge */

const defaultMergeMsg = (r, label) => `Merge ${label}` + (r.head.branch && !['main', 'master'].includes(r.head.branch) ? ` into ${r.head.branch}` : '');

function mergeCore(r, theirsId, { label, noff = false, ffOnly = false, msg = null }) {
  const ours = headId(r);
  if (isAncestor(r, theirsId, ours)) return ok('Already up to date.');
  const canFF = isAncestor(r, ours, theirsId);
  if (canFF && !noff) {
    const g = guardOverwrite(r, headTree(r), treeOf(r, theirsId), 'merge');
    if (g) return fail(g);
    const before = headTree(r);
    checkoutTree(r, theirsId);
    moveHead(r, theirsId);
    return ok(`Updating ${short(ours)}..${short(theirsId)}\nFast-forward\n${statText(before, treeOf(r, theirsId))}`, { events: [{ type: 'merge', ff: true }] });
  }
  if (ffOnly) return fatal('Not possible to fast-forward, aborting.');
  const base = mergeBase(r, ours, theirsId);
  const oursTree = headTree(r);
  const res = mergeTrees(treeOf(r, base), oursTree, treeOf(r, theirsId), 'HEAD', label.replace(/^(remote-tracking )?branch '(.*?)'.*$/, '$2'));
  const g = guardOverwrite(r, oursTree, res.tree, 'merge');
  if (g) return fail(g);
  const mmsg = msg || defaultMergeMsg(r, label);
  if (!res.conflicts.length) {
    applyTreeChange(r, oursTree, res.tree);
    const id = makeCommit(r, { parents: [ours, theirsId], tree: { ...res.tree }, msg: mmsg, author: r.user });
    moveHead(r, id);
    return ok(`Merge made by the 'ort' strategy.\n${statText(oursTree, res.tree)}`, { events: [{ type: 'merge', ff: false }] });
  }
  const out = [];
  for (const p of res.conflicts) out.push(`Auto-merging ${p}`, `CONFLICT (content): Merge conflict in ${p}`);
  // clean parts of the merge are applied + staged, conflicted ones carry markers in the work tree only
  for (const p of new Set([...Object.keys(oursTree), ...Object.keys(res.tree)])) {
    if (res.conflicts.includes(p)) { setPath(r.work, p, res.tree[p]); setPath(r.index, p, oursTree[p]); }
    else if (oursTree[p] !== res.tree[p]) { setPath(r.work, p, res.tree[p]); setPath(r.index, p, res.tree[p]); }
  }
  r.state = { type: 'merge', theirs: theirsId, msg: mmsg, conflicts: [...res.conflicts] };
  out.push('Automatic merge failed; fix conflicts and then commit the result.');
  return { out: out.join('\n'), code: 1, events: [{ type: 'conflict' }] };
}

function cmdMerge(r, args) {
  if (args.includes('--abort')) {
    if (r.state?.type !== 'merge') return fatal('There is no merge to abort (MERGE_HEAD missing).');
    const H = headTree(r);
    r.index = { ...H };
    for (const p of Object.keys(r.work)) if (p in r.index || p in treeOf(r, r.state.theirs)) delete r.work[p];
    Object.assign(r.work, H);
    r.state = null;
    return ok('');
  }
  if (args.includes('--continue')) return cmdCommit(r, []);
  if (r.state) return fatal('You have not concluded your merge (MERGE_HEAD exists).\nPlease, commit your changes before you merge.');
  let msg = null;
  const mi = args.findIndex((a) => a === '-m');
  if (mi >= 0) msg = args[mi + 1];
  const spec = args.filter((a, i) => !a.startsWith('-') && !(mi >= 0 && i === mi + 1))[0];
  if (!spec) return fatal('No remote for the current branch.\nhint: name a branch to merge, e.g. git merge feature/my-branch');
  const id = resolve(r, spec);
  if (!id) return fail(`merge: ${spec} - not something we can merge`);
  if (!headId(r)) return fatal('nothing to merge into');
  const label = r.remote[spec] ? `remote-tracking branch '${spec}'` : r.branches[spec] ? `branch '${spec}'` : `commit '${spec}'`;
  return mergeCore(r, id, { label, noff: args.includes('--no-ff'), ffOnly: args.includes('--ff-only'), msg });
}

/* ----------------------------------------------------- cherry-pick/revert/rebase */

function pickApply(r, c, mode) {
  const cm = r.commits[c];
  const ours = headTree(r);
  let base, theirs, lt;
  if (mode === 'revert') { base = cm.tree; theirs = treeOf(r, cm.parents[0]); lt = `parent of ${short(c)} (${firstLine(cm.msg)})`; }
  else { base = treeOf(r, cm.parents[0]); theirs = cm.tree; lt = `${short(c)} (${firstLine(cm.msg)})`; }
  const res = mergeTrees(base, ours, theirs, 'HEAD', lt);
  return { ours, ...res };
}

function enterConflict(r, ours, res, state) {
  for (const p of new Set([...Object.keys(ours), ...Object.keys(res.tree)])) {
    if (res.conflicts.includes(p)) { setPath(r.work, p, res.tree[p]); setPath(r.index, p, ours[p]); }
    else if (ours[p] !== res.tree[p]) { setPath(r.work, p, res.tree[p]); setPath(r.index, p, res.tree[p]); }
  }
  r.state = { ...state, conflicts: [...res.conflicts] };
}

function cmdCherryPick(r, args) {
  if (args.includes('--abort')) { if (!r.state) return fatal('no cherry-pick or revert in progress'); return abortPick(r); }
  if (args.includes('--continue')) return cmdCommit(r, []);
  const spec = args.find((a) => !a.startsWith('-'));
  const id = resolve(r, spec);
  if (!id) return fatal(`bad revision '${spec}'`);
  if (r.state) return fatal('cherry-pick failed: a merge/rebase is already in progress');
  return pickOne(r, id, 'cherry-pick');
}
function abortPick(r) {
  const H = headTree(r);
  r.index = { ...H }; r.work = { ...H }; r.state = null;
  return ok('');
}
function pickOne(r, id, mode) {
  const cm = r.commits[id];
  if (cm.parents.length > 1) return fatal(`${mode} of a merge commit needs -m (not supported in this simulator)`);
  const dirty = dirtyTracked(r);
  if (dirty) return fail(`error: your local changes would be overwritten by ${mode}.\nhint: commit your changes or stash them to proceed.\nfatal: ${mode} failed`);
  const res = pickApply(r, id, mode);
  const msg = mode === 'revert' ? `Revert "${firstLine(cm.msg)}"\n\nThis reverts commit ${id}.` : cm.msg;
  const author = mode === 'revert' ? r.user : cm.author;
  if (!res.conflicts.length) {
    applyTreeChange(r, res.ours, res.tree);
    const nid = makeCommit(r, { parents: [headId(r)], tree: { ...res.tree }, msg, author });
    moveHead(r, nid);
    return ok(`[${r.head.branch || 'detached HEAD'} ${short(nid)}] ${firstLine(msg)}\n${statText(res.ours, res.tree)}`, { events: [{ type: mode }] });
  }
  enterConflict(r, res.ours, res, { type: mode, msg, author, pick: id });
  const out = res.conflicts.map((p) => `CONFLICT (content): Merge conflict in ${p}`);
  out.push(`error: could not ${mode === 'revert' ? 'revert' : 'apply'} ${short(id)}... ${firstLine(cm.msg)}`, 'hint: After resolving the conflicts, mark them with "git add <file>", then run "git commit".');
  return { out: out.join('\n'), code: 1, events: [{ type: 'conflict' }] };
}
function cmdRevert(r, args) {
  if (args.includes('--abort')) return r.state ? abortPick(r) : fatal('no cherry-pick or revert in progress');
  if (args.includes('--continue')) return cmdCommit(r, []);
  const specs = args.filter((a) => !a.startsWith('-'));
  if (!specs.length) return fatal('you must specify a commit to revert (find it with: git log --oneline)');
  if (r.state) return fatal('revert failed: a merge/rebase is already in progress');
  const out = [];
  for (const s of specs) {
    const id = resolve(r, s);
    if (!id) return fatal(`bad revision '${s}'`);
    const res = pickOne(r, id, 'revert');
    out.push(res.out);
    if (res.code) return { out: out.join('\n'), code: res.code, events: res.events };
  }
  return ok(out.join('\n'), { events: [{ type: 'revert' }] });
}

function cmdRebase(r, args) {
  const st = r.state;
  if (args.includes('--abort')) {
    if (st?.type !== 'rebase') return fatal('No rebase in progress?');
    r.head = { branch: st.branch };
    const t = treeOf(r, st.origHead);
    r.index = { ...t };
    for (const p of Object.keys(r.work)) if (p in r.index) delete r.work[p];
    Object.assign(r.work, t);
    r.state = null;
    return ok('');
  }
  if (args.includes('--continue') || args.includes('--skip')) {
    if (st?.type !== 'rebase') return fatal('No rebase in progress?');
    if (st.conflicts.length) return fail(`${st.conflicts.map((p) => `${p}: needs merge`).join('\n')}\nYou must edit all merge conflicts and then\nmark them as resolved using git add`);
    if (args.includes('--skip')) { const H = headTree(r); r.index = { ...H }; r.work = { ...H }; }
    else {
      const H = headTree(r);
      const cm = r.commits[st.cur];
      if (JSON.stringify(sortObj(H)) === JSON.stringify(sortObj(r.index))) {
        // resolution equals what is already upstream: git drops the now-empty commit
        const dropped = `dropping ${short(st.cur)} ${firstLine(cm.msg)} -- patch contents already upstream`;
        st.conflicts = []; st.cur = null;
        const res = runRebase(r, [], 0);
        return { ...res, out: [dropped, res.out].join('\n') };
      }
      const id = makeCommit(r, { parents: [headId(r)], tree: { ...r.index }, msg: cm.msg, author: cm.author });
      moveHead(r, id);
    }
    st.conflicts = [];
    st.cur = null;
    return runRebase(r, [], 0);
  }
  if (st) return fatal('It seems that there is already a rebase in progress. Use --continue or --abort.');
  const spec = args.find((a) => !a.startsWith('-'));
  if (!spec) return fatal('There is no tracking information for the current branch.\nhint: say which branch to rebase onto, e.g. git rebase origin/main');
  const onto = resolve(r, spec);
  if (!onto) return fatal(`invalid upstream '${spec}'`);
  if (!r.head.branch) return fatal('You are not currently on a branch.');
  const cur = headId(r);
  if (isAncestor(r, onto, cur)) return ok(`Current branch ${r.head.branch} is up to date.`);
  if (dirtyTracked(r)) return fail('error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.');
  return startRebase(r, onto, 'Successfully rebased');
}
function startRebase(r, onto, label) {
  const cur = headId(r);
  if (isAncestor(r, cur, onto)) {
    checkoutTree(r, onto);
    moveHead(r, onto);
    return ok(`Successfully rebased and updated refs/heads/${r.head.branch}.`, { events: [{ type: 'rebase' }] });
  }
  const base = mergeBase(r, cur, onto);
  const keep = ancestors(r, onto);
  const todo = [...ancestors(r, cur)].filter((id) => !keep.has(id) && r.commits[id].parents.length < 2).sort((a, b) => r.commits[a].ts - r.commits[b].ts);
  const branch = r.head.branch;
  checkoutTree(r, onto);
  r.head = { detached: onto };
  r.state = { type: 'rebase', branch, origHead: cur, onto, base, conflicts: [], cur: null };
  return runRebase(r, todo, 0);
}
function runRebase(r, todo, _) {
  const st = r.state;
  const queue = todo.length ? todo : st.todo || [];
  while (queue.length) {
    const c = queue.shift();
    st.todo = queue;
    const res = pickApply(r, c, 'pick');
    const cm = r.commits[c];
    if (res.conflicts.length) {
      enterConflict(r, res.ours, res, { ...st, cur: c, todo: queue });
      const out = res.conflicts.flatMap((p) => [`Auto-merging ${p}`, `CONFLICT (content): Merge conflict in ${p}`]);
      out.push(`error: could not apply ${short(c)}... ${firstLine(cm.msg)}`, 'hint: Resolve all conflicts manually, mark them as resolved with', 'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".', 'hint: You can instead skip this commit: run "git rebase --skip".', 'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".');
      return { out: out.join('\n'), code: 1, events: [{ type: 'conflict' }] };
    }
    if (JSON.stringify(sortObj(res.tree)) !== JSON.stringify(sortObj(res.ours))) {
      applyTreeChange(r, res.ours, res.tree);
      const id = makeCommit(r, { parents: [headId(r)], tree: { ...res.tree }, msg: cm.msg, author: cm.author });
      moveHead(r, id);
    }
  }
  const finalId = headId(r);
  r.branches[st.branch] = finalId;
  r.head = { branch: st.branch };
  r.state = null;
  return ok(`Successfully rebased and updated refs/heads/${st.branch}.`, { events: [{ type: 'rebase' }] });
}

/* ---------------------------------------------------------- remotes & sync */

function doFetch(r, o, { prune = false } = {}) {
  const lines = [];
  for (const [b, id] of Object.entries(o.branches)) {
    const ref = 'origin/' + b;
    const old = r.remote[ref];
    if (old === id) continue;
    copyReachable(o, r, id);
    r.remote[ref] = id;
    lines.push(old ? ` ${short(old)}..${short(id)}`.padEnd(20) + `${b} -> ${ref}` : ' * [new branch]'.padEnd(20) + `${b} -> ${ref}`);
  }
  for (const [n, t] of Object.entries(o.tags)) {
    if (!r.tags[n]) { copyReachable(o, r, t.id); r.tags[n] = { ...t }; lines.push(' * [new tag]'.padEnd(20) + `${n} -> ${n}`); }
  }
  if (prune) for (const ref of Object.keys(r.remote)) if (!o.branches[ref.slice(7)]) { delete r.remote[ref]; lines.push(` - [deleted]`.padEnd(20) + `(none) -> ${ref}`); }
  return lines.length ? `From ${o.url}\n${lines.join('\n')}` : '';
}

function cmdFetch(r, o, args) {
  const rem = args.find((a) => !a.startsWith('-'));
  if (rem && rem !== 'origin') return fatal(`'${rem}' does not appear to be a git repository`);
  return ok(doFetch(r, o, { prune: args.includes('--prune') || args.includes('-p') }), { events: [{ type: 'fetch' }] });
}

function cmdPull(r, o, args) {
  if (r.state) return fatal('You have not concluded your merge/rebase. Resolve it first.');
  if (!r.head.branch) return fatal('You are not currently on a branch.');
  const rebase = args.includes('--rebase') || args.includes('-r');
  const ffOnly = args.includes('--ff-only');
  const pos = args.filter((a) => !a.startsWith('-'));
  let upRef;
  if (pos.length >= 2) upRef = `${pos[0]}/${pos[1]}`;
  else upRef = r.upstream[r.head.branch];
  if (!upRef) return fail(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\n\n    git branch --set-upstream-to=origin/<branch> ${r.head.branch}\n\nor pull explicitly:  git pull origin <branch>`);
  const fetched = doFetch(r, o);
  const id = r.remote[upRef];
  if (!id) return fatal(`couldn't find remote ref ${upRef.replace('origin/', '')}`);
  const bname = upRef.replace(/^origin\//, '');
  let res;
  if (rebase) {
    if (isAncestor(r, id, headId(r))) res = ok('Current branch ' + r.head.branch + ' is up to date.');
    else if (dirtyTracked(r)) res = fail('error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.');
    else res = startRebase(r, id);
  } else res = mergeCore(r, id, { label: `branch '${bname}' of ${o.url}`, ffOnly });
  return { ...res, out: [fetched, res.out].filter(Boolean).join('\n'), events: [{ type: 'pull' }, ...(res.events || [])] };
}

function cmdPush(r, o, args) {
  let setUp = false, force = false, lease = false, del = false, tags = false;
  const pos = [];
  for (const a of args) {
    if (a === '-u' || a === '--set-upstream') setUp = true;
    else if (a === '-f' || a === '--force') force = true;
    else if (a.startsWith('--force-with-lease')) lease = true;
    else if (a === '-d' || a === '--delete') del = true;
    else if (a === '--tags') tags = true;
    else if (a === '--follow-tags' || a === '-q' || a === '--no-verify') continue;
    else if (a.startsWith('-')) return fatal(`unknown option: ${a}`);
    else pos.push(a);
  }
  let remote = pos[0];
  if (remote && remote !== 'origin') return fatal(`'${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.`);
  const specs = pos.slice(1);
  const lines = [];
  const events = [];
  let rejected = false;
  const cur = r.head?.branch;
  if (!remote && !tags) {
    if (!cur) return fatal('You are not currently on a branch.');
    if (!r.upstream[cur]) return fatal(`The current branch ${cur} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin ${cur}\n`);
    specs.push(r.upstream[cur].replace(/^origin\//, '') === cur ? cur : `${cur}:${r.upstream[cur].replace(/^origin\//, '')}`);
  } else if (remote && !specs.length && !tags) {
    if (!cur) return fatal('You are not currently on a branch.');
    specs.push(cur);
  }
  if (tags) for (const n of Object.keys(r.tags)) if (!o.tags[n]) specs.push(`refs/tags/${n}`);
  for (const spec of specs) {
    if (spec.startsWith(':') || del) {
      const rb = spec.startsWith(':') ? spec.slice(1) : spec;
      if (!o.branches[rb]) { lines.push(`error: unable to delete '${rb}': remote ref does not exist`); rejected = true; continue; }
      if (rb === o.defaultBranch) { lines.push(` ! [remote rejected] ${rb} (refusing to delete the default branch)`); rejected = true; continue; }
      delete o.branches[rb]; o.version++;
      delete r.remote['origin/' + rb];
      lines.push(` - [deleted]         ${rb}`);
      events.push({ type: 'push', branch: rb, deleted: true });
      continue;
    }
    let [src, dst] = spec.includes(':') ? spec.split(':') : [spec, spec];
    if (src === 'HEAD') { src = cur; if (!spec.includes(':')) dst = cur; }
    const isTag = src.startsWith('refs/tags/') || (!r.branches[src] && r.tags[src]);
    if (isTag) {
      const n = src.replace('refs/tags/', '');
      if (!r.tags[n]) { lines.push(`error: src refspec ${n} does not match any`); rejected = true; continue; }
      if (o.tags[n]) { lines.push(` ! [rejected]        ${n} -> ${n} (already exists)`); rejected = true; continue; }
      copyReachable(r, o, r.tags[n].id);
      o.tags[n] = { ...r.tags[n] }; o.version++;
      lines.push(` * [new tag]         ${n} -> ${n}`);
      events.push({ type: 'push', tag: n });
      continue;
    }
    const lid = r.branches[src];
    if (!lid) { lines.push(`error: src refspec ${src} does not match any`); rejected = true; continue; }
    const rid = o.branches[dst];
    if (rid === lid) { lines.push('Everything up-to-date'); if (setUp) { r.upstream[src] = 'origin/' + dst; r.remote['origin/' + dst] = lid; lines.push(`branch '${src}' set up to track 'origin/${dst}'.`); } continue; }
    let why = null;
    if (rid) {
      if (!r.commits[rid]) why = 'fetch first';
      else if (!isAncestor(r, rid, lid)) why = 'non-fast-forward';
    }
    if (why && (force || lease)) {
      if (lease && r.remote['origin/' + dst] !== rid) why = 'stale info';
      else why = null;
    }
    if (why) {
      lines.push(` ! [rejected]        ${src} -> ${dst} (${why})`);
      rejected = true;
      continue;
    }
    copyReachable(r, o, lid);
    o.branches[dst] = lid; o.version++;
    r.remote['origin/' + dst] = lid;
    lines.push(rid ? `${force || lease ? ' + ' : '   '}${short(rid)}..${short(lid)}`.padEnd(22) + `${src} -> ${dst}${force || lease ? ' (forced update)' : ''}` : ' * [new branch]'.padEnd(22) + `${src} -> ${dst}`);
    if (setUp) { r.upstream[src] = 'origin/' + dst; lines.push(`branch '${src}' set up to track 'origin/${dst}'.`); }
    events.push({ type: 'push', branch: dst, isNew: !rid, ref: lid });
  }
  const body = lines.filter((l) => !l.startsWith('branch ') && l !== 'Everything up-to-date' && !l.startsWith('error: src'));
  let out = [body.length ? `To ${o.url}` : '', ...lines].filter(Boolean).join('\n');
  if (rejected) {
    const why = lines.join('\n');
    out += `\nerror: failed to push some refs to '${o.url}'`;
    if (why.includes('fetch first')) out += '\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. Integrate the remote changes (e.g. \'git pull ...\') before\nhint: pushing again.';
    else if (why.includes('non-fast-forward')) out += '\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. Integrate the remote changes (e.g. \'git pull ...\')\nhint: before pushing again.';
    else if (why.includes('stale info')) out += '\nhint: The remote moved since your last fetch. Run git fetch, check what changed, then try again.';
    return { out, code: 1, events };
  }
  return ok(out, { events });
}

/* ------------------------------------------------------------------- misc */

function cmdTag(r, args) {
  const flags = args.filter((a) => a.startsWith('-'));
  const pos = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-m' && args[i - 1] !== '--message');
  const mi = args.findIndex((a) => a === '-m' || a === '--message');
  const msg = mi >= 0 ? args[mi + 1] : null;
  if (flags.includes('-d') || flags.includes('--delete')) {
    if (!r.tags[pos[0]]) return fail(`error: tag '${pos[0]}' not found.`);
    const id = r.tags[pos[0]].id;
    delete r.tags[pos[0]];
    return ok(`Deleted tag '${pos[0]}' (was ${short(id)})`);
  }
  if (!pos.length || flags.includes('-l') || flags.includes('--list')) return ok(Object.keys(r.tags).sort().join('\n'));
  const [name, at] = pos;
  if (!branchOk(name)) return fatal(`'${name}' is not a valid tag name.`);
  if (r.tags[name]) return fatal(`tag '${name}' already exists`);
  const id = at ? resolve(r, at) : headId(r);
  if (!id) return fatal(`Failed to resolve '${at}' as a valid ref.`);
  if ((flags.includes('-a') || flags.includes('--annotate')) && msg === null) return fail('error: annotated tags need a message: git tag -a <name> -m "message"');
  r.tags[name] = { id, msg: flags.includes('-a') || msg !== null ? msg : null };
  return ok('', { events: [{ type: 'tag', name }] });
}

function cmdStash(r, args) {
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'push';
  const rest = sub === 'push' && args[0] === 'push' ? args.slice(1) : args;
  if (sub === 'list') return ok(r.stash.map((s, i) => `stash@{${i}}: WIP on ${s.branch}: ${short(s.base)} ${s.baseMsg}`).join('\n'));
  if (sub === 'drop') { if (!r.stash.length) return fatal('No stash entries found.'); const [s] = r.stash.splice(0, 1); return ok(`Dropped refs/stash@{0} (${short(sha(JSON.stringify(s.work)))})`); }
  if (sub === 'clear') { r.stash = []; return ok(''); }
  if (sub === 'show') { if (!r.stash.length) return fatal('No stash entries found.'); return ok(statText(treeOf(r, r.stash[0].base), r.stash[0].work)); }
  if (sub === 'pop' || sub === 'apply') {
    if (!r.stash.length) return fail('No stash entries found.');
    if (r.state) return fatal('finish your merge/rebase first');
    const s = r.stash[0];
    const base = treeOf(r, s.base);
    const ours = { ...r.work };
    const res = mergeTrees(base, ours, { ...s.work, ...s.untracked }, 'Updated upstream', 'Stashed changes');
    for (const p of new Set([...Object.keys(ours), ...Object.keys(res.tree)])) setPath(r.work, p, res.tree[p]);
    for (const p of Object.keys(s.work)) if (base[p] === undefined && s.index[p] !== undefined) r.index[p] = r.work[p];
    if (res.conflicts.length) return { out: `${res.conflicts.map((p) => `CONFLICT (content): Merge conflict in ${p}`).join('\n')}\nThe stash entry is kept in case you need it again.`, code: 1 };
    if (sub === 'pop') r.stash.shift();
    return ok(`${statusText(r)}\n${sub === 'pop' ? `Dropped refs/stash@{0} (${short(sha(JSON.stringify(s.work)))})` : ''}`.trim());
  }
  if (sub === 'push') {
    const withUntracked = rest.includes('-u') || rest.includes('--include-untracked');
    const ch = changesOf(r);
    const tracked = ch.staged.length || ch.unstaged.length;
    if (!tracked && !(withUntracked && ch.untracked.length)) return ok('No local changes to save');
    const H = headTree(r);
    const work = {};
    for (const p of Object.keys(r.index)) if (r.work[p] !== undefined) work[p] = r.work[p];
    const untracked = {};
    if (withUntracked) for (const p of ch.untracked) untracked[p] = r.work[p];
    const mi = rest.indexOf('-m');
    r.stash.unshift({ base: headId(r), baseMsg: firstLine(r.commits[headId(r)].msg), branch: r.head.branch || '(no branch)', index: { ...r.index }, work, untracked, msg: mi >= 0 ? rest[mi + 1] : null });
    for (const p of Object.keys(r.index)) delete r.work[p];
    r.index = { ...H };
    Object.assign(r.work, H);
    for (const p of Object.keys(untracked)) delete r.work[p];
    return ok(`Saved working directory and index state WIP on ${r.head.branch}: ${short(headId(r))} ${firstLine(r.commits[headId(r)].msg)}`, { events: [{ type: 'stash' }] });
  }
  return fatal(`unknown stash command '${sub}'`);
}

function cmdReset(r, args) {
  const mode = args.includes('--hard') ? 'hard' : args.includes('--soft') ? 'soft' : 'mixed';
  const pos = args.filter((a) => !a.startsWith('-'));
  if (r.state?.type === 'merge' && !args.includes('--hard')) return fail('fatal: Cannot do a mixed reset in the middle of a merge.');
  let rev = null;
  let paths = pos;
  if (pos.length && resolve(r, pos[0]) && !(pos[0] in r.index && !r.branches[pos[0]])) { rev = pos[0]; paths = pos.slice(1); }
  if (paths.length) return restorePaths(r, paths, { staged: true, source: rev ? resolve(r, rev) : null });
  const id = resolve(r, rev || 'HEAD');
  if (!id) return fatal(`ambiguous argument '${rev}': unknown revision`);
  const old = headTree(r);
  if (r.head.branch) r.branches[r.head.branch] = id; else r.head.detached = id;
  const neu = treeOf(r, id);
  if (mode !== 'soft') r.index = { ...neu };
  if (mode === 'hard') {
    for (const p of Object.keys(r.work)) if (p in old || p in neu) delete r.work[p];
    Object.assign(r.work, neu);
    r.state = null;
    return ok(`HEAD is now at ${short(id)} ${firstLine(r.commits[id].msg)}`);
  }
  if (mode === 'mixed') return ok(changesOf(r).unstaged.length ? 'Unstaged changes after reset:\n' + changesOf(r).unstaged.map((c) => `${c.kind === 'deleted' ? 'D' : 'M'}\t${c.path}`).join('\n') : '');
  return ok('');
}

function cmdDiff(r, args) {
  const staged = args.includes('--staged') || args.includes('--cached');
  const pos = args.filter((a) => !a.startsWith('-'));
  const revs = pos.filter((a) => resolve(r, a) && !(a in r.work));
  const paths = pos.filter((a) => !revs.includes(a));
  const only = paths.length ? [...new Set([...Object.keys(r.work), ...Object.keys(r.index), ...Object.keys(headTree(r))])].filter((p) => paths.some((s) => p === normPath(s) || p.startsWith(normPath(s) + '/'))) : null;
  let text;
  if (revs.length === 2 || (revs.length === 1 && revs[0].includes('..'))) {
    let [a, b] = revs.length === 2 ? revs : revs[0].split('..');
    text = diffTreesText(treeOf(r, resolve(r, a)), treeOf(r, resolve(r, b || 'HEAD')), only);
  } else if (revs.length === 1) text = diffTreesText(treeOf(r, resolve(r, revs[0])), staged ? r.index : r.work, only);
  else if (staged) text = diffTreesText(headTree(r), r.index, only);
  else { const t = {}; for (const p of Object.keys(r.index)) t[p] = r.work[p]; text = diffTreesText(r.index, Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)), only); }
  return ok(text);
}

function cmdShow(r, args) {
  const spec = args.find((a) => !a.startsWith('-')) || 'HEAD';
  const id = resolve(r, spec);
  if (!id) return fatal(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
  const c = r.commits[id];
  const dec = decorations(r);
  const head = [C.yellow('commit ' + id) + dec(id)];
  if (c.parents.length > 1) head.push(`Merge: ${c.parents.map(short).join(' ')}`);
  head.push(`Author: ${c.author.name} <${c.author.email}>`, `Date:   ${fmtDate(c.ts)}`, '', ...c.msg.split('\n').map((l) => `    ${l}`), '');
  return ok(head.join('\n') + '\n' + diffTreesText(treeOf(r, c.parents[0]), c.tree));
}

function cmdRm(r, args) {
  const cached = args.includes('--cached');
  const specs = args.filter((a) => !a.startsWith('-'));
  if (!specs.length) return fatal('No pathspec was given. Which files should I remove?');
  const out = [];
  for (const s of specs) {
    const m = pathMatches(Object.keys(r.index), s);
    if (!m.length) return fatal(`pathspec '${s}' did not match any files`);
    for (const p of m) { delete r.index[p]; if (!cached) delete r.work[p]; out.push(`rm '${p}'`); }
  }
  return ok(out.join('\n'));
}

function cmdConfig(r, args) {
  const pos = args.filter((a) => !a.startsWith('-'));
  if (args.includes('--list') || args.includes('-l')) return ok(`user.name=${r.user.name}\nuser.email=${r.user.email}${r.cloned ? `\nremote.origin.url=${r.url}\nbranch.${r.head.branch}.remote=origin` : ''}`);
  if (pos[0] === 'user.name') { if (pos[1] === undefined) return ok(r.user.name); r.user = { ...r.user, name: pos[1] }; return ok(''); }
  if (pos[0] === 'user.email') { if (pos[1] === undefined) return ok(r.user.email); r.user = { ...r.user, email: pos[1] }; return ok(''); }
  return ok('');
}

const HELP = `usage: git <command> [<args>]

Commands supported in this simulator:
  clone  status  log  diff  show        look around
  add  commit  restore  reset  rm       record changes
  branch  switch  checkout  merge       branching
  fetch  pull  push  remote             sync with origin
  rebase  cherry-pick  revert           rewrite / undo
  stash  tag  config`;

/* ---------------------------------------------------------- git entry point */

function git(r, o, args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return ok(HELP);
  if (sub === '--version' || sub === 'version') return ok('git version 2.47.0 (simulator)');
  if (sub === 'clone') return cmdClone(r, o, rest);
  if (sub === 'config') return cmdConfig(r, rest);
  if (sub === 'init') return fail("In this training room the team repository already lives on the server.\nUse: git clone " + o.url);
  if (!r.cloned) return fatal('not a git repository (or any of the parent directories): .git\nhint: you need to clone the team repository first.');
  switch (sub) {
    case 'status': return ok(statusText(r, { short: rest.includes('-s') || rest.includes('--short') }));
    case 'log': return cmdLog(r, rest);
    case 'diff': return cmdDiff(r, rest);
    case 'show': return cmdShow(r, rest);
    case 'add': return cmdAdd(r, rest);
    case 'commit': return cmdCommit(r, rest);
    case 'branch': return cmdBranch(r, rest);
    case 'switch': return cmdSwitch(r, rest);
    case 'checkout': return cmdCheckout(r, rest);
    case 'restore': return cmdRestore(r, rest);
    case 'merge': return cmdMerge(r, rest);
    case 'fetch': return cmdFetch(r, o, rest);
    case 'pull': return cmdPull(r, o, rest);
    case 'push': return cmdPush(r, o, rest);
    case 'rebase': return cmdRebase(r, rest);
    case 'cherry-pick': return cmdCherryPick(r, rest);
    case 'revert': return cmdRevert(r, rest);
    case 'stash': return cmdStash(r, rest);
    case 'tag': return cmdTag(r, rest);
    case 'reset': return cmdReset(r, rest);
    case 'rm': return cmdRm(r, rest);
    case 'remote': return ok(rest.includes('-v') ? `origin\t${o.url} (fetch)\norigin\t${o.url} (push)` : 'origin');
    default: return fail(`git: '${sub}' is not a git command in this simulator. Try: git help`);
  }
}

/* ------------------------------------------------------------ shell & files */

export function writeFile(r, path, content) {
  const p = normPath(path);
  if (!p) return { ok: false, error: `invalid file name: ${path}` };
  if (!r.cloned) return { ok: false, error: 'clone the repository first' };
  if (String(content).length > 6000) return { ok: false, error: 'file too large for the simulator' };
  r.work[p] = String(content).replace(/\r\n/g, '\n');
  return { ok: true, path: p };
}

function listDir(r, spec) {
  const all = Object.keys(r.work);
  const base = !spec || spec === '.' ? '' : normPath(spec);
  if (base === null) return null;
  const prefix = base ? base + '/' : '';
  if (base && r.work[base] !== undefined) return [base];
  const names = new Set();
  for (const p of all) if (p.startsWith(prefix)) { const rest = p.slice(prefix.length); const seg = rest.split('/')[0]; names.add(rest.includes('/') ? seg + '/' : seg); }
  if (base && !names.size) return null;
  return [...names].sort();
}

function shell(r, toks, line) {
  const cmd = toks[0];
  const redirIdx = toks.findIndex((t) => typeof t === 'object');
  const args = (redirIdx >= 0 ? toks.slice(1, redirIdx) : toks.slice(1)).filter((t) => typeof t === 'string');
  const redir = redirIdx >= 0 ? toks[redirIdx] : null;
  const target = redir ? toks[redirIdx + 1] : null;
  const needRepo = () => (!r.cloned ? fail(`${cmd}: no repository here yet — clone it first with: git clone <url>`) : null);
  switch (cmd) {
    case 'echo': {
      const text = args.filter((a) => a !== '-e').join(' ').replace(args.includes('-e') ? /\\n/g : /(?!)/, '\n');
      if (!redir) return ok(text);
      const nr = needRepo(); if (nr) return nr;
      if (typeof target !== 'string') return fail('bash: syntax error near unexpected token `newline\'');
      const p = normPath(target);
      if (!p) return fail(`bash: ${target}: invalid file name`);
      if (redir.redir === '>>' && r.work[p] !== undefined) {
        const cur = r.work[p];
        r.work[p] = (cur === '' || cur.endsWith('\n') ? cur : cur + '\n') + text + '\n';
      } else r.work[p] = text + '\n';
      return ok('', { events: [{ type: 'edit', path: p }] });
    }
    case 'cat': {
      const nr = needRepo(); if (nr) return nr;
      if (!args.length) return fail('cat: missing file operand');
      const out = [];
      for (const a of args) { const p = normPath(a); if (p && r.work[p] !== undefined) out.push(r.work[p].replace(/\n$/, '')); else return fail(`cat: ${a}: No such file or directory`); }
      return ok(out.join('\n'));
    }
    case 'ls': case 'll': case 'dir': {
      const nr = needRepo(); if (nr) return nr;
      const spec = args.find((a) => !a.startsWith('-'));
      const l = listDir(r, spec);
      if (!l) return fail(`ls: cannot access '${spec}': No such file or directory`);
      const hidden = args.some((a) => /^-[a-z]*a/.test(a)) && !spec ? [C.blue('.git/')] : [];
      return ok([...hidden, ...l.map((n) => (n.endsWith('/') ? C.blue(n) : n))].join('  '));
    }
    case 'touch': {
      const nr = needRepo(); if (nr) return nr;
      for (const a of args) { const p = normPath(a); if (!p) return fail(`touch: cannot touch '${a}'`); if (r.work[p] === undefined) r.work[p] = ''; }
      return ok('', { events: [{ type: 'edit' }] });
    }
    case 'rm': {
      const nr = needRepo(); if (nr) return nr;
      for (const a of args.filter((x) => !x.startsWith('-'))) { const p = normPath(a); if (!p || r.work[p] === undefined) return fail(`rm: cannot remove '${a}': No such file or directory`); delete r.work[p]; }
      return ok('');
    }
    case 'mkdir': return ok('');
    case 'pwd': return ok(r.cloned ? `/home/${r.user.name.toLowerCase().replace(/\W+/g, '')}/${r.dir}` : `/home/${r.user.name.toLowerCase().replace(/\W+/g, '')}`);
    case 'cd': {
      const a = args[0];
      if (!a || a === '~' || a === '.' || a === '..' || a === '-') return ok('');
      if (r.cloned && (a === r.dir || a === './' + r.dir || a === r.dir + '/')) return ok('');
      return fail(`bash: cd: ${a}: No such file or directory`);
    }
    case 'clear': case 'cls': return ok('', { action: { type: 'clear' } });
    case 'whoami': return ok(r.user.name);
    case 'edit': case 'nano': case 'vim': case 'vi': case 'code': case 'notepad': {
      const nr = needRepo(); if (nr) return nr;
      const p = normPath(args[0] || '');
      if (!p) return fail(`usage: ${cmd} <file>`);
      if (r.work[p] === undefined) r.work[p] = '';
      return ok(`Opening ${p} in the editor panel →`, { action: { type: 'edit', path: p } });
    }
    case 'help': return ok(`${HELP}\n\nShell helpers: ls, cat <file>, echo "text" >> <file>, touch <file>, edit <file>, clear`);
    default: return fail(`${cmd}: command not found. Type 'help' to see what works here.`, 127);
  }
}

/** Run one command line against a player's repo + the shared origin. */
export function run(r, o, line) {
  const trimmed = line.trim();
  if (!trimmed) return ok('');
  const toks = tokenize(trimmed);
  if (!toks) return fail('bash: unexpected EOF while looking for matching quote');
  if (toks[0] === 'git') {
    if (toks.some((t) => typeof t === 'object')) return fail('bash: redirection is not supported on git commands in this simulator');
    try { return git(r, o, toks.slice(1)); } catch (e) { return fail(`error: simulator hit an unexpected problem (${e.message})`); }
  }
  if (typeof toks[0] !== 'string') return fail('bash: syntax error');
  return shell(r, toks, trimmed);
}

/* ---------------------------------------------------------------- UI views */

export function fileStatuses(r) {
  const ch = changesOf(r);
  const st = {};
  for (const p of Object.keys(r.work)) st[p] = 'clean';
  for (const c of ch.staged) st[c.path] = c.kind === 'deleted' ? 'deleted' : 'staged';
  for (const c of ch.unstaged) st[c.path] = c.kind === 'deleted' ? 'deleted' : st[c.path] === 'staged' ? 'staged+modified' : 'modified';
  for (const p of ch.untracked) st[p] = 'untracked';
  for (const p of ch.conflicts) st[p] = 'conflict';
  return Object.entries(st).sort(([a], [b]) => a.localeCompare(b)).map(([path, status]) => ({ path, status, content: r.work[path] ?? null }));
}

export function graphData(store, refs, head = null) {
  const heads = Object.values(refs).filter(Boolean);
  const ids = new Set();
  for (const h of heads) for (const id of ancestors(store, h)) ids.add(id);
  const byId = {};
  for (const [name, id] of Object.entries(refs)) if (id) (byId[id] ||= []).push(name);
  return [...ids]
    .map((id) => store.commits[id])
    .sort((a, b) => b.ts - a.ts)
    .map((c) => ({ id: short(c.id), parents: c.parents.map(short), msg: firstLine(c.msg), author: c.author.name, refs: byId[c.id] || [], head: head && head === c.id }));
}

export { changesOf, statusText };
