// Scenario definitions. The *server* decides what every player has to do.
// Every player gets the same tasks (parameterised with their own names / files),
// and tasks are verified by looking at repo state, not at the exact command typed.
import { Origin, originCommit, originBranch, isAncestor, treeOf, hasMarkers } from './gitsim.js';

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

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'dev';

export function makePlayerVars(name, index, taken) {
  let slug = slugify(name);
  while (taken.has(slug)) slug += index + 1;
  taken.add(slug);
  return { slug, n: index + 1, theme: THEMES[index % THEMES.length] };
}

/* ------------------------------------------------------------------ helpers */

const T = (id, title, goal, hints, check, extra = {}) => ({ id, title, goal, hints, check, ...extra });
const H = (text, cmd) => ({ text, cmd });
const onB = (r, n) => r.head?.branch === n;
const headOf = (r) => (r.head?.branch ? r.branches[r.head.branch] : r.head?.detached);
const inRepo = (r, id, tip) => isAncestor(r, id, tip);
const fileAt = (store, id, p) => treeOf(store, id)[p];
const merged = (r, p, f, base) => isAncestor(r, r.branches[f], r.branches[base]) && !r.state;
const commitWith = (r, pred) => Object.values(r.commits).some(pred);

export function seedOrigin(players, flowId) {
  const o = new Origin(URL);
  originCommit(o, 'main', {
    'README.md': '# Shop\n\nA tiny online shop. Welcome to the team!\n',
    'CHANGELOG.md': '# Changelog\n\n- 1.0.0 first release\n',
    'config.txt': 'app_name=Shop\nversion=1.0.0\n',
  }, 'Initial commit', SAM);
  const ws = {};
  for (const p of players) {
    ws[`players/${p.slug}/profile.txt`] = `name=${p.name}\ntheme=light\n`;
    ws[`players/${p.slug}/notes.txt`] = `# notes of ${p.name}\n- nothing yet\n`;
  }
  originCommit(o, 'main', ws, 'Add player workspaces', SAM);
  if (flowId === 'gitflow') originBranch(o, 'develop', 'main');
  return o;
}

const READ_ONLY_STAGE = (flowName) => ({
  id: 'start',
  title: 'Get the code',
  intro: `Welcome to the team! This room runs the **${flowName}** workflow. Everything you do happens in your own private copy of the repository; \`origin\` is the shared server copy that your teammates push to as well.`,
  tasks: (p, ctx) => [
    T('clone', 'Clone the team repository', `Download the team repo into your machine: \`${URL}\``, [
      H('`git clone <url>` copies the whole repository (all branches and history) and checks out the default branch.'),
      H('Run this:', `git clone ${URL}`),
    ], ({ r }) => r.cloned, { why: 'Cloning is always step one on a new project or a new laptop.' }),
    T('log', 'Look at the history', 'Print the history as one line per commit.', [
      H('`git log` shows commits, newest first. A flag makes it compact.'),
      H('Run this:', 'git log --oneline'),
    ], ({ ran }) => ran(/^git log\b/), { why: 'Reading history is how you find out what your teammates did.' }),
    T('branches', 'List all branches', 'Show your local branches **and** the ones that exist on origin.', [
      H('`git branch` lists local branches. One flag also includes remote-tracking branches (`remotes/origin/...`).'),
      H('Run this:', 'git branch -a'),
    ], ({ ran }) => ran(/^git branch\b.*(-a|-r|--all|--remotes)/), { why: 'Remote-tracking branches (origin/x) are your last known picture of the server.' }),
    T('status', 'Check the status', 'Ask git what state your working folder is in.', [
      H('Use the command that tells you which branch you are on and what changed.'),
      H('Run this:', 'git status'),
    ], ({ ran }) => ran(/^git status\b/), { why: 'Run `git status` all the time. It tells you what to do next.' }),
  ],
});

/* ================================================================ GIT FLOW */

