// Pure pickup, XP, upgrade, and chest presentation mapping.
const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function pickupFeedback(frame, feedback = {}, reducedMotion = false) {
  const active = feedback.sounds?.includes('pickup') === true;
  const magnetRadius = number(frame?.player?.magnet);
  const particles = active && !reducedMotion ? Object.freeze(Array.from({length:4}, (_, index) => {
    const angle = index * Math.PI / 2 + number(frame?.tick) * .05;
    return Object.freeze({x:Math.cos(angle) * 18, y:Math.sin(angle) * 18, size:2});
  })) : Object.freeze([]);
  return Object.freeze({active, magnetRadius, magnetActive:magnetRadius > 1, staticCount:(frame?.gems?.length || 0) + (frame?.pickups?.length || 0), particles, reducedMotion:!!reducedMotion});
}

export function upgradeFeedback(frame, reducedMotion = false) {
  const count = frame?.pendingUpgrade?.length || 0;
  return Object.freeze({active:count > 0, count, phase:count > 0 ? 'reveal' : 'idle', reducedMotion:!!reducedMotion});
}

export function chestFeedback(frame, reveal = null, reducedMotion = false) {
  const phase = reveal?.phase || (frame?.lastTreasure ? 'received' : 'idle');
  return Object.freeze({active:phase !== 'idle', phase, revealed:number(reveal?.revealed), reducedMotion:!!reducedMotion});
}

// Read-only projection of the approved 23-event local Moon cycle.
export const MOON_EVENT_OFFSETS = Object.freeze([180,225,270,315,360,405,450,495,540,563,585,608,630,642,654,666,678,690,702,714,726,732,795]);
export function moonFeedback(frame) {
  const evolved=frame?.pentagram?.evolved, cycle=frame?.moonCycle;
  if (evolved === undefined && (cycle === undefined || cycle === null)) return null;
  if (evolved === false && (cycle === undefined || cycle === null)) return null;
  if (evolved !== true) return {phase:'unknown', message:'月亮周期信息不可用'};
  if (cycle === null || cycle === undefined) return null;
  const tick=frame?.tick, start=cycle?.startTick, index=cycle?.nextEventIndex;
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle) || Object.keys(cycle).sort().join(',') !== 'nextEventIndex,startTick' ||
      !Number.isSafeInteger(tick) || !Number.isSafeInteger(start) || start < 0 || tick < start ||
      !Number.isInteger(index) || index < 0 || index >= MOON_EVENT_OFFSETS.length ||
      start + MOON_EVENT_OFFSETS[index] <= tick ||
      (index > 0 && start + MOON_EVENT_OFFSETS[index-1] > tick)) return {phase:'unknown',message:'月亮周期信息不可用'};
  const phase=index < 20 ? 'targets' : index === 20 ? 'draw' : index === 21 ? 'erase' : 'vacuum';
  const message=phase === 'targets' ? '华丽之月：逐次攻击 · 周期末将吸引经验宝石' :
    phase === 'draw' ? '华丽之月：月光汇聚 · 周期末将吸引经验宝石' :
    phase === 'erase' ? '华丽之月：月光即将横扫 · 周期末将吸引经验宝石' : '华丽之月：等待经验宝石吸附';
  return {phase,message:frame?.done ? '华丽之月：本局结束，周期已停止' : message};
}

// Visual observation only. A missing observed heart is not evidence of healing:
// bounded observations can omit still-live entities. Reset on gaps or bad frames.
export function createSoulHeartFeedback() {
  let previous=null, fades=[];
  function parse(frame) {
    if(!Number.isSafeInteger(frame?.tick)||frame.tick<0)return null;
    if(frame.soulHearts===undefined)return null;
    if(!Array.isArray(frame.soulHearts)||frame.soulHearts.length>1024)return null;
    if(frame.soulHearts.length && (frame.garlic?.evolved!==true || !Number.isFinite(frame.garlic.recoveredHp) || frame.garlic.recoveredHp<0 || frame.garlic.recoveredHp>1000000 || !Number.isFinite(frame.garlic.soulBonus) || frame.garlic.soulBonus<0 || frame.garlic.soulBonus>6))return null;
    const seen=new Set(),hearts=[];
    for(const heart of frame.soulHearts){
      if(!heart||typeof heart!=='object'||Array.isArray(heart)||Object.keys(heart).sort().join(',')!=='id,speed,x,y'||!Number.isSafeInteger(heart.id)||heart.id<0||seen.has(heart.id)||!Number.isFinite(heart.x)||Math.abs(heart.x)>1000000||!Number.isFinite(heart.y)||Math.abs(heart.y)>1000000||!Number.isInteger(heart.speed)||heart.speed<250||heart.speed>65537)return null;
      seen.add(heart.id);hearts.push({id:heart.id,x:heart.x,y:heart.y,speed:heart.speed});
    }
    return {tick:frame.tick,seed:frame.seed,character:frame.character,done:frame.done===true,hearts};
  }
  function reset(frame=null){previous=parse(frame);fades=[];}
  function update(frame){
    const next=parse(frame);if(!next){previous=null;fades=[];return {hearts:[],fades:[]};}
    // Bounded observe() omits the run seed and can reorder/truncate its nearest 24.
    // Render its actual hearts but never infer disappearance transitions from it.
    if(!Number.isSafeInteger(next.seed)){previous=null;fades=[];return {hearts:next.hearts,fades:[]};}
    if(!previous||next.tick<previous.tick||next.seed!==previous.seed||next.character!==previous.character){previous=next;fades=[];return {hearts:next.hearts,fades:[]};}
    if(next.tick===previous.tick){
      // A corrected same-tick snapshot or changed observation scope is a new baseline.
      if(JSON.stringify(next.hearts)!==JSON.stringify(previous.hearts)||next.done!==previous.done){previous=next;fades=[];}
      return {hearts:next.hearts,fades:[...fades]};
    }
    if(next.done||previous.done||next.tick-previous.tick>6)fades=[];
    else {
      const current=new Set(next.hearts.map(heart=>heart.id));
      for(const heart of previous.hearts)if(!current.has(heart.id))fades.push({x:heart.x,y:heart.y,tick:next.tick});
      fades=fades.filter(fade=>next.tick-fade.tick<12).slice(-64);
    }
    previous=next;return {hearts:next.hearts,fades:[...fades]};
  }
  return Object.freeze({reset,update});
}

