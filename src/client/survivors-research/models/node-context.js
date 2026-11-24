import {createStrategyMemory} from './strategy-memory.js';
import {parseStrategy} from './action-strategy.js';
import {createAdvisorMemory} from '../advisor-memory.js';
import {validControlBrief} from './control-brief.js';

const cardinalHeadings = new Set(['up','down','left','right']);
const tick = value => Number.isSafeInteger(value) && value >= 0;
const modes = new Set(['advisory-cardinal-v2','advisory-direction-v1']);
const schema = 'survivors-resume-context-v1';

export function createResumeContext({source_run_id, source_mode, base_tick, context_samples = [],
  applied_actions = [], accepted_guidance = [], accepted_strategies = [], previous_direction = null, initial_context = null}) {
  if (typeof source_run_id !== 'string' || !source_run_id || !tick(base_tick) ||
      !Array.isArray(context_samples) || !Array.isArray(applied_actions) || !Array.isArray(accepted_guidance) || !Array.isArray(accepted_strategies)) {
    throw new TypeError('Invalid node context inputs');
  }
  const memory = createAdvisorMemory();
  const strategyMemory = createStrategyMemory();
  let activeStrategy = null;
  let active = null;
  let historyFrom = null;
  const missing = [];
  if (initial_context) {
    validateContext(initial_context, initial_context.base_tick);
    if (initial_context.base_tick > base_tick) {
      throw new TypeError('Invalid inherited node context');
    }
    memory.importState(initial_context.memory_state, source_run_id);
    if (initial_context.strategy) {
      validateStrategyContext(initial_context.strategy,initial_context.base_tick);
      strategyMemory.importState(initial_context.strategy.memory_state,source_run_id);
      activeStrategy=structuredClone(initial_context.strategy.active_strategy);
    }
    active = initial_context.active_guidance;
    historyFrom = initial_context.history_from_tick;
    missing.push(...initial_context.missing);
  }
  const inheritedBoundary = initial_context?.base_tick ?? -1;
  const initialTick = memory.snapshot()?.tick ?? -1;
  const timeline = [
    ...context_samples.filter(row => tick(row?.observation?.tick) && row.observation.tick >= (initial_context ? inheritedBoundary : 0) && row.observation.tick >= initialTick &&
      row.observation.tick <= base_tick).map(row => ({tick:row.observation.tick, order:1, row})),
    ...accepted_guidance.filter(row => tick(row?.accepted_tick) && row.accepted_tick > inheritedBoundary &&
      row.accepted_tick <= base_tick).map(row => ({tick:row.accepted_tick, order:2, row})),
    ...applied_actions.filter(row => tick(row?.applied_tick) && row.applied_tick > inheritedBoundary &&
      row.applied_tick <= base_tick).map(row => ({tick:row.applied_tick, order:0, row})),
  ].sort((a,b) => a.tick-b.tick || a.order-b.order);
  for (const item of timeline) {
    const row = item.row;
    if (item.order === 1) {
      const observation = {...row.observation, run_id:source_run_id};
      if (!strategyMemory.observe({observation,frame:row.frame,hitsTaken:row.hitsTaken})) missing.push('invalid_strategy_sample_at_' + item.tick);
      if (!memory.observe(observation,row.frame,row.hitsTaken,Boolean(initial_context && item.tick === inheritedBoundary))) missing.push('invalid_sample_at_' + item.tick);
      else historyFrom ??= item.tick;
    } else if (item.order === 2) {
      const guidance = row.guidance;
      if (memory.snapshot()?.tick !== item.tick || !guidance ||
          !memory.accept({guidance_id:row.decision_id,source_tick:row.observation_tick,...guidance})) {
        missing.push('unrestored_guidance_at_' + item.tick);
      } else {
        const brief=row.hint?.control_brief;
        if(brief!==undefined&&brief!==null&&(!validControlBrief(brief,row.accepted_tick)||brief.accepted_tick>row.observation_tick))throw new TypeError('Invalid accepted control brief');
        active = {guidance,sourceTick:row.observation_tick,acceptedTick:row.accepted_tick,id:row.decision_id,
          ...(brief!==undefined&&{controlBrief:brief})};
      }
    } else { memory.recordAction(row); strategyMemory.recordAction(row); }
  }
  for (const row of accepted_strategies.filter(row=>tick(row?.accepted_tick) && row.accepted_tick>inheritedBoundary && row.accepted_tick<=base_tick).sort((a,b)=>a.accepted_tick-b.accepted_tick)) {
    if (!tick(row.source_tick) || row.source_tick>row.accepted_tick || typeof row.decision_id!=='string') throw new TypeError('Invalid accepted strategy');
    const strategy=parseStrategy(JSON.stringify(row.strategy));
    activeStrategy={strategy_id:row.decision_id,source_tick:row.source_tick,accepted_tick:row.accepted_tick,strategy};
  }
  const lastTick = memory.snapshot()?.tick ?? null;
  if (lastTick === null) missing.push('no_public_history');
  return structuredClone({schema,source_run_id,source_mode,base_tick,history_from_tick:historyFrom,
    history_to_tick:lastTick,memory_state:memory.exportState(),active_guidance:active,
    previous_direction:previous_direction ?? initial_context?.previous_direction ?? null,missing:[...new Set(missing)],
    strategy:{schema:'survivors-resume-strategy-v1',memory_state:strategyMemory.exportState(),active_strategy:activeStrategy}});
}

