import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function git(repository, args, { allowFail = false, cwd = repository.path, timeout = 15_000 } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw new Error(String(error?.stderr || error?.message || error).trim());
  }
}

function worktreeRows(repository) {
  const output = git(repository, ['worktree', 'list', '--porcelain'], { allowFail: true }) || '';
  return output.split(/\n\n+/).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const field = (prefix) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) || null;
    return { path: field('worktree '), branch: field('branch refs/heads/'), head: field('HEAD ') };
  });
}

function baseline(repository) {
  const remoteHead = git(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  for (const candidate of [remoteHead, 'origin/main', 'main', 'HEAD'].filter(Boolean)) {
    if (git(repository, ['rev-parse', '--verify', '--quiet', candidate], { allowFail: true }) !== null) return candidate;
  }
  throw new Error('repository has no usable baseline commit');
}

function directoryHasContent(path) {
  try { return statSync(path).isDirectory() && readdirSync(path).length > 0; } catch { return false; }
}

export function worktreePath(repository, slug) {
  return join(repository.path, repository.adapter === 'director' ? '.claude/worktrees' : '.handraise/worktrees', slug);
}

export function createWorktree(repository, slug) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(slug)) throw new Error('invalid worktree name');
  const path = worktreePath(repository, slug);
  const branch = repository.adapter === 'director' ? `feat/${slug}` : `handraise/${slug}`;
  const registered = worktreeRows(repository).find((item) => resolve(item.path) === resolve(path));
  if (registered) {
    if (registered.branch !== branch) throw new Error(`worktree exists on '${registered.branch}', expected '${branch}'`);
    return { path, branch, created: false, baseline: baseline(repository) };
  }
  if (existsSync(path) && directoryHasContent(path)) throw new Error(`${path} exists with unregistered content; inspect it before continuing`);

  if (repository.adapter === 'director') {
    const helper = join(repository.path, '.claude/skills/new-front/scripts/bootstrap.sh');
    if (!existsSync(helper)) throw new Error('this Director repository cannot create worktrees safely because its bootstrap helper is missing');
    try {
      execFileSync('bash', [helper, slug], {
        cwd: repository.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000,
      });
    } catch (error) {
      throw new Error(String(error?.stderr || error?.stdout || error?.message || error).trim());
    }
  } else {
    const base = baseline(repository);
    const branchExists = git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== null;
    const args = branchExists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, base];
    git(repository, args, { timeout: 60_000 });
  }
  return { path, branch, created: true, baseline: baseline(repository) };
}

export function gitState(repository, cwd, slug = '') {
  if (!cwd || !existsSync(cwd)) return { available: false, path: cwd || null, reason: 'working directory is missing' };
  const branch = git(repository, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, allowFail: true });
  if (!branch) return { available: false, path: cwd, reason: 'working directory is not a Git worktree' };
  const base = baseline(repository);
  const revision = git(repository, ['rev-parse', 'HEAD'], { cwd, allowFail: true });
  const baselineRevision = git(repository, ['rev-parse', base], { cwd, allowFail: true });
  const porcelain = git(repository, ['status', '--porcelain'], { cwd, allowFail: true }) || '';
  const counts = git(repository, ['rev-list', '--left-right', '--count', `${base}...HEAD`], { cwd, allowFail: true });
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
  const remoteBranch = `origin/${branch}`;
  const hasRemoteBranch = git(repository, ['rev-parse', '--verify', '--quiet', remoteBranch], { cwd, allowFail: true }) !== null;
  const protectedRefs = [base, ...(hasRemoteBranch ? [remoteBranch] : [])];
  const unbackedOutput = git(repository, ['rev-list', '--count', 'HEAD', '--not', ...protectedRefs], { cwd, allowFail: true });
  const expected = slug ? (repository.adapter === 'director' ? `feat/${slug}` : `handraise/${slug}`) : null;
  return {
    available: true,
    path: realpathSync(cwd),
    branch,
    revision,
    expectedBranch: expected,
    branchMismatch: Boolean(expected && branch !== expected),
    baseline: base,
    baselineRevision,
    dirty: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
    ahead,
    behind,
    backupRef: hasRemoteBranch ? remoteBranch : null,
    unbacked: unbackedOutput === null ? ahead : Number(unbackedOutput),
  };
}

export function workshopSnapshot(repository, sessions = []) {
  const ownedPaths = new Set(sessions.filter((session) => session.repoId === repository.id && session.cwd)
    .map((session) => { try { return realpathSync(session.cwd); } catch { return resolve(session.cwd); } }));
  const worktrees = worktreeRows(repository).map((worktree, index) => {
    const owner = sessions.find((session) => {
      if (!session.cwd) return false;
      try { return realpathSync(session.cwd) === realpathSync(worktree.path); } catch { return resolve(session.cwd) === resolve(worktree.path); }
    });
    return {
      ...worktree,
      primary: index === 0,
      owner: owner ? { slug: owner.slug, controlSlug: owner.controlSlug, front: owner.front } : null,
      git: gitState(repository, worktree.path, owner?.front || owner?.slug || ''),
      orphan: index > 0 && !ownedPaths.has(resolve(worktree.path)) && !owner,
    };
  });
  return { worktrees, orphans: worktrees.filter((item) => item.orphan) };
}

export function removeWorktree(repository, slug, { sessions = [] } = {}) {
  const path = worktreePath(repository, slug);
  if (sessions.some((session) => session.repoId === repository.id && session.cwd && resolve(session.cwd) === resolve(path))) {
    throw new Error('stop the session that owns this worktree before removing it');
  }
  const registered = worktreeRows(repository).find((item) => resolve(item.path) === resolve(path));
  if (!registered) throw new Error('worktree is not registered');
  const state = gitState(repository, path, slug);
  const blockers = [];
  if (state.dirty) blockers.push(`${state.dirty} uncommitted change(s)`);
  if (state.unbacked) blockers.push(`${state.unbacked} commit(s) exist only on this machine`);
  if (state.ahead) blockers.push(`${state.ahead} commit(s) are not in ${state.baseline}`);
  if (blockers.length) throw new Error(`worktree cannot be removed: ${blockers.join('; ')}`);
  git(repository, ['worktree', 'remove', path], { timeout: 60_000 });
  if (registered.branch) git(repository, ['branch', '-d', registered.branch], { allowFail: true });
  return { removed: slug, path, branch: registered.branch };
}
