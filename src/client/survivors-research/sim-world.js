import {stateHash} from './sim-state-hash.js';
import {BAT_CRYSTAL_BANDS} from '../../../public/games/survivors-lab-research-v1/src/bat-crystal-bands.mjs';
export {stateHash} from './sim-state-hash.js';
import {
  CHARACTERS, ENGINE_ID, MAX_TICKS, createSurvivorsGame,
} from '../../../public/games/survivors-lab-research-v1/src/sim.mjs';
import {
  DISTANCE_TIMEOUT_TICKS, MAX_RESEARCH_LATENCY_COMPENSATION_MS, RESEARCH_ACTIONS, RESEARCH_DEFAULT_CONFIG, RESEARCH_ENGINE,
  RESEARCH_ACTUAL_TRAIL_MODE, RESEARCH_ACTUAL_TRAIL_MAX_AGE_TICKS,
  RESEARCH_CLOSED_PLAN_FEEDBACK, RESEARCH_EXECUTED_PLAN_FEEDBACK, RESEARCH_EXECUTED_PLAN_MAX_AGE_TICKS,
  RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK, RESEARCH_CLOSED_PLAN_HISTORY_LIMIT, RESEARCH_CLOSED_PLAN_HISTORY_MAX_AGE_TICKS,
  RESEARCH_INFORMATION_FIELDS, RESEARCH_MOVEMENT_FEEDBACK_MODES, RESEARCH_MOVEMENT_RECEIPT_LIMIT,
  RESEARCH_OBSERVATIONS, RESEARCH_PRESSURE, RESEARCH_RULES, RESEARCH_SCHEMA,
  researchSequenceTicks, RESEARCH_SEQUENCE_PROFILE, RESEARCH_SLOTS_MAX_TICKS, RESEARCH_SLOTS_PROFILE,
  RESEARCH_SIM_NODE_SCHEMA, RESEARCH_SEGMENT_TICKS,
  TICK_HZ, researchMovement, researchPlanValidator,
} from '../../shared/survivors-research-contract.js';