function gitflowStages() {
  const feat = (p) => `feature/${p.slug}-profile`;
  const featTheme = (p) => `feature/${p.slug}-theme`;
  const hot = (p) => `hotfix/${p.slug}`;
  const rel = (p) => `release/${p.slug}-1.0.0`;
  const tagHot = (p) => `v1.0.${p.n}`;
  const tagRel = (p) => `${p.slug}-v1.0.0`;
  const file = (p) => `features/${p.slug}.txt`;
  const profile = (p) => `players/${p.slug}/profile.txt`;
  const notes = (p) => `players/${p.slug}/notes.txt`;
  const bug = (p) => `bugs/${p.slug}.txt`;
  const ver = (p) => `modules/${p.slug}/VERSION`;

  return [
    READ_ONLY_STAGE('Git Flow'),

    {
      id: 'feature',
      title: 'Build a feature',
      intro: 'In Git Flow, **`develop`** is where features come together and **`main`** only holds released code. You never work directly on either: every task gets its own `feature/*` branch, cut from `develop`.',
      tasks: (p) => [
        T('switch-develop', 'Move to develop', 'Switch to the `develop` branch (it exists on origin, git will create a local copy that tracks it).', [
          H('`git switch <branch>` changes branch. If the branch only exists on origin, git sets up tracking for you.'),
          H('Run this:', 'git switch develop'),
        ], ({ r }) => onB(r, 'develop') && r.upstream.develop === 'origin/develop', { why: 'Always start new work from the integration branch.' }),
        T('new-feature', 'Create your feature branch', `Create and switch to a new branch named \`${feat(p)}\`.`, [
          H('`git switch -c <name>` creates a branch from where you are right now and moves to it.'),
          H('Run this:', `git switch -c ${feat(p)}`),
        ], ({ r }) => onB(r, feat(p)) && isAncestor(r, r.branches.develop, headOf(r)), { why: 'Naming convention feature/<who>-<what> keeps the branch list readable.' }),
        T('create-file', 'Write the feature', `Create the file \`${file(p)}\` and put at least one line in it. Use the **editor panel** (＋ New file) or the terminal, e.g. \`echo "hello" > ${file(p)}\`.`, [
          H('Anything is fine. You can write with the shell: echo "text" > file.'),
          H('Run this:', `echo "feature by ${p.name}" > ${file(p)}`),
        ], ({ r, p }) => (r.work[file(p)] || '').trim().length > 0 && onB(r, feat(p))),
        T('stage', 'Stage the file', 'Put the new file into the **staging area** so it will be part of the next commit.', [
          H('`git add <file>` stages a file. Git only commits what is staged.'),
          H('Run this:', `git add ${file(p)}`),
        ], ({ r, p }) => r.index[file(p)] !== undefined && r.index[file(p)] === r.work[file(p)], { why: 'Staging lets you build clean, focused commits.' }),
        T('commit', 'Commit your work', 'Create a commit with a short, meaningful message.', [
          H('`git commit -m "message"` saves the staged snapshot. Write what and why, e.g. "Add profile page".'),
          H('Run this:', 'git commit -m "Add profile feature"'),
        ], ({ r, p }) => fileAt(r, r.branches[feat(p)], file(p)) !== undefined && r.branches[feat(p)] !== r.branches.develop),
        T('push-feature', 'Publish your branch', 'Push the branch to origin and make it track the remote one.', [
          H('A new branch does not exist on origin yet. `-u` links your local branch to it so later `git push` / `git pull` just work.'),
          H('Run this:', `git push -u origin ${feat(p)}`),
        ], ({ r, o, p }) => o.branches[feat(p)] && o.branches[feat(p)] === r.branches[feat(p)] && r.upstream[feat(p)] === 'origin/' + feat(p), { why: 'Pushing early = backup + teammates can see it.' }),
      ],
    },

    {
      id: 'integrate',
      title: 'Integrate into develop',
      intro: 'Your feature is finished. While you were working, a teammate pushed to `develop` too, so your copy of `develop` is **behind**. You must update it before merging.',
      setup: (o, meta) => {
        meta.samDev = originCommit(o, 'develop', { 'docs/CONTRIBUTING.md': '# Contributing\n\nSmall commits. Clear messages.\n' }, 'docs: add contributing guide', SAM);
        return [`Sam pushed "docs: add contributing guide" to origin/develop`];
      },
      tasks: (p, { meta }) => [
        T('update-develop', 'Update develop', 'Switch back to `develop` and bring in the new commit from origin.', [
          H('Two steps: `git switch develop`, then `git pull` (= fetch + merge the remote changes).'),
          H('Run these:', 'git switch develop\ngit pull'),
        ], ({ r, meta }) => onB(r, 'develop') && isAncestor(r, meta.samDev, headOf(r)), { why: '`git pull` downloads new commits and merges them into your current branch.' }),
        T('merge-feature', 'Merge your feature', `Merge \`${feat(p)}\` into \`develop\`.`, [
          H('Stand on the branch that should *receive* the work, then `git merge <other-branch>`.'),
          H('Run this:', `git merge ${feat(p)}`),
        ], ({ r }) => merged(r, p, feat(p), 'develop'), { why: 'Because develop moved on, git creates a merge commit joining the two lines of history.' }),
        T('push-develop', 'Share it', 'Push `develop` to origin.', [
          H('Plain `git push` pushes the current branch to the branch it tracks. If another teammate pushed first it is **rejected**: run `git pull`, then push again.'),
          H('Run this:', 'git push'),
        ], ({ r, o, p }) => isAncestor(o, r.branches[feat(p)], o.branches.develop), { why: 'A rejected push is normal. It protects you from overwriting teammates.' }),
        T('delete-local', 'Delete the local branch', 'The feature is merged, so remove the local branch.', [
          H('`git branch -d <name>` only deletes if the branch is fully merged. A safe delete.'),
          H('Run this:', `git branch -d ${feat(p)}`),
        ], ({ r }) => !r.branches[feat(p)]),
        T('delete-remote', 'Delete the remote branch', 'Remove the branch from origin too.', [
          H('You can delete a remote branch with push.'),
          H('Run this:', `git push origin --delete ${feat(p)}`),
        ], ({ o }) => !o.branches[feat(p)], { why: 'Short-lived branches should disappear after merging.' }),
      ],
    },

    {
      id: 'prepare-conflict',
      title: 'Prepare a change',
      intro: 'Next you will **change your own settings file**. Do this on a fresh feature branch cut from `develop`. Do **not** pull again after you commit. (A teammate is about to change the same line…)',
      tasks: (p) => [
        T('theme-branch', 'Branch for the theme change', `Create \`${featTheme(p)}\` from \`develop\`.`, [
          H('Make sure you are on `develop`, then create the branch.'),
          H('Run this:', `git switch -c ${featTheme(p)}`),
        ], ({ r }) => onB(r, featTheme(p)) && isAncestor(r, r.branches.develop, headOf(r))),
        T('theme-edit', 'Change your theme', `Open \`${profile(p)}\` in the editor and change the line \`theme=light\` to \`theme=${p.theme}\`.`, [
          H('Click the file in the Files tab (or type `edit <file>`), change the line and Save.'),
          H('Or from the shell:', `edit ${profile(p)}`),
        ], ({ r }) => new RegExp(`^theme=${p.theme}$`, 'm').test(r.work[profile(p)] || '')),
        T('theme-commit', 'Commit the change', 'Commit your edit. Tip: `-a` stages files git already tracks.', [
          H('`git commit -am "message"` stages modified tracked files and commits in one go (it does not add new files).'),
          H('Run this:', `git commit -am "Set my theme to ${p.theme}"`),
        ], ({ r }) => new RegExp(`^theme=${p.theme}$`, 'm').test(fileAt(r, r.branches[featTheme(p)], profile(p)) || '') && r.branches[featTheme(p)] !== r.branches.develop),
      ],
    },

    {
      id: 'conflict',
      title: 'Resolve a merge conflict',
      intro: 'Sam just pushed a commit to `develop` that changed the **same line** (`theme=`) in your profile file. Git cannot guess whose version is right, so it will stop and ask **you**. Conflicts are normal; the skill is staying calm and doing the steps in order.',
      setup: (o, meta, players) => {
        const ch = {};
        for (const p of players) ch[profile(p)] = `name=${p.name}\ntheme=dark\n`;
        meta.samTheme = originCommit(o, 'develop', ch, 'feat: dark theme by default', SAM);
        return ['Sam pushed "feat: dark theme by default" to origin/develop'];
      },
      tasks: (p) => {
        const inMerge = (r) => r.state?.type === 'merge';
        const done = (r) => merged(r, p, featTheme(p), 'develop');
        return [
          T('conf-update', 'Update develop', 'Switch to `develop` and pull Sam\'s change.', [
            H('Same as before: switch, then pull.'),
            H('Run these:', 'git switch develop\ngit pull'),
          ], ({ r, meta }) => onB(r, 'develop') && isAncestor(r, meta.samTheme, headOf(r))),
          T('conf-merge', 'Merge your branch (expect a conflict!)', `Merge \`${featTheme(p)}\` into \`develop\`. Git will report a **CONFLICT**. That is intended.`, [
            H('Merge as usual; git will stop halfway.'),
            H('Run this:', `git merge ${featTheme(p)}`),
          ], ({ r }) => (inMerge(r) && r.state.conflicts.includes(profile(p))) || done(r)),
          T('conf-resolve', 'Fix the conflicted file', `Open \`${profile(p)}\`. You will see conflict markers: \`<<<<<<<\`, \`=======\`, \`>>>>>>>\`. Keep the **one** \`theme=\` line you want and **delete all the marker lines**. Then save.`, [
            H('The part between `<<<<<<< HEAD` and `=======` is develop (Sam). The part until `>>>>>>>` is your branch. Pick one (or write a new value), and remove the 3 marker lines. The editor has quick buttons too.'),
            H('Open it:', `edit ${profile(p)}`),
          ], ({ r }) => (inMerge(r) || done(r)) && !hasMarkers(r.work[profile(p)]) && /^theme=\w+$/m.test(r.work[profile(p)] || '') && /^name=/m.test(r.work[profile(p)] || ''), { why: 'Git never edits the decision for you. A human must choose.' }),
          T('conf-add', 'Mark it resolved', 'Tell git the conflict is fixed by staging the file.', [
            H('Resolving = `git add` the file. `git status` shows what is left.'),
            H('Run this:', `git add ${profile(p)}`),
          ], ({ r }) => (inMerge(r) && r.state.conflicts.length === 0) || done(r)),
          T('conf-commit', 'Finish the merge', 'Conclude the merge with a commit.', [
            H('The merge is still open. A plain commit finishes it (git has already prepared the message: add `-m` to set your own).'),
            H('Run this:', 'git commit -m "Merge theme change, resolve conflict"'),
          ], ({ r }) => done(r)),
          T('conf-push', 'Push the result', 'Push `develop`. If it is rejected, pull first (and if git asks you for another conflict, repeat the steps).', [
            H('`git push`. If rejected → `git pull` → `git push`.'),
            H('Run this:', 'git push'),
          ], ({ r, o }) => isAncestor(o, r.branches[featTheme(p)], o.branches.develop)),
        ];
      },
    },

    {
      id: 'hotfix',
      title: 'Hotfix in production',
      intro: 'A bug was found in **production** (`main`). While you have half-finished work lying around! You will park your work with **`git stash`**, fix the bug on a **`hotfix/*`** branch cut from `main`, release it with a tag, and then **merge the fix back to `develop`** so it is not lost.',
      setup: (o, meta, players) => {
        const ch = {};
        for (const p of players) ch[bug(p)] = `status=broken\nreason=checkout crashes for ${p.name}\n`;
        meta.bug = originCommit(o, 'main', ch, 'release: v1.0.0 (known bug reports attached)', SAM);
        return ['Production bug reports were added to origin/main'];
      },
      tasks: (p) => [
        T('wip', 'Start some work', `You are on \`develop\`. Open \`${notes(p)}\` and add any new line, **without committing**.`, [
          H('Edit the file and save. Then `git status` will show it as modified.'),
          H('Run this:', `echo "- idea: faster search" >> ${notes(p)}`),
        ], ({ r }) => r.work[notes(p)] !== undefined && r.work[notes(p)] !== fileAt(r, headOf(r), notes(p))),
        T('stash', 'Park your work', 'You can\'t switch branches cleanly with unfinished changes. Put them on the **stash**.', [
          H('`git stash` shelves your uncommitted changes and gives you a clean folder again.'),
          H('Run this:', 'git stash'),
        ], ({ r }) => r.stash.length > 0 && r.work[notes(p)] === fileAt(r, headOf(r), notes(p)), { why: 'Stash = a drawer for half-done work, so you can react to emergencies.' }),
        T('pull-main', 'Get production', 'Switch to `main` and pull the latest.', [
          H('Hotfixes start from production code.'),
          H('Run these:', 'git switch main\ngit pull'),
        ], ({ r, meta }) => onB(r, 'main') && isAncestor(r, meta.bug, headOf(r))),
        T('hotfix-branch', 'Create the hotfix branch', `Create \`${hot(p)}\` from \`main\`.`, [
          H('Same as a feature branch, but the base is main.'),
          H('Run this:', `git switch -c ${hot(p)}`),
        ], ({ r }) => onB(r, hot(p)) && isAncestor(r, r.branches.main, headOf(r))),
        T('hotfix-edit', 'Fix the bug', `Edit \`${bug(p)}\`: change \`status=broken\` to \`status=fixed\`.`, [
          H('Open the file in the editor and save.'),
          H('Run this:', `edit ${bug(p)}`),
        ], ({ r }) => /^status=fixed$/m.test(r.work[bug(p)] || '')),
        T('hotfix-commit', 'Commit the fix', 'Commit the fix.', [
          H('You can stage and commit in one go for tracked files.'),
          H('Run this:', 'git commit -am "Fix checkout crash"'),
        ], ({ r }) => /^status=fixed$/m.test(fileAt(r, r.branches[hot(p)], bug(p)) || '') && r.branches[hot(p)] !== r.branches.main),
        T('hotfix-merge', 'Merge into main', `Switch to \`main\` and merge \`${hot(p)}\`.`, [
          H('Switch to the branch that should receive the fix, then merge.'),
          H('Run these:', `git switch main\ngit merge ${hot(p)}`),
        ], ({ r }) => merged(r, p, hot(p), 'main')),
        T('hotfix-tag', 'Tag the release', `Create an **annotated tag** \`${tagHot(p)}\` on main with a message.`, [
          H('Tags mark releases. `-a` makes an annotated tag, `-m` its message.'),
          H('Run this:', `git tag -a ${tagHot(p)} -m "Hotfix ${tagHot(p)}"`),
        ], ({ r }) => !!r.tags[tagHot(p)]?.msg && isAncestor(r, r.branches[hot(p)], r.tags[tagHot(p)].id), { why: '(In real life one person tags. Here each of you gets a unique tag number.)' }),
        T('hotfix-push', 'Ship it', `Push \`main\` **and** your tag \`${tagHot(p)}\` to origin.`, [
          H('Tags are not pushed by default. Push the branch and the tag name (reject? pull first).'),
          H('Run this:', `git push origin main ${tagHot(p)}`),
        ], ({ r, o }) => isAncestor(o, r.branches[hot(p)], o.branches.main) && !!o.tags[tagHot(p)]),
        T('back-merge', 'Merge the fix back to develop', 'Switch to `develop`, pull, and merge `main` into it so develop also has the fix.', [
          H('Git Flow rule: a hotfix must land on **both** main and develop.'),
          H('Run these:', 'git switch develop\ngit pull\ngit merge main'),
        ], ({ r }) => isAncestor(r, r.branches[hot(p)], r.branches.develop) && !r.state && onB(r, 'develop')),
        T('back-push', 'Push develop', 'Push `develop` (pull first if rejected).', [H('Run this:', 'git push')], ({ r, o }) => isAncestor(o, r.branches[hot(p)], o.branches.develop)),
        T('stash-pop', 'Get your work back', 'Restore your parked work from the stash.', [
          H('`git stash pop` re-applies it and drops the entry.'),
          H('Run this:', 'git stash pop'),
        ], ({ r }) => r.stash.length === 0 && r.work[notes(p)] !== fileAt(r, headOf(r), notes(p))),
      ],
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
        T('rel-update', 'Update develop', 'Be on `develop` with the latest changes.', [H('Run these:', 'git switch develop\ngit pull')], ({ r, meta }) => onB(r, 'develop') && isAncestor(r, meta.modules, headOf(r))),
        T('rel-branch', 'Open the release branch', `Create \`${rel(p)}\` from \`develop\`.`, [H('Run this:', `git switch -c ${rel(p)}`)], ({ r }) => onB(r, rel(p)) && isAncestor(r, r.branches.develop, headOf(r))),
        T('rel-bump', 'Bump the version', `Edit \`${ver(p)}\` and set it to \`1.0.0\`.`, [H('Edit then save:', `edit ${ver(p)}`)], ({ r }) => (r.work[ver(p)] || '').trim() === '1.0.0'),
        T('rel-commit', 'Commit the bump', 'Commit it.', [H('Run this:', 'git commit -am "Bump version to 1.0.0"')], ({ r }) => (fileAt(r, r.branches[rel(p)], ver(p)) || '').trim() === '1.0.0' && r.branches[rel(p)] !== r.branches.develop),
        T('rel-main', 'Merge into main (no fast-forward)', `Switch to \`main\`, pull, and merge \`${rel(p)}\` with \`--no-ff\` so the release shows up as an explicit merge commit.`, [
          H('`--no-ff` forces a merge commit even if a fast-forward is possible.'),
          H('Run these:', `git switch main\ngit pull\ngit merge --no-ff ${rel(p)}`),
        ], ({ r }) => { const t = r.branches[rel(p)]; return commitWith(r, (c) => c.parents.length === 2 && c.parents[1] === t && isAncestor(r, c.id, r.branches.main)); }),
        T('rel-tag', 'Tag the release', `Create the annotated tag \`${tagRel(p)}\` on \`main\`.`, [H('Run this:', `git tag -a ${tagRel(p)} -m "Release 1.0.0"`)], ({ r }) => !!r.tags[tagRel(p)]?.msg && isAncestor(r, r.branches[rel(p)], r.tags[tagRel(p)].id)),
        T('rel-push', 'Push main and the tag', 'Publish the release.', [H('Run this:', `git push origin main ${tagRel(p)}`)], ({ r, o }) => isAncestor(o, r.branches[rel(p)], o.branches.main) && !!o.tags[tagRel(p)]),
        T('rel-back', 'Merge back into develop', 'Merge the release branch into `develop` and push it.', [H('Run these:', `git switch develop\ngit pull\ngit merge ${rel(p)}\ngit push`)], ({ r, o }) => isAncestor(o, r.branches[rel(p)], o.branches.develop)),
        T('rel-clean', 'Clean up', `Delete the local branch \`${rel(p)}\`.`, [H('Run this:', `git branch -d ${rel(p)}`)], ({ r }) => !r.branches[rel(p)]),
      ],
    },
  ];
}

