(() => {
'use strict';

/* ------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const COLORS = ['#79c0ff', '#56d364', '#e3b341', '#d2a8ff', '#ff9bce', '#ffa657', '#56d4dd'];
const colorOf = (name) => { let n = 0; for (const c of name) n = (n * 31 + c.charCodeAt(0)) >>> 0; return COLORS[n % COLORS.length]; };
const avatar = (name) => h('span', { class: 'avatar', style: `background:${colorOf(name)}`, text: name.slice(0, 1).toUpperCase() });
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } } };
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }

const FLOWS = [
  { id: 'gitflow', name: 'Git Flow', blurb: 'main + develop, feature/*, hotfix/* and release/* branches. Classic for versioned releases.' },
  { id: 'trunk', name: 'Trunk-based', blurb: 'One main branch, tiny short-lived branches, rebase, revert and release tags. Classic for continuous delivery.' },
];

const QUICK = [
  ['Look', [['status', 'git status'], ['log graph', 'git log --oneline --graph --all'], ['branches', 'git branch -a'], ['diff', 'git diff']]],
  ['Save', [['add .', 'git add .'], ['commit', 'git commit -m "<message>"'], ['commit -am', 'git commit -am "<message>"']]],
  ['Sync', [['fetch', 'git fetch'], ['pull', 'git pull'], ['pull --rebase', 'git pull --rebase'], ['push', 'git push'], ['push -u', 'git push -u origin <branch>']]],
  ['Branch', [['switch', 'git switch <branch>'], ['new branch', 'git switch -c <name>'], ['merge', 'git merge <branch>'], ['rebase', 'git rebase origin/main'], ['delete', 'git branch -d <branch>']]],
  ['Fix / undo', [['stash', 'git stash'], ['stash pop', 'git stash pop'], ['restore', 'git restore <file>'], ['revert', 'git revert <id>'], ['tag', 'git tag -a <name> -m "<message>"']]],
  ['Mid-conflict', [['merge --abort', 'git merge --abort'], ['rebase --continue', 'git rebase --continue'], ['rebase --abort', 'git rebase --abort']]],
];

/* --------------------------------------------------------------- state */
const S = { ws: null, view: null, session: store.get('gso-session'), editing: null, dirty: false, hist: [], histIdx: 0, nextId: 1, tab: 'files', retry: 0, pane: 'task' };
let lastScreen = null;

/* ----------------------------------------------------------- websocket */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    if (S.session) send({ t: 'resume', code: S.session.code, token: S.session.token });
    else show('landing');
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    S.ws = null;
    const wait = Math.min(8000, 700 * 2 ** S.retry++);
    if (S.session) toast('Connection lost. Reconnecting…', wait);
    setTimeout(connect, wait);
  };
}
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); else toast('Not connected yet, retrying…'); }

function onMessage(m) {
  switch (m.t) {
    case 'joined': S.session = { code: m.code, token: m.token }; store.set('gso-session', S.session); break;
    case 'resume-failed': S.session = null; store.del('gso-session'); show('landing'); break;
    case 'error': $('#landing-error').textContent = m.message; $('#lobby-error').textContent = m.message; toast(m.message); break;
    case 'state': S.view = m; render(); break;
    case 'out': onOut(m); break;
    case 'saved': onSaved(m); break;
  }
}

/* ------------------------------------------------------------- screens */
function show(name) {
  for (const s of ['landing', 'lobby', 'game']) $('#screen-' + s).hidden = s !== name;
  if (lastScreen !== name) { lastScreen = name; if (name === 'game') setTimeout(() => $('#term-in').focus(), 50); }
}

function flowPicker(root, selected, onPick, disabled = false) {
  root.replaceChildren(...FLOWS.map((f) => h('button', { type: 'button', class: 'flow-opt', 'aria-pressed': String(f.id === selected), disabled, onclick: () => onPick(f.id) }, h('b', { text: f.name }), h('span', { text: f.blurb }))));
}