export class ResearchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ResearchError('invalid-config', 'Expected a research configuration object.');
  }
  const config = {...RESEARCH_DEFAULT_CONFIG};
  for (const key of Object.keys(config)) {
    if (Object.hasOwn(input, key)) config[key] = input[key];
  }
  if (Object.hasOwn(input, 'observation_fields')) {
    const fields = input.observation_fields;
    if (!Array.isArray(fields) || fields.some(field => !RESEARCH_INFORMATION_FIELDS.includes(field))) {
      throw new ResearchError('invalid-config', 'Invalid information field selection.');
    }
    config.observation_fields = RESEARCH_INFORMATION_FIELDS.filter(field => fields.includes(field));
  }
  if (Object.hasOwn(input, 'pressure_profile')) {
    if (input.pressure_profile !== RESEARCH_PRESSURE) throw new ResearchError('invalid-config', 'Unknown enemy pressure profile.');
    config.pressure_profile = input.pressure_profile;
  }
  if (Object.hasOwn(input, 'movement_feedback')) {
    const mode = input.movement_feedback;
    const profile = mode === RESEARCH_EXECUTED_PLAN_FEEDBACK || mode === RESEARCH_CLOSED_PLAN_FEEDBACK ||
      mode === RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK
      ? RESEARCH_SEQUENCE_PROFILE : RESEARCH_SLOTS_PROFILE;
    if (!RESEARCH_MOVEMENT_FEEDBACK_MODES.includes(mode) ||
        (mode !== 'none' && config.action_profile !== profile)) {
      throw new ResearchError('invalid-config', 'Movement feedback requires a supported mode and matching action profile.');
    }
    config.movement_feedback = mode;
  }
  if (Object.hasOwn(input, 'visual_trail')) {
    if (input.visual_trail !== RESEARCH_ACTUAL_TRAIL_MODE) {
      throw new ResearchError('invalid-config', 'Unknown visual trail mode.');
    }
    config.visual_trail = input.visual_trail;
  }
  if (Object.hasOwn(input, 'pause_for_upgrade')) {
    if (typeof input.pause_for_upgrade !== 'boolean' || input.pause_for_upgrade &&
        (config.action_profile !== RESEARCH_SLOTS_PROFILE || config.latency_compensation_ms !== 0 ||
          config.max_observation_age_ms !== null)) {
      throw new ResearchError('invalid-config', 'Upgrade pause requires fixed slots with no latency compensation or observation expiry.');
    }
    if (input.pause_for_upgrade) config.pause_for_upgrade = true;
  }
  if (input.fixture != null) config.fixture = input.fixture;
  if (Object.hasOwn(input, 'scenario')) {
    const {id, seed, character} = BAT_CRYSTAL_BANDS;
    if (input.scenario !== id || config.fixture !== undefined ||
        Object.hasOwn(input, 'seed') && input.seed !== seed ||
        Object.hasOwn(input, 'character') && input.character !== character) {
      throw new ResearchError('invalid-config', 'Invalid fixed research scenario, seed or character.');
    }
    Object.assign(config, {scenario: id, seed, character});
  }
  const {rules, seed, character, max_ticks, observation_profile, action_profile, max_observation_age_ms,
    latency_compensation_ms, fixture} = config;
  if (rules !== RESEARCH_RULES || ENGINE_ID !== RESEARCH_ENGINE) {
    throw new ResearchError('unsupported-version', 'Unsupported research rules or engine version.');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !CHARACTERS.includes(character) ||
      !Number.isInteger(max_ticks) || max_ticks < 1 || max_ticks > MAX_TICKS ||
      !RESEARCH_OBSERVATIONS.includes(observation_profile) || !RESEARCH_ACTIONS.includes(action_profile) ||
      max_observation_age_ms !== null && (!Number.isFinite(max_observation_age_ms) || max_observation_age_ms < 0) ||
      !Number.isFinite(latency_compensation_ms) || latency_compensation_ms < 0 ||
      latency_compensation_ms > MAX_RESEARCH_LATENCY_COMPENSATION_MS ||
      fixture !== undefined && fixture !== 'pending-upgrade') {
    throw new ResearchError('invalid-config', 'Invalid research seed, character, time limit, profile, age limit, latency compensation budget or fixture.');
  }
  return config;
}

function fixtureState(engine) {
  const checkpoint = engine.exportState();
  const {state} = checkpoint;
  state.player.xp = 100;
  state.player.xpEarned = 100;
  // Put a baseline enemy inside contact range and add ordinary world loot.
  Object.assign(state.enemies[0], {x: 0.05, y: 0.05});
  state.pickups.push({id: state.nextId++, kind: 'coin', x: 0, y: 0});
  state.chests.push({id: state.nextId++, tier: 1, boss: true, x: 1.4, y: 0});
  engine.restoreState(checkpoint);
}

const stop = Object.freeze({id: 'stop', kind: 'stop', x: 0, y: 0});
const stopped = () => ({entry: stop, startTick: null, deadline: null, travelled: 0});
const roundDisplacement = value => Math.round(value * 10000) / 10000 || 0;
const EMPTY_PLAN_HISTORY = Object.freeze([]);
const TRAIL_POINT_CAPACITY = RESEARCH_ACTUAL_TRAIL_MAX_AGE_TICKS + 1;

function executedPlanSummary(plan) {
  return {
    dx: roundDisplacement(plan.dx), dy: roundDisplacement(plan.dy),
    executed_ticks: plan.lastTick - plan.startTick + 1,
    hp_delta: plan.hpDelta,
  };
}

const NODE_FIELDS = ['movement', 'movementPlan', 'planInfo', 'treasureId', 'recentMovementReceipts',
  'receiptEndpoint', 'slotDisplacement', 'closedPlanHistory', 'lastPlanExecution', 'lastClosedPlanExecution',
  'hp', 'distance', 'damageTaken', 'hitsTaken'];
const CLOCK_FIELDS = ['latency_compensation_ms', 'max_observation_age_ms'];

