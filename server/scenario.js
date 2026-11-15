// Scenario definitions. The *server* decides what every player has to do.
// Every player gets the same tasks (parameterised with their own names / files),
// Tasks are verified from repo STATE (not from the command typed), but the state is strict:
// exact branch names, exact file contents, exact commit / tag messages. A task only passes when
// everything matches the instructions, otherwise the player gets an explanation of what to fix.
import { Origin, originCommit, originBranch, isAncestor, ancestors, treeOf, hasMarkers } from './gitsim.js';

export const URL = 'https://git.sim/team/shop.git';
export const FLOWS = {
  gitflow: {
    id: 'gitflow',
    name: 'Git Flow',
    blurb: 'main + develop, feature/*, hotfix/* and release/* branches. Classic for versioned releases.',
  },
  trunk: {
    id: 'trunk',
    name: 'Trunk-based',
    blurb: 'One main branch, tiny short-lived branches, rebase, revert and release tags. Classic for continuous delivery.',
  },
};

const SAM = { name: 'Sam (teammate)', email: 'sam@team.dev' };
const THEMES = ['blue', 'green', 'red', 'purple', 'orange'];
const LANGS = ['fr', 'de', 'es', 'id', 'ja'];
const SETTINGS = 'team/settings.txt';

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'dev';

export function makePlayerVars(name, index, taken) {
  let slug = slugify(name);
  while (taken.has(slug)) slug += index + 1;
  taken.add(slug);
  return { slug, n: index + 1, theme: THEMES[index % THEMES.length], lang: LANGS[index % LANGS.length] };
}

/* ------------------------------------------------------------------ helpers */

// V = "validated" task: issue(ctx) returns null when everything is exactly right,
// a string explaining what to fix, or '' to fail silently (e.g. "not done yet").
const V = (id, title, goal, hints, issue, extra = {}) => ({ id, title, goal, hints, check: (c) => issue(c) === null, explain: (c) => issue(c) || null, ...extra });
const H = (text, cmd) => ({ text, cmd });
const onB = (r, n) => r.head?.branch === n;
const headOf = (r) => (r.head?.branch ? r.branches[r.head.branch] : r.head?.detached);
const fileAt = (store, id, p) => treeOf(store, id)[p];
const commitWith = (r, pred) => Object.values(r.commits).some(pred);
const firstLine = (m) => String(m).split('\n')[0];
const q = (s) => '`' + s + '`';

const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
const sameText = (a, b) => a !== undefined && a !== null && norm(a) === norm(b);
const fence = (t) => '\n```\n' + norm(t) + '```';

const needBranch = (r, name) => (onB(r, name) ? null : `You are on ${q(r.head?.branch || 'detached HEAD')} but this must happen on branch ${q(name)}. Switch with: ${q('git switch ' + name)}`);
const fileIssue = (actual, expected, path) => (actual === undefined ? `File ${q(path)} does not exist yet.` : sameText(actual, expected) ? null : `${q(path)} must contain exactly this (including the spelling and every line):${fence(expected)}`);

function ahead(r, tip, baseTip) {
  const keep = ancestors(r, baseTip);
  return [...ancestors(r, tip)].filter((id) => !keep.has(id) && r.commits[id].parents.length < 2).map((id) => r.commits[id]).sort((a, b) => a.ts - b.ts);
}
function changedPaths(r, c) {
  const a = treeOf(r, c.parents[0]), b = c.tree;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort();
}
function commitIssue(r, c, { msg, files, contents }) {
  if (firstLine(c.msg) !== msg) return `The commit message must be exactly: ${q(msg)}\nYours is: ${q(firstLine(c.msg))}\nFix the last commit with: ${q(`git commit --amend -m "${msg}"`)}`;
  const ch = changedPaths(r, c);
  if (files && (ch.length !== files.length || !files.every((f) => ch.includes(f)))) return `This commit must change only ${files.map(q).join(', ')} but it changes ${ch.length ? ch.map(q).join(', ') : 'nothing'}. Undo the commit with ${q('git reset --soft HEAD~1')}, unstage the wrong files (${q('git restore --staged <file>')}), then commit again.`;
  for (const [path, text] of Object.entries(contents || {})) if (!sameText(c.tree[path], text)) return `The committed content of ${q(path)} is wrong. It must be exactly:${fence(text)}Fix the file, ${q('git add')} it, then ${q('git commit --amend --no-edit')}.`;
  return null;
}
/** the branch must carry exactly these commits (oldest first) on top of base */
function branchIssue(r, br, baseTip, specs) {
  const tip = r.branches[br];
  if (!tip) return `Branch ${q(br)} does not exist.`;
  const list = ahead(r, tip, baseTip);
  if (!list.length) return '';
  if (list.length !== specs.length) return `${q(br)} should have exactly ${specs.length} new commit${specs.length > 1 ? 's' : ''} but has ${list.length}. Use ${q('git log --oneline')} to look, then ${q('git reset --soft HEAD~1')} / ${q('git commit --amend')} to fix it.`;
  for (let i = 0; i < specs.length; i++) { const e = commitIssue(r, list[i], specs[i]); if (e) return e; }
  return null;
}
const mergeMsg = (br, into) => (['main', 'master'].includes(into) ? `Merge branch '${br}'` : `Merge branch '${br}' into ${into}`);
/** if the merge of `br` into `into` created a merge commit it must carry git's default message */
function mergeMsgIssue(r, br, into) {
  const tip = r.branches[br];
  const M = Object.values(r.commits).find((c) => c.parents.length === 2 && c.parents[1] === tip && isAncestor(r, c.id, r.branches[into]));
  if (M && firstLine(M.msg) !== mergeMsg(br, into)) return `The merge commit message must be git's default: ${q(mergeMsg(br, into))}\nYours is: ${q(firstLine(M.msg))}\nFix it with: ${q(`git commit --amend -m "${mergeMsg(br, into)}"`)}`;
  return null;
}
const tagIssue = (r, name, msg, mustContain) => {
  const t = r.tags[name];
  if (!t) return '';
  if (!t.msg) return `${q(name)} must be an annotated tag with a message. Delete it (${q('git tag -d ' + name)}) and create it again with ${q(`git tag -a ${name} -m "${msg}"`)}`;
  if (t.msg !== msg) return `The tag message must be exactly ${q(msg)} but is ${q(t.msg)}. Delete the tag (${q('git tag -d ' + name)}) and create it again.`;
  if (mustContain && !isAncestor(r, mustContain, t.id)) return `The tag ${q(name)} does not point at a commit that contains your work. Make sure you are on the right branch/commit, delete the tag and tag again.`;
  return null;
};