let createFlow = 'gitflow';
function initLanding() {
  const pick = (id) => { createFlow = id; flowPicker($('#flow-picker'), createFlow, pick); };
  flowPicker($('#flow-picker'), createFlow, pick);
  const saved = store.get('gso-name');
  if (saved) { $('#create-name').value = saved; $('#join-name').value = saved; }
  const q = new URLSearchParams(location.search).get('room');
  if (q) $('#join-code').value = q.toUpperCase().slice(0, 4);
  $('#form-create').addEventListener('submit', (e) => { e.preventDefault(); const name = $('#create-name').value.trim(); store.set('gso-name', name); $('#landing-error').textContent = ''; send({ t: 'create', name, flow: createFlow }); });
  $('#form-join').addEventListener('submit', (e) => { e.preventDefault(); const name = $('#join-name').value.trim(); store.set('gso-name', name); $('#landing-error').textContent = ''; send({ t: 'join', name, code: $('#join-code').value.trim().toUpperCase() }); });
}

function leave() {
  S.session = null; store.del('gso-session'); S.view = null;
  history.replaceState(null, '', location.pathname);
  if (S.ws) S.ws.close();
  show('landing');
}

/* --------------------------------------------------------------- lobby */
function renderLobby(v) {
  const r = v.room;
  $('#lobby-code').textContent = r.code;
  const players = r.players;
  $('#lobby-count').textContent = `${players.length}/${r.max}`;
  const slots = [];
  for (let i = 0; i < r.max; i++) {
    const p = players[i];
    slots.push(p ? h('li', { class: 'filled' }, avatar(p.name), h('b', { text: p.name }), p.host ? h('span', { class: 'pill', text: 'host' }) : null, p.you ? h('span', { class: 'muted small', text: '(you)' }) : null)
      : h('li', { text: i < r.min ? 'Waiting for player…' : 'Open slot (optional)' }));
  }
  $('#lobby-players').replaceChildren(...slots);
  flowPicker($('#lobby-flow'), r.flow, (id) => send({ t: 'flow', flow: id }), !v.you.host);
  $('#lobby-outline').replaceChildren(...r.outline.map((t) => h('li', { text: t })));
  const btn = $('#btn-start');
  const enough = players.length >= r.min;
  btn.hidden = !v.you.host;
  btn.disabled = !enough;
  $('#lobby-hint').textContent = v.you.host ? (enough ? 'Everyone gets the same tasks. Start when all your teammates are in.' : `Share the code. You need at least ${r.min} players to start.`) : 'Waiting for the host to start the game…';
}

/* ---------------------------------------------------------------- game */
function render() {
  const v = S.view;
  if (!v) return;
  if (v.room.status === 'lobby') { show('lobby'); renderLobby(v); return; }
  show('game');
  renderTop(v);
  renderTask(v);
  renderTeam(v);
  renderFeed(v);
  renderPrompt(v);
  renderFiles(v);
  renderBranches(v);
  $('#graph-local').replaceChildren(drawGraph(v.repo.local, v.repo.cloned ? 'Clone the repo to see your commits.' : 'Clone the repo to see your commits.'));
  $('#graph-origin').replaceChildren(drawGraph(v.repo.origin, 'Nothing here yet.'));
}

function renderTop(v) {
  $('#g-code').textContent = v.room.code;
  $('#g-flow').textContent = v.room.flowName;
  const p = v.progress;
  $('#g-bar').style.width = `${Math.round((p.done / p.total) * 100)}%`;
  $('#g-bar-label').textContent = `${p.done}/${p.total} tasks`;
  $('#g-players').replaceChildren(...v.room.players.map((pl) => h('span', { class: `chip${pl.connected ? '' : ' off'}${pl.you ? ' you' : ''}`, title: `${pl.name}: stage ${pl.stage + 1}` }, avatar(pl.name), pl.name)));
}