export function resumeConfig(node, overrides = {}) {
  const source = validateConfig(node?.config);
  const config = validateConfig({...source, ...overrides});
  for (const field of new Set([...Object.keys(config), ...Object.keys(source)])) {
    if (!CLOCK_FIELDS.includes(field) && stateHash(config[field] ?? null) !== stateHash(source[field] ?? null)) {
      throw new ResearchError('invalid-resume-node', 'The resume node requires the source simulation profile.');
    }
  }
  return config;
}

export function resumeInitialState(node, durationTicks = RESEARCH_SEGMENT_TICKS) {
  if (!Number.isSafeInteger(durationTicks) || durationTicks < 1) {
    throw new ResearchError('invalid-resume-node', 'The segment must contain at least one simulation tick.');
  }
  return {schema: RESEARCH_SCHEMA, rules: RESEARCH_RULES, engine: RESEARCH_ENGINE,
    node_state: node, limit_tick: node?.base_tick + Math.min(durationTicks, node?.config?.max_ticks - node?.base_tick)};
}

export class ResearchWorld {
  #trail;
  #initialState;

  constructor(config, initialState) {
    this.config = config;
    this.planValidator = researchPlanValidator(config.action_profile);
    this.engine = createSurvivorsGame({seed: config.seed, character: config.character, maxTicks: config.max_ticks,
      denseOpening: config.pressure_profile === RESEARCH_PRESSURE, scenario: config.scenario});
    const node = initialState?.node_state;
    if (initialState) {
      const {schema, rules, engine, checkpoint} = initialState;
      if (schema !== RESEARCH_SCHEMA || rules !== RESEARCH_RULES || engine !== RESEARCH_ENGINE) {
        throw new ResearchError('unsupported-version', 'Unsupported initial research state version.');
      }
      if (node) {
        const {node_hash, ...payload} = node;
        const state = payload.engine_state?.checkpoint?.state;
        const limit = initialState.limit_tick;
        if (node.schema !== RESEARCH_SIM_NODE_SCHEMA || typeof node.source_run_id !== 'string' ||
            !node.source_run_id || node.source_run_id.length > 160 || !Number.isSafeInteger(node.base_tick) ||
            node.base_tick < 0 || state?.tick !== node.base_tick || state.done || state.seed !== config.seed ||
            state.character !== config.character || node.engine_state.checkpoint.maxTicks !== config.max_ticks ||
            !Number.isSafeInteger(limit) || limit <= node.base_tick || limit > config.max_ticks ||
            node_hash !== stateHash(payload)) {
          throw new ResearchError('invalid-resume-node', 'Invalid simulation resume state or time range.');
        }
        resumeConfig(node, config);
        this.engine.restoreContinuationState(node.engine_state);
        this.#initialState = structuredClone(initialState);
      } else {
        if (checkpoint?.state?.tick !== 0 || checkpoint.state.done || checkpoint.state.seed !== config.seed ||
            checkpoint.state.character !== config.character || checkpoint.maxTicks !== config.max_ticks) {
          throw new ResearchError('invalid-replay', 'Initial state and research configuration disagree.');
        }
        this.engine.restoreState(checkpoint);
      }
    } else if (config.fixture === 'pending-upgrade') {
      fixtureState(this.engine);
    }
    const {player, pendingUpgrade} = this.engine.snapshot();
    this.tick = node?.base_tick ?? 0;
    this.baseTick = this.tick;
    this.limitTick = node ? initialState.limit_tick : config.max_ticks;
    this.done = false;
    this.reason = null;
    this.x = player.x;
    this.y = player.y;
    if (config.visual_trail === RESEARCH_ACTUAL_TRAIL_MODE) {
      this.#trail = [Object.freeze({tick: 0, x: this.x, y: this.y})];
    }
    this.level = player.level;
    this.offerId = pendingUpgrade ? `level-${player.level}` : null;
    this.treasureId = null;
    this.movement = stopped();
    this.movementPlan = [];
    this.planInfo = null;
    this.movementFeedback = config.action_profile === RESEARCH_SLOTS_PROFILE &&
      (config.movement_feedback === 'receipts' || config.movement_feedback === 'trajectory') &&
      (!config.observation_fields || config.observation_fields.includes('movement'));
    this.recentMovementReceipts = Object.freeze([]);
    this.receiptEndpoint = null;
    this.slotDisplacement = null;
    this.executedPlanFeedback = config.action_profile === RESEARCH_SEQUENCE_PROFILE &&
      (config.movement_feedback === RESEARCH_EXECUTED_PLAN_FEEDBACK ||
        config.movement_feedback === RESEARCH_CLOSED_PLAN_FEEDBACK ||
        config.movement_feedback === RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK) &&
      (!config.observation_fields || ['movement', 'health'].every(field => config.observation_fields.includes(field)));
    this.closedPlanFeedback = this.executedPlanFeedback && config.movement_feedback === RESEARCH_CLOSED_PLAN_FEEDBACK;
    this.closedPlanHistoryFeedback = this.executedPlanFeedback && config.movement_feedback === RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK;
    this.closedPlanHistory = EMPTY_PLAN_HISTORY;
    this.lastPlanExecution = null;
    this.lastClosedPlanExecution = null;
    this.hp = player.hp;
    this.distance = 0;
    this.damageTaken = 0;
    this.hitsTaken = 0;
    if (node) {
      this.restoreHarness(node.harness);
      this.initialCounters = this.counters();
    }
    this.trace = [];
    this.checkpoints = [this.checkpoint()];
  }