/* text rules for the shared settings file ---------------------------------- */
const BASE = { theme: 'light', language: 'en' };
const getField = (t, f) => (String(t).match(new RegExp(`^${f}=(.*)$`, 'm')) || [])[1];
const replaceField = (t, f, v) => String(t).replace(new RegExp(`^${f}=.*$`, 'm'), `${f}=${v}`);
const insertAfterField = (t, f, line) => String(t).replace(new RegExp(`^(${f}=.*)$`, 'm'), `$1\n${line}`);
/** Team rule for conflicts: the first teammate's value stays, your wish is recorded as a comment right below it. */
const expectedFrom = (ours, R, p) => (getField(ours, R.field) === BASE[R.field] ? replaceField(ours, R.field, R.val(p)) : insertAfterField(ours, R.field, `# ${p.name} wanted: ${R.field}=${R.val(p)}`));

export function seedOrigin(players, flowId) {
  const o = new Origin(URL);
  originCommit(o, 'main', {
    'README.md': '# Shop\n\nA tiny online shop. Welcome to the team!\n',
    'CHANGELOG.md': '# Changelog\n\n- 1.0.0 first release\n',
    'config.txt': 'app_name=Shop\nversion=1.0.0\n',
  }, 'Initial commit', SAM);
  const ws = { [SETTINGS]: '# Team settings (everybody edits this file!)\ntheme=light\n\nlanguage=en\n' };
  for (const p of players) ws[`players/${p.slug}/notes.txt`] = `# notes of ${p.name}\n- nothing yet\n`;
  originCommit(o, 'main', ws, 'Add player workspaces', SAM);
  if (flowId === 'gitflow') originBranch(o, 'develop', 'main');
  return o;
}

/* exact texts every player must produce */
const featureText = (p) => `Feature: profile page\nOwner: ${p.name}\n`;
const bugBroken = (p) => `status=broken\nreason=checkout crashes for ${p.name}\n`;
const bugFixed = (p) => `status=fixed\nreason=checkout crashes for ${p.name}\n`;
const WIP_LINE = '- idea: faster search';

const READ_ONLY_STAGE = (flowName) => ({
  id: 'start',
  title: 'Get the code',
  intro: `Welcome to the team! This room runs the **${flowName}** workflow. Everything you do happens in your own private copy of the repository; \`origin\` is the shared server copy that your teammates push to as well.\n\n**Rules of this room:** names, file contents and commit messages are given to you **exactly**. A task only turns green when what you did matches the instructions, and you will be told what to fix when it does not. Real teams have such rules too (naming conventions, commit message formats).`,
  tasks: () => [
    V('clone', 'Clone the team repository', `Download the team repo into your machine: \`${URL}\``, [
      H('`git clone <url>` copies the whole repository (all branches and history) and checks out the default branch.'),
      H('Run this:', `git clone ${URL}`),
    ], ({ r }) => (r.cloned ? null : ''), { why: 'Cloning is always step one on a new project or a new laptop.' }),
    V('log', 'Look at the history', 'Print the history as one line per commit.', [
      H('`git log` shows commits, newest first. A flag makes it compact.'),
      H('Run this:', 'git log --oneline'),
    ], ({ ran }) => (ran(/^git log\b/) ? null : ''), { why: 'Reading history is how you find out what your teammates did.' }),
    V('branches', 'List all branches', 'Show your local branches **and** the ones that exist on origin.', [
      H('`git branch` lists local branches. One flag also includes remote-tracking branches (`remotes/origin/...`).'),
      H('Run this:', 'git branch -a'),
    ], ({ ran }) => (ran(/^git branch\b.*(-a|-r|--all|--remotes)/) ? null : ''), { why: 'Remote-tracking branches (origin/x) are your last known picture of the server.' }),
    V('status', 'Check the status', 'Ask git what state your working folder is in.', [
      H('Use the command that tells you which branch you are on and what changed.'),
      H('Run this:', 'git status'),
    ], ({ ran }) => (ran(/^git status\b/) ? null : ''), { why: 'Run `git status` all the time. It tells you what to do next.' }),
  ],
});

/* ------------------------------------------------------------------ relay
   ALL players change the SAME line of a shared file and integrate one after another (the
   server keeps fetch/pull/merge/push/rebase locked until everybody ahead of you is done).
   Player 2 conflicts with player 1, player 3 with player 2's resolution, and so on.
   Round 2 runs in reverse order, so the first player of round 1 conflicts in round 2. */
const ROUNDS = [
  { n: 1, field: 'theme', val: (p) => p.theme, relay: 'asc', suffix: 'theme' },
  { n: 2, field: 'language', val: (p) => p.lang, relay: 'desc', suffix: 'lang' },
];
const relayMsg = (R, p) => `feat: set ${R.field} to ${R.val(p)}`;

function relayPrepStage(flow, R) {
  const base = flow === 'gitflow' ? 'develop' : 'main';
  const br = (p) => `${flow === 'gitflow' ? 'feature' : 'feat'}/${p.slug}-${R.suffix}`;
  return {
    id: `prepare-conflict-${R.n}`,
    title: `Prepare change ${R.n}/2`,
    intro: `Everybody on the team is about to change the **same line** of \`${SETTINGS}\` (\`${R.field}=\`), each with their own value. First everyone prepares their change **locally**. Do not sync with origin yet; that happens one teammate at a time.`,
    tasks: (p) => {
      const expected = (r) => replaceField(fileAt(r, r.branches[base], SETTINGS) ?? '', R.field, R.val(p));
      return [
        V(`prep${R.n}-update`, `Start from the latest ${base}`, `Switch to \`${base}\` and pull, so every teammate starts from the same code.`, [
          H('Switch, then pull.'),
          H('Run these:', `git switch ${base}\ngit pull`),
        ], ({ r, ran }) => (onB(r, base) && ran(/^git pull/) && isAncestor(r, r.remote['origin/' + base], headOf(r)) ? null : needBranchIfActed(r, base))),
        V(`prep${R.n}-branch`, 'Create your branch', `Create \`${br(p)}\` from \`${base}\`.`, [H('Run this:', `git switch -c ${br(p)}`)], ({ r }) => (onB(r, br(p)) && isAncestor(r, r.branches[base], headOf(r)) ? null : r.head?.branch && r.head.branch !== br(p) && r.head.branch !== base ? `The branch must be named exactly ${q(br(p))}.` : '')),
        V(`prep${R.n}-edit`, `Set your ${R.field}`, (c) => `Open \`${SETTINGS}\` in the editor (click it in Files, or run \`edit ${SETTINGS}\`) and change **only** the \`${R.field}=\` line. The whole file must be exactly:${fence(expected(c.r))}`, [
          H('Open the file in the editor and save.'),
          H('Open it:', `edit ${SETTINGS}`),
        ], ({ r }) => needBranch(r, br(p)) || fileIssue(r.work[SETTINGS], expected(r), SETTINGS)),
        V(`prep${R.n}-commit`, 'Commit your change', `Commit it with the exact message \`${relayMsg(R, p)}\`. **Do not push or pull yet!**`, [
          H('Stage and commit in one go (the file is already tracked).'),
          H('Run this:', `git commit -am "${relayMsg(R, p)}"`),
        ], ({ r }) => branchIssue(r, br(p), r.branches[base], [{ msg: relayMsg(R, p), files: [SETTINGS], contents: { [SETTINGS]: expected(r) } }]) ?? null),
      ];
    },
  };
}
const needBranchIfActed = (r, base) => (r.head?.branch && r.head.branch !== base ? needBranch(r, base) : '');

