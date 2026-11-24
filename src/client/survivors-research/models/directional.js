import {createLocalMicroFeedback,LOCAL_MICRO_PROJECTION_SCHEMA,projectLocalMicro} from './local-micro.js';
import {NACE_MODEL,NACE_PROVIDER} from './nace-decisions.js';
import {DREX_LOCAL_MICRO_PROJECTION_SCHEMA,DREX_WEAPON_MICRO_PROJECTION_SCHEMA} from './local-micro.js';
import {RESEARCH_COVERAGE_SEQUENCE_PROFILE} from '../../../shared/survivors-research-contract.js';
import {DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE} from './local-path-micro.js';
import {createStrategist} from './strategy.js';
import {createStrategyScheduler} from './strategy-scheduler.js';
import {CARDINAL_ADVISOR_MODE} from './action-cardinal.js';
import {createAdvisorScheduler} from './advisor-scheduler.js';
import {ADVISOR_MODE} from './action-advisor.js';
import {createCardinalAdvisor, createDirectionalAdvisor, createLocalPathMicroModel, createNaceUpgradeModel, createOpenAIDecisionsModel, DECISIONS_MODEL, DECISIONS_PROFILE} from './decisions.js';

export function createDirectionalModel({legacyPrevious = null} = {}) {
  const native = createOpenAIDecisionsModel({
    model: DECISIONS_MODEL, generation_profile: DECISIONS_PROFILE, localConnection: true, timeout_ms: 10000,
  });
  let previous = legacyPrevious && structuredClone(legacyPrevious);
  function directionObservation({observation, hitsTaken}) {
    const direction_context = previous && {
      threat: previous.threat, crystal: previous.crystal, action: previous.action,
      observed_tick: previous.observedTick, applied_tick: previous.appliedTick,
      hits_since_observation: hitsTaken - previous.hitsTaken,
    };
    return {...observation, direction_context};
  }
  return {
    directionObservation,
    config: {...native.config, movement_question_mode: 'direction-v1'},
    decide(context) {
      if (context.observation.upgrade_offer) return native.decide(context);
      const hint = context.advisorHint;
      return native.decide({...context, observation: directionObservation(context),
        ...(hint && {advisor_role: 'micro', advisor_context: hint})});
    },
    actionApplied({observation, result, appliedTick, hitsTaken}) {
      if (observation.upgrade_offer) return;
      const [threat, crystal, action] = JSON.parse(result.raw_response).answers;
      previous = {threat: threat.choice, crystal: crystal.choice, action: action.choice,
        observedTick: observation.tick, appliedTick, hitsTaken};
    },
  };
}

export function createAdvisedDirectionalModel({memory, advisor = createDirectionalAdvisor(), restore = null, legacyPrevious = null}) {
  const micro = createDirectionalModel({legacyPrevious});
  return {...micro, config: {...micro.config, advisor_mode: ADVISOR_MODE},
    advisor: createAdvisorScheduler({memory, advise: advisor.advise, restore})};
}

export function createCardinalModel() {
  const native = createOpenAIDecisionsModel({
    model: DECISIONS_MODEL, generation_profile: DECISIONS_PROFILE, localConnection:true, timeout_ms:10000,
  });
  return {...native, config:{...native.config, movement_question_mode:'cardinal-v2'},
    directionObservation: ({observation}) => observation,
    decide(context) {
      if (context.observation.upgrade_offer) return native.decide(context);
      return native.decide({...context, advisor_role:'cardinal-micro', advisor_context:context.advisorHint ?? null});
    },
    actionApplied() {},
  };
}

export function createCardinalAdvisedModel({memory, advisor = createCardinalAdvisor(), restore = null}) {
  const micro = createCardinalModel();
  return {...micro, config:{...micro.config, advisor_mode:CARDINAL_ADVISOR_MODE},
    advisor:createAdvisorScheduler({memory, advise:advisor.advise, provider:advisor.provider, mode:CARDINAL_ADVISOR_MODE, cardinal:true, restore})};
}

export function createStrategicAdvisedModel({memory,strategyMemory,advisor=createCardinalAdvisor(),strategist=createStrategist(),restore=null,strategyRestore=null}) {
  const model=createCardinalAdvisedModel({memory,advisor,restore});
  return {...model,strategy:createStrategyScheduler({memory:strategyMemory,advise:strategist.advise,config:strategist.config,restore:strategyRestore})};
}

export function createLocalMicroStrategicModel({memory,strategyMemory,advisor=createCardinalAdvisor(),strategist,restore=null,strategyRestore=null,pathMicroModel,actionProfile}) {
  const targetHandoff=pathMicroModel===NACE_MODEL&&advisor.provider===NACE_PROVIDER;
  const weaponAware=targetHandoff&&actionProfile===RESEARCH_COVERAGE_SEQUENCE_PROFILE;
  const model=createStrategicAdvisedModel({memory,strategyMemory,advisor,
    strategist:strategist??createStrategist({transitionAware:targetHandoff,combatAware:weaponAware,briefAware:weaponAware,sharedFactsAware:weaponAware,tacticsAware:weaponAware}),restore,strategyRestore});
  const native=createOpenAIDecisionsModel({model:DECISIONS_MODEL,generation_profile:DECISIONS_PROFILE,localConnection:true,timeout_ms:10000});
  const controller=pathMicroModel?createLocalPathMicroModel(pathMicroModel,{targetHandoff,actionProfile,weaponAware,briefAware:weaponAware,sharedFactsAware:weaponAware,tacticsAware:weaponAware}):native;
  const upgrade=targetHandoff?createNaceUpgradeModel():native;
  const feedback=createLocalMicroFeedback();
  return {...model,config:{...model.config,movement_question_mode:'local-cardinal-v1',
    ...(pathMicroModel && controller.config),micro_visual_profile:'local-micro-v1',
    local_projection_schema:weaponAware?DREX_WEAPON_MICRO_PROJECTION_SCHEMA:
      targetHandoff?DREX_LOCAL_MICRO_PROJECTION_SCHEMA:LOCAL_MICRO_PROJECTION_SCHEMA,
    ...(weaponAware&&{combat_context_schema:'survivors-combat-context-v1',control_brief_mode:'control-brief-v3'}),
    ...(targetHandoff&&{provider_input_profile:DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE,upgrade_provider:NACE_PROVIDER})},
    prepareLocalMicro({observation,frame,advisorHint}) {
      const local_feedback=feedback.observe({observation,frame,advisorHint});
      const local_facing=frame?.player?.facing===-1||frame?.player?.facing===1 ? frame.player.facing:null;
      const local_projection=projectLocalMicro({observation,advisorHint,feedback:local_feedback,facing:local_facing,targetHandoff,weaponAware});
      return {local_feedback,local_facing,local_projection};
    },
    decide(context) {
      if(context.observation.upgrade_offer)return upgrade.decide(context);
      return controller.decide({...context,advisor_role:'local-micro',advisor_context:context.advisorHint??null});
    },
    actionApplied({result,advisorHint,appliedTick}) {feedback.actionApplied({result,advisorHint,appliedTick});},
  };
}