  restoreHarness(harness) {
    if (!harness || NODE_FIELDS.some(field => !Object.hasOwn(harness, field)) ||
        ![harness.hp, harness.distance, harness.damageTaken].every(value => Number.isFinite(value) && value >= 0) ||
        !Number.isSafeInteger(harness.hitsTaken) || harness.hitsTaken < 0 ||
        !Array.isArray(harness.movementPlan) || harness.movementPlan.length > RESEARCH_SLOTS_MAX_TICKS ||
        !Array.isArray(harness.recentMovementReceipts) || !Array.isArray(harness.closedPlanHistory)) {
      throw new ResearchError('invalid-resume-node', 'Invalid controller resume state.');
    }
    const revive = entry => {
      const expected = entry?.id === 'stop' && entry.kind === 'stop' ? stop : researchMovement(this.config.action_profile, entry?.id);
      if (!expected || stateHash(expected) !== stateHash(entry)) {
        throw new ResearchError('invalid-resume-node', 'Invalid inherited movement.');
      }
      return expected;
    };
    const stored = structuredClone(harness);
    const movement = stored.movement;
    const entry = revive(movement?.entry);
    if (!Number.isFinite(movement.travelled) || movement.travelled < 0 ||
        (entry.kind === 'stop' ? movement.startTick !== null || movement.deadline !== null :
          !Number.isSafeInteger(movement.startTick) || !Number.isSafeInteger(movement.deadline) ||
          movement.startTick < 1 || movement.startTick > this.tick + 1 || movement.deadline <= this.tick)) {
      throw new ResearchError('invalid-resume-node', 'Invalid inherited movement time range.');
    }
    movement.entry = entry;
    for (const segment of stored.movementPlan) {
      segment.entry = revive(segment.entry);
      if (!Number.isSafeInteger(segment.duration) || segment.duration < 1 || segment.duration > RESEARCH_SLOTS_MAX_TICKS) {
        throw new ResearchError('invalid-resume-node', 'Invalid pending movement segment.');
      }
    }
    for (const field of NODE_FIELDS) this[field] = stored[field];
    if (this.#trail) {
      const firstTick = Math.max(0, this.tick - RESEARCH_ACTUAL_TRAIL_MAX_AGE_TICKS);
      if (!Array.isArray(stored.trail) || stored.trail.length !== this.tick - firstTick + 1 ||
          stored.trail.some((point, index) => point?.tick !== firstTick + index ||
            !Number.isFinite(point.x) || !Number.isFinite(point.y)) ||
          stored.trail.at(-1).x !== this.x || stored.trail.at(-1).y !== this.y) {
        throw new ResearchError('invalid-resume-node', 'Invalid controller position history.');
      }
      for (const point of stored.trail) this.#trail[point.tick % TRAIL_POINT_CAPACITY] = Object.freeze(point);
    }
  }