function renderTask(v) {
  const p = v.progress;
  const card = $('#task-card');
  const kids = [];
  if (p.finished) {
    card.className = 'panel celebrate';
    kids.push(h('p', { class: 'stage-label', text: 'All done' }), h('h2', { class: 'stage-title', text: '🏁 You finished every task!' }));
    const everyone = v.room.status === 'done';
    kids.push(h('p', { class: 'intro', text: everyone ? 'The whole team finished. Everyone went through exactly the same tasks.' : 'Waiting for the rest of the team. Stay around: you can still use the terminal.' }));
    if (v.summary) {
      kids.push(h('h3', { text: 'Team stats' }));
      kids.push(h('table', { class: 'stats' }, h('tr', {}, ...['Player', 'Tasks', 'Commands', 'Hints'].map((x) => h('th', { text: x }))), ...v.summary.players.map((x) => h('tr', {}, h('td', { text: x.name }), h('td', { text: x.tasks }), h('td', { text: x.commands }), h('td', { text: x.hints })))));
      kids.push(h('h3', { text: 'Your cheat sheet' }));
      kids.push(h('ul', { class: 'cheat' }, ...v.summary.cheatsheet.map(([c, d]) => h('li', {}, h('code', { text: c }), ' ', h('span', { class: 'muted', text: '→ ' + d })))));
    }
    card.replaceChildren(...kids);
    return;
  }
  card.className = 'panel';
  kids.push(h('p', { class: 'stage-label', text: `Stage ${p.stageIdx + 1} of ${p.stageCount}` }), h('h2', { class: 'stage-title', text: p.stageTitle }), h('p', { class: 'intro', html: md(p.stageIntro) }));
  if (p.waiting) {
    kids.push(h('div', { class: 'task-now waiting' }, h('div', { class: 'big-emoji', text: '⏳' }), h('b', { text: 'Stage complete!' }), h('p', { class: 'muted', text: p.waitingOn.length ? `Waiting for ${p.waitingOn.join(', ')} so the whole team starts the next stage together.` : 'Starting the next stage…' }),
      v.you.host && p.waitingOn.length ? h('button', { class: 'btn small', onclick: () => send({ t: 'force' }) }, 'Move on without them') : null));
  } else {
    const t = p.task;
    if (p.turn) {
      const blocked = p.turn.blockedBy.length > 0;
      kids.push(h('div', { class: `relay${blocked ? ' wait' : ' go'}` },
        h('b', { text: blocked ? `⏳ Not your turn: waiting for ${p.turn.blockedBy.join(', ')}` : '🟢 It\'s your turn to sync!' }),
        h('div', { class: 'order' }, ...p.turn.order.flatMap((n, i) => [i ? h('span', { class: 'arrow', text: '→' }) : null, h('span', { class: `ord${n === v.you.name ? ' me' : ''}`, text: `${i + 1}. ${n}` })].filter(Boolean))),
        h('span', { class: 'muted small', text: blocked ? 'Fetch / pull / merge / push / rebase are locked until then. Check what the teammates ahead of you changed in the Origin tab.' : 'Teammates behind you are waiting for your push.' }),
        blocked && v.you.host ? h('button', { class: 'btn tiny', onclick: () => send({ t: 'force' }) }, 'Unlock turn order') : null));
    }
    kids.push(h('div', { class: 'task-now' },
      h('div', { class: 'step', text: `Task ${p.taskIdx + 1} of ${p.taskCount}` }),
      h('h4', { text: t.title }),
      h('p', { class: 'goal', html: md(t.goal) }),
      h('div', { class: 'hints' }, ...t.hints.map((x, i) => hintBox(x, i))),
      t.hints.length < t.hintsTotal ? h('button', { class: 'btn small', onclick: () => send({ t: 'hint' }) }, `💡 ${t.hints.length ? 'Another hint' : 'Need a hint?'} (${t.hints.length}/${t.hintsTotal})`) : null,
      t.why ? h('p', { class: 'why', html: '<b>Why:</b> ' + md(t.why) }) : null));
  }
  kids.push(h('ul', { class: 'checklist' }, ...p.allTasks.map((t) => h('li', { class: t.state, text: t.title }))));
  card.replaceChildren(...kids);
}

function hintBox(x) {
  const box = h('div', { class: 'hint' }, h('div', { html: md(x.text) }));
  if (x.cmd) {
    box.append(h('pre', { text: x.cmd }));
    const first = x.cmd.split('\n')[0];
    box.append(h('div', { class: 'hint-actions' }, h('button', { class: 'btn tiny', onclick: () => fillInput(first) }, 'Paste into terminal')));
  }
  return box;
}

