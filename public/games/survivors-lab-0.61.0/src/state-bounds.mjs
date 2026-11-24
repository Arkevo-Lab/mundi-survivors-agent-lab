// Resource/semantic limits for local checkpoints. These are safety caps, not
// original-game balance. Oversized saves reject intact; no silent trimming.
import {requireValue, integer} from './persistence.mjs';
import {enemyStats} from './balance.mjs';
const MAX_TICK=31*60*60;
const numberIn=(value,min,max)=>typeof value==='number' && Number.isFinite(value) && value>=min && value<=max;
export function validateStateBounds(state,weaponFields,maxTicks) {
  for(const [key,value] of Object.entries(state)) if(typeof value==='number') requireValue(numberIn(value,-1000,key==='rng'||key==='seed'?0xffffffff:10_000_000),'state bound: '+key);
  for(const [key,value] of Object.entries(state))if(/Tick$|Until$/.test(key))requireValue(integer(value,key.startsWith('last')?-1000:0,MAX_TICK*2),'state timer: '+key);
  requireValue(state.tick<=maxTicks && (state.reason!=='time-limit'||state.tick===maxTicks) && (state.done ? state.reason==='time-limit'||state.player.hp===0 : state.player.hp>0 && state.tick<maxTicks),'terminal state mismatch');
  for(const [key,value] of Object.entries(state.player)) if(typeof value==='number')requireValue(numberIn(value,-1_000_000,['xp','xpEarned'].includes(key)?900_000_000_000:1_000_000),'player bound: '+key);
  const p=state.player;
  for(const key of ['might','growth','projectileSpeed','area','luck','cooldownMultiplier'])requireValue(numberIn(p[key],0.01,16),'player multiplier: '+key);
  requireValue(integer(p.bonusProjectiles,0,16)&&integer(p.level,1,1000)&&numberIn(p.speed,0,100)&&numberIn(p.magnet,0.01,100)&&integer(p.armor,0,100),'player resource bound');
  requireValue([1,-1].includes(p.facing)&&numberIn(p.facingX,-1,1)&&numberIn(p.facingY,-1,1),'invalid facing');
  for(const field of weaponFields) {
    const weapon=state[field];if(!weapon)continue;
    for(const [key,value] of Object.entries(weapon)) if(typeof value==='number') {
      requireValue(numberIn(value,key.startsWith('last')?-1000:0,1_000_000),'weapon bound: '+field+'.'+key);
      if(['amount','strikes'].includes(key))requireValue(integer(value,1,field==='vandalier'?20:16),'weapon projectile count');
      if(/Ticks$/.test(key))requireValue(integer(value,1,MAX_TICK),'weapon timer');
      if(/Tick$|Until$/.test(key))requireValue(integer(value,key.startsWith('last')?-1000:0,MAX_TICK*2),'weapon clock');
      if(['radius','area','orbitRadius'].includes(key))requireValue(numberIn(value,0.01,32),'weapon area');
      if(['speed','angularSpeed'].includes(key))requireValue(numberIn(value,0.01,100),'weapon speed');
    }
    if(field==='laurel')requireValue(integer(weapon.maxCharges,1,8)&&integer(weapon.charges,0,weapon.maxCharges),'invalid charges');
    if(field==='clockLancet')requireValue(weapon.sweepModel==='clock12'&&integer(weapon.phase,0,11)&&integer(weapon.lastDirection,0,11),'invalid clock sweep');
    if(field==='pentagram')requireValue(numberIn(weapon.preserveChance,0,1),'invalid preserve chance');
  }
  const limits={garlicAreas:512,birdRays:512,bibleShots:512,soulHearts:1024,enemies:1024,projectiles:2048,gems:8192,chests:128,breakables:28,pickups:4096,lightningStrikes:256,santaWaterZones:256,carnageExplosions:256,whipStrikes:128,pendingWhips:128,recentEnemyDeaths:4096};
  let total=0;
  for(const [name,limit] of Object.entries(limits)) {
    requireValue(state[name].length<=limit,'collection capacity: '+name);total+=state[name].length;
    for(const entity of state[name])for(const [key,value] of Object.entries(entity))if(typeof value==='number' && !(name==='enemies' && ['hp','maxHp','baseHp'].includes(key)) && !(name==='gems' && key==='rawValue') && !(name==='pickups' && ['halfUnits','feverTicks'].includes(key)))requireValue(numberIn(value,-1_000_000,10_000_000),'entity bound: '+name+'.'+key);
  }
  // Level-scaled Reapers legitimately exceed the generic coordinate/counter
  // budget. Bind health to the actual production profile and spawn level.
  for(const enemy of state.enemies) {
    requireValue(integer(enemy.spawnLevel,1,p.level),'enemy spawn level bound');
    const generated=enemyStats(enemy.kind,enemy.spawnLevel);
    requireValue(enemy.baseHp===generated.baseHp && enemy.maxHp===generated.maxHp && enemy.levelScaled===generated.levelScaled && numberIn(enemy.hp,Number.MIN_VALUE,generated.maxHp),'enemy health bound');
  }
  requireValue(total<=20000,'entity capacity exceeded');
  requireValue(state.enemies.length*(state.projectiles.length+state.whipStrikes.length+state.santaWaterZones.length+state.carnageExplosions.length+state.bibleShots.length+state.birdRays.length+state.garlicAreas.length)<=1_000_000,'collision work capacity exceeded');
  for(const prop of state.breakables)requireValue(prop.kind==='candelabra'&&prop.hp>0&&prop.radius>0,'invalid breakable variant');
  for(const gem of state.gems)requireValue(integer(gem.value,1,1_000_000),'invalid gem');
  for(const shot of state.projectiles) {
    requireValue(integer(shot.ttl,1,MAX_TICK)&&Math.abs(shot.vx)<=1000&&Math.abs(shot.vy)<=1000&&numberIn(shot.damage,0,1_000_000),'projectile bound');
    if(['axe','death-spiral','cross','heaven-sword','bone'].includes(shot.kind))requireValue(numberIn(shot.radius,0.01,64),'missing projectile radius');
    requireValue(new Set(shot.hitIds).size===shot.hitIds.length && shot.hitIds.length<=20000,'invalid hit references');
  }
  requireValue(state.progression.receipts.length<=4096 && state.progression.encounters.length<=128,'receipt capacity reached; export required');
  const worldIds=new Set([...state.chests,...state.enemies].map(row=>row.id));
  for(const receipt of state.progression.receipts)if(receipt.kind==='treasure')requireValue(!worldIds.has(Number(receipt.id.slice(6))),'claimed chest still in world');
  const encounters=state.progression.encounters;
  requireValue(new Set(encounters.map(row=>row.id)).size===encounters.length,'duplicate encounter receipt');
  requireValue(encounters.filter(row=>row.kind!=='reaper').length===state.bossKills,'boss ledger mismatch');
  for(const encounter of encounters)requireValue(!worldIds.has(encounter.id),'defeated encounter still in world');
}
