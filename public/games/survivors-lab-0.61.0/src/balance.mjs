// Independently transcribed numeric facts from the official HTML5 v0.2.4
// sample. Enemy health and weapon power share a x10 unit conversion; player
// health/contact damage and experience retain their original units.
export const COMBAT_UNITS = 10;
export const PLAYER_BASE_SPEED = 3.2;

// Installed LevelUpFactory computes cumulative thresholds with an r4 factor.
// This engine stores progress relative to the previous threshold instead.
export function experienceToNextLevel(level) {
  if (!Number.isInteger(level) || level < 1 || level > 1000) throw new Error('invalid level');
  const cumulative = value => {
    const factor = Math.fround(Math.min(8, Math.fround(5 + Math.fround(1.5 * Math.floor(value / 20)))));
    return Math.fround(Math.fround(factor * value) * value);
  };
  return Math.fround(cumulative(level) - cumulative(level - 1));
}

// Preserve normal-mode enemy/player speed ratios while translating world units.
const SPEED_SCALE = 0.231 * PLAYER_BASE_SPEED / 82.5;
const rows = {
  // hp, speed, contact, experience, knockback, level-scaled, radius, artwork
  'bat-1': [.1,140,5,1,1,false,.48,'bat'],
  'bat-2': [.5,140,5,1,1,false,.48,'bat'],
  'bat-3': [.5,140,5,1,1,false,.48,'bat'],
  'bat-4': [5,140,10,30,1,true,.65,'bat'],
  'bat-5': [5,140,10,30,1,true,.65,'bat'],
  'bat-swarm': [.1,700,1,1,1,false,.4,'bat'],
  'ghost-swarm': [1,700,5,1.5,0,false,.48,'ghost'],
  zombie: [1,100,10,1,.8,false,.5,'zombie'],
  skeleton: [1.5,100,10,2,1,false,.48,'skeleton'],
  ghost: [1,200,5,1.5,0,false,.48,'ghost'],
  'mudman-1': [7,100,10,2.5,.3,false,.55,'mudman'],
  'mudman-2': [15,100,10,2.5,.3,false,.55,'mudman'],
  'large-bat': [27,140,10,2.5,.1,false,.7,'bat'],
  werewolf: [18,130,14,2,.8,false,.6,'werewolf'],
  mantis: [50,80,20,3,0,false,.7,'mantis'],
  mummy: [50,80,20,3,0,false,.6,'mummy'],
  flower: [3,20,1,2,1,true,.6,'flower'],
  'large-flower': [50,80,20,3,0,false,.8,'flower'],
  'boss-bat': [50,140,20,25,0,true,1.1,'bat'],
  'boss-mantis': [15,160,20,50,0,true,1.25,'mantis'],
  'boss-werewolf': [20,130,20,30,.1,true,1.1,'werewolf'],
  'boss-mummy': [25,80,20,25,0,true,1.2,'mummy'],
  'boss-flower': [15,160,30,50,0,true,1.3,'flower'],
  reaper: [65535,1200,65535,0,-.5,true,1.4,'reaper']
};
export const ENEMY_PROFILES = Object.freeze(Object.fromEntries(Object.entries(rows).map(([kind,r])=>
  [kind,Object.freeze({baseHp:r[0]*COMBAT_UNITS,speed:Number((r[1]*SPEED_SCALE).toFixed(6)),
    damage:r[2],xp:r[3],knockback:r[4],levelScaled:r[5],radius:r[6],sprite:r[7]})])));
export function enemyStats(kind,level=1){
  const p=ENEMY_PROFILES[kind];
  if(!p||!Number.isInteger(level)||level<1)throw Error('invalid enemy profile');
  const maxHp=p.baseHp*(p.levelScaled?level:1);
  return {...p,hp:maxHp,maxHp,spawnLevel:level};
}
export function enemyExperience(enemy,random){
  const roll = Math.fround(random());
  return Math.floor(Math.fround(Math.fround(roll + Math.fround(.5)) * Math.fround(enemy.xp)));
}