function gitflowRelayStage(R) {
  const br = (p) => `feature/${p.slug}-${R.suffix}`;
  const info = (r, p) => {
    if (r.state?.type === 'merge') return { phase: 'open', ours: fileAt(r, headOf(r), SETTINGS), result: r.work[SETTINGS] };
    const tip = r.branches[br(p)];
    if (tip && isAncestor(r, tip, r.branches.develop)) {
      const M = Object.values(r.commits).find((c) => c.parents.length === 2 && c.parents[1] === tip && isAncestor(r, c.id, r.branches.develop));
      if (M) return { phase: 'done', ours: fileAt(r, M.parents[0], SETTINGS), result: M.tree[SETTINGS] };
      return { phase: 'done', ff: true };
    }
    return null;
  };
  const resIssue = (i, p) => (i.ff || sameText(i.result, expectedFrom(i.ours, R, p)) ? null : `The resolved ${q(SETTINGS)} must be exactly:${fence(expectedFrom(i.ours, R, p))}`);
  return {
    id: `conflict-${R.n}`,
    relay: R.relay,
    title: `Conflict relay ${R.n}/2`,
    intro: `**Teamwork time.** Everybody changed the same line, so you integrate **one after another**: ${R.relay === 'asc' ? 'in joining order' : 'in REVERSE order this time'}. Whoever goes first merges cleanly; every other teammate hits a conflict with what the previous teammate just pushed.\n\n**Team rule for conflicts:** the value already on \`develop\` (from the teammate before you) stays; you record your wish as a comment line directly below it: \`# <Your name> wanted: ${R.field}=<your value>\`. Sync commands unlock when it is your turn.`,
    tasks: (p) => [
      V(`conf${R.n}-update`, 'Update develop', 'Switch to `develop` and pull (this brings in the work your teammates already pushed).', [
        H('Switch, then pull.'),
        H('Run these:', 'git switch develop\ngit pull'),
      ], ({ r, ran }) => (onB(r, 'develop') && ran(/^git pull/) && isAncestor(r, r.remote['origin/develop'], headOf(r)) ? null : needBranchIfActed(r, 'develop'))),
      V(`conf${R.n}-merge`, 'Merge your branch', `Merge \`${br(p)}\` into \`develop\`. If a teammate went before you, git reports a **CONFLICT**. Otherwise it merges cleanly: you are first!`, [
        H('Stand on develop, then merge.'),
        H('Run this:', `git merge ${br(p)}`),
      ], ({ r, ran }) => { const i = info(r, p); return i && (i.phase === 'open' ? r.state.conflicts.includes(SETTINGS) : ran(/^git merge/)) ? null : needBranchIfActed(r, 'develop'); }),
      V(`conf${R.n}-resolve`, 'Resolve the conflict', (c) => {
        const i = info(c.r, p);
        if (i && i.phase === 'open') return `Open \`${SETTINGS}\`, remove the markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and make the file **exactly**:${fence(expectedFrom(i.ours, R, p))}Then save it.`;
        return `Open \`${SETTINGS}\`. If git reported a conflict, fix it following the team rule. No conflict this time (you are first)? Nothing to edit.`;
      }, [
        H('`<<<<<<< HEAD` ... `=======` is what is already on develop (your teammates). `=======` ... `>>>>>>>` is your branch. Keep your teammate\'s line, add your comment line below it, delete the 3 marker lines. The editor has buttons to help.'),
        H('Open it:', `edit ${SETTINGS}`),
      ], ({ r }) => { const i = info(r, p); return i ? resIssue(i, p) : ''; }, { why: 'Git never edits the decision for you. A human must choose, and usually must ask the teammate!' }),
      V(`conf${R.n}-add`, 'Mark it resolved', 'Stage the file to tell git the conflict is fixed.', [H('Run this:', `git add ${SETTINGS}`)], ({ r }) => {
        const i = info(r, p);
        if (!i) return '';
        if (i.phase === 'open') { if (r.state.conflicts.length) return ''; return sameText(r.index[SETTINGS], expectedFrom(i.ours, R, p)) ? null : `You staged a file that does not match the required content. It must be exactly:${fence(expectedFrom(i.ours, R, p))}Fix the file, save, ${q('git add ' + SETTINGS)} again.`; }
        return resIssue(i, p);
      }),
      V(`conf${R.n}-commit`, 'Finish the merge', 'Conclude the merge with a commit. Keep git\'s default message.', [
        H('The merge is still open; a commit finishes it. Without `-m` git prepares the default message.'),
        H('Run this:', 'git commit --no-edit'),
      ], ({ r }) => { const i = info(r, p); if (!i || i.phase !== 'done') return ''; return resIssue(i, p) ?? mergeMsgIssue(r, br(p), 'develop'); }),
      V(`conf${R.n}-push`, 'Push the result', 'Push `develop` so the next teammate can continue.', [H('Run this:', 'git push')], ({ r, o }) => (isAncestor(o, r.branches[br(p)], o.branches.develop) ? null : '')),
    ],
  };
}