function renderTeam(v) {
  const total = v.progress.total;
  $('#team').replaceChildren(...v.room.players.map((p) => h('li', {},
    h('div', { class: 'row' }, h('span', { class: `dot${p.connected ? '' : ' off'}` }), avatar(p.name), h('span', { class: 'name', text: p.name + (p.you ? ' (you)' : '') }),
      h('span', { class: 'meta', text: p.finished ? '🏁 finished' : p.waiting ? '⏳ waiting' : `stage ${p.stage + 1}` })),
    h('div', { class: 'bar' }, h('i', { style: `width:${Math.round((p.done / total) * 100)}%` })))));
}
function renderFeed(v) {
  const items = [...v.room.feed].reverse();
  $('#feed').replaceChildren(...items.map((f) => h('li', { class: f.kind, text: f.text })));
}

/* ------------------------------------------------------------ terminal */
const term = () => $('#term');
function lineEl(cls, children) { return h('div', { class: 'ln ' + (cls || '') }, children); }

function ansiLine(text) {
  const frag = document.createDocumentFragment();
  const re = /\x1b\[(\d+)m/g;
  let last = 0, cls = [], m;
  const push = (s) => { if (s) frag.append(cls.length ? h('span', { class: cls.join(' '), text: s }) : document.createTextNode(s)); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const c = +m[1];
    if (c === 0) cls = [];
    else if (c === 1) cls.push('a1');
    else if (c === 2) cls.push('a2');
    else cls.push('c' + c);
  }
  push(text.slice(last));
  return frag;
}
function printOut(text) {
  const t = term();
  if (text == null || text === '') return;
  for (const raw of text.split('\n')) {
    let cls = '';
    if (/^(fatal|error):/.test(raw) || /^CONFLICT/.test(raw) || /^ ! \[rejected\]/.test(raw)) cls = 'err';
    else if (/^hint:/.test(raw)) cls = 'hintl';
    t.append(lineEl(cls, ansiLine(raw)));
  }
  t.scrollTop = t.scrollHeight;
}
function printCmd(line) {
  term().append(lineEl('cmdline', [h('span', { class: 'pr', text: promptText() + ' ' }), line]));
  term().scrollTop = term().scrollHeight;
}
function promptText() {
  const r = S.view?.repo;
  if (!r || !r.cloned) return '~ $';
  const b = r.head?.branch || (r.head?.detached ? '(detached)' : '?');
  return `~/${r.dir} (${b}${r.state ? '|' + r.state.type.toUpperCase() : ''}) $`;
}
function renderPrompt() {
  const r = S.view.repo;
  const p = $('#prompt');
  if (!r.cloned) { p.replaceChildren(document.createTextNode('~ $')); return; }
  const b = r.head?.branch || '(detached)';
  p.replaceChildren(...[document.createTextNode(`~/${r.dir} `), h('span', { class: 'br', text: `(${b}` }), r.state ? h('span', { class: 'st', text: '|' + r.state.type.toUpperCase() }) : null, h('span', { class: 'br', text: ')' }), document.createTextNode(' $')].filter(Boolean));
  $('#term-title').textContent = r.cloned ? `~/${r.dir}` : 'terminal (not in a repository yet)';
}

function runLine(line) {
  line = line.trim();
  if (!line) return;
  printCmd(line);
  S.hist.push(line); S.histIdx = S.hist.length;
  send({ t: 'cmd', line, id: S.nextId++ });
}
function onOut(m) {
  printOut(m.out);
  if (m.action?.type === 'clear') term().replaceChildren();
  if (m.action?.type === 'edit') { switchTab('files'); openEditor(m.action.path); }
}
function fillInput(text) {
  const inp = $('#term-in');
  inp.value = text; inp.focus();
  const m = text.match(/<[^>]+>/);
  if (m) inp.setSelectionRange(m.index, m.index + m[0].length); else inp.setSelectionRange(text.length, text.length);
  if (matchMedia('(max-width: 760px)').matches) showPane('term');
}

function initTerminal() {
  const inp = $('#term-in');
  $('#term-form').addEventListener('submit', (e) => { e.preventDefault(); const v = inp.value; inp.value = ''; if (v.trim() === 'clear') term().replaceChildren(); else runLine(v); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); if (S.histIdx > 0) inp.value = S.hist[--S.histIdx]; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (S.histIdx < S.hist.length) { S.histIdx++; inp.value = S.hist[S.histIdx] ?? ''; } }
    else if (e.key === 'Tab') { e.preventDefault(); complete(inp); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); term().replaceChildren(); }
  });
  $('#term').addEventListener('click', () => { if (!getSelection().toString()) inp.focus(); });
  $('#btn-clear').addEventListener('click', () => { term().replaceChildren(); inp.focus(); });
  term().append(lineEl('sys', 'Welcome! Type commands like in a real terminal. Try `help`. Use ↑ for history and Tab to complete.'));
}

