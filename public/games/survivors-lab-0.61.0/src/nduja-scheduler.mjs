// 061-only deterministic Nduja volley scheduling. Projectile geometry, source
// prefab flags and native physics order remain outside this local policy.
export const NDUJA_MAX_PENDING_SHOTS=1024;
export const NDUJA_MAX_PROJECTILES=2048;
export const NDUJA_MAX_VOLLEY_ID=10_000_000;
export const NDUJA_MAX_TICK=31*60*60;
const int=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const finite=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
const required=(ok,message)=>{if(!ok)throw new Error(message);};
const exact=(object,keys)=>object && typeof object==='object' && !Array.isArray(object) && Object.keys(object).sort().join(',')===keys;
const order=(a,b)=>a.dueTick-b.dueTick || a.volleyId-b.volleyId || a.index-b.index;
const delay=index=>Math.ceil(index*40*60/1000);

export function ndujaBurstParameters({bonusProjectiles,cooldownMultiplier,emptyTomeLevel}={}) {
 required(int(bonusProjectiles,0,16) && finite(cooldownMultiplier,.01,16) && int(emptyTomeLevel,0,5),'invalid nduja burst stats');
 return {amount:12+Math.min(10,bonusProjectiles),
  intervalTicks:Math.max(1,Math.floor(30*Math.max(.1,cooldownMultiplier-emptyTomeLevel*.08)))};
}

export function validateNdujaScheduler(state,tick) {
 required(int(tick,0,NDUJA_MAX_TICK),'invalid nduja tick');
 required(exact(state,'active,nextBurstTick,nextVolleyId,pendingShots,startTick') && typeof state.active==='boolean' &&
  int(state.startTick,0,tick) && int(state.nextBurstTick,0,Math.min(NDUJA_MAX_TICK+480,tick+480)) &&
  int(state.nextVolleyId,1,NDUJA_MAX_VOLLEY_ID) && Array.isArray(state.pendingShots) &&
  state.pendingShots.length<=NDUJA_MAX_PENDING_SHOTS,'invalid nduja scheduler');
 const groups=new Map(),pairs=new Set();let prior=null;
 for(let i=0;i<state.pendingShots.length;i++){
  required(Object.hasOwn(state.pendingShots,i),'sparse nduja queue');const shot=state.pendingShots[i];
  required(exact(shot,'bornTick,dueTick,index,total,volleyId') && int(shot.bornTick,0,tick) &&
   int(shot.volleyId,1,state.nextVolleyId-1) && int(shot.total,12,22) && int(shot.index,0,shot.total-1) &&
   shot.dueTick===shot.bornTick+delay(shot.index) && (!prior || order(prior,shot)<0),'invalid nduja shot');
  const key=`${shot.volleyId}:${shot.index}`,group=groups.get(shot.volleyId);
  required(!pairs.has(key) && (!group || group.bornTick===shot.bornTick && group.total===shot.total && shot.index===group.last+1),'conflicting nduja volley');
  pairs.add(key);groups.set(shot.volleyId,{bornTick:shot.bornTick,total:shot.total,last:shot.index});prior=shot;
 }
 for(const group of groups.values())required(group.last===group.total-1,'incomplete nduja volley');
 return true;
}
export function createNdujaScheduler(tick) {
 required(int(tick,0,NDUJA_MAX_TICK),'invalid nduja start');
 return {active:true,startTick:tick,nextBurstTick:tick+1,nextVolleyId:1,pendingShots:[]};
}
export function pickupNdujaScheduler(current,tick) {
 if(current===null)return createNdujaScheduler(tick);
 validateNdujaScheduler(current,tick);
 const next={...current,pendingShots:current.pendingShots.map(shot=>({...shot}))};
 if(next.active)next.startTick=tick-Math.max(1,tick-next.startTick-600);
 else {next.active=true;next.startTick=tick;next.nextBurstTick=Math.min(next.nextBurstTick,tick+1);}
 required(next.startTick>=0,'invalid nduja start');return next;
}

// Amount and cooldown are sampled when a volley is scheduled. Duration is
// checked each tick; projectile speed/area/facing are sampled at emission.
// A full projectile pool leaves overdue shots in due/id/index order. When the
// bounded queue cannot fit a whole volley, scheduling waits for room instead of
// dropping shots or blocking world movement; this is a local capacity policy.
export function advanceNdujaScheduler(current,tick,stats,availableSlots) {
 validateNdujaScheduler(current,tick);
 required(exact(stats,'area,bonusProjectiles,character,cooldownMultiplier,emptyTomeLevel,facingX,facingY,projectileSpeed,spellbinderLevel') &&
  int(stats.bonusProjectiles,0,16) && finite(stats.cooldownMultiplier,.01,16) && int(stats.emptyTomeLevel,0,5) &&
  int(stats.spellbinderLevel,0,5) && ['antonio','imelda','pasqualina','gennaro','arca','porta','exdash','mortaccio'].includes(stats.character) && finite(stats.projectileSpeed,.01,16) &&
  finite(stats.area,.01,16) && finite(stats.facingX,-1,1) && finite(stats.facingY,-1,1) &&
  int(availableSlots,0,NDUJA_MAX_PROJECTILES),'invalid nduja stats');
 const next={...current,pendingShots:current.pendingShots.map(shot=>({...shot}))};
 const duration=Math.max(1,Math.floor(600*((stats.character==='exdash'?0.9:1)+stats.spellbinderLevel*.1)));
 if(next.active && tick-next.startTick>duration)next.active=false;
 if(next.active && tick>=next.nextBurstTick){
  const {amount:total,intervalTicks}=ndujaBurstParameters(stats);
  if(next.pendingShots.length+total<=NDUJA_MAX_PENDING_SHOTS){
   required(next.nextVolleyId<NDUJA_MAX_VOLLEY_ID,'nduja volley id capacity');
   const volleyId=next.nextVolleyId++;
   for(let index=0;index<total;index++)next.pendingShots.push({bornTick:tick,dueTick:tick+delay(index),volleyId,index,total});
   next.pendingShots.sort(order);
   next.nextBurstTick=tick+intervalTicks;
  }else next.nextBurstTick=tick+1;
 }
 let count=0;while(count<availableSlots && count<next.pendingShots.length && next.pendingShots[count].dueTick<=tick)count++;
 const emitted=next.pendingShots.splice(0,count).map(shot=>({...shot,projectileSpeed:stats.projectileSpeed,area:stats.area,facingX:stats.facingX,facingY:stats.facingY}));
 validateNdujaScheduler(next,tick);
 return {state:next,emitted};
}
