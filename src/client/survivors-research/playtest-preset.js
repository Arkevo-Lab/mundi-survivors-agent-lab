import {INFORMATION_PRESETS} from './information-presets.js';
import {WHOLE_PATH_MODE, WHOLE_PATH_QUESTION_SCHEMA} from './models/action-whole-path.js';
import {STRUCTURED_TRAIL_PATH_GUIDANCE as R17_PATH_GUIDANCE} from './models/decisions.js';
import {LOCAL_FARM_STRATEGY_SOURCE_SHA256, WHOLE_PATH_FARM_STRATEGY_SHA256} from './models/iterated-whole-path.js';
import {RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK, RESEARCH_PRESSURE, RESEARCH_SEQUENCE_PROFILE, TICK_HZ} from '../../shared/survivors-research-contract.js';

export const RECOMMENDED_PLAYTEST = Object.freeze({
  round: 17,
  movementProtocol: WHOLE_PATH_MODE,
  minimumObservationIntervalMs: 0,
  information: INFORMATION_PRESETS.find(({id}) => id === 'medium-high'),
  visualProfile: 'structured-v1',
  pathQuestionGuidance: Object.freeze({schema: WHOLE_PATH_QUESTION_SCHEMA, guidance: R17_PATH_GUIDANCE}),
  config: Object.freeze({
    character: 'antonio',
    max_ticks: 60 * TICK_HZ,
    pressure_profile: RESEARCH_PRESSURE,
    observation_profile: 'state-detail-v1',
    action_profile: RESEARCH_SEQUENCE_PROFILE,
    movement_feedback: RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK,
  }),
  benchmark: Object.freeze({
    preset_id: 'survivors-rsi-round-17',
    candidate_sha256: '6c64a3bf3fa50f342e8e42bcf2bcf7d3b0f89412e40b3c3de1a7a78666c3fb32',
    movement_protocol: WHOLE_PATH_MODE,
    movement_feedback: RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK,
    training_intent: 'goal-stateless-v1',
    path_question_instructions_sha256: '3241d9bb3cc5ad606b604c5f59c8a5d9aee7392b1a85aa66cef851c3ad9fd1f6',
    strategy_sha256: WHOLE_PATH_FARM_STRATEGY_SHA256,
    strategy_source_sha256: LOCAL_FARM_STRATEGY_SOURCE_SHA256,
    gem_radius_px: 8,
  }),
});