function trunkRelayStage(R) {
  const br = (p) => `feat/${p.slug}-${R.suffix}`;
  const info = (r, p) => {
    if (r.state?.type === 'rebase') return { phase: 'open', ours: fileAt(r, headOf(r), SETTINGS), result: r.work[SETTINGS] };
    if (!r.state && onB(r, br(p)) && isAncestor(r, r.remote['origin/main'], headOf(r))) {
      const tip = r.commits[headOf(r)];
      if (firstLine(tip.msg) !== relayMsg(R, p)) return null;
      return { phase: 'done', ours: fileAt(r, tip.parents[0], SETTINGS), result: tip.tree[SETTINGS] };
    }
    return null;
  };
  const resIssue = (i, p) => (sameText(i.result, expectedFrom(i.ours, R, p)) ? null : `The resolved ${q(SETTINGS)} must be exactly:${fence(expectedFrom(i.ours, R, p))}`);
  return {
    id: `conflict-${R.n}`,
    relay: R.relay,
    title: `Rebase relay ${R.n}/2`,
    intro: `**Teamwork time.** Everybody changed the same line, so you land your changes **one after another**: ${R.relay === 'asc' ? 'in joining order' : 'in REVERSE order this time'}. Whoever goes first rebases cleanly; every other teammate's rebase **stops with a conflict** against the previous teammate's change.\n\n**Team rule for conflicts:** the value already on \`main\` stays; you record your wish as a comment directly below it: \`# <Your name> wanted: ${R.field}=<your value>\`. Sync commands unlock when it is your turn.`,
    tasks: (p) => [
      V(`rc${R.n}-rebase`, 'Fetch and rebase', 'Fetch, then rebase your branch onto `origin/main`. If a teammate went first, git stops with a conflict.', [
        H('You must be on your branch.'),
        H('Run these:', 'git fetch\ngit rebase origin/main'),
      ], ({ r, ran }) => { const i = info(r, p); return i && (i.phase === 'open' ? r.state.conflicts.includes(SETTINGS) : ran(/^git rebase/)) ? null : needBranchIfActed(r, br(p)); }),
      V(`rc${R.n}-resolve`, 'Resolve the conflict', (c) => {
        const i = info(c.r, p);
        if (i && i.phase === 'open') return `Open \`${SETTINGS}\`, remove the markers and make the file **exactly**:${fence(expectedFrom(i.ours, R, p))}Then save it.`;
        return `Open \`${SETTINGS}\`. If the rebase stopped with a conflict, fix it following the team rule. No conflict (you are first)? Nothing to edit.`;
      }, [
        H('`<<<<<<< HEAD` is main (your teammates). The other half is your commit. Keep the teammate\'s line, add your comment below it, delete the 3 marker lines.'),
        H('Open it:', `edit ${SETTINGS}`),
      ], ({ r }) => { const i = info(r, p); return i ? resIssue(i, p) : ''; }),
      V(`rc${R.n}-add`, 'Mark it resolved', 'Stage the file.', [H('Run this:', `git add ${SETTINGS}`)], ({ r }) => {
        const i = info(r, p);
        if (!i) return '';
        if (i.phase === 'open') { if (r.state.conflicts.length) return ''; return sameText(r.index[SETTINGS], expectedFrom(i.ours, R, p)) ? null : `You staged a file that does not match the required content. It must be exactly:${fence(expectedFrom(i.ours, R, p))}`; }
        return resIssue(i, p);
      }),
      V(`rc${R.n}-continue`, 'Continue the rebase', 'Carry on replaying your commit. This is **not** `git commit`!', [H('Run this:', 'git rebase --continue')], ({ r }) => { const i = info(r, p); return i && i.phase === 'done' ? resIssue(i, p) : ''; }),
      V(`rc${R.n}-land`, 'Land it', 'Switch to `main`, pull, merge your branch, push, so the next teammate can go.', [H('Run these:', `git switch main\ngit pull\ngit merge ${br(p)}\ngit push`)], ({ r, o }) => (isAncestor(o, r.branches[br(p)], o.branches.main) ? mergeMsgIssue(r, br(p), 'main') : '')),
    ],
  };
}

/* ================================================================ GIT FLOW */

