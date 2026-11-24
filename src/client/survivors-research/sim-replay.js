import {RESEARCH_ENGINE, RESEARCH_RULES, RESEARCH_SCHEMA, TICK_MS,
  researchMovement, researchPlanValidator} from '../../shared/survivors-research-contract.js';
import {projectObservation} from './sim-observation.js';
import {ResearchError, ResearchWorld, validateConfig} from './sim-world.js';

const resumableStop = reason => ['segment-limit', 'stopped', 'interrupted'].includes(reason);
const isStateHash = value => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

function checkActions(actions, config, baseTick, endTick) {
  if (!Array.isArray(actions) || actions.length > endTick - baseTick) {
    throw new ResearchError('invalid-replay', 'The replay has an invalid action log.');
  }
  let last = baseTick;
  const validatePlan = researchPlanValidator(config.action_profile);
  for (const row of actions) {
    const {applied_tick: tick, action_id: action, action_ids} = row ?? {};
    const valid = validatePlan ? validatePlan(action, action_ids)
      : action_ids === undefined && typeof action === 'string' &&
        (researchMovement(config.action_profile, action) || /^choose:level-[1-9][0-9]*:[a-z-]+$/.test(action));
    if (!Number.isInteger(tick) || tick <= last || tick > endTick || !valid) {
      throw new ResearchError('invalid-replay', 'Expected ordered, unique action ticks and valid action IDs.');
    }
    last = tick;
  }
}

export function replayResearch(request) {
  return replay(request);
}

export function buildResearchNode(request) {
  return replay(request, true);
}