/* ============================================================ TRUNK BASED */

function trunkStages() {
  const br = (p) => `feat/${p.slug}-greeting`;
  const brTheme = (p) => `feat/${p.slug}-theme`;
  const file = (p) => `features/${p.slug}.txt`;
  const profile = (p) => `players/${p.slug}/profile.txt`;
  const notes = (p) => `players/${p.slug}/notes.txt`;
  const svc = (p) => `services/${p.slug}.txt`;
  const tag = (p) => `${p.slug}-v1.1.0`;
  const lines = (t) => (t || '').split('\n').filter((l) => l.trim());

  return [
    READ_ONLY_STAGE('Trunk-based'),

    {
      id: 'short-branch',
      title: 'A short-lived branch',
      intro: 'In trunk-based development there is **one** long-lived branch: `main` (the trunk). Work happens on tiny branches that live for hours, not weeks, and every commit is small. Unfinished features hide behind flags so `main` is always releasable.',
      tasks: (p) => [
        T('tb-branch', 'Branch from main', `Create the branch \`${br(p)}\`.`, [
          H('`git switch -c <name>` creates and enters a branch.'),
          H('Run this:', `git switch -c ${br(p)}`),
        ], ({ r }) => onB(r, br(p)) && isAncestor(r, r.branches.main, headOf(r))),
        T('tb-file', 'Write the feature', `Create \`${file(p)}\` with one line of text (editor panel or terminal).`, [
          H('Anything works.'),
          H('Run this:', `echo "greeting v1" > ${file(p)}`),
        ], ({ r }) => lines(r.work[file(p)]).length >= 1),
        T('tb-commit1', 'Commit #1', 'Stage and commit the new file.', [
          H('Two commands: `git add`, then `git commit -m`.'),
          H('Run these:', `git add ${file(p)}\ngit commit -m "Add greeting"`),
        ], ({ r }) => fileAt(r, r.branches[br(p)], file(p)) !== undefined && r.branches[br(p)] !== r.branches.main),
        T('tb-commit2', 'Commit #2 (small steps)', `Add a **second line** to \`${file(p)}\` and commit it as a separate commit.`, [
          H('`echo "text" >> file` appends a line. Small commits are easier to review and to revert.'),
          H('Run these:', `echo "greeting v2" >> ${file(p)}\ngit commit -am "Improve greeting"`),
        ], ({ r }) => lines(fileAt(r, r.branches[br(p)], file(p))).length >= 2),
        T('tb-push', 'Push the branch', 'Publish the branch.', [H('Run this:', `git push -u origin ${br(p)}`)], ({ r, o }) => o.branches[br(p)] === r.branches[br(p)] && r.upstream[br(p)] === 'origin/' + br(p)),
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
        T('tb-fetch', 'Fetch', 'Download the new commits from origin **without changing your files**.', [
          H('`git fetch` updates `origin/main` but leaves your branches alone, so it is always safe.'),
          H('Run this:', 'git fetch'),
        ], ({ r, meta }) => isAncestor(r, meta.sam, r.remote['origin/main'])),
        T('tb-rebase', 'Rebase onto origin/main', 'Replay your branch on top of the latest `origin/main`.', [
          H('You must be on your branch. `git rebase <base>`'),
          H('Run this:', 'git rebase origin/main'),
        ], ({ r, meta }) => onB(r, br(p)) && !r.state && isAncestor(r, meta.sam, headOf(r)), { why: 'Your commits get new ids, so origin\'s copy of your branch is now "different history".' }),
        T('tb-force', 'Update your remote branch safely', 'The remote copy has the old commits. Overwrite it, but with the **safe** force option, which refuses if someone else pushed there.', [
          H('A rebased branch needs a force push. `--force-with-lease` is the safe variant. Only ever do this on your own branch.'),
          H('Run this:', 'git push --force-with-lease'),
        ], ({ r, o }) => o.branches[br(p)] === r.branches[br(p)] && isAncestor(r, r.remote['origin/main'], o.branches[br(p)])),
        T('tb-land', 'Land it on main', 'Switch to `main`, pull, merge your branch, and push `main`. (If the push is rejected: pull and try again.)', [
          H('The branch is directly on top of main, so the merge is a clean fast-forward.'),
          H('Run these:', `git switch main\ngit pull\ngit merge ${br(p)}\ngit push`),
        ], ({ r, o }) => isAncestor(o, r.branches[br(p)], o.branches.main)),
        T('tb-clean', 'Clean up', 'Delete your branch locally **and** on origin.', [
          H('Two deletes: local `git branch -d`, remote `git push origin --delete`.'),
          H('Run these:', `git branch -d ${br(p)}\ngit push origin --delete ${br(p)}`),
        ], ({ r, o }) => !r.branches[br(p)] && !o.branches[br(p)]),
      ],
    },

    {
      id: 'prepare-conflict',
      title: 'Prepare a change',
      intro: 'Your next change touches your profile file. Do it quickly on a short branch from `main`, commit, and **do not pull** afterwards. A teammate is about to touch the same line.',
      tasks: (p) => [
        T('tc-branch', 'Branch from main', `Create \`${brTheme(p)}\`.`, [H('Run this:', `git switch -c ${brTheme(p)}`)], ({ r }) => onB(r, brTheme(p)) && isAncestor(r, r.branches.main, headOf(r))),
        T('tc-edit', 'Change your theme', `In \`${profile(p)}\` change \`theme=light\` to \`theme=${p.theme}\`.`, [H('Open it:', `edit ${profile(p)}`)], ({ r }) => new RegExp(`^theme=${p.theme}$`, 'm').test(r.work[profile(p)] || '')),
        T('tc-commit', 'Commit', 'Commit your change.', [H('Run this:', `git commit -am "Set my theme to ${p.theme}"`)], ({ r }) => new RegExp(`^theme=${p.theme}$`, 'm').test(fileAt(r, r.branches[brTheme(p)], profile(p)) || '') && r.branches[brTheme(p)] !== r.branches.main),
      ],
    },

    {
      id: 'conflict',
      title: 'Conflict during a rebase',
      intro: 'Sam pushed a commit to `main` that changed the **same line** in your profile. Rebasing replays your commit onto it, so git stops with a conflict **in the middle of the rebase**. You resolve it, `git add`, and `git rebase --continue`.',
      setup: (o, meta, players) => {
        const ch = {};
        for (const p of players) ch[profile(p)] = `name=${p.name}\ntheme=dark\n`;
        meta.samTheme = originCommit(o, 'main', ch, 'feat: dark theme by default', SAM);
        return ['Sam pushed "feat: dark theme by default" to origin/main'];
      },
      tasks: (p) => {
        const inRb = (r) => r.state?.type === 'rebase';
        const done = (r, meta) => !r.state && onB(r, brTheme(p)) && isAncestor(r, meta.samTheme, headOf(r));
        return [
          T('rc-rebase', 'Fetch and rebase (expect a conflict!)', 'Fetch, then rebase your branch onto `origin/main`.', [
            H('You must be on your theme branch.'),
            H('Run these:', 'git fetch\ngit rebase origin/main'),
          ], ({ r, meta }) => (inRb(r) && r.state.conflicts.includes(profile(p))) || done(r, meta)),
          T('rc-resolve', 'Fix the file', `Edit \`${profile(p)}\`, keep one \`theme=\` line, delete the 3 marker lines.`, [
            H('`<<<<<<< HEAD` is main (Sam). The other half is your commit. Choose.'),
            H('Open it:', `edit ${profile(p)}`),
          ], ({ r, meta }) => (inRb(r) || done(r, meta)) && !hasMarkers(r.work[profile(p)]) && /^theme=\w+$/m.test(r.work[profile(p)] || '') && /^name=/m.test(r.work[profile(p)] || '')),
          T('rc-add', 'Mark it resolved', 'Stage the file.', [H('Run this:', `git add ${profile(p)}`)], ({ r, meta }) => (inRb(r) && r.state.conflicts.length === 0) || done(r, meta)),
          T('rc-continue', 'Continue the rebase', 'Tell git to carry on replaying your commits.', [
            H('Do **not** use `git commit` here; the rebase has its own command.'),
            H('Run this:', 'git rebase --continue'),
          ], ({ r, meta }) => done(r, meta)),
          T('rc-land', 'Land it', 'Switch to `main`, pull, merge your branch, push.', [
            H('Run these:', `git switch main\ngit pull\ngit merge ${brTheme(p)}\ngit push`),
          ], ({ r, o }) => isAncestor(o, r.branches[brTheme(p)], o.branches.main)),
        ];
      },
    },

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
      tasks: (p) => [
        T('rv-wip', 'Start some work', `Add any new line to \`${notes(p)}\` and do **not** commit.`, [H('Run this:', `echo "- idea" >> ${notes(p)}`)], ({ r }) => r.work[notes(p)] !== fileAt(r, headOf(r), notes(p))),
        T('rv-stash', 'Stash it', 'Park your work.', [H('Run this:', 'git stash')], ({ r }) => r.stash.length > 0 && r.work[notes(p)] === fileAt(r, headOf(r), notes(p))),
        T('rv-pull', 'Update main', 'Switch to `main` and pull.', [H('Run these:', 'git switch main\ngit pull')], ({ r, meta }) => onB(r, 'main') && isAncestor(r, meta.bad[p.slug], headOf(r))),
        T('rv-revert', 'Revert the bad commit', `Find the commit called \`perf: speed up ${p.slug} service\` in the log, and revert it.`, [
          H('`git log --oneline` shows the short id (7 characters). `git revert <id>` creates an *undo* commit.'),
          H('Run these:', 'git log --oneline\ngit revert <id>'),
        ], ({ r }) => /^status=ok$/m.test(fileAt(r, r.branches.main, svc(p)) || '') && commitWith(r, (c) => c.msg.startsWith(`Revert "perf: speed up ${p.slug} service"`) && isAncestor(r, c.id, r.branches.main)), { why: 'Revert keeps history honest: nothing is erased, the fix is just another commit.' }),
        T('rv-push', 'Push the fix', 'Push `main`. If it is rejected, use `git pull --rebase` and push again.', [
          H('Everybody is pushing to main right now. `git pull --rebase` replays your revert on top of theirs, keeping history linear.'),
          H('Run this:', 'git push'),
        ], ({ o }) => /^status=ok$/m.test(fileAt(o, o.branches.main, svc(p)) || '')),
        T('rv-pop', 'Get your work back', 'Restore your stash.', [H('Run this:', 'git stash pop')], ({ r }) => r.stash.length === 0 && r.work[notes(p)] !== fileAt(r, headOf(r), notes(p))),
      ],
    },

    {
      id: 'release',
      title: 'Release with a tag',
      intro: 'Trunk-based teams do not keep release branches for simple releases. Every commit on `main` is releasable; a release is just a **tag** on a commit of main.',
      tasks: (p) => [
        T('rl-update', 'Update main', 'Be on `main`, up to date with origin.', [H('Run these:', 'git switch main\ngit pull')], ({ r }) => onB(r, 'main') && isAncestor(r, r.remote['origin/main'], r.branches.main) && r.remote['origin/main'] === r.remote['origin/main']),
        T('rl-tag', 'Tag the release', `Create the annotated tag \`${tag(p)}\` on the current commit.`, [H('Run this:', `git tag -a ${tag(p)} -m "Release 1.1.0"`)], ({ r }) => !!r.tags[tag(p)]?.msg && /^status=ok$/m.test(fileAt(r, r.tags[tag(p)].id, svc(p)) || '')),
        T('rl-push', 'Publish the tag', 'Push only the tag to origin.', [H('Run this:', `git push origin ${tag(p)}`)], ({ o }) => !!o.tags[tag(p)]),
        T('rl-list', 'List the tags', 'Show every tag that exists. You should see everyone\'s!', [H('First fetch everyone else\'s tags, then list them:', 'git fetch\ngit tag')], ({ ran }) => ran(/^git tag\s*$/)),
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