function gitflowStages() {
  const feat = (p) => `feature/${p.slug}-profile`;
  const hot = (p) => `hotfix/${p.slug}`;
  const rel = (p) => `release/${p.slug}-1.0.0`;
  const tagHot = (p) => `v1.0.${p.n}`;
  const tagRel = (p) => `${p.slug}-v1.0.0`;
  const file = (p) => `features/${p.slug}.txt`;
  const notes = (p) => `players/${p.slug}/notes.txt`;
  const bug = (p) => `bugs/${p.slug}.txt`;
  const ver = (p) => `modules/${p.slug}/VERSION`;
  const featMsg = (p) => `feat: add ${p.slug} profile page`;
  const hotMsg = (p) => `fix: checkout crash for ${p.slug}`;
  const BUMP = 'chore: bump version to 1.0.0';

  return [
    READ_ONLY_STAGE('Git Flow'),

    {
      id: 'feature',
      title: 'Build a feature',
      intro: 'In Git Flow, **`develop`** is where features come together and **`main`** only holds released code. You never work directly on either: every task gets its own `feature/*` branch, cut from `develop`.',
      tasks: (p) => [
        V('switch-develop', 'Move to develop', 'Switch to the `develop` branch (it exists on origin, git will create a local copy that tracks it).', [
          H('`git switch <branch>` changes branch. If the branch only exists on origin, git sets up tracking for you.'),
          H('Run this:', 'git switch develop'),
        ], ({ r }) => (onB(r, 'develop') && r.upstream.develop === 'origin/develop' ? null : ''), { why: 'Always start new work from the integration branch.' }),
        V('new-feature', 'Create your feature branch', `Create and switch to a new branch named exactly \`${feat(p)}\`.`, [
          H('`git switch -c <name>` creates a branch from where you are right now and moves to it.'),
          H('Run this:', `git switch -c ${feat(p)}`),
        ], ({ r }) => (onB(r, feat(p)) && isAncestor(r, r.branches.develop, headOf(r)) ? null : r.head?.branch && !['develop', 'main'].includes(r.head.branch) && r.head.branch !== feat(p) ? `The branch must be named exactly ${q(feat(p))}. Rename with ${q('git branch -m ' + feat(p))}.` : ''), { why: 'Naming convention feature/<who>-<what> keeps the branch list readable.' }),
        V('create-file', 'Write the feature', (c) => `Create the file \`${file(p)}\` (use **＋ New file** in the Files tab or run \`edit ${file(p)}\`) with exactly this content:${fence(featureText(p))}`, [
          H('Open the editor with the command below, paste the text, save.'),
          H('Open it:', `edit ${file(p)}`),
        ], ({ r }) => needBranch(r, feat(p)) || fileIssue(r.work[file(p)], featureText(p), file(p))),
        V('stage', 'Stage the file', 'Put the new file into the **staging area** so it will be part of the next commit.', [
          H('`git add <file>` stages a file. Git only commits what is staged.'),
          H('Run this:', `git add ${file(p)}`),
        ], ({ r }) => (sameText(r.index[file(p)], featureText(p)) ? null : r.index[file(p)] !== undefined ? `The staged version of ${q(file(p))} is not the required content. Fix the file, then ${q('git add ' + file(p))} again.` : ''), { why: 'Staging lets you build clean, focused commits.' }),
        V('commit', 'Commit your work', `Commit with exactly this message: \`${featMsg(p)}\``, [
          H('`git commit -m "message"` saves the staged snapshot. The message format is `type: what` (here a feat).'),
          H('Run this:', `git commit -m "${featMsg(p)}"`),
        ], ({ r }) => branchIssue(r, feat(p), r.branches.develop, [{ msg: featMsg(p), files: [file(p)], contents: { [file(p)]: featureText(p) } }])),
        V('push-feature', 'Publish your branch', 'Push the branch to origin and make it track the remote one.', [
          H('A new branch does not exist on origin yet. `-u` links your local branch to it so later `git push` / `git pull` just work.'),
          H('Run this:', `git push -u origin ${feat(p)}`),
        ], ({ r, o }) => {
          if (o.branches[feat(p)] && o.branches[feat(p)] !== r.branches[feat(p)]) return `origin has a different version of ${q(feat(p))} than your local branch. After fixing a commit, update origin with ${q('git push --force-with-lease')}.`;
          return o.branches[feat(p)] && r.upstream[feat(p)] === 'origin/' + feat(p) ? null : '';
        }, { why: 'Pushing early = backup + teammates can see it.' }),
      ],
    },

    {
      id: 'integrate',
      title: 'Integrate into develop',
      intro: 'Your feature is finished. While you were working, a teammate pushed to `develop` too, so your copy of `develop` is **behind**. You must update it before merging.',
      setup: (o, meta) => {
        meta.samDev = originCommit(o, 'develop', { 'docs/CONTRIBUTING.md': '# Contributing\n\nSmall commits. Clear messages.\n' }, 'docs: add contributing guide', SAM);
        return ['Sam pushed "docs: add contributing guide" to origin/develop'];
      },
      tasks: (p) => [
        V('update-develop', 'Update develop', 'Switch back to `develop` and bring in the new commit from origin.', [
          H('Two steps: `git switch develop`, then `git pull` (= fetch + merge the remote changes).'),
          H('Run these:', 'git switch develop\ngit pull'),
        ], ({ r, meta }) => (onB(r, 'develop') && isAncestor(r, meta.samDev, headOf(r)) ? null : needBranchIfActed(r, 'develop')), { why: '`git pull` downloads new commits and merges them into your current branch.' }),
        V('merge-feature', 'Merge your feature', `Merge \`${feat(p)}\` into \`develop\` and keep git's default merge message.`, [
          H('Stand on the branch that should *receive* the work, then `git merge <other-branch>`.'),
          H('Run this:', `git merge ${feat(p)}`),
        ], ({ r }) => (isAncestor(r, r.branches[feat(p)], r.branches.develop) && !r.state ? mergeMsgIssue(r, feat(p), 'develop') : needBranchIfActed(r, 'develop')), { why: 'Because develop moved on, git creates a merge commit joining the two lines of history.' }),
        V('push-develop', 'Share it', 'Push `develop` to origin.', [
          H('Plain `git push` pushes the current branch to the branch it tracks. If another teammate pushed first it is **rejected**: run `git pull`, then push again.'),
          H('Run this:', 'git push'),
        ], ({ r, o }) => (isAncestor(o, r.branches[feat(p)], o.branches.develop) ? null : ''), { why: 'A rejected push is normal. It protects you from overwriting teammates.' }),
        V('delete-local', 'Delete the local branch', 'The feature is merged, so remove the local branch.', [
          H('`git branch -d <name>` only deletes if the branch is fully merged. A safe delete.'),
          H('Run this:', `git branch -d ${feat(p)}`),
        ], ({ r }) => (!r.branches[feat(p)] ? null : '')),
        V('delete-remote', 'Delete the remote branch', 'Remove the branch from origin too.', [
          H('You can delete a remote branch with push.'),
          H('Run this:', `git push origin --delete ${feat(p)}`),
        ], ({ o }) => (!o.branches[feat(p)] ? null : ''), { why: 'Short-lived branches should disappear after merging.' }),
      ],
    },

    ...ROUNDS.flatMap((R) => [relayPrepStage('gitflow', R), gitflowRelayStage(R)]),

    {
      id: 'hotfix',
      title: 'Hotfix in production',
      intro: 'A bug was found in **production** (`main`). While you have half-finished work lying around! You will park your work with **`git stash`**, fix the bug on a **`hotfix/*`** branch cut from `main`, release it with a tag, and then **merge the fix back to `develop`** so it is not lost.',
      setup: (o, meta, players) => {
        const ch = {};
        for (const p of players) ch[bug(p)] = bugBroken(p);
        meta.bug = originCommit(o, 'main', ch, 'release: v1.0.0 (known bug reports attached)', SAM);
        return ['Production bug reports were added to origin/main'];
      },
      tasks: (p) => {
        const wipText = (r) => (fileAt(r, headOf(r), notes(p)) ?? '') + WIP_LINE + '\n';
        return [
          V('wip', 'Start some work', `You are on \`develop\`. Add this exact line to the end of \`${notes(p)}\` and **do not commit**: \`${WIP_LINE}\``, [
            H('Append a line to the file; then `git status` shows it as modified.'),
            H('Run this:', `echo "${WIP_LINE}" >> ${notes(p)}`),
          ], ({ r }) => (r.work[notes(p)] === undefined ? '' : sameText(r.work[notes(p)], wipText(r)) ? null : fileIssue(r.work[notes(p)], wipText(r), notes(p)))),
          V('stash', 'Park your work', 'You can\'t switch branches cleanly with unfinished changes. Put them on the **stash**.', [
            H('`git stash` shelves your uncommitted changes and gives you a clean folder again.'),
            H('Run this:', 'git stash'),
          ], ({ r }) => (r.stash.length > 0 && sameText(r.work[notes(p)], fileAt(r, headOf(r), notes(p))) ? null : ''), { why: 'Stash = a drawer for half-done work, so you can react to emergencies.' }),
          V('pull-main', 'Get production', 'Switch to `main` and pull the latest.', [
            H('Hotfixes start from production code.'),
            H('Run these:', 'git switch main\ngit pull'),
          ], ({ r, meta }) => (onB(r, 'main') && isAncestor(r, meta.bug, headOf(r)) ? null : needBranchIfActed(r, 'main'))),
          V('hotfix-branch', 'Create the hotfix branch', `Create \`${hot(p)}\` from \`main\`.`, [
            H('Same as a feature branch, but the base is main.'),
            H('Run this:', `git switch -c ${hot(p)}`),
          ], ({ r }) => (onB(r, hot(p)) && isAncestor(r, r.branches.main, headOf(r)) ? null : r.head?.branch && !['main', 'develop'].includes(r.head.branch) && r.head.branch !== hot(p) ? `The branch must be named exactly ${q(hot(p))}.` : '')),
          V('hotfix-edit', 'Fix the bug', `Open \`${bug(p)}\` and change \`status=broken\` to \`status=fixed\`. The file must be exactly:${fence(bugFixed(p))}`, [
            H('Open the file in the editor and save.'),
            H('Open it:', `edit ${bug(p)}`),
          ], ({ r }) => needBranch(r, hot(p)) || fileIssue(r.work[bug(p)], bugFixed(p), bug(p))),
          V('hotfix-commit', 'Commit the fix', `Commit with exactly: \`${hotMsg(p)}\``, [
            H('You can stage and commit in one go for tracked files.'),
            H('Run this:', `git commit -am "${hotMsg(p)}"`),
          ], ({ r }) => branchIssue(r, hot(p), r.branches.main, [{ msg: hotMsg(p), files: [bug(p)], contents: { [bug(p)]: bugFixed(p) } }])),
          V('hotfix-merge', 'Merge into main', `Switch to \`main\` and merge \`${hot(p)}\`. Keep git's default merge message.`, [
            H('Switch to the branch that should receive the fix, then merge.'),
            H('Run these:', `git switch main\ngit merge ${hot(p)}`),
          ], ({ r }) => (isAncestor(r, r.branches[hot(p)], r.branches.main) && !r.state ? mergeMsgIssue(r, hot(p), 'main') : '')),
          V('hotfix-tag', 'Tag the release', `Create the **annotated tag** \`${tagHot(p)}\` with the exact message \`Hotfix ${tagHot(p)}\`.`, [
            H('Tags mark releases. `-a` makes an annotated tag, `-m` its message.'),
            H('Run this:', `git tag -a ${tagHot(p)} -m "Hotfix ${tagHot(p)}"`),
          ], ({ r }) => tagIssue(r, tagHot(p), `Hotfix ${tagHot(p)}`, r.branches[hot(p)]), { why: '(In real life one person tags. Here each of you gets a unique tag number.)' }),
          V('hotfix-push', 'Ship it', `Push \`main\` **and** your tag \`${tagHot(p)}\` to origin.`, [
            H('Tags are not pushed by default. Push the branch and the tag name (rejected? pull first).'),
            H('Run this:', `git push origin main ${tagHot(p)}`),
          ], ({ r, o }) => (isAncestor(o, r.branches[hot(p)], o.branches.main) && o.tags[tagHot(p)] ? null : '')),
          V('back-merge', 'Merge the fix back to develop', 'Switch to `develop`, pull, and merge `main` into it so develop also has the fix.', [
            H('Git Flow rule: a hotfix must land on **both** main and develop.'),
            H('Run these:', 'git switch develop\ngit pull\ngit merge main'),
          ], ({ r }) => (isAncestor(r, r.branches[hot(p)], r.branches.develop) && !r.state && onB(r, 'develop') ? null : '')),
          V('back-push', 'Push develop', 'Push `develop` (pull first if rejected).', [H('Run this:', 'git push')], ({ r, o }) => (isAncestor(o, r.branches[hot(p)], o.branches.develop) ? null : '')),
          V('stash-pop', 'Get your work back', 'Restore your parked work from the stash. Your note line must be back in the file.', [
            H('`git stash pop` re-applies it and drops the entry.'),
            H('Run this:', 'git stash pop'),
          ], ({ r }) => (r.stash.length === 0 && sameText(r.work[notes(p)], wipText(r)) ? null : '')),
        ];
      },
    },

    {
      id: 'release',
      title: 'Cut a release',
      intro: 'Time to release. In Git Flow a release has its own branch **`release/*`** cut from `develop` (only version bumps and bug fixes go in), then it is merged into **`main`** with a merge commit, **tagged**, and merged back into `develop`.',
      setup: (o, meta, players) => {
        const ch = {};
        for (const p of players) ch[ver(p)] = '0.9.0\n';
        meta.modules = originCommit(o, 'develop', ch, 'chore: add module version files', SAM);
        return ['Sam pushed "chore: add module version files" to origin/develop'];
      },
      tasks: (p) => [
        V('rel-update', 'Update develop', 'Be on `develop` with the latest changes.', [H('Run these:', 'git switch develop\ngit pull')], ({ r, meta }) => (onB(r, 'develop') && isAncestor(r, meta.modules, headOf(r)) ? null : needBranchIfActed(r, 'develop'))),
        V('rel-branch', 'Open the release branch', `Create \`${rel(p)}\` from \`develop\`.`, [H('Run this:', `git switch -c ${rel(p)}`)], ({ r }) => (onB(r, rel(p)) && isAncestor(r, r.branches.develop, headOf(r)) ? null : r.head?.branch && !['main', 'develop'].includes(r.head.branch) && r.head.branch !== rel(p) ? `The branch must be named exactly ${q(rel(p))}.` : '')),
        V('rel-bump', 'Bump the version', `Edit \`${ver(p)}\` so it contains exactly:${fence('1.0.0\n')}`, [H('Edit then save:', `edit ${ver(p)}`)], ({ r }) => needBranch(r, rel(p)) || fileIssue(r.work[ver(p)], '1.0.0\n', ver(p))),
        V('rel-commit', 'Commit the bump', `Stage **only** \`${ver(p)}\` and commit with exactly: \`${BUMP}\`. Careful: you still have unfinished changes in your notes file, so do **not** use \`git commit -a\`: it would sweep them into the release!`, [
          H('`git add <file>` stages one file; then a plain `git commit -m`. A release commit must contain only the release change.'),
          H('Run these:', `git add ${ver(p)}\ngit commit -m "${BUMP}"`),
        ], ({ r }) => branchIssue(r, rel(p), r.branches.develop, [{ msg: BUMP, files: [ver(p)], contents: { [ver(p)]: '1.0.0\n' } }])),
        V('rel-main', 'Merge into main (no fast-forward)', `Switch to \`main\`, pull, and merge \`${rel(p)}\` with \`--no-ff\` so the release shows up as an explicit merge commit (keep the default message).`, [
          H('`--no-ff` forces a merge commit even if a fast-forward is possible.'),
          H('Run these:', `git switch main\ngit pull\ngit merge --no-ff ${rel(p)}`),
        ], ({ r }) => {
          const t = r.branches[rel(p)];
          if (!commitWith(r, (c) => c.parents.length === 2 && c.parents[1] === t && isAncestor(r, c.id, r.branches.main))) return isAncestor(r, t, r.branches.main) ? `The release was fast-forwarded, there is no merge commit. Undo with ${q('git reset --hard HEAD~1')} (on main, before pushing) and merge again with ${q('--no-ff')}.` : needBranchIfActed(r, 'main');
          return mergeMsgIssue(r, rel(p), 'main');
        }),
        V('rel-tag', 'Tag the release', `Create the annotated tag \`${tagRel(p)}\` with the exact message \`Release 1.0.0\`.`, [H('Run this:', `git tag -a ${tagRel(p)} -m "Release 1.0.0"`)], ({ r }) => tagIssue(r, tagRel(p), 'Release 1.0.0', r.branches[rel(p)])),
        V('rel-push', 'Push main and the tag', 'Publish the release.', [H('Run this:', `git push origin main ${tagRel(p)}`)], ({ r, o }) => (isAncestor(o, r.branches[rel(p)], o.branches.main) && o.tags[tagRel(p)] ? null : '')),
        V('rel-back', 'Merge back into develop', 'Merge the release branch into `develop` and push it.', [H('Run these:', `git switch develop\ngit pull\ngit merge ${rel(p)}\ngit push`)], ({ r, o }) => (isAncestor(o, r.branches[rel(p)], o.branches.develop) ? null : '')),
        V('rel-clean', 'Clean up', `Delete the local branch \`${rel(p)}\`.`, [H('Run this:', `git branch -d ${rel(p)}`)], ({ r }) => (!r.branches[rel(p)] ? null : '')),
      ],
    },
  ];
}

