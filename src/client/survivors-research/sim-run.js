import {
  MAX_RESEARCH_LATENCY_COMPENSATION_MS, RESEARCH_CLOCK_POLICY, RESEARCH_ENGINE, RESEARCH_RULES, RESEARCH_SCHEMA,
  RESEARCH_SEQUENCE_PROFILE, RESEARCH_SLOTS_COUNT, RESEARCH_SLOTS_PROFILE, TICK_MS, researchMovement, researchPlanValidator,
} from '../../shared/survivors-research-contract.js';
import {projectObservation} from './sim-observation.js';
import {projectVisualFrame} from './sim-visual-frame.js';
import {ResearchError, ResearchWorld, resumeConfig, resumeInitialState, validateConfig} from './sim-world.js';

export const epochNow = () => performance.timeOrigin + performance.now();
const hasId = id => typeof id === 'string' && id.length > 0 && id.length <= 160;
const sameSequence = (a, b) => a === b ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, index) => id === b[index]));
const DECISION_CAP = 250_000;
const pauseDuration = (pause, at) => Math.max(0, Math.min(pause.budget_ms, at - pause.started_at_ms));
const WAITING_OBSERVERS_CAP = 16;
const LAG_BUCKETS_MS = [1, 2, 4, 8, 16, 20, 25, 33, 50, 75, 100, 150, 250, 500, 1000, 2000, 5000, 30000];
const {max_steps_per_pump: MAX_STEPS, max_lag_ms: MAX_LAG, sustained_lag_ms: SUSTAINED_LAG,
  snapshot_interval_ticks: SNAPSHOT_INTERVAL} = RESEARCH_CLOCK_POLICY;

export class ResearchRun {
  constructor({
    runId, config, nodeState, durationTicks, send, now = epochNow, allowSameObservationTick = false,
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = timer => globalThis.clearTimeout(timer),
  }) {
    this.runId = runId;
    this.config = nodeState ? resumeConfig(nodeState, config) : validateConfig(config);
    this.world = new ResearchWorld(this.config, nodeState && resumeInitialState(nodeState, durationTicks));
    this.resumed = Boolean(nodeState);
    this.baseTick = this.world.baseTick;
    this.initialSample = null;
    this.send = send;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timer = null;
    this.status = 'created';
    this.startedAt = null;
    this.endedAt = null;
    this.observations = new Map();
    this.lastSample = null;
    this.waiters = [];
    this.decisions = new Map();
    this.lastAppliedObservationTick = -1;
    this.allowSameObservationTick = allowSameObservationTick;
    this.pending = null;
    this.actions = [];
    this.invalidReasons = new Set();
    this.lagSince = null;
    this.compensationReceipts = new Map();
    this.inFlightDecision = null;
    this.activePause = null;
    this.pausedMs = 0;
    this.upgradePause = null;
    this.upgradePausedMs = 0;
    this.clock = {
      policy: RESEARCH_CLOCK_POLICY, lag_ms: 0, max_lag_ms: 0, max_backlog_ticks: 0,
      pump_count: 0, catchup_pumps: 0, max_pump_ms: 0, max_tick_ms: 0, mean_lag_ms: 0,
      lag_bucket_upper_bounds_ms: LAG_BUCKETS_MS,
      lag_bucket_counts: Array(LAG_BUCKETS_MS.length + 1).fill(0),
    };
  }

  emit(type, fields) {
    this.send({schema: RESEARCH_SCHEMA, type, run_id: this.runId, ...fields});
  }

  event(type, fields = {}) {
    this.emit('research:event', {event: {type, tick: this.world.tick, at_ms: this.now(), ...fields}});
  }

  clockSnapshot(at = this.endedAt ?? this.now()) {
    return {...this.clock, lag_bucket_counts: this.clock.lag_bucket_counts.slice(),
      latency_compensated_ms: this.totalPausedAt(at), effective_elapsed_ms: this.effectiveElapsedAt(at),
      latency_pause_active: this.activePause !== null && at < this.activePause.deadline_at_ms,
      ...(this.config.pause_for_upgrade && {upgrade_pause_active: this.upgradePause !== null,
        upgrade_paused_ms: this.upgradePausedAt(at)})};
  }