  resumeNode(sourceRunId) {
    if (this.done || typeof sourceRunId !== 'string' || !sourceRunId || sourceRunId.length > 160 ||
        this.tick >= this.config.max_ticks || this.engine.snapshot().done) {
      throw new ResearchError('invalid-resume-node', 'Choose a nonterminal frame with time remaining.');
    }
    const harness = Object.fromEntries(NODE_FIELDS.map(field => [field, this[field]]));
    if (this.#trail) harness.trail = this.actualTrail();
    const payload = structuredClone({schema: RESEARCH_SIM_NODE_SCHEMA, source_run_id: sourceRunId, base_tick: this.tick,
      config: this.config, engine_state: this.engine.exportContinuationState(), harness});
    return {...payload, node_hash: stateHash(payload)};
  }

  counters() {
    const {kills, chestsOpened, gold, player} = this.snapshot();
    return {kills, chests_opened: chestsOpened, gold, hp: player.hp, damage_taken: this.damageTaken,
      hits_taken: this.hitsTaken, xp_earned: player.xpEarned, gems_collected: player.gemsCollected, distance: this.distance};
  }

  initialState() {
    return this.#initialState ? structuredClone(this.#initialState)
      : {schema: RESEARCH_SCHEMA, rules: RESEARCH_RULES, engine: RESEARCH_ENGINE, checkpoint: this.engine.exportState()};
  }

  snapshot() {
    const snapshot = {...this.engine.snapshot(), hits_taken: this.hitsTaken};
    return this.done ? {...snapshot, done: true, reason: this.reason} : snapshot;
  }

  checkpoint() {
    return {tick: this.tick, state_hash: stateHash({
      engine: this.engine.exportState(), movement: this.movement, distance: this.distance, reason: this.reason,
      ...(this.movementPlan.length > 0 && {movement_plan: this.movementPlan}),
      ...(this.planInfo && {plan: this.planInfo}),
    })};
  }

  recordCheckpoint() {
    const current = this.checkpoint();
    if (this.checkpoints.at(-1).tick === this.tick) this.checkpoints.pop();
    this.checkpoints.push(current);
  }

  movementInfo() {
    const {entry, deadline, travelled} = this.movement;
    const receiptOffset = this.movementReceiptOffset();
    return {action_id: entry.id, remaining_ticks: deadline === null ? 0 : Math.max(0, deadline - this.tick),
      remaining_distance: entry.kind === 'distance' ? Math.max(0, entry.amount - travelled) : null, travelled,
      ...(this.planInfo && {plan: this.planInfo}),
      ...(this.recentMovementReceipts.length > 0 && {receipts: this.recentMovementReceipts}),
      ...(receiptOffset && {receipt_offset: receiptOffset})};
  }

  movementReceiptOffset() {
    if (!this.receiptEndpoint) return undefined;
    const dx = roundDisplacement(this.x - this.receiptEndpoint.x);
    const dy = roundDisplacement(this.y - this.receiptEndpoint.y);
    return dx || dy ? {dx, dy} : undefined;
  }

  previousMovement() {
    if (this.closedPlanHistoryFeedback) return undefined;
    const plan = this.closedPlanFeedback ? this.lastClosedPlanExecution : this.lastPlanExecution;
    if (!plan) return undefined;
    const age = this.tick - plan.lastTick;
    if (age > RESEARCH_EXECUTED_PLAN_MAX_AGE_TICKS) return undefined;
    return {...executedPlanSummary(plan), age_ticks: age};
  }

  movementHistory() {
    if (this.done || this.offerId || this.closedPlanHistory.length === 0) return undefined;
    return this.closedPlanHistory.map(({endTick, summary}) => ({...summary, age_ticks: this.tick - endTick}));
  }

  actualTrail() {
    if (!this.#trail || this.done) return undefined;
    const oldestTick = Math.max(0, this.tick - RESEARCH_ACTUAL_TRAIL_MAX_AGE_TICKS);
    const points = [];
    for (let tick = oldestTick; tick <= this.tick; tick++) {
      points.push(this.#trail[tick % TRAIL_POINT_CAPACITY]);
    }
    return Object.freeze(points);
  }

  recordExecutedMovement(next) {
    const startTick = this.planInfo?.started_tick;
    if (startTick !== undefined) {
      if (this.lastPlanExecution?.startTick !== startTick) {
        this.lastPlanExecution = {startTick, x: this.x, y: this.y, hp: this.hp};
      }
      const plan = this.lastPlanExecution;
      plan.lastTick = next.tick;
      plan.dx = next.x - plan.x;
      plan.dy = next.y - plan.y;
      plan.hpDelta = next.hp - plan.hp;
    }
    this.hp = next.hp;
  }

  movementVector() {
    const {entry} = this.movement;
    const magnitude = Math.max(1, Math.hypot(entry.x, entry.y));
    return [entry.x / magnitude, entry.y / magnitude];
  }

  choiceIndex(actionId) {
    if (!this.offerId || !actionId.startsWith(`choose:${this.offerId}:`)) return -1;
    const optionId = actionId.split(':')[2];
    return this.engine.snapshot().pendingUpgrade.findIndex(option => option.id === optionId);
  }

  endMovement(reason, tick, events) {
    if (this.movement.entry.kind !== 'stop') {
      const receipt = this.closeMovementReceipt(reason);
      if (!this.planInfo || this.movement.startTick <= this.tick) events.push({type: 'movement_ended', tick, action_id: this.movement.entry.id, reason,
        started_tick: this.movement.startTick, travelled: this.movement.travelled,
        ...(receipt && {receipt}),
        ...(this.movement.entry.kind === 'distance' ? {target_distance: this.movement.entry.amount} : {})});
      this.movement = stopped();
    }
  }

  closeMovementReceipt(reason) {
    const displacement = this.slotDisplacement;
    this.slotDisplacement = null;
    if (!displacement?.ticks) return undefined;
    const receipt = Object.freeze({action_id: this.movement.entry.id, started_tick: this.movement.startTick,
      executed_ticks: displacement.ticks, dx: roundDisplacement(displacement.dx), dy: roundDisplacement(displacement.dy),
      reason: reason === 'hold-expired' ? 'completed' : reason});
    this.recentMovementReceipts = Object.freeze([
      ...this.recentMovementReceipts, receipt,
    ].slice(-RESEARCH_MOVEMENT_RECEIPT_LIMIT));
    this.receiptEndpoint = {x: this.x, y: this.y};
    return receipt;
  }

  endPlan(reason, tick, events) {
    if (!this.planInfo) return;
    const plan = this.planInfo;
    if (this.closedPlanFeedback && this.lastPlanExecution?.startTick === plan.started_tick) {
      // The next plan will start a new accumulator on its first successful tick.
      this.lastClosedPlanExecution = this.lastPlanExecution;
    }
    const executed = this.lastPlanExecution;
    if (this.closedPlanHistoryFeedback && reason !== 'run-ended' &&
        executed?.startTick === plan.started_tick && executed.lastTick >= executed.startTick) {
      const entry = Object.freeze({endTick: executed.lastTick, summary: Object.freeze(executedPlanSummary(executed))});
      this.closedPlanHistory = Object.freeze([...this.closedPlanHistory, entry].slice(-RESEARCH_CLOSED_PLAN_HISTORY_LIMIT));
    }
    events.push({type: 'movement_plan_ended', tick, reason, action_id: plan.action_ids[0], ...plan,
      executed_ticks: Math.min(plan.scheduled_ticks, this.tick - plan.started_tick + 1)});
    this.planInfo = null;
    this.movementPlan = [];
  }

  startMovement(entry, duration, tick) {
    this.movement = {entry, startTick: tick, deadline: tick + duration - 1, travelled: 0};
    if (this.movementFeedback) this.slotDisplacement = {ticks: 0, dx: 0, dy: 0};
  }

  startPlan(actionIds, tick, events) {
    const profile = this.config.action_profile;
    const budget = profile === RESEARCH_SLOTS_PROFILE ? RESEARCH_SLOTS_MAX_TICKS : researchSequenceTicks(profile);
    let remaining = budget;
    let requestedTicks = 0;
    const segments = [];
    for (const id of actionIds) {
      const entry = researchMovement(profile, id);
      const duration = entry.kind === 'ticks' ? entry.amount : Math.ceil(entry.amount * TICK_HZ / 1000);
      requestedTicks += duration;
      const scheduled = Math.min(remaining, duration);
      if (scheduled > 0) segments.push({entry, duration: scheduled});
      remaining -= scheduled;
    }
    const [first, ...rest] = segments;
    this.movementPlan = rest;
    this.planInfo = Object.freeze({
      action_ids: Object.freeze([...actionIds]), index: 0, scheduled_segments: segments.length,
      requested_ticks: requestedTicks, scheduled_ticks: budget - remaining, started_tick: tick,
    });
    this.startMovement(first.entry, first.duration, tick);
    if (requestedTicks > budget) {
      events.push({type: 'movement_plan_truncated', tick, action_id: actionIds[0], action_ids: [...actionIds],
        requested_ticks: requestedTicks, scheduled_ticks: budget});
    }
  }

  advance(actionId = null, actionIds) {
    if (this.done) throw new ResearchError('terminal', 'The run has ended.');
    const tick = this.tick + 1;
    const events = [];
    const previousMovement = {...this.movement};
    const previousPlan = this.movementPlan;
    const previousPlanInfo = this.planInfo;
    const previousDisplacement = this.slotDisplacement;
    const previousReceipts = this.recentMovementReceipts;
    const previousReceiptEndpoint = this.receiptEndpoint;
    const previousClosedPlanExecution = this.lastClosedPlanExecution;
    const previousClosedPlanHistory = this.closedPlanHistory;
    let choice;
    let selected;
    if (actionId !== null) {
      const validatePlan = this.planValidator;
      selected = this.config.action_profile === RESEARCH_SEQUENCE_PROFILE && actionIds === undefined ? [actionId] : actionIds;
      if (validatePlan ? !validatePlan(actionId, selected) : actionIds !== undefined) {
        throw new ResearchError('invalid-action-sequence', 'Invalid action sequence for this profile.');
      }
      const entry = researchMovement(this.config.action_profile, actionId);
      if (entry) {
        this.endMovement(entry.kind === 'stop' ? 'stopped' : 'replaced', tick, events);
        this.endPlan(entry.kind === 'stop' ? 'stopped' : 'replaced', tick, events);
        if (entry.kind !== 'stop') {
          if (validatePlan) this.startPlan(selected, tick, events);
          else {
            const duration = entry.kind === 'hold' ? Math.ceil(entry.amount * TICK_HZ / 1000) : DISTANCE_TIMEOUT_TICKS;
            this.startMovement(entry, duration, tick);
          }
        }
      } else {
        choice = this.choiceIndex(actionId);
        if (choice < 0) throw new ResearchError('stale-offer', 'The selected upgrade offer is no longer available.');
        if (validatePlan) {
          this.endMovement('replaced', tick, events);
          this.endPlan('replaced', tick, events);
        }
        events.push({type: 'upgrade_selected', tick, offer_id: this.offerId, option_id: actionId.split(':')[2]});
      }
    }

    const {x, y} = this.movement.entry;
    let next;
    try {
      next = this.engine.advance({moveX: x, moveY: y, choice});
    } catch (error) {
      this.movement = previousMovement;
      this.movementPlan = previousPlan;
      this.planInfo = previousPlanInfo;
      this.slotDisplacement = previousDisplacement;
      this.recentMovementReceipts = previousReceipts;
      this.receiptEndpoint = previousReceiptEndpoint;
      this.lastClosedPlanExecution = previousClosedPlanExecution;
      this.closedPlanHistory = previousClosedPlanHistory;
      throw error;
    }
    this.tick = next.tick;
    if (this.closedPlanHistory.length > 0 &&
        this.tick - this.closedPlanHistory[0].endTick > RESEARCH_CLOSED_PLAN_HISTORY_MAX_AGE_TICKS) {
      this.closedPlanHistory = Object.freeze(this.closedPlanHistory.filter(
        ({endTick}) => this.tick - endTick <= RESEARCH_CLOSED_PLAN_HISTORY_MAX_AGE_TICKS));
    }
    this.level = next.level;
    if (this.executedPlanFeedback) this.recordExecutedMovement(next);
    const dx = next.x - this.x, dy = next.y - this.y;
    const travelled = Math.hypot(dx, dy);
    if (this.slotDisplacement) {
      this.slotDisplacement.ticks++;
      this.slotDisplacement.dx += dx;
      this.slotDisplacement.dy += dy;
    }
    this.distance += travelled;
    this.damageTaken += next.damageTaken;
    if (next.damageTaken > 0) {
      this.hitsTaken++;
      events.push({type: 'player_hit', tick, damage: next.damageTaken, hits_taken: this.hitsTaken});
    }
    this.x = next.x;
    this.y = next.y;
    if (this.#trail) {
      this.#trail[this.tick % TRAIL_POINT_CAPACITY] = Object.freeze({tick: this.tick, x: this.x, y: this.y});
    }
    this.movement.travelled += travelled;
    if (next.done) this.finish(next.reason, events);
    else if (this.movement.entry.kind === 'distance' && this.movement.travelled >= this.movement.entry.amount) {
      this.endMovement('distance-reached', tick, events);
    } else if (this.movement.deadline === tick) {
      this.endMovement(this.movement.entry.kind === 'distance' ? 'distance-timeout' : 'hold-expired', tick, events);
      if (this.movementPlan.length > 0) {
        const [nextSegment, ...rest] = this.movementPlan;
        this.movementPlan = rest;
        this.startMovement(nextSegment.entry, nextSegment.duration, tick + 1);
        this.planInfo = Object.freeze({...this.planInfo, index: this.planInfo.index + 1});
      } else this.endPlan('completed', tick, events);
    }
    const offerId = next.pendingUpgrade && !next.done ? `level-${next.level}` : null;
    if (offerId && offerId !== this.offerId) {
      events.push({type: 'upgrade_offered', tick, offer_id: offerId});
    }
    this.offerId = offerId;
    if (next.lastTreasure && next.lastTreasure.id !== this.treasureId) {
      this.treasureId = next.lastTreasure.id;
      events.push({type: 'treasure', tick, reward: next.lastTreasure});
    }
    const traceMovement = selected ? JSON.stringify([this.movement.entry.id, selected]) : this.movement.entry.id;
    this.trace.push(this.engine.trace(traceMovement));
    if (!this.done && tick === this.limitTick && this.#initialState) this.finish('segment-limit', events);
    if (!this.done && tick % TICK_HZ === 0) this.recordCheckpoint();
    return events;
  }

  finish(reason, events = []) {
    if (!this.done) {
      this.beforeFinish?.(reason);
      this.done = true;
      this.reason = reason;
      this.endMovement('run-ended', this.tick, events);
      this.endPlan('run-ended', this.tick, events);
      this.closedPlanHistory = EMPTY_PLAN_HISTORY;
      this.#trail = undefined;
      this.recordCheckpoint();
    }
    return events;
  }

  performanceResult() {
    const {kills, chestsOpened, gold, player} = this.snapshot();
    return {reason: this.reason, tick: this.tick, kills, chests_opened: chestsOpened, gold,
      level: player.level, hp: player.hp, max_hp: player.maxHp, damage_taken: this.damageTaken, hits_taken: this.hitsTaken,
      xp: player.xp, xp_earned: player.xpEarned, gems_collected: player.gemsCollected,
      distance: this.distance, state_hash: this.checkpoint().state_hash, checkpoints: this.checkpoints.slice(),
      trace: this.trace.slice(),
      ...(this.#initialState && {base_tick: this.baseTick, limit_tick: this.limitTick, elapsed_ticks: this.tick - this.baseTick,
        branch_sim_time_ms: (this.tick - this.baseTick) * 1000 / TICK_HZ, initial_counters: {...this.initialCounters}})};
  }
}