/* ============================================================ TRUNK BASED */

function trunkStages() {
  const br = (p) => `feat/${p.slug}-greeting`;
  const file = (p) => `features/${p.slug}.txt`;
  const notes = (p) => `players/${p.slug}/notes.txt`;
  const svc = (p) => `services/${p.slug}.txt`;
  const tag = (p) => `${p.slug}-v1.1.0`;
  const m1 = (p) => `feat: add greeting for ${p.slug}`;
  const m2 = 'feat: improve greeting';
  const v1 = 'greeting v1\n';
  const v2 = 'greeting v1\ngreeting v2\n';

  return [
    READ_ONLY_STAGE('Trunk-based'),

    {
      id: 'short-branch',
      title: 'A short-lived branch',
      intro: 'In trunk-based development there is **one** long-lived branch: `main` (the trunk). Work happens on tiny branches that live for hours, not weeks, and every commit is small. Unfinished features hide behind flags so `main` is always releasable.',
      tasks: (p) => [
        V('tb-branch', 'Branch from main', `Create the branch \`${br(p)}\`.`, [
          H('`git switch -c <name>` creates and enters a branch.'),
          H('Run this:', `git switch -c ${br(p)}`),
        ], ({ r }) => (onB(r, br(p)) && isAncestor(r, r.branches.main, headOf(r)) ? null : r.head?.branch && r.head.branch !== 'main' && r.head.branch !== br(p) ? `The branch must be named exactly ${q(br(p))}.` : '')),
        V('tb-file', 'Write the feature', `Create \`${file(p)}\` containing exactly one line: \`greeting v1\``, [
          H('The shell can do it in one command.'),
          H('Run this:', `echo "greeting v1" > ${file(p)}`),
        ], ({ r }) => needBranch(r, br(p)) || fileIssue(r.work[file(p)], v1, file(p))),
        V('tb-commit1', 'Commit #1', `Stage the file and commit with exactly: \`${m1(p)}\``, [
          H('Two commands: `git add`, then `git commit -m`.'),
          H('Run these:', `git add ${file(p)}\ngit commit -m "${m1(p)}"`),
        ], ({ r }) => branchIssue(r, br(p), r.branches.main, [{ msg: m1(p), files: [file(p)], contents: { [file(p)]: v1 } }])),
        V('tb-commit2', 'Commit #2 (small steps)', `Append the line \`greeting v2\` to the file (so it has 2 lines) and commit it as a **separate** commit with exactly: \`${m2}\``, [
          H('`echo "text" >> file` appends a line. Small commits are easier to review and to revert.'),
          H('Run these:', `echo "greeting v2" >> ${file(p)}\ngit commit -am "${m2}"`),
        ], ({ r }) => branchIssue(r, br(p), r.branches.main, [{ msg: m1(p), files: [file(p)], contents: { [file(p)]: v1 } }, { msg: m2, files: [file(p)], contents: { [file(p)]: v2 } }])),
        V('tb-push', 'Push the branch', 'Publish the branch.', [H('Run this:', `git push -u origin ${br(p)}`)], ({ r, o }) => (o.branches[br(p)] === r.branches[br(p)] && r.upstream[br(p)] === 'origin/' + br(p) ? null : '')),
      ],
    },

    {
      id: 'rebase',
      title: 'Stay up to date with rebase',
      intro: 'While you worked, `main` moved. Trunk-based teams keep history **linear**: instead of merging main into the branch they **rebase**, which replays your commits on top of the latest main. Then they land the change quickly.',
      setup: (o, meta) => {
        meta.sam = originCommit(o, 'main', { 'docs/CONTRIBUTING.md': '# Contributing\n\nSmall commits. Merge to main daily.\n' }, 'docs: add contributing guide', SAM);
        return ['Sam pushed "docs: add contributing guide" to origin/main'];
      },
      tasks: (p) => [
        V('tb-fetch', 'Fetch', 'Download the new commits from origin **without changing your files**.', [
          H('`git fetch` updates `origin/main` but leaves your branches alone, so it is always safe.'),
          H('Run this:', 'git fetch'),
        ], ({ r, meta }) => (isAncestor(r, meta.sam, r.remote['origin/main']) ? null : '')),
        V('tb-rebase', 'Rebase onto origin/main', 'Replay your branch on top of the latest `origin/main`. Your 2 commits must stay unchanged.', [
          H('You must be on your branch. `git rebase <base>`'),
          H('Run this:', 'git rebase origin/main'),
        ], ({ r, meta }) => (onB(r, br(p)) && !r.state && isAncestor(r, meta.sam, headOf(r)) ? branchIssue(r, br(p), r.remote['origin/main'], [{ msg: m1(p), files: [file(p)], contents: { [file(p)]: v1 } }, { msg: m2, files: [file(p)], contents: { [file(p)]: v2 } }]) : needBranchIfActed(r, br(p))), { why: 'Your commits get new ids, so origin\'s copy of your branch is now "different history".' }),
        V('tb-force', 'Update your remote branch safely', 'The remote copy has the old commits. Overwrite it, but with the **safe** force option, which refuses if someone else pushed there.', [
          H('A rebased branch needs a force push. `--force-with-lease` is the safe variant. Only ever do this on your own branch.'),
          H('Run this:', 'git push --force-with-lease'),
        ], ({ r, o }) => (o.branches[br(p)] === r.branches[br(p)] && isAncestor(r, r.remote['origin/main'], o.branches[br(p)]) ? null : '')),
        V('tb-land', 'Land it on main', 'Switch to `main`, pull, merge your branch, and push `main`. (If the push is rejected: pull and try again.)', [
          H('The branch is directly on top of main, so the merge is a clean fast-forward.'),
          H('Run these:', `git switch main\ngit pull\ngit merge ${br(p)}\ngit push`),
        ], ({ r, o }) => (isAncestor(o, r.branches[br(p)], o.branches.main) ? mergeMsgIssue(r, br(p), 'main') : '')),
        V('tb-clean', 'Clean up', 'Delete your branch locally **and** on origin.', [
          H('Two deletes: local `git branch -d`, remote `git push origin --delete`.'),
          H('Run these:', `git branch -d ${br(p)}\ngit push origin --delete ${br(p)}`),
        ], ({ r, o }) => (!r.branches[br(p)] && !o.branches[br(p)] ? null : '')),
      ],
    },

    ...ROUNDS.flatMap((R) => [relayPrepStage('trunk', R), trunkRelayStage(R)]),

    {
      id: 'revert',
      title: 'Bad commit on main: revert it',
      intro: 'Someone merged a change that **broke your service** on `main`. In trunk-based development the fastest fix is usually to **revert** the bad commit (a new commit that undoes it) instead of rewriting history. And you have half-finished work, so stash it first.',
      setup: (o, meta, players) => {
        const ch = {};
        for (const p of players) ch[svc(p)] = 'status=ok\n';
        originCommit(o, 'main', ch, 'ci: add service configs', SAM);
        meta.bad = {};
        for (const p of players) meta.bad[p.slug] = originCommit(o, 'main', { [svc(p)]: 'status=broken\n' }, `perf: speed up ${p.slug} service`, SAM);
        return ['Sam merged risky commits to origin/main. Some services are now broken!'];
      },
      tasks: (p) => {
        const wipText = (r) => (fileAt(r, headOf(r), notes(p)) ?? '') + WIP_LINE + '\n';
        const revMsg = `Revert "perf: speed up ${p.slug} service"`;
        return [
          V('rv-wip', 'Start some work', `Add this exact line to the end of \`${notes(p)}\` and do **not** commit: \`${WIP_LINE}\``, [H('Run this:', `echo "${WIP_LINE}" >> ${notes(p)}`)], ({ r }) => (r.work[notes(p)] === undefined ? '' : sameText(r.work[notes(p)], wipText(r)) ? null : fileIssue(r.work[notes(p)], wipText(r), notes(p)))),
          V('rv-stash', 'Stash it', 'Park your work.', [H('Run this:', 'git stash')], ({ r }) => (r.stash.length > 0 && sameText(r.work[notes(p)], fileAt(r, headOf(r), notes(p))) ? null : '')),
          V('rv-pull', 'Update main', 'Switch to `main` and pull.', [H('Run these:', 'git switch main\ngit pull')], ({ r, meta }) => (onB(r, 'main') && isAncestor(r, meta.bad[p.slug], headOf(r)) ? null : needBranchIfActed(r, 'main'))),
          V('rv-revert', 'Revert the bad commit', `Find the commit called \`perf: speed up ${p.slug} service\` in the log and revert it. Keep git's default message (\`${revMsg}\`).`, [
            H('`git log --oneline` shows the short id (7 characters). `git revert <id>` creates an *undo* commit.'),
            H('Run these:', 'git log --oneline\ngit revert <id>'),
          ], ({ r }) => {
            const c = Object.values(r.commits).find((x) => firstLine(x.msg).startsWith('Revert "') && isAncestor(r, x.id, r.branches.main) && x.msg.includes(`perf: speed up ${p.slug} service`));
            if (!c) {
              const wrong = Object.values(r.commits).find((x) => firstLine(x.msg).startsWith('Revert "') && isAncestor(r, x.id, r.branches.main) && !x.msg.includes(`perf: speed up ${p.slug} service`) && x.author.name === r.user.name);
              return wrong ? `You reverted the wrong commit (${q(firstLine(wrong.msg))}). Undo it with ${q('git reset --hard HEAD~1')} and revert the commit called ${q('perf: speed up ' + p.slug + ' service')}.` : '';
            }
            if (firstLine(c.msg) !== revMsg) return `The revert message must be git's default ${q(revMsg)}.`;
            const ch = changedPaths(r, c);
            return ch.length === 1 && ch[0] === svc(p) && sameText(c.tree[svc(p)], 'status=ok\n') ? null : `The revert must only change ${q(svc(p))} back to ${q('status=ok')}.`;
          }, { why: 'Revert keeps history honest: nothing is erased, the fix is just another commit.' }),
          V('rv-push', 'Push the fix', 'Push `main`. If it is rejected, use `git pull --rebase` and push again.', [
            H('Everybody is pushing to main right now. `git pull --rebase` replays your revert on top of theirs, keeping history linear.'),
            H('Run this:', 'git push'),
          ], ({ o }) => (sameText(fileAt(o, o.branches.main, svc(p)), 'status=ok\n') ? null : '')),
          V('rv-pop', 'Get your work back', 'Restore your stash. Your note line must be back in the file.', [H('Run this:', 'git stash pop')], ({ r }) => (r.stash.length === 0 && sameText(r.work[notes(p)], wipText(r)) ? null : '')),
        ];
      },
    },

    {
      id: 'release',
      title: 'Release with a tag',
      intro: 'Trunk-based teams do not keep release branches for simple releases. Every commit on `main` is releasable; a release is just a **tag** on a commit of main.',
      tasks: (p) => [
        V('rl-update', 'Update main', 'Be on `main`, up to date with origin.', [H('Run these:', 'git switch main\ngit pull')], ({ r }) => (onB(r, 'main') && isAncestor(r, r.remote['origin/main'], r.branches.main) ? null : needBranchIfActed(r, 'main'))),
        V('rl-tag', 'Tag the release', `Create the annotated tag \`${tag(p)}\` with the exact message \`Release 1.1.0\` on the current commit.`, [H('Run this:', `git tag -a ${tag(p)} -m "Release 1.1.0"`)], ({ r }) => {
          const t = r.tags[tag(p)];
          const e = tagIssue(r, tag(p), 'Release 1.1.0', null);
          if (e !== null) return e;
          return sameText(fileAt(r, t.id, svc(p)), 'status=ok\n') ? null : `The tag must point at a commit where your service is fixed. Update main (${q('git pull')}), delete the tag and tag again.`;
        }),
        V('rl-push', 'Publish the tag', 'Push only the tag to origin.', [H('Run this:', `git push origin ${tag(p)}`)], ({ o }) => (o.tags[tag(p)] ? null : '')),
        V('rl-list', 'List the tags', 'Show every tag that exists. You should see everyone\'s!', [H('First fetch everyone else\'s tags, then list them:', 'git fetch\ngit tag')], ({ ran }) => (ran(/^git tag\s*$/) ? null : '')),
      ],
    },
  ];
}

export function buildScenario(flowId) {
  return flowId === 'trunk' ? trunkStages() : gitflowStages();
}

export const CHEATSHEET = {
  gitflow: [
    ['git clone <url>', 'copy the repo'],
    ['git switch -c feature/x', 'new branch'],
    ['git add . && git commit -m ""', 'save work'],
    ['git push -u origin <branch>', 'publish a new branch'],
    ['git pull', 'fetch + merge'],
    ['git merge <branch>', 'combine work'],
    ['git add <file> → git commit', 'finish a conflict'],
    ['git stash / git stash pop', 'park work'],
    ['git tag -a v1 -m ""', 'mark a release'],
    ['git merge --no-ff release/x', 'explicit release merge'],
  ],
  trunk: [
    ['git switch -c feat/x', 'short-lived branch'],
    ['git commit -am ""', 'small commits'],
    ['git fetch', 'look, don\'t touch'],
    ['git rebase origin/main', 'linear history'],
    ['git push --force-with-lease', 'safe force on own branch'],
    ['git rebase --continue', 'after resolving'],
    ['git revert <id>', 'undo a bad commit safely'],
    ['git stash / git stash pop', 'park work'],
    ['git tag -a v1 -m ""', 'release = tag'],
  ],
};
