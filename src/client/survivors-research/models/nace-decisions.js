import { ResearchModelError } from './common.js';

export const NACE_MODEL = 'drex-max-v1.1';
export const NACE_PROVIDER = 'nace-decisions';
export const NACE_ENDPOINT = 'https://console.nace.ai/v1/systemone';
export const NACE_ACTION_PATH = '/api/survivors-research/model/nace/action';
export const NACE_PROFILE = 'nace-systemone-choice-v1';

const pngDataUrl = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

export function naceDecisionInput(input) {
  const [message] = input.input;
  const [question] = input.questions;
  const [state, image, legend] = message?.content ?? [];
  if (input.input.length !== 1 || message.content.length !== 3 || input.questions.length !== 1 ||
      question?.name !== 'path' || question.type !== 'choice' || question.choices.length !== 65 ||
      state?.type !== 'input_text' || image?.type !== 'input_image' || legend?.type !== 'input_text' ||
      !pngDataUrl.test(image.image_url) || new Set(question.choices.map(choice => choice.value)).size !== 65) {
    throw new TypeError('Expected one 65-choice path question and one local PNG');
  }
  return {model:NACE_MODEL, state:[state.text, 'Image 1', legend.text], questions:{
    [question.name]:{type:'choice', instructions:question.instructions,
      criteria:Object.fromEntries(question.choices.map(({value, description}) => [value, description]))},
  }, images:[image.image_url]};
}

// The cardinal question is compiled by the same code as the Luna direction route.
export function naceDirectionInput(input) {
  return fullImageChoiceInput(input,'guidance',choices=>choices.length>=4&&choices.length<=20&&choices.length%4===0,
    /^(?:none|loot:\d+):(up|down|left|right)$/);
}

export function naceUpgradeInput(input) {
  return fullImageChoiceInput(input,'action',choices=>choices.length>0,
    /^choose:level-[1-9][0-9]*:[a-z-]+$/);
}

function fullImageChoiceInput(input,name,validCount,validId) {
  const [message]=input.input;
  const [question]=input.questions;
  const content=message?.content??[];
  const images=content.filter(part=>part.type==='input_image');
  const choices=question?.choices??[];
  if(input.input.length!==1||message?.role!=='user'||input.questions.length!==1||
      question?.name!==name||question.type!=='choice'||typeof question.instructions!=='string'||!validCount(choices)||
      new Set(choices.map(choice=>choice.value)).size!==choices.length||
      choices.some(({value,description})=>!validId.test(value)||typeof description!=='string')||
      images.length!==1||!pngDataUrl.test(images[0].image_url)||
      content.some(part=>part.type!=='input_image'&&(part.type!=='input_text'||typeof part.text!=='string'||part.text==='Image 1'))) {
    throw new TypeError('Expected one validated choice question and one full PNG');
  }
  return {model:NACE_MODEL,state:content.map(part=>part.type==='input_image'?'Image 1':part.text),
    questions:{[name]:{type:'choice',instructions:question.instructions,
      criteria:Object.fromEntries(choices.map(({value,description})=>[value,description]))}},
    images:[images[0].image_url]};
}

export const nacePathAnswer=(data,choices)=>naceChoiceAnswer(data,choices,'path');

export const naceDirectionAnswer=(data,choices)=>timedNaceAnswer(data,choices,'guidance');
export const naceUpgradeAnswer=(data,choices)=>timedNaceAnswer(data,choices,'action');

function timedNaceAnswer(data,choices,name){
  const answer=naceChoiceAnswer(data,choices,name);
  if(typeof data.request_id!=='string'||!data.request_id||!Number.isFinite(data.evaluation_time_ms)||data.evaluation_time_ms<0){
    throw new ResearchModelError('malformed','Nace 响应缺少有效的请求标识或处理时间');
  }
  return answer;
}

function naceChoiceAnswer(data,choices,question) {
  if (data?.model !== NACE_MODEL) {
    throw new ResearchModelError('provider_model_unavailable', 'Nace 未返回指定版本 drex-max-v1.1');
  }
  const answer = data.answers?.[question];
  const scores = answer?.probabilities;
  const values = choices.map(({value}) => value);
  if (Object.keys(data.answers ?? {}).length !== 1 || answer?.type !== 'choice' || !values.includes(answer.choice) ||
      !probability(answer.confidence) || !scores || Array.isArray(scores) || Object.keys(scores).length !== values.length ||
      !values.every(value => Object.hasOwn(scores, value) && probability(scores[value]))) {
    throw new ResearchModelError('malformed', 'Nace 未返回完整的选择和概率');
  }
  return answer;
}
