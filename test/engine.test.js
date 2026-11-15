import test from 'node:test';
import assert from 'node:assert/strict';
import { Origin, Repo, run, originCommit, originBranch, headId, isAncestor, hasMarkers } from '../server/gitsim.js';

const sam = { name: 'Sam', email: 'sam@team.dev' };
function world() {
  const o = new Origin('https://git.sim/team/shop.git');
  originCommit(o, 'main', { 'README.md': '# Shop\n', 'config.txt': 'a=1\nb=2\nc=3\n' }, 'Initial commit', sam);
  originBranch(o, 'develop', 'main');
  const mk = (n) => new Repo({ name: n, email: n + '@x.dev' });
  return { o, mk };
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sh = (r, o, l) => { const x = run(r, o, l); return { ...x, out: strip(x.out) }; };

test('clone, branch, commit, push, reject, pull', () => {
  const { o, mk } = world();
  const a = mk('a'), b = mk('b');
  assert.equal(sh(a, o, 'git clone https://git.sim/team/shop.git').code, 0);
  sh(b, o, 'git clone https://git.sim/team/shop.git');
  assert.match(sh(a, o, 'git status').out, /nothing to commit, working tree clean/);
  sh(a, o, 'git switch -c feature/a');
  sh(a, o, 'echo "hi" > f.txt');
  assert.match(sh(a, o, 'git status').out, /Untracked files/);
  sh(a, o, 'git add f.txt');
  assert.match(sh(a, o, 'git commit -m "add f"').out, /add f/);
  assert.match(sh(a, o, 'git push').out, /no upstream/);
  assert.match(sh(a, o, 'git push -u origin feature/a').out, /new branch/);
  // main race
  sh(a, o, 'git switch main'); sh(a, o, 'git merge feature/a'); assert.equal(sh(a, o, 'git push').code, 0);
  sh(b, o, 'echo x > g.txt'); sh(b, o, 'git add .'); sh(b, o, 'git commit -m g');
  const rej = sh(b, o, 'git push');
  assert.equal(rej.code, 1); assert.match(rej.out, /rejected.*fetch first/);
  assert.equal(sh(b, o, 'git pull').code, 0);
  assert.equal(sh(b, o, 'git push').code, 0);
  assert.ok(isAncestor(o, headId(a), o.branches.main));
});

test('merge conflict flow', () => {
  const { o, mk } = world();
  const a = mk('a');
  sh(a, o, 'git clone https://git.sim/team/shop.git');
  sh(a, o, 'git switch -c f'); sh(a, o, 'echo "b=ME" > /dev/null');
  a.work['config.txt'] = 'a=1\nb=ME\nc=3\n';
  sh(a, o, 'git commit -am mine');
  originCommit(o, 'main', { 'config.txt': 'a=1\nb=SAM\nc=3\n' }, 'sam', sam);
  sh(a, o, 'git switch main'); sh(a, o, 'git pull');
  const m = sh(a, o, 'git merge f');
  assert.equal(m.code, 1); assert.match(m.out, /CONFLICT/);
  assert.ok(hasMarkers(a.work['config.txt']));
  assert.match(sh(a, o, 'git status').out, /both modified:\s+config.txt/);
  assert.match(sh(a, o, 'git commit -m x').out, /unmerged/);
  a.work['config.txt'] = 'a=1\nb=BOTH\nc=3\n';
  sh(a, o, 'git add config.txt');
  assert.match(sh(a, o, 'git commit -m "merge"').out, /merge/);
  assert.equal(a.state, null);
  assert.equal(sh(a, o, 'git push').code, 0);
  assert.match(sh(a, o, 'git log --oneline --graph').out, /\*/);
});

test('rebase with conflict, continue; force-with-lease', () => {
  const { o, mk } = world();
  const a = mk('a');
  sh(a, o, 'git clone https://git.sim/team/shop.git');
  sh(a, o, 'git switch -c f');
  a.work['config.txt'] = 'a=1\nb=ME\nc=3\n';
  sh(a, o, 'git commit -am mine');
  sh(a, o, 'git push -u origin f');
  originCommit(o, 'main', { 'config.txt': 'a=1\nb=SAM\nc=3\n' }, 'sam', sam);
  sh(a, o, 'git fetch');
  const r = sh(a, o, 'git rebase origin/main');
  assert.equal(r.code, 1);
  assert.match(sh(a, o, 'git status').out, /rebase in progress/);
  a.work['config.txt'] = 'a=1\nb=OK\nc=3\n';
  sh(a, o, 'git add config.txt');
  assert.match(sh(a, o, 'git rebase --continue').out, /Successfully rebased/);
  assert.equal(a.state, null);
  assert.ok(isAncestor(a, o.branches.main, headId(a)));
  assert.match(sh(a, o, 'git push').out, /rejected/);
  assert.match(sh(a, o, 'git push --force-with-lease').out, /forced/);
});

test('stash, revert, tag, restore, reset', () => {
  const { o, mk } = world();
  const a = mk('a');
  sh(a, o, 'git clone https://git.sim/team/shop.git');
  a.work['README.md'] = '# changed\n';
  assert.match(sh(a, o, 'git stash').out, /Saved/);
  assert.equal(a.work['README.md'], '# Shop\n');
  sh(a, o, 'git stash pop');
  assert.equal(a.work['README.md'], '# changed\n');
  sh(a, o, 'git commit -am bad');
  const bad = headId(a);
  sh(a, o, 'git revert ' + bad.slice(0, 7));
  assert.equal(a.work['README.md'], '# Shop\n');
  assert.match(sh(a, o, 'git tag -a v1 -m rel').out, /^$/);
  assert.match(sh(a, o, 'git log --oneline').out, /tag: v1/);
  sh(a, o, 'git push origin v1'); assert.ok(o.tags.v1);
  a.work['README.md'] = 'zzz'; sh(a, o, 'git restore README.md'); assert.equal(a.work['README.md'], '# Shop\n');
  sh(a, o, 'git reset --hard HEAD~1'); assert.equal(a.work['README.md'], '# changed\n');
});

test('checkout refuses to overwrite local changes', () => {
  const { o, mk } = world();
  const a = mk('a');
  sh(a, o, 'git clone https://git.sim/team/shop.git');
  sh(a, o, 'git switch -c f'); a.work['README.md'] = 'f'; sh(a, o, 'git commit -am f'); sh(a, o, 'git switch main');
  a.work['README.md'] = 'dirty';
  assert.match(sh(a, o, 'git switch f').out, /would be overwritten/);
});