  totalPausedAt(at) {
    const active = this.activePause;
    return this.pausedMs + (active ? pauseDuration(active, at) : 0);
  }

  upgradePausedAt(at) {
    return this.upgradePausedMs + (this.upgradePause ? Math.max(0, at - this.upgradePause.startedAt) : 0);
  }

  effectiveElapsedAt(at) {
    return this.startedAt === null ? 0 : Math.max(0, at - this.startedAt - this.totalPausedAt(at) - this.upgradePausedAt(at));
  }

  pauseForUpgrade(offerId) {
    // Discard overdue time beyond the offer so a catch-up pump cannot leak extra ticks.
    const startedAt = this.startedAt + this.upgradePausedMs + (this.world.tick - this.baseTick) * TICK_MS;
    this.upgradePause = {offerId, startedAt};
    this.event('upgrade_pause_started', {offer_id: offerId});
  }

  closeUpgradePause(at) {
    if (!this.upgradePause) return undefined;
    const {offerId, startedAt} = this.upgradePause;
    const duration = Math.max(0, at - startedAt);
    this.upgradePausedMs += duration;
    this.upgradePause = null;
    return {offer_id: offerId, paused_ms: duration, upgrade_paused_ms: this.upgradePausedMs};
  }

  compensationReceipt(record, at) {
    if (record !== this.activePause) return {...record};
    return {...record, paused_ms: pauseDuration(record, at)};
  }

  beginLatency(decisionId, budget = this.config.latency_compensation_ms) {
    if (this.config.pause_for_upgrade) {
      throw new ResearchError('invalid-latency-budget', 'Upgrade pause does not use latency compensation.');
    }
    if (!hasId(decisionId)) throw new ResearchError('invalid-decision-id', 'A valid decision_id is required.');
    if (!Number.isFinite(budget) || budget < 0 || budget > MAX_RESEARCH_LATENCY_COMPENSATION_MS) {
      throw new ResearchError('invalid-latency-budget', 'Expected a supported latency compensation budget.');
    }
    const at = this.now();
    const original = this.compensationReceipts.get(decisionId);
    if (original) {
      this.expirePause(at);
      return {latency_compensation: this.compensationReceipt(original, at)};
    }
    if (this.status !== 'running') {
      const terminal = this.status === 'ended';
      throw new ResearchError(terminal ? 'terminal' : 'not-running', terminal ? 'The run has ended.' : 'The run has not started.');
    }
    if (this.inFlightDecision || this.pending) {
      throw new ResearchError('latency-in-flight', 'Finish the previous decision before opening a compensation window.');
    }
    if (this.decisions.has(decisionId)) throw new ResearchError('decision-conflict', 'The decision has already been submitted.');
    if (this.compensationReceipts.size >= DECISION_CAP) {
      this.invalidate('decision-log-capacity');
      this.finish('evidence-capacity');
      throw new ResearchError('evidence-capacity', 'Decision evidence exceeded the run limit.');
    }

    const active = budget > 0 && this.invalidReasons.size === 0;
    const record = {
      decision_id: decisionId, budget_ms: budget, started_at_ms: active ? at : null,
      deadline_at_ms: active ? at + budget : null, ended_at_ms: null, paused_ms: 0, active,
      reason: active ? null : budget === 0 ? 'disabled' : 'environment-invalid',
    };
    this.compensationReceipts.set(decisionId, record);
    if (budget > 0) this.inFlightDecision = decisionId;
    if (active) {
      this.activePause = record;
      this.event('latency_compensation_started', {...record, latency_compensated_ms: this.pausedMs});
      this.rearm();
    }
    return {latency_compensation: {...record}};
  }

  endLatency(decisionId) {
    if (!hasId(decisionId)) throw new ResearchError('invalid-decision-id', 'A valid decision_id is required.');
    const record = this.compensationReceipts.get(decisionId);
    if (!record) throw new ResearchError('unknown-decision', 'No latency compensation window exists for this decision.');
    const at = this.now();
    if (this.inFlightDecision === decisionId) this.inFlightDecision = null;
    if (record === this.activePause) {
      this.closePause(at, 'request-ended');
      this.rearm();
    }
    return {latency_compensation: {...record}};
  }