// Same boolean projection as enemyHitVfx(...).flash without allocating an
// unused frozen VFX object for every visible enemy in the render loop.
export function enemyHitFlashForRender(frame,enemy,reducedMotion=false){
  const tick=Number.isFinite(frame?.tick)?frame.tick:0;
  const until=Number.isFinite(enemy?.hitUntil)?enemy.hitUntil:-Infinity;
  return tick<until && !reducedMotion;
}

// Projection only: do not inspect/copy hitIds or reconstruct rays from clocks.
// Invalid entries are omitted; a repeated id draws at its first valid occurrence.
export function projectBirdRays(frame){
  if(!Array.isArray(frame?.birdRays)||frame.birdRays.length>512)return [];
  const seen=new Set(),out=[];
  for(const ray of frame.birdRays){
    if(!ray||typeof ray!=='object'||Array.isArray(ray)||!Number.isSafeInteger(ray.id)||ray.id<1||seen.has(ray.id)||
      !['peachone','ebonyWings','vandalier'].includes(ray.slot)||!['flight','impact'].includes(ray.phase)||
      !Number.isFinite(ray.x)||Math.abs(ray.x)>1000000||!Number.isFinite(ray.y)||Math.abs(ray.y)>1000000)continue;
    seen.add(ray.id);out.push({id:ray.id,slot:ray.slot,phase:ray.phase,x:ray.x,y:ray.y});
  }
  return out;
}

// This projection never inspects area hit histories or causes gameplay.
export function projectGarlicAreas(frame){
 const garlic=frame?.garlic,areas=frame?.garlicAreas;
 if(!garlic)return {state:areas===undefined||Array.isArray(areas)&&areas.length===0?'absent':'unknown',count:null,limited:false};
 const mode=garlic.legacyArea;
 if(mode===undefined&&areas===undefined)return {state:'legacy',count:null,limited:false};
 if(typeof mode!=='boolean'||!Array.isArray(areas)||areas.length>512)return {state:'unknown',count:null,limited:false};
 if(mode)return {state:areas.length?'unknown':'legacy',count:null,limited:false};
 if(typeof garlic.evolved!=='boolean'||!Number.isSafeInteger(frame.tick)||frame.tick<0)return {state:'unknown',count:null,limited:false};
 const ids=new Set();
 for(const area of areas){
  if(!area||typeof area!=='object'||Array.isArray(area)||!Number.isSafeInteger(area.id)||area.id<1||ids.has(area.id)||
    !Number.isSafeInteger(area.bornTick)||area.bornTick<0||area.bornTick>frame.tick||!Number.isSafeInteger(area.untilTick)||area.untilTick<=frame.tick||area.untilTick-area.bornTick>1248||area.evolved!==garlic.evolved)return {state:'unknown',count:null,limited:false};
  ids.add(area.id);
 }
 return {state:areas.length?'active':'inactive',count:areas.length,limited:!Number.isSafeInteger(frame.seed)};
}

// 060-only presentation of the last emitted Lancet direction; no inferred future cast.
export function projectClockLancet(frame){
  const weapon=frame?.clockLancet,tick=frame?.tick;
  if(!weapon||typeof weapon!=='object'||Array.isArray(weapon)||weapon.sweepModel!=='clock12'||!Number.isSafeInteger(tick)||tick<0||!Number.isInteger(weapon.phase)||weapon.phase<0||weapon.phase>11||!Number.isInteger(weapon.lastDirection)||weapon.lastDirection<0||weapon.lastDirection>11||!Number.isSafeInteger(weapon.lastCastTick))return null;
  const age=tick-weapon.lastCastTick;if(age<0||age>=12)return null;
  return {angle:-weapon.lastDirection*Math.PI/6,alpha:1-age/12};
}
