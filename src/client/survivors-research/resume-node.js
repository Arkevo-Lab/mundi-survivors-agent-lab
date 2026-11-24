import {RESEARCH_COVERAGE_SEQUENCE_PROFILE, RESEARCH_SEQUENCE_PROFILE} from '../../shared/survivors-research-contract.js';
import {hashJSON} from './evidence.js';
import {stateHash} from './sim-state-hash.js';
import {createResumeContext} from './models/node-context.js';
import {expectResponse} from './worker-client.js';

export const NODE_SCHEMA = 'survivors-research-node-v1';
export const NODE_DURATION_TICKS = 600;
export const BRANCH_SCHEMA = 'survivors-research-branch-v1';
const tickValue = value => Number.isSafeInteger(value) && value >= 0;

export function strategyName(model, advisor, strategy) {
  if (advisor?.condition === 'latest-local-micro') return '局部微操';
  if (strategy?.mode === 'chat-strategy-v1') return '三层对照';
  if (advisor?.condition === 'micro-control') return '微操层对照';
  if (advisor?.mode === 'advisory-cardinal-v2') return '两层对照';
  if (advisor) return '历史方向层';
  if (model?.movement_question_mode === 'direction-v1') return '三问方向实验';
  if (model?.movement_feedback === 'closed-plan-history-v1') return '第 17 轮历史方案';
  return model?.kind === 'human' ? '玩家' : model?.model ?? model?.kind ?? '未知策略';
}

export function canBuildResumeNode(run, tick) {
  return tickValue(tick) && tick >= (run.manifest.branch?.base_tick ?? 0) &&
    tick < run.manifest.config.max_ticks && (tick < run.result.tick || tick === run.result.tick &&
      !['death', 'reaper', 'time-limit'].includes(run.result.reason));
}

export async function resumeNodeId(run, tick, events) {
  const evidence_hash = run.manifest.archive_hashes?.events_sha256 ?? await hashJSON(events);
  const actions_hash = run.manifest.archive_hashes?.actions_sha256 ?? await hashJSON(run.actions);
  return hashJSON({schema: NODE_SCHEMA, restoration_version: 2, run_id: run.run_id, tick, evidence_hash, actions_hash,
    parent_context: run.resume_node?.integrity ?? null, terminal: run.result.state_hash,
    engine: run.manifest.engine_sha256, initial: run.manifest.initial_state_sha256, config: run.manifest.config});
}

export async function verifyResumeNode(node) {
  const {integrity, ...unsigned} = node ?? {};
  if (node?.schema !== NODE_SCHEMA || !/^[a-f0-9]{64}$/.test(node.node_id ?? '') ||
      !tickValue(node.source?.tick) || typeof node.source?.run_id !== 'string' ||
      node.snapshot?.tick !== node.source.tick || node.context?.base_tick !== node.source.tick ||
      node.context?.source_run_id !== node.source.run_id ||
      node.node_state?.source_run_id !== node.source.run_id || node.node_state.base_tick !== node.source.tick ||
      node.node_state.node_hash !== node.source.state_hash ||
      await hashJSON(node.node_state.config) !== await hashJSON(node.source.config) ||
      !Number.isFinite(node.facts?.hp) || node.facts.hp !== node.snapshot?.player?.hp ||
      !tickValue(node.facts.gems_collected) || node.facts.gems_collected !== node.snapshot.player.gemsCollected ||
      !tickValue(node.facts.hits_taken) || node.facts.hits_taken !== node.snapshot.hits_taken || integrity !== await hashJSON(unsigned)) throw Error('测试节点内容或校验值无效');
  return node;
}

export async function deriveCoverageResumeNode(parent, {parentFileSha256} = {}) {
  await verifyResumeNode(parent);
  const {integrity, ...node} = structuredClone(parent);
  const {node_hash, ...state} = node.node_state;
  const {movement, movementPlan, planInfo} = state.harness ?? {};
  if (!/^[a-f0-9]{64}$/.test(parentFileSha256 ?? '') || node_hash !== stateHash(state) ||
      state.config.action_profile !== RESEARCH_SEQUENCE_PROFILE ||
      (state.config.movement_feedback ?? 'none') !== 'none' ||
      movement?.entry?.id !== 'stop' || planInfo !== null ||
      !Array.isArray(movementPlan) || movementPlan.length !== 0) {
    throw Error('测试节点不能派生为 600 毫秒动作档');
  }
  const profile_migration = {
    version: 'survivors-action-profile-migration-v1',
    from: RESEARCH_SEQUENCE_PROFILE,
    to: RESEARCH_COVERAGE_SEQUENCE_PROFILE,
    parent_file_sha256: parentFileSha256,
    parent_node_id: node.node_id,
    parent_integrity: integrity,
    parent_node_hash: node_hash,
    engine_state_sha256: await hashJSON(state.engine_state),
    harness_sha256: await hashJSON(state.harness),
    advanced_ticks: 0,
  };
  state.config.action_profile = RESEARCH_COVERAGE_SEQUENCE_PROFILE;
  node.node_id = await hashJSON(profile_migration);
  node.node_state = {...state, node_hash: stateHash(state)};
  node.source = {...node.source, config: {...state.config}, state_hash: node.node_state.node_hash, profile_migration};
  return {...node, integrity: await hashJSON(node)};
}