const GIT_CMDS = ['add', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit', 'diff', 'fetch', 'log', 'merge', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'revert', 'rm', 'show', 'stash', 'status', 'switch', 'tag'];
function complete(inp) {
  const v = inp.value.slice(0, inp.selectionStart);
  const parts = v.split(/\s+/);
  const word = parts[parts.length - 1];
  let cands = [];
  const r = S.view?.repo;
  if (parts[0] === 'git' && parts.length === 2) cands = GIT_CMDS;
  else if (r) cands = [...r.branches.map((b) => b.name), ...r.remoteBranches.map((b) => b.replace(/^origin\//, '')), ...r.remoteBranches, ...r.files.map((f) => f.path), ...r.tags];
  const m = [...new Set(cands)].filter((c) => c.startsWith(word) && c !== word);
  if (!m.length) return;
  let pre = m[0];
  for (const c of m) while (!c.startsWith(pre)) pre = pre.slice(0, -1);
  inp.value = v.slice(0, v.length - word.length) + (m.length === 1 ? m[0] + ' ' : pre) + inp.value.slice(inp.selectionStart);
  if (m.length > 1) { printCmd(v); printOut(m.slice(0, 20).join('  ')); }
}

function initQuick() {
  $('#quick').replaceChildren(...QUICK.map(([label, items]) => h('div', { class: 'quick-row' }, h('span', { class: 'lbl', text: label }), ...items.map(([name, cmd]) => {
    const needs = /<[^>]+>/.test(cmd);
    return h('button', { type: 'button', class: 'qbtn' + (needs ? ' fill' : ''), title: cmd + (needs ? '  (fills the terminal: edit the <placeholder>, then press Enter)' : ''), onclick: () => (needs ? fillInput(cmd) : runLine(cmd)) }, name);
  }))));
}

/* ---------------------------------------------------------- files/editor */
function switchTab(name) {
  S.tab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['files', 'branches', 'local', 'origin']) $('#tab-' + t).hidden = t !== name;
}

const BADGE = { untracked: 'U', modified: 'M', staged: 'A', 'staged+modified': 'AM', conflict: 'CONFLICT', deleted: 'D' };
function renderFiles(v) {
  const files = v.repo.files;
  const ul = $('#files');
  if (!v.repo.cloned) { ul.replaceChildren(h('li', { class: 'muted', text: 'No files yet. Clone the repository first.' })); closeEditor(); return; }
  ul.replaceChildren(...files.map((f) => h('li', { class: S.editing === f.path ? 'sel' : '', onclick: () => openEditor(f.path) },
    h('span', { class: 'path', text: f.path }),
    f.status !== 'clean' ? h('span', { class: `badge b-${f.status}`, title: f.status, text: BADGE[f.status] }) : null)));
  if (S.editing) {
    const f = files.find((x) => x.path === S.editing);
    if (!f) closeEditor();
    else if (!S.dirty && $('#ed-text').value !== f.content) { $('#ed-text').value = f.content; updateConflictBar(); }
  }
}
function openEditor(path) {
  const f = S.view?.repo.files.find((x) => x.path === path);
  if (!f) return;
  S.editing = path; S.dirty = false;
  $('#editor').hidden = false;
  $('#ed-path').textContent = path;
  $('#ed-text').value = f.content ?? '';
  $('#ed-status').textContent = '';
  updateConflictBar();
  renderFiles(S.view);
  if (matchMedia('(max-width: 760px)').matches) showPane('side');
}
function closeEditor() { S.editing = null; S.dirty = false; $('#editor').hidden = true; }
function updateConflictBar() { $('#ed-conflict').hidden = !/^(<<<<<<<|=======|>>>>>>>)/m.test($('#ed-text').value); }
function saveEditor() { if (!S.editing) return; send({ t: 'save', path: S.editing, content: $('#ed-text').value }); }
function onSaved(m) {
  if (m.ok) { S.dirty = false; $('#ed-status').textContent = 'Saved ✓ (now git add it)'; toast(`Saved ${m.path}`, 1500); }
  else toast(m.error || 'Could not save');
}
function resolveConflict(mode) {
  const ta = $('#ed-text');
  ta.value = ta.value.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n?/g, (_m, a, b) => (mode === 'ours' ? a : mode === 'theirs' ? b : a + b));
  S.dirty = true; updateConflictBar();
  $('#ed-status').textContent = 'Not saved yet';
}
function initEditor() {
  $('#ed-text').addEventListener('input', () => { S.dirty = true; $('#ed-status').textContent = 'Not saved yet'; updateConflictBar(); });
  $('#ed-text').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveEditor(); } });
  $('#ed-save').addEventListener('click', saveEditor);
  $('#ed-close').addEventListener('click', () => { closeEditor(); renderFiles(S.view); });
  $('#ed-del').addEventListener('click', () => { if (S.editing && confirm(`Delete ${S.editing} from your working folder?`)) { send({ t: 'del', path: S.editing }); closeEditor(); } });
  $$('#ed-conflict [data-res]').forEach((b) => b.addEventListener('click', () => resolveConflict(b.dataset.res)));
  $('#btn-newfile').addEventListener('click', () => {
    if (!S.view?.repo.cloned) return toast('Clone the repository first.');
    if ($('#newfile-row')) return;
    const inp = h('input', { placeholder: 'path/name.txt', 'aria-label': 'New file name' });
    const row = h('li', { id: 'newfile-row' }, inp);
    $('#files').prepend(row);
    inp.focus();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') row.remove();
      if (e.key === 'Enter') { const p = inp.value.trim(); row.remove(); if (!p) return; send({ t: 'save', path: p, content: '' }); setTimeout(() => openEditor(p.replace(/^\.\//, '')), 250); }
    });
  });
}

/* ------------------------------------------------------------ branches */
function renderBranches(v) {
  const r = v.repo;
  $('#branches').replaceChildren(...(r.branches.length ? r.branches.map((b) => h('li', { class: b.current ? 'cur' : '' },
    h('span', { class: 'nm', text: (b.current ? '● ' : '') + b.name, title: b.upstream ? `tracks ${b.upstream}` : 'no upstream' }),
    b.ahead ? h('span', { class: 'ab', text: `↑${b.ahead}`, title: 'commits to push' }) : null,
    b.behind ? h('span', { class: 'ab', text: `↓${b.behind}`, title: 'commits to pull' }) : null,
    !b.current ? h('button', { class: 'btn tiny', onclick: () => runLine(`git switch ${b.name}`) }, 'switch') : null)) : [h('li', { class: 'muted', text: 'none yet' })]));
  $('#remote-branches').replaceChildren(...(r.remoteBranches.length ? r.remoteBranches.map((b) => h('li', { text: b })) : [h('li', { class: 'muted', text: 'unknown until you clone or fetch' })]));
  const live = r.originBranches.filter((b) => !r.remoteBranches.includes('origin/' + b));
  if (live.length) $('#remote-branches').append(h('li', { class: 'muted small', text: `New on the server (run git fetch): ${live.join(', ')}` }));
  $('#tags').textContent = r.tags.length ? r.tags.join('  ') : 'none';
  $('#stash-info').textContent = r.stash ? `Stash: ${r.stash} entr${r.stash === 1 ? 'y' : 'ies'}` : '';
}

/* --------------------------------------------------------------- graph */
const LANE_COLORS = ['#79c0ff', '#56d364', '#e3b341', '#d2a8ff', '#ff9bce', '#ffa657', '#56d4dd'];
function drawGraph(commits, emptyMsg) {
  if (!commits.length) return h('p', { class: 'muted small', text: emptyMsg });
  const list = commits.slice(0, 70);
  const ROW = 30, X0 = 14, DX = 16, GW = 372;
  const lanes = [];
  const pos = {};
  list.forEach((c, row) => {
    let lane = lanes.indexOf(c.id);
    if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; }
    lanes[lane] = c.id;
    pos[c.id] = { lane, row };
    const [p0, ...rest] = c.parents;
    if (p0) { const ex = lanes.indexOf(p0); if (ex >= 0 && ex !== lane) lanes[lane] = null; else lanes[lane] = p0; } else lanes[lane] = null;
    for (const p of rest) if (!lanes.includes(p)) { let f = lanes.indexOf(null); if (f < 0) f = lanes.length; lanes[f] = p; }
  });
  const width = X0 * 2 + (Math.max(...Object.values(pos).map((p) => p.lane)) + 1) * DX;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  svg.setAttribute('height', list.length * ROW + 10);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'commit graph');
  const X = (lane) => X0 + lane * DX;
  const Y = (row) => 16 + row * ROW;
  for (const c of list) {
    const a = pos[c.id];
    for (const p of c.parents) {
      const b = pos[p];
      const col = LANE_COLORS[Math.max(a.lane, b ? b.lane : a.lane) % LANE_COLORS.length];
      const y2 = b ? Y(b.row) : Y(list.length) + 4;
      const x2 = b ? X(b.lane) : X(a.lane);
      const d = a.lane === (b ? b.lane : a.lane) ? `M${X(a.lane)} ${Y(a.row)} L${x2} ${y2}` : `M${X(a.lane)} ${Y(a.row)} C${X(a.lane)} ${Y(a.row) + ROW * 0.8} ${x2} ${y2 - ROW * 0.8} ${x2} ${y2}`;
      svg.append(mk('path', { d, stroke: col, 'stroke-width': 2, fill: 'none', opacity: 0.9 }));
    }
  }
  for (const c of list) {
    const a = pos[c.id];
    const col = LANE_COLORS[a.lane % LANE_COLORS.length];
    svg.append(mk('circle', { cx: X(a.lane), cy: Y(a.row), r: c.parents.length > 1 ? 5.5 : 4.5, fill: c.head ? '#fff' : '#0d1117', stroke: col, 'stroke-width': 2.5 }));
    let x = width;
    const t = mk('text', { x, y: Y(a.row) + 4 });
    // refs as pills, then message
    const g = mk('g', {});
    let cursor = x;
    for (const ref of c.refs.slice(0, 2)) {
      const label = ref.length > 22 ? ref.slice(0, 21) + '…' : ref;
      const w = label.length * 6.2 + 12;
      const isRemote = ref.startsWith('origin/'), isTag = ref.startsWith('tag: ');
      const color = isTag ? '#e3b341' : isRemote ? '#ff7b72' : '#56d364';
      g.append(mk('rect', { x: cursor, y: Y(a.row) - 9, width: w, height: 18, rx: 9, fill: color, 'fill-opacity': 0.16, stroke: color, 'stroke-opacity': 0.7 }));
      const tt = mk('text', { x: cursor + 6, y: Y(a.row) + 4, class: 'ref', fill: color }); tt.style.fill = color; tt.textContent = label;
      g.append(tt);
      cursor += w + 5;
    }
    const extra = c.refs.length > 2 ? ` +${c.refs.length - 2}` : '';
    const room = Math.max(10, Math.floor((GW - cursor - 6) / 6.3) - extra.length);
    const full = `${c.msg}  ·  ${c.author.split(' ')[0]}`;
    t.setAttribute('x', cursor); t.textContent = (full.length > room ? full.slice(0, room - 1) + '…' : full) + extra;
    const ttl = mk('title', {}); ttl.textContent = `${c.id}  ${c.msg}  (${c.author})${c.refs.length ? '  [' + c.refs.join(', ') + ']' : ''}`; t.append(ttl);
    svg.append(g, t);
  }
  svg.setAttribute('width', GW);
  return svg;
}

/* ---------------------------------------------------------- mobile nav */
function showPane(p) {
  S.pane = p;
  $$('#mobile-nav button').forEach((b) => b.classList.toggle('active', b.dataset.pane === p));
  $('#col-task').classList.toggle('show', p === 'task');
  $('#col-term').classList.toggle('show', p === 'term');
  $('#col-side').classList.toggle('show', p === 'side');
}

/* ----------------------------------------------------------------- boot */
function init() {
  initLanding();
  initTerminal();
  initQuick();
  initEditor();
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('#mobile-nav button').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));
  showPane('task');
  $('#btn-start').addEventListener('click', () => send({ t: 'start' }));
  $('#btn-leave-lobby').addEventListener('click', leave);
  $('#btn-copy').addEventListener('click', async () => {
    const link = `${location.origin}/?room=${S.view.room.code}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { prompt('Copy this link', link); }
  });
  show('landing');
  connect();
}
init();
})();
