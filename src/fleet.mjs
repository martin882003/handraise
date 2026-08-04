const ATTENTION_PRIORITY = { error: 0, blocked: 1, waiting: 2 };

function recent(outcome, now, days) {
  const age = now - new Date(outcome.at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= days * 24 * 3600 * 1000;
}

export function fleetVerdict({ repositories = [], sessions = [], outcomes = [], now = Date.now() } = {}) {
  const attention = sessions.filter((session) => Object.hasOwn(ATTENTION_PRIORITY, session.status))
    .sort((left, right) => ATTENTION_PRIORITY[left.status] - ATTENTION_PRIORITY[right.status]
      || String(left.repoId || '').localeCompare(String(right.repoId || ''))
      || String(left.slug || '').localeCompare(String(right.slug || '')));
  const controlledLanes = new Set(sessions
    .filter((session) => session.repoId && (session.front || session.slug))
    .map((session) => `${session.repoId}:${session.front || session.slug}`));
  const external = repositories.flatMap((repository) => (repository.lanes || [])
    .filter((lane) => lane.liveness === 'live' && !controlledLanes.has(`${repository.id}:${lane.slug}`))
    .map((lane) => ({ ...lane, repoId: repository.id, repositoryName: repository.name })));
  const risks = repositories.flatMap((repository) => {
    const worktrees = repository.workshop?.worktrees || [];
    const orphans = repository.workshop?.orphans || [];
    return [...worktrees.map((worktree) => ({ ...worktree, orphan: Boolean(worktree.orphan) })),
      ...orphans.map((worktree) => ({ ...worktree, orphan: true }))]
      .filter((worktree) => worktree.orphan || worktree.git?.dirty || worktree.git?.unbacked || worktree.git?.branchMismatch)
      .map((worktree) => ({ ...worktree, repoId: repository.id, repositoryName: repository.name }));
  });
  const recentOutcomes = outcomes.filter((outcome) => recent(outcome, now, 7));
  const recentFailures = outcomes.filter((outcome) => outcome.type === 'failed' && recent(outcome, now, 1));
  const failed = attention.filter((session) => session.status === 'error');
  const blocked = attention.filter((session) => session.status === 'blocked');
  const waiting = attention.filter((session) => session.status === 'waiting');
  const running = sessions.length + external.length;

  let kind = 'idle';
  let title = 'No agent sessions are running.';
  if (failed.length) {
    kind = 'failed';
    title = `${failed.length} session${failed.length === 1 ? '' : 's'} failed and need${failed.length === 1 ? 's' : ''} recovery.`;
  } else if (blocked.length) {
    kind = 'blocked';
    title = `${blocked.length} session${blocked.length === 1 ? '' : 's'} await${blocked.length === 1 ? 's' : ''} a permission decision.`;
  } else if (waiting.length) {
    kind = 'waiting';
    title = `${waiting.length} session${waiting.length === 1 ? '' : 's'} wait${waiting.length === 1 ? 's' : ''} for you.`;
  } else if (risks.length) {
    kind = 'unsafe';
    title = `${risks.length} Git workspace${risks.length === 1 ? '' : 's'} need${risks.length === 1 ? 's' : ''} a safety review.`;
  } else if (recentFailures.length) {
    kind = 'recent-failure';
    title = `${recentFailures.length} session${recentFailures.length === 1 ? '' : 's'} failed in the last 24 hours.`;
  } else if (running) {
    kind = 'active';
    title = 'The fleet is moving and no intervention is pending.';
  } else if (recentOutcomes.length) {
    kind = 'recent';
    title = 'Recent work finished and the fleet is clear.';
  }

  return {
    kind, title, attention, risks, external, recentOutcomes,
    counts: {
      running,
      needsYou: attention.length,
      failed: failed.length,
      blocked: blocked.length,
      waiting: waiting.length,
      unsafe: risks.length,
      completed7d: recentOutcomes.filter((outcome) => outcome.type === 'completed').length,
      failed7d: recentOutcomes.filter((outcome) => outcome.type === 'failed').length,
      stopped7d: recentOutcomes.filter((outcome) => outcome.type === 'stopped').length,
    },
  };
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function fleetManagerPrompt({ repositories = [], sessions = [], nodePath = 'node', binPath = 'handraise' } = {}) {
  const inventory = repositories.length ? repositories.map((repository) => {
    const components = (repository.components || []).map((component) => component.slug).slice(0, 24);
    const fronts = (repository.fronts || []).filter((front) => front.kind !== 'backlog' && front.state !== 'done')
      .map((front) => `${front.slug}:${front.component}:${front.state}`).slice(0, 30);
    return [
      `- ${repository.name} [${repository.id}]`,
      `  path: ${repository.path}`,
      `  adapter: ${repository.adapter}`,
      `  components: ${components.join(', ') || 'none'}`,
      `  open fronts: ${fronts.join(', ') || 'none'}`,
    ].join('\n');
  }).join('\n') : '- No repositories are connected.';
  const live = sessions.length ? sessions.slice(0, 60).map((session) => (
    `- ${session.slug} · repo=${session.repoId || 'global'} · component=${session.component || 'unassigned'} · front=${session.front || 'unassigned'} · status=${session.status}`
  )).join('\n') : '- No managed sessions are currently visible.';
  const command = `${shellQuote(nodePath)} ${shellQuote(binPath)} project`;

  return [
    'You are the conversational Handraise Fleet Director. Speak in the user\'s language and ask one focused question at a time.',
    'Your job is to understand desired outcomes, inspect repository contracts and current runtime state read-only, and propose coordinated work with exact repository, component and front ownership.',
    `Connected repository inventory:\n${inventory}`,
    `Current managed sessions:\n${live}`,
    'Keep proposals separate from execution. Before confirmation, describe the complete proposed operations and visible consequences in the conversation; do not write repository metadata, launch agents, stop sessions or create operation files.',
    'Require an explicit user confirmation for the exact proposal. After confirmation, serialize each approved operation into a temporary JSON file and apply it only through the typed Handraise boundary.',
    `Component command: ${command} component --repo <repository-id> --from <operation.json>.`,
    `Front command: ${command} front --repo <repository-id> --from <operation.json>.`,
    'Component actions are create, update, retire, reopen and remove. Front actions are create, update and remove; an adapter may safely reject unsupported operations.',
    'Every front proposal must include repository, component, slug, title, observable outcome, confirmed context, handoff, ordered tasks, impact and complexity. Call out dependencies and cross-repository sequencing explicitly.',
    'Never edit component/front Markdown directly and never bypass a Director helper. Do not start implementation yourself; after confirmed planning, direct the user to the explicit session controls.',
  ].join('\n\n');
}