// Cumulative power at each level, including evolved replacements. Attack
// intervals, trajectories, hitboxes and critical effects remain separate work.
const powers={
 whip:[1,1,1.5,2,2.5,3,3.5,4],wand:[1,1,1,1,2,2,2,3],
 knife:[.65,.65,1.15,1.15,1.15,1.15,1.65,1.65],
 fireWand:[2,3,4,5,6,7,8,9],lightning:[1.5,1.5,2.5,2.5,4.5,4.5,6.5,6.5],
 santaWater:[1,1,2,2,3,3,3.5,4],axe:[2,2,4,4,4,6,6,8],
 bible:[1,1,1,2,2,2,3,3],cross:[.5,1.5,1.5,1.5,2.5,2.5,2.5,3.5],
 runetracer:[1,1.5,2,2,2.5,3,3,3],garlic:[.5,.7,.8,.9,1.1,1.2,1.3,1.5],
 peachone:[1,1,2,2,2,3,3,3],ebonyWings:[1,1,2,2,2,3,3,3],
 vandalier:[2.8,2.8,2.8,2.8,2.8,2.8,2.8,2.8],
 bone:[.5,.5,2.5,2.5,4.5,4.5,6.5,6.5]
};
const evolvedPower={whip:4,wand:3,knife:1.65,fireWand:10,lightning:6.5,santaWater:4,runetracer:3,axe:6,bible:3,cross:7.7,vandalier:2.8,garlic:2};
export const DAMAGE_WEAPONS=Object.freeze(Object.keys(powers));

// Candidate evolution matrix for the prototype. The legacy *Dps fields are
// nominal single-hit damage per tick (damage * amount / cooldown ticks), not
// measured damage per second: modifiers, misses and repeated hits are omitted.
// These values describe local tuning, not original-game parity.
const evolutionRows = {
  whip: {rarity: 'evolution', baseDamage: 40, evolvedDamage: 40, baseCooldown: 81, evolvedCooldown: 81, baseAmount: 2, evolvedAmount: 2, utility: 'critical-life-steal'},
  wand: {rarity: 'evolution', baseDamage: 30, evolvedDamage: 30, baseCooldown: 60, evolvedCooldown: 30, baseAmount: 4, evolvedAmount: 4, utility: 'piercing'},
  knife: {rarity: 'evolution', baseDamage: 16.5, evolvedDamage: 16.5, baseCooldown: 60, evolvedCooldown: 21, baseAmount: 6, evolvedAmount: 6, utility: 'continuous-direction'},
  fireWand: {rarity: 'evolution', baseDamage: 90, evolvedDamage: 100, baseCooldown: 180, evolvedCooldown: 180, baseAmount: 3, evolvedAmount: 2, utility: 'piercing'},
  axe: {rarity: 'evolution', baseDamage: 80, evolvedDamage: 60, baseCooldown: 240, evolvedCooldown: 240, baseAmount: 3, evolvedAmount: 9, utility: 'radial-piercing'},
  bible: {rarity: 'evolution', baseDamage: 30, evolvedDamage: 30, baseCooldown: 180, evolvedCooldown: 180, baseAmount: 4, evolvedAmount: 4, utility: 'permanent-orbit'},
  cross: {rarity: 'evolution', baseDamage: 35, evolvedDamage: 77, baseCooldown: 120, evolvedCooldown: 198, baseAmount: 3, evolvedAmount: 1, utility: 'critical-return'}
};
export const EVOLUTION_BALANCE_CANDIDATES = Object.freeze(Object.fromEntries(
  Object.entries(evolutionRows).map(([kind, row]) => [kind, Object.freeze({
    ...row,
    baseDps: Math.round(row.baseDamage * row.baseAmount / row.baseCooldown * 1e6) / 1e6,
    evolvedDps: Math.round(row.evolvedDamage * row.evolvedAmount / row.evolvedCooldown * 1e6) / 1e6
  })])
));

export function weaponDamage(kind,level=1,evolved=false){
 const levels=powers[kind];
 if(!levels||!Number.isInteger(level)||level<1||level>8)throw Error('invalid weapon level');
 const power=evolved?evolvedPower[kind]:levels[level-1];
 if(power===undefined)throw Error('invalid evolution');
 return Math.round(power*COMBAT_UNITS*100)/100;
}
