import {ACTION_POLICY} from './action-prompt.js';
import {ResearchModelError} from './common.js';
import {DECISIONS_MODEL, WHIP_GUIDANCE, decisionModelInput} from './decisions.js';
import {RESEARCH_SLOTS_COUNT, RESEARCH_SLOTS_PROFILE, RESEARCH_SLOT_WAIT_ID, researchCandidates}
  from '../../../shared/survivors-research-contract.js';

export const JOINT_GENERATED_PLAN_PROFILE = 'openai-chat-joint-plan-v1';
const SCHEMA_NAME = 'survivors_joint_plan_v1';
const direction = actionId => actionId === RESEARCH_SLOT_WAIT_ID ? 'wait' : actionId.split(':')[1];
const actionByDirection = new Map(researchCandidates(RESEARCH_SLOTS_PROFILE).map(({id}) => [direction(id), id]));

export function jointGeneratedPlanInput({observation, candidates, action_profile, training_strategy}) {
  if (action_profile !== RESEARCH_SLOTS_PROFILE || observation?.profile !== 'state-detail-v1' ||
      observation.upgrade_offer || Object.hasOwn(observation, 'training_intent') ||
      Object.hasOwn(observation, 'training_tactics') || training_strategy === undefined) {
    throw new ResearchModelError('invalid_observation', 'Expected a public fixed-slot movement observation and strategy');
  }
  const joint = decisionModelInput(DECISIONS_MODEL, {
    observation: {...observation, training_intent: {mode: 'goal-stateless-v1', prior: null}},
    candidates, action_profile, training_strategy,
  });
  const goals = joint.questions.at(-1).choices;
  const actions = joint.questions[0].choices.map(({value, description}) => ({value: direction(value), description}));
  return {
    model: DECISIONS_MODEL, reasoning_effort: 'none', max_completion_tokens: 128, stream: false, store: false,
    messages: [
      {role: 'system', content: ACTION_POLICY.replace('Choose one action', 'Choose one tactical goal and a coordinated movement plan') +
        ' ' + training_strategy + ' ' + WHIP_GUIDANCE + ' Choose your goal and all ten actions together in one JSON object. ' +
        'The ten ordered slots each last 50 ms from application, covering 500 ms total. Every slot must use one listed movement or wait. ' +
        'Use the current relative offsets, pickup radius, and movement scale to make progress toward your selected goal when safe. ' +
        'The goal is a label. The ten actions are what the player will execute.'},
      {role: 'user', content: JSON.stringify({observation, goals, actions})},
    ],
    response_format: {type: 'json_schema', json_schema: {name: SCHEMA_NAME, strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['goal_id', 'slots'],
      properties: {goal_id: {type: 'string', enum: goals.map(({value}) => value)},
        slots: {type: 'array', minItems: RESEARCH_SLOTS_COUNT, maxItems: RESEARCH_SLOTS_COUNT,
          items: {type: 'string', enum: actions.map(({value}) => value)}}},
    }}},
  };
}

export function parseJointGeneratedPlan(raw, input) {
  const fail = () => {throw new ResearchModelError('malformed', 'Expected one allowed goal and all ten allowed movement slots');};
  let reply, plan;
  try {
    reply = JSON.parse(raw);
    plan = JSON.parse(reply.choices[0].message.content);
  } catch { fail(); }
  const choice = reply.choices[0];
  const {goal_id, slots} = input.response_format.json_schema.schema.properties;
  if (reply.choices.length !== 1 || choice.finish_reason !== 'stop' || choice.message.refusal ||
      !plan || Object.keys(plan).length !== 2 || !goal_id.enum.includes(plan.goal_id) ||
      !Array.isArray(plan.slots) || plan.slots.length !== RESEARCH_SLOTS_COUNT ||
      !plan.slots.every(slot => slots.items.enum.includes(slot))) fail();
  const action_ids = plan.slots.map(slot => actionByDirection.get(slot));
  return {goal_id: plan.goal_id, action_ids};
}
