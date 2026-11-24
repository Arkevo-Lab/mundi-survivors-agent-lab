export const CONTROL_BRIEF_SCHEMA='survivors-control-brief-v1';
export const CONTROL_BRIEF_MODE='control-brief-v1';
export const CONTROL_BRIEF_MODE_V2='control-brief-v2';
export const CONTROL_BRIEF_MODE_V3='control-brief-v3';
export const isControlBriefMode=mode=>mode===CONTROL_BRIEF_MODE||mode===CONTROL_BRIEF_MODE_V2||mode===CONTROL_BRIEF_MODE_V3;
const keys=['schema','strategy_id','source_tick','accepted_tick','age_ticks','approach','phase','transition'];
const validTick=n=>Number.isSafeInteger(n)&&n>=0;
const phrase=s=>typeof s==='string'&&s.trim().length>0&&[...s].length<=240&&/[\u3400-\u9fff]/u.test(s);
export function validControlBrief(brief,tick){
  return brief!==null&&typeof brief==='object'&&!Array.isArray(brief)&&Object.keys(brief).length===keys.length&&
    keys.every(k=>Object.hasOwn(brief,k))&&brief.schema===CONTROL_BRIEF_SCHEMA&&typeof brief.strategy_id==='string'&&brief.strategy_id.length>0&&
    validTick(tick)&&validTick(brief.source_tick)&&validTick(brief.accepted_tick)&&brief.source_tick<=brief.accepted_tick&&brief.accepted_tick<=tick&&
    brief.age_ticks===tick-brief.source_tick&&['approach','phase','transition'].every(k=>phrase(brief[k]));
}
export function createControlBrief(strategy,tick){
  if(strategy==null)return null;
  const s=strategy.strategy;
  const brief={schema:CONTROL_BRIEF_SCHEMA,strategy_id:strategy.strategy_id,source_tick:strategy.source_tick,accepted_tick:strategy.accepted_tick,
    age_ticks:tick-strategy.source_tick,approach:s?.approach,phase:s?.phase,transition:s?.transition};
  if(!validControlBrief(brief,tick))throw new TypeError('Invalid control brief');
  return Object.freeze(brief);
}
export function ageControlBrief(brief,tick){
  if(brief==null)return null;
  const next={...brief,age_ticks:tick-brief.source_tick};
  if(!validControlBrief(next,tick))throw new TypeError('Invalid control brief age');
  return Object.freeze(next);
}
