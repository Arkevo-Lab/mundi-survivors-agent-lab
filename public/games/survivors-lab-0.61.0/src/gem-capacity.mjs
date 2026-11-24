// 059 resource limits and source-informed Forest gem batching. Threshold 400
// triggers a conditional offscreen merge; it is not an entity hard cap.
import {integer,requireValue} from './persistence.mjs';
import {VIEW} from './stage.mjs';
export const MAX_GEMS=8192, MAX_GEM_UNITS=1_000_000, MAX_RAW_GEM_XP=50_000_000_000;
export const gemUnits=gem=>gem.units===undefined?1:gem.units;
export const gemRawValue=gem=>gem.rawValue===undefined?gem.value*gemUnits(gem):gem.rawValue;
function validateGem(gem) {
 const units=gemUnits(gem);
 requireValue(integer(gem.value,1,1_000_000) && integer(units,1,MAX_GEM_UNITS),'invalid gem units or value');
 if(gem.rawValue!==undefined)requireValue(integer(gem.rawValue,1,MAX_RAW_GEM_XP) && gem.rawValue>=units && gem.value===Math.min(gem.rawValue,1_000_000),'invalid gem raw value');
}
export function validateGemCapacity(gems,collected=0) {
 requireValue(Array.isArray(gems) && gems.length<=MAX_GEMS && integer(collected,0,MAX_GEM_UNITS),'gem capacity');
 let units=0,raw=0;const values=new Set();let pair=false;
 for(const gem of gems){
  validateGem(gem);const n=gemUnits(gem);units+=n;raw+=gemRawValue(gem);
  requireValue(Number.isSafeInteger(units) && Number.isSafeInteger(raw) && units+collected<=MAX_GEM_UNITS && raw<=MAX_RAW_GEM_XP,'gem capacity budget');
  if(values.has(gem.value))pair=true;else values.add(gem.value);
 }
 // Retain the old full-save admissibility requirement for backward compatibility.
 if(gems.length===MAX_GEMS)requireValue(pair && units+collected<MAX_GEM_UNITS,'gem capacity uncompressible');
 return {units,raw};
}
function mergeInto(target,source) {
 const raw=gemRawValue(target)+gemRawValue(source),units=gemUnits(target)+gemUnits(source);
 requireValue(integer(raw,1,MAX_RAW_GEM_XP) && integer(units,1,MAX_GEM_UNITS),'gem capacity budget');
 return {...target,value:Math.min(raw,1_000_000),units,rawValue:raw};
}
export function depositGem(gems,gem,collected=0,knownUnstacked=false) {
 validateGem(gem);
 if(knownUnstacked && gems.length<MAX_GEMS-1){
  requireValue(collected+gems.length+1<=MAX_GEM_UNITS,'gem capacity budget');gems.push(gem);return;
 }
 const totals=validateGemCapacity(gems,collected);
 requireValue(totals.units+collected+gemUnits(gem)<=MAX_GEM_UNITS && totals.raw+gemRawValue(gem)<=MAX_RAW_GEM_XP,'gem capacity budget');
 if(gems.length<MAX_GEMS){
  if(gems.length===MAX_GEMS-1)validateGemCapacity([...gems,gem],collected);
  gems.push(gem);return;
 }
 requireValue(totals.units+collected+gemUnits(gem)<MAX_GEM_UNITS,'gem capacity budget');
 let target=-1,best=Infinity;
 for(let i=0;i<gems.length;i++)if(gems[i].value===gem.value){
  const distance=(gems[i].x-gem.x)**2+(gems[i].y-gem.y)**2;
  if(distance<best || distance===best && (target<0 || gems[i].id<gems[target].id)){target=i;best=distance;}
 }
 if(target>=0){gems[target]=mergeInto(gems[target],gem);return;}
 const byId=[...gems].sort((a,b)=>a.id-b.id),first=new Map();let pair=null;
 for(const item of byId){if(first.has(item.value)){const candidate=[first.get(item.value),item];
  if(!pair || candidate[0].id<pair[0].id || candidate[0].id===pair[0].id && candidate[1].id<pair[1].id)pair=candidate;
 }else first.set(item.value,item);}
 requireValue(!!pair,'gem capacity uncompressible');
 const targetIndex=gems.indexOf(pair[0]),sourceIndex=gems.indexOf(pair[1]);
 gems[targetIndex]=mergeInto(pair[0],pair[1]);gems.splice(sourceIndex,1);gems.push(gem);
}
const distanceSquared=(item,player)=>(item.x-player.x)**2+(item.y-player.y)**2;
// Source rectangle is 1.2 x 1.3 times the orthographic camera bounds. Our
// fixed VIEW maps those proportions into local units; it is not native geometry.
const insideContainment=(item,player)=>{
 const x=item.x-player.x,y=item.y-player.y,halfX=VIEW.width/VIEW.scale*.6,halfY=VIEW.height/VIEW.scale*.65;
 return x>=-halfX && x<halfX && y>=-halfY && y<halfY;
};
export function depositGemBatch(gems,pending,player,collected=0,knownUnstacked=false) {
 if(!pending.length)return {merged:false};
 if(gems.length+pending.length<400 && knownUnstacked){
  requireValue(collected+gems.length+pending.length<=MAX_GEM_UNITS,'gem capacity budget');
  for(const gem of pending)validateGem(gem);
  gems.push(...pending);return {merged:false};
 }
 const totals=validateGemCapacity(gems,collected);let units=totals.units,raw=totals.raw;
 for(const gem of pending){validateGem(gem);units+=gemUnits(gem);raw+=gemRawValue(gem);}
 requireValue(Number.isSafeInteger(units)&&Number.isSafeInteger(raw)&&units+collected<=MAX_GEM_UNITS&&raw<=MAX_RAW_GEM_XP,'gem capacity budget');
 // Mutate only this temporary list until the entire batch is validated.
 const next=[...gems];let merged=false;
 if(next.length+pending.length>=400){
  const targetCount=Math.max(400-pending.length,1);
  if(next.length>targetCount){
   // If the farthest sorted item is visible, the original loop stops before
   // removing anything. Find that item linearly to avoid sorting the common
   // all-visible case. Equal distances take the last local insertion here,
   // matching a stable ascending sort consumed from its end.
   let farthestLast=null, farthestDistance=-Infinity;
   for(const gem of next){const d=distanceSquared(gem,player);if(d>=farthestDistance){farthestDistance=d;farthestLast=gem;}}
   if(!insideContainment(farthestLast,player)){
   // LINQ OrderBy is stable; source HashSet enumeration ties cannot be matched
   // exactly, so local insertion order is the deterministic tie-break.
   const sorted=next.map((gem,index)=>({gem,index,distance:distanceSquared(gem,player)})).sort((a,b)=>a.distance-b.distance||a.index-b.index);
   let i=sorted.length-1,removed=0,aggregate=null;
   while(next.length>targetCount && i>=0){
    const gem=sorted[i--].gem;if(insideContainment(gem,player))break;
    aggregate=aggregate?mergeInto(aggregate,gem):gem;next.splice(next.indexOf(gem),1);removed++;
    if(removed>targetCount)break;
   }
   if(aggregate){const target=sorted[i]?.gem;requireValue(!!target,'gem condensation target');const at=next.indexOf(target);requireValue(at>=0,'gem condensation target');next[at]=mergeInto(target,aggregate);merged=true;}
   }
  }
 }
 let furthest=null,furthestIndex=-1,best=-Infinity;
 for(let i=0;i<next.length;i++){const d=distanceSquared(next[i],player);if(d>best){best=d;furthest=next[i];furthestIndex=i;}}
 for(const gem of pending){
  if(next.length>400){
   if(!furthest){for(let i=0;i<next.length;i++){const d=distanceSquared(next[i],player);if(d>best){best=d;furthest=next[i];furthestIndex=i;}}}
   requireValue(furthestIndex>=0,'gem overflow target');furthest=mergeInto(furthest,gem);next[furthestIndex]=furthest;merged=true;
  }else next.push(gem);
 }
 requireValue(next.length<=MAX_GEMS,'gem capacity');
 gems.splice(0,gems.length,...next);return {merged};
}