function archivedOutput(run, event) {
  return event.raw_response ?? (event.output_file &&
    run.payloads?.files[run.payloads.prefix + event.output_file]);
}

function previousDirection(run, actions, events) {
  if (run.manifest.model?.movement_question_mode !== 'direction-v1') return null;
  const applied = actions.findLast(row => !row.action_id.startsWith('choose:'));
  if (!applied) return null;
  const attempt = events.find(row => row.type === 'model:attempt' && row.decision_id === applied.decision_id &&
    row.status === 'applied' && row.applied_tick === applied.applied_tick && row.action_id === applied.action_id);
  if (!attempt) return null;
  try {
    const [threat, crystal, action] = JSON.parse(archivedOutput(run, attempt)).answers;
    if (threat?.name !== 'threat' || crystal?.name !== 'crystal' || action?.name !== 'direction') return null;
    const hitsTaken = (run.manifest.branch?.start_facts.hits_taken ?? 0) +
      events.filter(row => row.type === 'player_hit' && row.tick <= attempt.observation_tick).length;
    return {threat: threat.choice, crystal: crystal.choice, action: action.choice,
      observedTick: attempt.observation_tick, appliedTick: applied.applied_tick, hitsTaken};
  } catch { return null; }
}

export async function buildResumeNode({run, tick, events, worker, nodeId}) {
  const preparedAt = performance.now();
  const {manifest, initial_state, actions, result} = run;
  if (!canBuildResumeNode(run, tick)) {
    throw Error('请选择对局结束前的回放时间');
  }
  const observations = [...new Map(events.filter(row => row.type === 'observation_sampled' && !row.terminal &&
    tickValue(row.tick) && row.tick <= tick && typeof row.observation_id === 'string' &&
    Number.isFinite(row.sampled_at_ms)).map(row => [row.tick, {
      tick: row.tick, observation_id: row.observation_id, sampled_at_ms: row.sampled_at_ms,
    }])).values()].sort((a, b) => a.tick - b.tick);
  const built = expectResponse(await worker.request('research:build_node', run.run_id,
    {config: manifest.config, initial_state, actions, result, tick, observations}, {timeout: 30000}));
  if (!built.consistent || built.base_tick !== tick || built.snapshot?.tick !== tick) {
    throw Error('所选节点未通过回放校验');
  }
  const applied_actions = actions.filter(row => row.applied_tick <= tick);
  const accepted_guidance = events.filter(row => row.type === 'advisor:published' && row.run_id === run.run_id &&
    tickValue(row.accepted_tick) && row.accepted_tick <= tick && tickValue(row.observation_tick) &&
    row.observation_tick <= row.accepted_tick);
  const accepted_strategies = events.filter(row => row.type === 'strategy:published' && row.run_id === run.run_id &&
    tickValue(row.accepted_tick) && row.accepted_tick <= tick && tickValue(row.source_tick) &&
    row.source_tick <= row.accepted_tick);
  const sourceMode = manifest.advisor?.mode ?? manifest.model?.movement_question_mode ?? manifest.model?.kind ?? null;
  const previous_direction = previousDirection(run, applied_actions, events);
  const context = createResumeContext({source_run_id: run.run_id, source_mode: sourceMode, base_tick: tick,
    context_samples: built.context_samples, applied_actions, accepted_guidance, accepted_strategies,
    previous_direction, initial_context: run.resume_node?.context});
  if (manifest.model?.movement_question_mode === 'direction-v1' &&
      applied_actions.some(row => !row.action_id.startsWith('choose:')) && !context.previous_direction) {
    context.missing = [...new Set([...context.missing, 'legacy_previous_unavailable'])];
  }
  const {snapshot} = built;
  const node = {schema: NODE_SCHEMA, node_id: nodeId ?? await resumeNodeId(run, tick, events), node_state: built.node_state,
    context, source: {run_id: run.run_id, tick, engine_sha256: manifest.engine_sha256,
      initial_state_sha256: manifest.initial_state_sha256, state_hash: built.node_state.node_hash,
      strategy: strategyName(manifest.model, manifest.advisor, manifest.strategy), config: manifest.config,
      offline_preparation_ms: performance.now() - preparedAt},
    facts: {hp: snapshot.player.hp, gems_collected: snapshot.player.gemsCollected, hits_taken: snapshot.hits_taken},
    snapshot};
  return {...node, integrity: await hashJSON(node)};
}
