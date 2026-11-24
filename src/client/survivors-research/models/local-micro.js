const finite=Number.isFinite;
const number=v=>finite(v)?v:null;
const vector=v=>Array.isArray(v)&&v.length===2&&v.every(finite)?[...v]:null;
const emptyFeedback=()=>({previous_action:null,displacement:null,pickup_delta:null,consecutive_deviations:null,coverage:'fresh'});
const FALLBACK_LOCAL_RADIUS = 1;
export const LOCAL_MICRO_PROJECTION_SCHEMA = 'survivors-local-micro-v2';
export const DREX_LOCAL_MICRO_PROJECTION_SCHEMA='survivors-local-micro-v3';
export const DREX_WEAPON_MICRO_PROJECTION_SCHEMA = 'survivors-local-micro-v4';
export const isDrexLocalMicroProjectionSchema = value =>
  value === DREX_LOCAL_MICRO_PROJECTION_SCHEMA || value === DREX_WEAPON_MICRO_PROJECTION_SCHEMA;
export const isLocalMicroProjectionSchema = value =>
  value === LOCAL_MICRO_PROJECTION_SCHEMA || isDrexLocalMicroProjectionSchema(value);
const lootId=id=>Number.isSafeInteger(id)&&id>=0;
const sourceTruncated = source => typeof source?.truncated==='boolean' ? source.truncated : null;
function segmentDistance(x,y,dx,dy) {
  const denom=dx*dx+dy*dy, t=denom ? Math.max(0,Math.min(1,(x*dx+y*dy)/denom)) : 0;
  return Math.hypot(x-t*dx,y-t*dy);
}
function projectTarget(observation,hint,speed) {
  if(!lootId(hint.target?.id))return null;
  const loot=Array.isArray(observation.loot)?observation.loot:[];
  const matches=loot.filter(item=>item.kind==='experience'&&item.id===hint.target.id);
  if(matches.length!==1||!finite(matches[0]?.dx)||!finite(matches[0]?.dy)){
    const unknown=matches.length>0||!Array.isArray(observation.loot)||sourceTruncated(observation.coverage?.loot)!==false||
      loot.some(item=>item.kind==='experience'&&!lootId(item.id));
    return {status:unknown?'unknown':'not_visible'};
  }
  const {id,dx,dy,being_collected}=matches[0];
  if(being_collected===true)return {status:'attracted'};
  if(speed===null||speed<0)return {status:'unknown'};
  if(Math.hypot(dx,dy)>speed)return {status:'outside_local'};
  return {status:'visible',id,dx,dy,last_seen_tick:observation.tick};
}
function projectWeapons(player, threats, localRadius) {
  if (!Array.isArray(player?.weapon_state)) return null;
  const enemyIds = new Set(threats.filter(enemy=>enemy.type==='enemy'&&enemy.id!==null).map(enemy=>enemy.id));
  const levels = new Map((player.equipment??[]).map(weapon=>[weapon.id,weapon.level]));
  return player.weapon_state.map(({id,combat}) => {
    let localCombat = null;
    if (combat) {
      const activeStrikes = combat.active_strikes?.filter(strike => {
        if (!strike.max_bounds) return true;
        const x = Math.max(0,Math.abs(strike.dx)-strike.max_bounds.half_width);
        const y = Math.max(0,Math.abs(strike.dy)-strike.max_bounds.half_height);
        return Math.hypot(x,y)<=localRadius;
      }).map(({max_bounds,...strike})=>({...strike,already_hit_enemy_ids:strike.already_hit_enemy_ids.filter(enemyId=>enemyIds.has(enemyId))}))??null;
      localCombat = {...combat,active_strikes:activeStrikes};
    }
    return {id,level:levels.get(id)??null,combat:localCombat};
  });
}
export function projectLocalMicro({observation,advisorHint=null,feedback=null,facing=null,targetHandoff=false,weaponAware=false}) {
  if (!observation || !Number.isSafeInteger(observation.tick) || observation.tick<0) throw new TypeError('Invalid local observation');
  const speed=number(observation.player?.speed), pickupRadius=number(observation.player?.gem_pickup_radius);
  const speedBasedRadius=speed!==null&&speed>0;
  const localRadius=speedBasedRadius?speed:FALLBACK_LOCAL_RADIUS;
  const movement=vector(observation.player?.movement), threats=[], stats={};
  for(const [key,type] of [['enemies','enemy'],['hazards','hazard']]) {
    const source=Array.isArray(observation[key])?observation[key]:[]; let unknownVelocity=0,unknownShape=0,unknownHostility=0,selected=0;
    for(const row of source) {
      if(!finite(row.dx)||!finite(row.dy)) continue;
      const v=vector(row.velocity), r=finite(row.radius)&&row.radius>=0?row.radius:null;
      const w=finite(row.half_width)&&row.half_width>=0?row.half_width:null;
      const h=finite(row.half_height)&&row.half_height>=0?row.half_height:null;
      const shape=row.shape==='rectangle' ? (w!==null && h!==null?'rectangle':'unknown') :
        row.shape==='circle' ? (r!==null?'circle':'unknown') : row.shape!==undefined ? 'unknown' : r!==null?'circle':'unknown';
      const centerDistance=Math.hypot(row.dx,row.dy);
      const extent=shape==='circle'?r:shape==='rectangle'?Math.hypot(w,h):null;
      let current_clearance=null;
      if(shape==='circle') current_clearance=centerDistance-r;
      else if(shape==='rectangle') {
        const x=Math.abs(row.dx)-w,y=Math.abs(row.dy)-h;
        current_clearance=Math.hypot(Math.max(x,0),Math.max(y,0))+Math.min(Math.max(x,y),0);
      }
      if((current_clearance??centerDistance)>localRadius) continue;
      if(type==='hazard' && row.hostile!==true) {
        if(typeof row.hostile!=='boolean') unknownHostility++;
        continue;
      }
      if (!v) unknownVelocity++;
      if (extent===null) unknownShape++;
      threats.push({type,dx:row.dx,dy:row.dy,shape,radius:r,half_width:w,half_height:h,velocity:v,
        ...(weaponAware && {id:type==='enemy'&&lootId(row.id)?row.id:null,
          hp:type==='enemy'&&finite(row.hp)&&row.hp>=0?row.hp:null}),
        current_clearance,touching_now:current_clearance===null?null:current_clearance<=0}); selected++;
    }
    stats[key]={selected,unknown_velocity:unknownVelocity,unknown_shape:unknownShape,
      source_truncated:sourceTruncated(observation.coverage?.[key])};
    if(type==='hazard') stats[key].unknown_hostility=unknownHostility;
  }
  const reachKnown=speed!==null&&speed>=0&&pickupRadius!==null&&pickupRadius>=0;
  const step=reachKnown?speed*0.1:null;
  const guidance=advisorHint && ['up','down','left','right'].includes(advisorHint.heading) &&
    Number.isSafeInteger(advisorHint.expires_tick) && advisorHint.expires_tick>observation.tick
    ? {heading:advisorHint.heading,remaining_ticks:advisorHint.expires_tick-observation.tick,
      ...(targetHandoff&&{target:projectTarget(observation,advisorHint,speed)}),
      ...(Object.hasOwn(advisorHint,'control_brief')&&{control_brief:advisorHint.control_brief})} : null;
  const local_gems=[];
  const near_gems=[];
  for (const item of observation.loot??[]) {
    if(item.kind!=='experience'||!finite(item.dx)||!finite(item.dy)) continue;
    const distance=Math.hypot(item.dx,item.dy);
    if(targetHandoff ? speed===null||speed<0||distance>speed : distance>localRadius) continue;
    const being_collected=item.being_collected===true;
    const identity=targetHandoff&&{id:lootId(item.id)?item.id:null};
    local_gems.push({dx:item.dx,dy:item.dy,being_collected,...identity,
      ...(targetHandoff&&{selected:guidance?.target?.status==='visible'&&guidance.target.id===item.id})});
    if(!reachKnown||being_collected||distance<=pickupRadius) continue;
    if([[step,0],[-step,0],[0,step],[0,-step]].some(([dx,dy])=>
      segmentDistance(item.dx,item.dy,dx,dy)<=pickupRadius)) {
      near_gems.push({dx:item.dx,dy:item.dy,gap:distance-pickupRadius,...identity});
    }
  }
  const coverage={enemies:stats.enemies,hazards:stats.hazards,loot:{
    selected:local_gems.length,within_one_step:near_gems.length,source_truncated:sourceTruncated(observation.coverage?.loot),
  },pickup_reach_known:reachKnown};
  const feedbackValue=feedback??emptyFeedback();
  const half_height=localRadius+0.5;
  const schema = weaponAware ? DREX_WEAPON_MICRO_PROJECTION_SCHEMA :
    targetHandoff ? DREX_LOCAL_MICRO_PROJECTION_SCHEMA : LOCAL_MICRO_PROJECTION_SCHEMA;
  return {schema,tick:observation.tick,
    player:{speed,movement,gem_pickup_radius:pickupRadius,step_distance:speed!==null&&speed>=0?speed/10:null,
      facing:facing===-1||facing===1?facing:null},
    ...(weaponAware && {weapons:projectWeapons(observation.player,threats,localRadius)}),
    guidance,threats,local_gems,near_gems,coverage,feedback:structuredClone(feedbackValue),
    viewport:{local_radius:localRadius,radius_basis:speedBasedRadius?'one-second-movement':'minimum-fallback',
      half_width:half_height*480/270,half_height,scale_px_per_unit:135/half_height}};
}
export function createLocalMicroFeedback() {
  let last=null,previousAction=null,deviations=null,lastGuidanceId=null,observationGap=false;
  function observe({observation,frame,advisorHint}) {
    const live=advisorHint?.heading && Number.isSafeInteger(advisorHint.expires_tick) && observation.tick<advisorHint.expires_tick;
    const guidanceId=live?advisorHint.guidance_id:null;
    if (!guidanceId || guidanceId!==lastGuidanceId) {deviations=null;lastGuidanceId=guidanceId;}
    const p=frame?.player, count=frame?.gemsCollected;
    if(!p||!finite(p.x)||!finite(p.y)||frame.tick!==observation.tick||!Number.isSafeInteger(count)) {last=null;observationGap=true;return {...emptyFeedback(),coverage:'partial'};}
    const current={tick:observation.tick,x:p.x,y:p.y,pickups:count};
    const result={previous_action:previousAction,displacement:last?{dx:current.x-last.x,dy:current.y-last.y}:null,
      pickup_delta:last?current.pickups-last.pickups:null,consecutive_deviations:deviations,
      coverage:last?'observed':observationGap?'partial':'fresh'};
    last=current;observationGap=false;return result;
  }
  function actionApplied({result,advisorHint,appliedTick}) {
    const action=result?.action_id?.split(':')[1]??(result?.action_id==='stop'?'stop':null);
    if(!['up','down','left','right','stop'].includes(action))return;
    previousAction=action;
    const valid=advisorHint?.heading && Number.isSafeInteger(appliedTick) && appliedTick<advisorHint.expires_tick;
    if (!valid) {deviations=null;lastGuidanceId=null;}
    else {if(lastGuidanceId!==advisorHint.guidance_id) deviations=0;
      deviations=action===advisorHint.heading?0:(deviations??0)+1;lastGuidanceId=advisorHint.guidance_id;}
  }
  return {observe,actionApplied};
}
export function validLocalFeedback(f) {
  return f && Object.keys(f).length===5 && ['fresh','partial','observed'].includes(f.coverage) &&
    (f.previous_action===null||['up','down','left','right','stop'].includes(f.previous_action)) &&
    (f.displacement===null||Object.keys(f.displacement).length===2 && finite(f.displacement.dx) && finite(f.displacement.dy)) &&
    (f.pickup_delta===null||Number.isSafeInteger(f.pickup_delta)&&f.pickup_delta>=0) &&
    (f.consecutive_deviations===null||Number.isSafeInteger(f.consecutive_deviations)&&f.consecutive_deviations>=0);
}
export function localMicroQuestion(projection) {
  const heading=projection.guidance?.heading;
  const resume=heading ? `Then resume guidance toward ${heading}.` : 'Then continue using the current local observation.';
  let instruction;
  if (projection.threats.some(threat=>threat.touching_now===true)) {
    instruction=`A threat currently overlaps the player. Choose one action to leave the current overlap in the next 100 ms. ${resume}`;
  } else if (projection.near_gems.length) {
    instruction=`A nearby gem can enter pickup range in one short step. Choose one step to collect it; briefly evade only if that step would cause immediate contact. ${resume}`;
  } else {
    instruction=heading ? `Advance toward ${heading} for the next up to 100 ms. Briefly evade only if contact is imminent within that step, then resume guidance.`
      : 'Direction guidance is unavailable. Continue actual movement when appropriate or choose one local action; briefly evade imminent contact.';
  }
  if (projection.threats.some(threat=>threat.touching_now===null)) instruction+=' Unknown threat geometry does not imply safety.';
  if (projection.near_gems.length && projection.feedback?.pickup_delta===0) instruction+=' Pickup can be credited after a delay.';
  instruction+=' Positive x is right and positive y is down.';
  instruction+='\n请严格优先考虑方向层给的方向建议';
  return {type:'choice',name:'action',instructions:instruction,
    choices:['up','down','left','right','stop'].map(value=>({value,description:value==='stop'?'Stop now.':`Move ${value} for up to 100 ms.`}))};
}