async function replay({config: input, initial_state, actions, result, tick, include_positions = false,
  observations = [], run_id: runId}, buildNode = false) {
  const config = validateConfig(input);
  if (!initial_state || !result || result.schema !== RESEARCH_SCHEMA ||
      result.rules !== RESEARCH_RULES || result.engine !== RESEARCH_ENGINE) {
    throw new ResearchError('unsupported-version', 'Expected a replay from this research schema and engine.');
  }
  const world = new ResearchWorld(config, initial_state);
  const baseTick = world.baseTick;
  const endTick = result.tick;
  const target = tick ?? endTick;
  if (!Number.isInteger(endTick) || endTick < baseTick || endTick > world.limitTick ||
      !Number.isInteger(target) || target < baseTick || target > endTick ||
      result.status !== 'ended' || typeof result.reason !== 'string' || !isStateHash(result.state_hash)) {
    throw new ResearchError('invalid-replay', 'Invalid replay tick range or terminal result.');
  }
  if (buildNode && (typeof runId !== 'string' || result.run_id !== runId || tick === undefined ||
      target >= config.max_ticks || target === endTick && !resumableStop(result.reason) ||
      !Array.isArray(observations) || observations.length > target - baseTick + 1)) {
    throw new ResearchError('invalid-resume-node', 'Select an unfinished frame from this source run.');
  }
  if (initial_state.node_state && (result.base_tick !== baseTick || result.limit_tick !== world.limitTick)) {
    throw new ResearchError('invalid-replay', 'The segment result disagrees with the starting state.');
  }
  let lastObservation = baseTick - 1;
  if (buildNode) for (const row of observations) {
    if (!Number.isSafeInteger(row?.tick) || row.tick <= lastObservation || row.tick > target ||
        row.observation_id !== 'obs-' + row.tick || !Number.isFinite(row.sampled_at_ms)) {
      throw new ResearchError('invalid-resume-node', 'Invalid source observation timeline.');
    }
    lastObservation = row.tick;
  }
  checkActions(actions, config, baseTick, endTick);
  if (!Array.isArray(result.checkpoints) || result.checkpoints.length > endTick - baseTick + 1) {
    throw new ResearchError('invalid-replay', 'Invalid replay checkpoints.');
  }
  const expected = new Map();
  let lastCheckpointTick = -1;
  for (const row of result.checkpoints) {
    const {tick: checkpointTick, state_hash} = row ?? {};
    if (!Number.isInteger(checkpointTick) || checkpointTick < baseTick || checkpointTick <= lastCheckpointTick ||
        checkpointTick > endTick || !isStateHash(state_hash)) {
      throw new ResearchError('invalid-replay', 'Replay checkpoints must have increasing ticks and state hashes.');
    }
    lastCheckpointTick = checkpointTick;
    expected.set(checkpointTick, state_hash);
  }
  if (result.trace !== undefined && (!Array.isArray(result.trace) || result.trace.length !== endTick - baseTick ||
      !result.trace.every(hash => typeof hash === 'string' && /^[0-9a-f]{8}$/.test(hash)))) {
    throw new ResearchError('invalid-replay', 'Invalid per-tick trajectory digests.');
  }
  expected.set(endTick, result.state_hash);
  const positions = include_positions ? [[world.x, world.y]] : null;
  let actionIndex = 0;
  let observationIndex = 0;
  let node;
  const contextSamples = [];
  const collect = () => {
    if (!buildNode) return;
    const row = observations[observationIndex];
    if (row?.tick === world.tick) {
      observationIndex++;
      const snapshot = world.snapshot();
      const {observation} = projectObservation({snapshot, config, runId, movement:world.movementVector(),
        movementReceipts: world.recentMovementReceipts, movementReceiptOffset: world.movementReceiptOffset(),
        previousMovement: world.previousMovement(), movementHistory: world.movementHistory(),
        sampledAt: row.sampled_at_ms, now: () => row.sampled_at_ms});
      contextSamples.push({observation,frame:{tick:row.tick,sampled_at_ms:row.sampled_at_ms,
        player:{x:world.x,y:world.y},gemsCollected:snapshot.player.gemsCollected},hitsTaken:world.hitsTaken});
    }
    if (world.tick === target && !world.done) node = {node_state:world.resumeNode(runId),
      snapshot:world.snapshot(),movement:world.movementInfo(),base_tick:world.tick,context_samples:contextSamples};
  };
  let firstDivergent = null;
  if (buildNode && target === endTick) {
    world.beforeFinish = reason => {
      if (resumableStop(reason) && world.tick === target) collect();
    };
  }
  const compare = () => {
    if (firstDivergent === null && expected.has(world.tick)) {
      const actual = world.checkpoints.at(-1);
      if (actual.tick !== world.tick || expected.get(world.tick) !== actual.state_hash) firstDivergent = world.tick;
    }
  };
  if (endTick !== baseTick) {
    compare();
    // A terminal target still needs its prefix observations from the initial tick onward.
    collect();
  }
  // For a zero-tick stopped run, beforeFinish captures the sole frame below.
  // Without per-tick digests the source terminal digest verifies the captured prefix.
  const walkTo = buildNode && !result.trace ? endTick : target;
  while (world.tick < walkTo && !world.done) {
    const next = world.tick + 1;
    const action = actions[actionIndex]?.applied_tick === next ? actions[actionIndex++] : undefined;
    try {
      world.advance(action?.action_id, action?.action_ids);
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error;
      firstDivergent ??= next;
      break;
    }
    if (positions && next <= target) positions.push([world.x, world.y]);
    if (result.trace && world.trace.at(-1) !== result.trace[next - baseTick - 1]) firstDivergent ??= next;
    // A manual stop at a checkpoint replaces the running digest at that tick.
    if (world.tick !== endTick) compare();
    if (next <= target && !world.done) collect();
    if (next % 240 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (world.tick === endTick && !world.done) {
    if (['time-limit', 'segment-limit', 'death', 'reaper'].includes(result.reason)) firstDivergent ??= world.tick;
    world.finish(result.reason);
  }
  if (world.tick === endTick) compare();
  if (world.tick !== walkTo || world.done && world.tick < endTick) firstDivergent ??= world.tick;
  if (buildNode) return { ...(firstDivergent === null && node), consistent: firstDivergent === null && !!node,
    can_resume:firstDivergent === null && !!node, first_divergent_tick:firstDivergent };
  return {
    snapshot: world.snapshot(), movement: world.movementInfo(),
    result: {...world.performanceResult(), sim_time_ms: world.tick * TICK_MS},
    ...(positions && firstDivergent === null && {positions}),
    consistent: firstDivergent === null, first_divergent_tick: firstDivergent,
    can_resume: firstDivergent === null && target < config.max_ticks &&
      (!world.done || resumableStop(world.reason)),
  };
}