function validateStrategyContext(value,nodeTick) {
  if (value?.schema!=='survivors-resume-strategy-v1') throw new TypeError('Invalid strategy context');
  const memory=createStrategyMemory(); memory.importState(value.memory_state,'validation');
  if (memory.snapshot()?.to_tick > nodeTick) throw new TypeError('Future strategy memory');
  const active=value.active_strategy;
  if (active) {
    if (typeof active.strategy_id!=='string' || !active.strategy_id || !tick(active.source_tick) || !tick(active.accepted_tick) ||
        active.source_tick>active.accepted_tick || active.accepted_tick>nodeTick) throw new TypeError('Future strategy');
    parseStrategy(JSON.stringify(active.strategy));
  }
}

function validateContext(context, nodeTick) {
  const state = context?.memory_state;
  if (context?.strategy) validateStrategyContext(context.strategy,nodeTick);
  if (!context || context.schema !== schema || !tick(nodeTick) || context.base_tick !== nodeTick ||
      !Array.isArray(context.missing) || !state || !Array.isArray(state.targets) ||
      !Array.isArray(state.enemies) || !Array.isArray(state.history) || !Array.isArray(state.actions) ||
      (state.current && (!tick(state.current.tick) || state.current.tick > nodeTick))) {
    throw new TypeError('Invalid resume context');
  }
  for (const pair of [...state.targets, ...state.enemies]) {
    if (!Array.isArray(pair) || pair.length !== 2 || !tick(pair[0]) || pair[1]?.id !== pair[0] ||
        !tick(pair[1].last_seen_tick) || pair[1].last_seen_tick > nodeTick ||
        !Number.isFinite(pair[1].x) || !Number.isFinite(pair[1].y) ||
        (pair[1].previous && (!tick(pair[1].previous.tick) || pair[1].previous.tick > nodeTick))) {
      throw new TypeError('Invalid resume memory observation');
    }
  }
  for (const entry of state.history) {
    const row = entry?.legacy;
    if (!row || !tick(row.from_tick) || !tick(row.to_tick) || row.from_tick > row.to_tick ||
        row.to_tick > nodeTick) throw new TypeError('Invalid resume memory history');
  }
  if (state.ongoing && (!tick(state.ongoing.metadata?.source_tick) ||
      !tick(state.ongoing.metadata?.accepted_tick) ||
      state.ongoing.metadata.source_tick > state.ongoing.metadata.accepted_tick ||
      state.ongoing.metadata.accepted_tick > nodeTick)) throw new TypeError('Invalid resume ongoing guidance');
  if (state.actions.some(action => !tick(action?.applied_tick) || action.applied_tick > nodeTick) ||
      !tick(state.lastActionTick) || state.lastActionTick > nodeTick) throw new TypeError('Invalid resume actions');
  const active = context.active_guidance;
  if(active?.controlBrief!=null&&(!validControlBrief(active.controlBrief,active.acceptedTick)||active.controlBrief.accepted_tick>active.sourceTick))throw new TypeError('Invalid resume control brief');
  if (active && (!tick(active.sourceTick) || !tick(active.acceptedTick) ||
      active.sourceTick > active.acceptedTick || active.acceptedTick > nodeTick ||
      typeof active.id !== 'string' || !active.guidance || typeof active.guidance.heading !== 'string')) {
    throw new TypeError('Invalid resume guidance');
  }
}

export function restoreNodeModel({context,nodeTick,branchRunId,targetMode,enableStrategy=false}) {
  if (!context || context.schema !== schema || context.base_tick !== nodeTick || !tick(nodeTick) ||
      typeof branchRunId !== 'string' || !branchRunId) throw new TypeError('Invalid resume context');
  validateContext(context,nodeTick);
  const memory = createAdvisorMemory();
  memory.importState(context.memory_state,branchRunId);
  const missing = [...context.missing];
  let active = context.active_guidance && structuredClone(context.active_guidance);
  if (active && (!modes.has(targetMode) || active.sourceTick + 120 <= nodeTick ||
      targetMode === 'advisory-cardinal-v2' && !cardinalHeadings.has(active.guidance.heading))) {
    missing.push('incompatible_or_expired_guidance');
    active = null;
  }
  const current = memory.snapshot();
  if (active?.guidance.target_id !== null && active) {
    const target = current?.targets.find(row => row.id === active.guidance.target_id);
    if (!target || !['visible','unknown'].includes(target.status)) {
      missing.push('guidance_target_unavailable');
      active = null;
    }
  }
  let strategyMemory, strategyRestore;
  if (enableStrategy) {
    strategyMemory=createStrategyMemory();
    if (context.strategy) strategyMemory.importState(context.strategy.memory_state,branchRunId);
    else missing.push('strategy_history_unavailable');
    strategyRestore={active:context.strategy?.active_strategy ?? null,nextTick:nodeTick};
  }
  return {memory,advisorRestore:{active,nextTick:nodeTick}, ...(enableStrategy && {strategyMemory,strategyRestore}),
    legacyPrevious:targetMode === 'advisory-direction-v1' ? structuredClone(context.previous_direction) : null,
    contextReport:{source_mode:context.source_mode,target_mode:targetMode,history_from_tick:context.history_from_tick,
      history_to_tick:context.history_to_tick,missing:[...new Set(missing)],transition:'fresh-requests-at-node'}};
}