  closePause(at, reason) {
    const record = this.activePause;
    if (!record) return false;
    const endedAt = Math.min(at, record.deadline_at_ms);
    Object.assign(record, {active: false, ended_at_ms: endedAt,
      paused_ms: pauseDuration(record, endedAt),
      reason: at >= record.deadline_at_ms ? 'budget-expired' : reason});
    this.activePause = null;
    this.pausedMs += record.paused_ms;
    this.event('latency_compensation_ended', {...record, latency_compensated_ms: this.pausedMs});
    return true;
  }

  expirePause(at) {
    if (this.activePause && at >= this.activePause.deadline_at_ms) {
      this.closePause(at, 'budget-expired');
      this.rearm();
    }
  }

  rearm() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.arm();
  }

  publishSnapshot() {
    const started = this.now();
    const snapshot = this.world.snapshot();
    this.emit('research:snapshot', {snapshot, movement: this.world.movementInfo(), clock: this.clockSnapshot(),
      sampled_at_ms: started, snapshot_ready_at_ms: this.now()});
    this.clock.max_snapshot_send_ms = Math.max(this.clock.max_snapshot_send_ms ?? 0, this.now() - started);
  }

  start(includeInitialVisualFrame = false) {
    if (typeof includeInitialVisualFrame !== 'boolean') {
      throw new ResearchError('invalid-visual-frame-option', 'include_initial_visual_frame must be a boolean.');
    }
    if (this.status === 'ended') throw new ResearchError('terminal', 'The run has ended.');
    if (this.status === 'created') {
      this.startedAt = this.now();
      this.status = 'running';
      this.event('run_started', {started_at_ms: this.startedAt});
      if (this.resumed) {
        this.initialSample = this.sample(includeInitialVisualFrame, this.startedAt, false);
        if (this.config.pause_for_upgrade && this.world.offerId) this.pauseForUpgrade(this.world.offerId);
      }
      this.publishSnapshot();
      this.arm();
    }
    return {started_at_ms: this.startedAt, tick: this.world.tick, ...(this.initialSample && {initial_sample: this.initialSample})};
  }

  arm() {
    if (this.status === 'running' && !this.upgradePause) {
      const dueAt = this.activePause?.deadline_at_ms ?? this.startedAt + this.pausedMs + this.upgradePausedMs + (this.world.tick - this.baseTick + 1) * TICK_MS;
      // A late callback catches up in bounded batches. The next callback keeps
      // its original deadline so no part of the world clock is discarded.
      this.timer = this.schedule(() => this.pump(), Math.max(0, dueAt - this.now()));
    }
  }

  invalidate(reason, fields = {}) {
    if (this.invalidReasons.has(reason)) return;
    this.invalidReasons.add(reason);
    this.event('environment_invalid', {reason, ...fields});
  }

  lifecycle(state) {
    if (!['visible', 'hidden', 'pagehide', 'freeze', 'resume'].includes(state)) {
      throw new ResearchError('invalid-lifecycle', 'Unknown document lifecycle state.');
    }
    this.event('lifecycle', {state});
    if (['hidden', 'pagehide', 'freeze'].includes(state) && this.status !== 'ended') {
      const reason = state === 'hidden' ? 'page-hidden' : state;
      this.invalidate(`page-${state}`);
      if (this.closePause(this.now(), reason)) this.rearm();
    }
    return {state};
  }

  pump() {
    this.timer = null;
    if (this.status !== 'running' || this.upgradePause) return;
    const started = this.now();
    if (this.activePause) {
      if (started < this.activePause.deadline_at_ms) {
        this.arm();
        return;
      }
      this.closePause(started, 'budget-expired');
    }
    const elapsed = this.effectiveElapsedAt(started);
    const overdue = Math.max(0, Math.floor(elapsed / TICK_MS + 1e-4) - (this.world.tick - this.baseTick));
    if (!overdue) {
      this.arm();
      return;
    }
    const lag = Math.max(0, elapsed - (this.world.tick - this.baseTick) * TICK_MS);
    const clock = this.clock;
    clock.lag_ms = lag;
    clock.max_lag_ms = Math.max(clock.max_lag_ms, lag);
    clock.max_backlog_ticks = Math.max(clock.max_backlog_ticks, overdue);
    clock.pump_count++;
    clock.mean_lag_ms += (lag - clock.mean_lag_ms) / clock.pump_count;
    const bucket = LAG_BUCKETS_MS.findIndex(upper => lag <= upper);
    clock.lag_bucket_counts[bucket === -1 ? LAG_BUCKETS_MS.length : bucket]++;
    if (overdue > 1) clock.catchup_pumps++;
    if (lag > MAX_LAG) {
      if (this.lagSince === null) {
        this.lagSince = elapsed;
        this.event('clock_backlog', {lag_ms: lag, backlog_ticks: overdue});
      }
      if (elapsed - this.lagSince >= SUSTAINED_LAG || lag > SUSTAINED_LAG) {
        this.invalidate('clock-lag', {lag_ms: lag, backlog_ticks: overdue});
      }
    } else if (this.lagSince !== null) {
      this.event('clock_recovered', {lag_ms: lag});
      this.lagSince = null;
    }
    const previousTick = this.world.tick;
    try {
      for (let step = 0; step < Math.min(overdue, MAX_STEPS) && !this.world.done && !this.upgradePause; step++) {
        this.advance();
      }
    } catch (error) {
      this.invalidate('simulation-error', {message: error.message});
      this.finish('simulation-error');
      return;
    } finally {
      clock.max_pump_ms = Math.max(clock.max_pump_ms, this.now() - started);
      clock.lag_ms = Math.max(0, this.effectiveElapsedAt(this.now()) - (this.world.tick - this.baseTick) * TICK_MS);
    }
    if (this.world.done) {
      this.finish(this.world.reason);
      return;
    }
    if (this.upgradePause || Math.floor(previousTick / SNAPSHOT_INTERVAL) !== Math.floor(this.world.tick / SNAPSHOT_INTERVAL)) {
      this.publishSnapshot();
    }
    this.flushObservers();
    this.arm();
  }

  advance() {
    let pending = this.pending;
    this.pending = null;
    const tickStarted = this.now();
    const ageLimit = this.config.max_observation_age_ms;
    if (pending && ageLimit !== null && tickStarted - pending.sampled_at_ms > ageLimit) {
      this.rejectPending(pending, 'observation-expired', 'The observation expired before the next tick.');
      pending = null;
    }
    let events;
    try {
      events = this.world.advance(pending?.action_id, pending?.action_ids);
      this.lastSample = null;
    } catch (error) {
      if (pending) this.rejectPending(pending, 'simulation-error', error.message);
      throw error;
    }
    const appliedAt = this.now();
    this.clock.max_tick_ms = Math.max(this.clock.max_tick_ms, appliedAt - tickStarted);
    if (pending) {
      const {action_id, action_ids, decision_id, observation_id, observation_tick, sampled_at_ms, received_at_ms, paused_at_sample_ms} = pending;
      const rawAge = Math.max(0, tickStarted - sampled_at_ms);
      const pausedAge = Math.max(0, Math.min(rawAge, this.totalPausedAt(tickStarted) - paused_at_sample_ms));
      const evidence = {action_id, ...(action_ids && {action_ids}), decision_id, observation_id, observation_tick, sampled_at_ms,
        received_at_ms, applied_tick: this.world.tick, applied_at_ms: tickStarted, tick_completed_at_ms: appliedAt,
        observation_age_ms: rawAge, adjusted_observation_age_ms: rawAge - pausedAge,
        latency_compensated_ms: pausedAge, source: 'controller'};
      this.lastAppliedObservationTick = observation_tick;
      this.actions.push(evidence);
      this.event('action_applied', evidence);
      pending.resolve(evidence);
    }
    for (const {type, ...fields} of events) {
      this.event(type, fields);
      if (type === 'upgrade_selected' && pending?.upgradePause) {
        this.event('upgrade_pause_ended', {...pending.upgradePause, reason: 'selected'});
      }
      if (type === 'upgrade_offered' && this.config.pause_for_upgrade && !this.world.done) {
        this.pauseForUpgrade(fields.offer_id);
      }
    }
  }

  observe(afterTick = -1, includeVisualFrame = false, receivedAt = this.now()) {
    if (typeof includeVisualFrame !== 'boolean') {
      throw new ResearchError('invalid-visual-frame-option', 'include_visual_frame must be a boolean.');
    }
    if (!Number.isInteger(afterTick) || afterTick < -1 || afterTick > this.world.tick) {
      throw new ResearchError('invalid-after-tick', 'after_tick must refer to a current or earlier tick, or -1.');
    }
    if (this.status === 'ended' || this.world.tick > afterTick) {
      return this.sample(includeVisualFrame, receivedAt, false);
    }
    if (this.status !== 'running') throw new ResearchError('not-running', 'Start the run before waiting for its next tick.');
    if (this.waiters.length >= WAITING_OBSERVERS_CAP) {
      throw new ResearchError('too-many-observers', 'Too many observation requests are waiting for a tick.');
    }
    return new Promise((resolve, reject) => this.waiters.push({afterTick, includeVisualFrame, receivedAt, resolve, reject}));
  }

  sample(includeVisualFrame, receivedAt, waitedForNewTick) {
    const startedAt = this.now();
    let sample = this.lastSample;
    const cacheHit = Boolean(sample && sample.payload.terminal === this.world.done);
    const timing = {
      request_received_at_ms: receivedAt,
      sample_started_at_ms: startedAt,
      waited_for_new_tick: waitedForNewTick,
      snapshot_started_at_ms: null,
      snapshot_finished_at_ms: null,
      observation_project_started_at_ms: null,
      observation_project_finished_at_ms: null,
      ...(this.config.visual_trail && {
        actual_trail_capture_started_at_ms: null,
        actual_trail_capture_finished_at_ms: null,
      }),
      visual_project_started_at_ms: null,
      visual_project_finished_at_ms: null,
      response_post_started_at_ms: null,
      snapshot_cache_hit: cacheHit,
      observation_cache_hit: cacheHit,
      visual_cache_hit: null,
    };
    if (!cacheHit) {
      const sampledAt = this.now();
      timing.snapshot_started_at_ms = sampledAt;
      const snapshot = this.world.snapshot();
      timing.snapshot_finished_at_ms = this.now();
      const movement = this.world.movementVector();
      timing.observation_project_started_at_ms = this.now();
      const {observation, candidates} = projectObservation({
        snapshot, config: this.config, runId: this.runId, movement,
        movementReceipts: this.world.recentMovementReceipts, movementReceiptOffset: this.world.movementReceiptOffset(),
        previousMovement: this.world.previousMovement(),
        movementHistory: this.world.movementHistory(),
        sampledAt, now: this.now,
      });
      const {observation_id, tick, terminal, projected_at_ms, upgrade_offer: offer} = observation;
      timing.observation_project_finished_at_ms = projected_at_ms;
      if (!terminal) {
        const availableOffer = offer && {
          id: offer.offer_id,
          options: offer.options.map(option => option.option_id),
        };
        this.observations.set(observation_id, {tick, sampledAt, offer: availableOffer, pausedAtSample: this.totalPausedAt(sampledAt)});
      }
      // Capture the trail with the snapshot even when the first observer only asks for JSON.
      let actualTrail;
      if (this.config.visual_trail) {
        timing.actual_trail_capture_started_at_ms = this.now();
        actualTrail = this.world.actualTrail();
        timing.actual_trail_capture_finished_at_ms = this.now();
      }
      sample = {snapshot, movement, actualTrail, payload: {observation, candidates, terminal}};
      this.lastSample = sample;
      this.event('observation_sampled', {observation_id, sampled_at_ms: sampledAt, projected_at_ms, terminal});
    }
    const response = {...sample.payload, observation_timing: timing};
    if (includeVisualFrame) {
      timing.visual_cache_hit = Boolean(sample.visualFrame);
      if (!sample.visualFrame) {
        timing.visual_project_started_at_ms = this.now();
        sample.visualFrame = projectVisualFrame(sample.snapshot, sample.movement,
          sample.payload.observation.sampled_at_ms, this.now, this.config.observation_fields, sample.actualTrail);
        timing.visual_project_finished_at_ms = sample.visualFrame.projected_at_ms;
      }
      response.visual_frame = sample.visualFrame;
    }
    return response;
  }

  flushObservers() {
    const ready = this.waiters.filter(waiter => this.status === 'ended' || this.world.tick > waiter.afterTick);
    if (!ready.length) return;
    this.waiters = this.waiters.filter(waiter => !ready.includes(waiter));
    for (const waiter of ready) {
      try {
        waiter.resolve(this.sample(waiter.includeVisualFrame, waiter.receivedAt, true));
      } catch (error) {
        waiter.reject(error);
      }
    }
  }

  submit({observation_id, decision_id, action_id, action_ids}) {
    const fields = {observation_id, decision_id, action_id};
    if (!hasId(decision_id)) return this.rejectAction(fields, 'invalid-action', 'A valid decision_id is required.');
    const profile = this.config.action_profile;
    const validatePlan = researchPlanValidator(profile);
    const selected = profile === RESEARCH_SEQUENCE_PROFILE && action_ids === undefined ? [action_id] : action_ids;
    if (Array.isArray(selected) && selected.length <= RESEARCH_SLOTS_COUNT && Array.from(selected).every(hasId)) {
      fields.action_ids = Object.freeze([...selected]);
    }
    const validSequence = validatePlan ? validatePlan(action_id, fields.action_ids) : selected === undefined;
    const original = this.decisions.get(decision_id);
    if (original) {
      if (!validSequence || original.observation_id !== observation_id || original.action_id !== action_id ||
          !sameSequence(original.action_ids, fields.action_ids)) {
        return this.rejectAction(fields, 'decision-conflict', 'This decision ID was used for another action.');
      }
      return original.outcome;
    }
    if (this.decisions.size >= DECISION_CAP) {
      this.invalidate('decision-log-capacity');
      this.finish('evidence-capacity');
      return this.rejectAction(fields, 'evidence-capacity', 'Decision evidence exceeded the run limit.');
    }
    const receivedAt = this.now();
    const sample = this.observations.get(observation_id);
    const rejection = validSequence ? this.validateAction({observation_id, action_id, sample, receivedAt})
      : ['invalid-action-sequence', 'Invalid action sequence for this profile.'];
    const outcome = rejection ? this.rejectAction(fields, ...rejection) : new Promise((resolve, reject) => {
      this.pending = {...fields, observation_tick: sample.tick, sampled_at_ms: sample.sampledAt,
        received_at_ms: receivedAt, paused_at_sample_ms: sample.pausedAtSample, resolve, reject};
      this.event('action_accepted', {...fields, observation_tick: sample.tick, received_at_ms: receivedAt});
      if (this.upgradePause) {
        this.pending.upgradePause = this.closeUpgradePause(receivedAt);
        this.arm();
      }
    });
    // A malformed sequence may be retried after correction. Valid submissions
    // keep the original outcome for idempotent delivery.
    if (validSequence) this.decisions.set(decision_id, {...fields, outcome});
    return outcome;
  }

  validateAction({observation_id, action_id, sample, receivedAt}) {
    if (this.status !== 'running') return this.status === 'ended'
      ? ['terminal', 'The run has ended.'] : ['not-running', 'The run has not started.'];
    if (!hasId(observation_id) || !hasId(action_id)) return ['invalid-action', 'An observation ID and action ID are required.'];
    if (!sample) return ['unknown-observation', 'This run did not issue the specified observation.'];
    if (sample.tick < this.lastAppliedObservationTick ||
        sample.tick === this.lastAppliedObservationTick && !this.allowSameObservationTick) {
      return ['out-of-order', 'Use a newer observation than the last applied decision.'];
    }
    if (this.pending) return ['action-in-flight', 'Wait for the preceding action acknowledgement.'];
    if (this.inFlightDecision) return ['latency-in-flight', 'End the current model request before submitting an action.'];
    const age = this.config.max_observation_age_ms;
    if (age !== null && receivedAt - sample.sampledAt > age) return ['observation-expired', 'The observation exceeded the configured age limit.'];
    if (researchMovement(this.config.action_profile, action_id)) {
      if (this.upgradePause) return ['unknown-candidate', 'This observation requires an upgrade choice.'];
      return this.config.action_profile === RESEARCH_SLOTS_PROFILE && sample.offer
        ? ['unknown-candidate', 'This observation requires an upgrade choice.'] : null;
    }
    if (!action_id.startsWith('choose:')) return ['unknown-candidate', 'Unknown movement action for this profile.'];
    const currentOffer = this.world.offerId;
    const [prefix, offerId, optionId, ...extra] = action_id.split(':');
    if (prefix !== 'choose' || !offerId || !optionId || extra.length) return ['unknown-candidate', 'Invalid upgrade action ID.'];
    if (currentOffer !== offerId || sample.offer?.id !== offerId) return ['stale-offer', 'The selected offer is no longer available in this observation.'];
    if (!sample.offer.options.includes(optionId)) return ['unknown-candidate', 'Unknown upgrade option.'];
    return null;
  }

  rejectAction(fields, code, message) {
    const ids = Object.fromEntries(Object.entries(fields).filter(([, id]) => hasId(id)));
    this.event('action_rejected', {...ids, ...(fields.action_ids && {action_ids: fields.action_ids}), error: {code, message}});
    return Promise.reject(new ResearchError(code, message));
  }

  rejectPending(pending, code, message) {
    this.event('action_rejected', {action_id: pending.action_id, decision_id: pending.decision_id,
      ...(pending.action_ids && {action_ids: pending.action_ids}),
      observation_id: pending.observation_id, received_at_ms: pending.received_at_ms, error: {code, message}});
    pending.reject(new ResearchError(code, message));
  }

  finish(reason = 'stopped') {
    if (this.status === 'ended') return this.result();
    this.endedAt = this.now();
    this.status = 'ended';
    this.inFlightDecision = null;
    this.closePause(this.endedAt, 'run-ended');
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    const upgradePause = this.closeUpgradePause(this.endedAt) ?? pending?.upgradePause;
    if (upgradePause) this.event('upgrade_pause_ended', {...upgradePause, reason: 'run-ended'});
    if (pending) this.rejectPending(pending, 'terminal', 'The run ended before the action could apply.');
    if (['interrupted', 'evidence-error'].includes(reason)) this.invalidate(reason);
    const offset = this.effectiveElapsedAt(this.endedAt) - (this.world.tick - this.baseTick) * TICK_MS;
    this.clock.final_offset_ms = offset;
    if (Math.abs(offset) > MAX_LAG) this.invalidate('clock-drift', {offset_ms: offset});
    for (const {type, ...fields} of this.world.finish(reason)) this.event(type, fields);
    this.publishSnapshot();
    this.flushObservers();
    const result = this.result();
    this.event('run_ended', {result: result.result});
    return result;
  }

  result() {
    const at = this.endedAt ?? this.now();
    const elapsed = this.startedAt === null ? 0 : at - this.startedAt;
    return {result: {
      schema: RESEARCH_SCHEMA, engine: RESEARCH_ENGINE, rules: RESEARCH_RULES, run_id: this.runId,
      status: this.status, started_at_ms: this.startedAt, ended_at_ms: this.endedAt,
      elapsed_ms: elapsed, effective_elapsed_ms: this.effectiveElapsedAt(at),
      latency_compensation_ms: this.config.latency_compensation_ms, latency_compensated_ms: this.totalPausedAt(at),
      ...(this.config.pause_for_upgrade && {upgrade_paused_ms: this.upgradePausedAt(at)}),
      sim_time_ms: this.world.tick * TICK_MS,
      environment_valid: this.invalidReasons.size === 0 && !this.config.fixture && this.startedAt !== null,
      environment_reasons: [...this.invalidReasons, ...(this.config.fixture ? ['debug-fixture'] : []),
        ...(this.startedAt === null ? ['not-started'] : [])],
      clock: this.clockSnapshot(at), decisions: this.actions.length, ...this.world.performanceResult(),
    }, actions: this.actions.slice()};
  }
}
