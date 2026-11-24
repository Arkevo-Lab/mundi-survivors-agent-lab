import {EQUIPMENT_UNLOCK_MANIFEST, DEFAULT_EQUIPMENT_UNLOCKS, validateEquipmentUnlocks, ACHIEVEMENT_UNLOCKS, evaluateAchievementConditions} from './equipment-unlocks.mjs';
import {WEAPON_METADATA, PASSIVE_METADATA} from './content-metadata.mjs';
import {MAX_GEMS, MAX_GEM_UNITS, MAX_RAW_GEM_XP, gemUnits, gemRawValue, validateGemCapacity, depositGemBatch} from './gem-capacity.mjs';
import {validateStateBounds} from './state-bounds.mjs';
import {selectModeledLoot} from './loot-table.mjs';
import {advanceNdujaScheduler,pickupNdujaScheduler,validateNdujaScheduler} from './nduja-scheduler.mjs';
import {clone, requireValue, integer, validateJSON, MAX_SAVE_BYTES} from './persistence.mjs';
import {settleTreasure, treasureGold} from './treasure.mjs';
import {ENEMY_PROFILES, enemyStats, enemyExperience, experienceToNextLevel, weaponDamage, DAMAGE_WEAPONS, PLAYER_BASE_SPEED} from './balance.mjs';
export {MAD_FOREST_WAVES} from './stage.mjs';
import {FOREST_PRESSURE, ENCOUNTER_PRESSURE_CANDIDATES, MAX_ENEMIES, outsideViewPosition, outsideActiveArea, FOREST_EVENTS, shouldTriggerEvent, eventFormation, MAD_FOREST_WAVES, FOREST_BOSSES, forestTreasurePrizeTypes, rollTreasureTier} from './stage.mjs';
import {waveContract} from './wave-pressure.mjs';
import {claimChest} from './treasure-claim-contract.mjs';
import {applyEnemyImpact, moveEnemy, createWhipStrike, whipBounds, whipContains, copyWhipStrike, WHIP_REPEAT_TICKS} from './combat.mjs';
export const ENGINE_ID = 'survivors-lab-0.61.0';
export const TICK_HZ = 60;
export const MAX_REROLLS = 999;
export const REAPER_TICK = 30 * 60 * TICK_HZ;
export const MAX_TICKS = 31 * 60 * TICK_HZ;
export const MAX_WEAPON_SLOTS = 6;
export const MAX_PASSIVE_SLOTS = 6;
export const CHARACTERS = Object.freeze(['antonio', 'imelda', 'pasqualina', 'gennaro', 'arca', 'porta', 'exdash', 'mortaccio']);

// The v0.2.4 demo's Antonio selection card says +10% attack damage every
// ten levels, capped at +50%. Base weapon power is now in balance.mjs.
export function antonioDamageMultiplier(level) {
  if (!Number.isInteger(level) || level < 1) throw new Error('invalid level');
  return 1 + Math.min(5, Math.floor(level / 10)) / 10;
}

// The same demo describes Imelda's +10% experience at each five-level
// milestone, capped at +30%. Base thresholds are a candidate rule in balance.mjs.
export function imeldaExperienceMultiplier(level) {
  if (!Number.isInteger(level) || level < 1) throw new Error('invalid level');
  return 1 + Math.min(3, Math.floor(level / 5)) / 10;
}

// The demo describes Pasqualina's projectile speed increasing at each
// five-level milestone, capped at +30%. Base projectile speeds are our own.
export function pasqualinaProjectileSpeedMultiplier(level) {
  if (!Number.isInteger(level) || level < 1) throw new Error('invalid level');
  return round(1.1 + Math.min(3, Math.floor(level / 5)) / 10);
}

// The demo's Arca card describes -5% cooldown at levels 10, 20 and 30.
// The character is hidden in that sample; this prototype exposes it directly.
export function arcaCooldownMultiplier(level) {
  if (!Number.isInteger(level) || level < 1) throw new Error('invalid level');
  return 1 - Math.min(3, Math.floor(level / 10)) * 0.05;
}

// The demo's hidden Porta table starts at 0.1 cooldown and adds 0.3 at
// levels 2, 3 and 4. The prototype exposes her directly for testing.
export function portaCooldownMultiplier(level) {
  if (!Number.isInteger(level) || level < 1) throw new Error('invalid level');
  return Math.min(1, Math.round((0.1 + (level - 1) * 0.3) * 100) / 100);
}

// The demo's hidden Mortaccio gains one projectile at levels 20, 40 and 60.
export function mortaccioProjectileBonus(level) {
  if (!Number.isInteger(level) || level < 1) throw new Error('invalid level');
  return Math.min(3, Math.floor(level / 20));
}

const COMMON_UPGRADES = Object.freeze([
  {id: 'move-speed', field: 'wingsLevel', label: '翅膀 · 移动速度 +10%'},
  {id: 'armor', field: 'armorLevel', label: '护甲 · 护甲 +1'},
  {id: 'magnet', field: 'attractorLevel', label: '吸引器'}
]);
const MAGNET_FACTORS = Object.freeze([0, 1.5, 1.33, 1.25, 1.2, 1.33]);
// Selected base-game rarity values from the installed WEAPON_DATA table.
const LEVEL_RARITY = Object.freeze({whip:100,wand:100,knife:100,'fire-wand':80,lightning:80,
  'santa-water':100,axe:100,bible:80,cross:80,runetracer:80,garlic:70,laurel:60,
  'clock-lancet':70,pentagram:60,peachone:50,'ebony-wings':50,bone:1,vandalier:1,
  'hollow-heart':90,'empty-tome':50,bracer:100,spinach:100,candelabrador:100,
  spellbinder:100,clover:100,crown:70,duplicator:50,pummarola:90,'move-speed':50,armor:100,magnet:100});
const SYNERGY_OPTIONS = Object.freeze({whip:'hollow-heart',wand:'empty-tome',knife:'bracer',
  fireWand:'spinach',axe:'candelabrador',cross:'clover',bible:'spellbinder',lightning:'duplicator',
  santaWater:'magnet',runetracer:'armor',garlic:'pummarola',pentagram:'crown',peachone:'gain-ebony-wings',
  ebonyWings:'gain-peachone'});
const PASSIVE_OPTION_FIELDS = Object.freeze({'hollow-heart':'hollowHeartLevel','empty-tome':'emptyTomeLevel',
  bracer:'bracerLevel',spinach:'spinachLevel',candelabrador:'candelabradorLevel',spellbinder:'spellbinderLevel',
  clover:'cloverLevel',crown:'crownLevel',duplicator:'duplicatorLevel','move-speed':'wingsLevel',
  armor:'armorLevel',magnet:'attractorLevel',pummarola:'pummarolaLevel'});
const optionEquipmentField = id => {
  if (PASSIVE_OPTION_FIELDS[id]) return PASSIVE_OPTION_FIELDS[id];
  if (!id.startsWith('gain-')) return null;
  return ({'gain-fire-wand':'fireWand','gain-santa-water':'santaWater','gain-clock-lancet':'clockLancet','gain-ebony-wings':'ebonyWings'})[id] ?? id.slice(5);
};
const optionKey = id => id.startsWith('gain-') ? id.slice(5) : id.endsWith('-level') ? id.slice(0,-6) : id;
const WEAPON_FIELDS = Object.freeze(['whip', 'wand', 'knife', 'fireWand', 'lightning',
  'santaWater', 'axe', 'bible', 'cross', 'runetracer', 'garlic', 'laurel', 'clockLancet',
  'pentagram', 'peachone', 'ebonyWings', 'bone', 'vandalier']);
const PASSIVE_FIELDS = Object.freeze(['hollowHeartLevel', 'emptyTomeLevel', 'bracerLevel',
  'spinachLevel', 'candelabradorLevel', 'spellbinderLevel', 'cloverLevel',
  'wingsLevel', 'armorLevel', 'attractorLevel', 'crownLevel', 'duplicatorLevel', 'pummarolaLevel']);
// Ordered to preserve the established reward pool and seeded selection.
const EVOLUTION_RECIPES = Object.freeze([
  ['evolve-vandalier','vandalier','available', [['weapon','peachone',8],['weapon','ebonyWings',1]]],
  ['evolve-runetracer','runetracer','available', [['weapon','runetracer',8],['passive','armorLevel',1]]],
  ['evolve-santa-water','santaWater','available', [['weapon','santaWater',8],['passive','attractorLevel',1]]],
  ['evolve-lightning','lightning','available', [['weapon','lightning',8],['passive','duplicatorLevel',1]]],
  ['evolve-whip','whip','available', [['weapon','whip',8],['passive','hollowHeartLevel',1]]],
  ['evolve-wand','wand','available', [['weapon','wand',8],['passive','emptyTomeLevel',1]]],
  ['evolve-knife','knife','available', [['weapon','knife',8],['passive','bracerLevel',1]]],
  ['evolve-fire-wand','fireWand','available', [['weapon','fireWand',8],['passive','spinachLevel',1]]],
  ['evolve-axe','axe','available', [['weapon','axe',8],['passive','candelabradorLevel',1]]],
  ['evolve-bible','bible','available', [['weapon','bible',8],['passive','spellbinderLevel',1]]],
  ['evolve-cross','cross','available', [['weapon','cross',8],['passive','cloverLevel',1]]],
  ['evolve-pentagram','pentagram','available', [['weapon','pentagram',8],['passive','crownLevel',1]]],
  ['evolve-garlic','garlic','available', [['weapon','garlic',8],['passive','pummarolaLevel',1]]]
]);
// Weapon power at all levels is sourced in balance.mjs. The remaining
// upgrades below include independent cadence/geometry translations.
// The demo's Whip table has eight levels: an extra strike at level 2,
// followed by power and occasional area gains. Numeric translations here
// include independent cadence/geometry tuning; power is in balance.mjs.
const WHIP_LEVEL_BONUSES = Object.freeze({
  2: {strikes: 1}, 3: {}, 4: {area: 0.1},
  5: {}, 6: {area: 0.1},
  7: {}, 8: {}
});
// The demo's Magic Wand also has eight levels: extra projectiles, interval,
// power and penetration upgrades. The values below are prototype tuning.
const WAND_LEVEL_BONUSES = Object.freeze({
  2: {amount: 1}, 3: {cooldown: -12}, 4: {amount: 1},
  5: {}, 6: {amount: 1}, 7: {pierce: 1}, 8: {}
});
// The demo's Knife table has eight levels: additional knives, power,
// penetration and shorter repeat intervals. Values are prototype tuning.
const KNIFE_LEVEL_BONUSES = Object.freeze({
  2: {amount: 1}, 3: {amount: 1},
  4: {amount: 1, cooldown: -6}, 5: {pierce: 1},
  6: {amount: 1, cooldown: -6}, 7: {amount: 1},
  8: {pierce: 1, cooldown: -6}
});
// Fire Wand's eight levels add power, with projectile speed at levels 3, 5,
// and 7. These numeric translations and attack cadence are prototype tuning.
const FIRE_WAND_LEVEL_BONUSES = Object.freeze({
  2: {}, 3: {speed: 2.4}, 4: {},
  5: {speed: 2.4}, 6: {},
  7: {speed: 2.4}, 8: {}
});
// Lightning Ring's demo table alternates more strikes with area and power
// at eight levels. The area translation remains prototype tuning.
const LIGHTNING_LEVEL_BONUSES = Object.freeze({
  2: {amount: 1}, 3: {radius: 0.2},
  4: {amount: 1}, 5: {radius: 0.2},
  6: {amount: 1}, 7: {radius: 0.2},
  8: {amount: 1}
});
// The demo's Santa Water creates damage zones. Its eight-level table adds
// amount/area, power and duration. These numeric translations and the
// targeting/pulse rules are independent prototype tuning.
const SANTA_WATER_LEVEL_BONUSES = Object.freeze({
  2: {amount: 1, radius: 0.15}, 3: {duration: 30},
  4: {amount: 1, radius: 0.15}, 5: {duration: 15},
  6: {amount: 1, radius: 0.15}, 7: {duration: 15},
  8: {radius: 0.15}
});
// The demo's Axe table adds amount, power and penetration across eight
// levels. The projectile trajectory and numeric translation below are ours.
const AXE_LEVEL_BONUSES = Object.freeze({
  2: {amount: 1}, 3: {}, 4: {pierce: 2},
  5: {amount: 1}, 6: {}, 7: {pierce: 2},
  8: {}
});
// The demo's King Bible circles the character. Levels 2/5/8 add books,
// 3/6 add speed and area, and 4/7 add duration and power. These numeric
// translations, collision pulse and orbit phase are independent tuning.
const BIBLE_LEVEL_BONUSES = Object.freeze({
  2: {amount: 1}, 3: {speed: 0.4, area: 0.2},
  4: {duration: 30}, 5: {amount: 1},
  6: {speed: 0.4, area: 0.2}, 7: {duration: 30},
  8: {amount: 1}
});
// The demo's Cross gains power, speed/area and additional projectiles at
// its eight levels. Projectile tuning and the return path below are ours.
const CROSS_LEVEL_BONUSES = Object.freeze({
  2: {}, 3: {speed: 2.25, radius: 0.025},
  4: {amount: 1}, 5: {},
  6: {speed: 2.25, radius: 0.025}, 7: {amount: 1},
  8: {}
});
// The demo's Laurel table has seven levels: four interval reductions and
// an additional charge at levels four and seven. Tick values and blocking
// behavior below are independent prototype tuning.
const LAUREL_LEVEL_BONUSES = Object.freeze({
  2: {recharge: -30}, 3: {recharge: -30}, 4: {charges: 1},
  5: {recharge: -30}, 6: {recharge: -30}, 7: {charges: 1}
});
// The demo's Clock Lancet has seven levels. Levels 2/4/5/7 extend the
// freeze; levels 3/6 shorten its interval. The beam and tick values are ours.
const CLOCK_LANCET_LEVEL_BONUSES = Object.freeze({
  2: {duration: 60}, 3: {cooldown: -30}, 4: {duration: 60},
  5: {duration: 60}, 6: {cooldown: -30}, 7: {duration: 60}
});
// Installed Pentagram has eight levels and a base 10% preservation chance.
// Ticks and the visible-screen footprint remain local conversions.
const PENTAGRAM_LEVEL_BONUSES = Object.freeze({
  2: {cooldown: -600}, 3: {preserveChance: 0.15},
  4: {cooldown: -600}, 5: {preserveChance: 0.2},
  6: {cooldown: -300}, 7: {preserveChance: 0.2}, 8: {cooldown: -300}
});
// The demo lists Peachone and Ebony Wings with the same eight-level pattern:
// more shots each level, area at 2/5/8, power at 3/6, interval at 4/7.
// Radius uses the same 0.85 world-unit-per-area translation as Vandalier;
// orbit, cadence and hit rules remain independent prototype tuning.
const BIRD_LEVEL_BONUSES = Object.freeze({
  2: {amount: 1, radius: 0.34}, 3: {amount: 1},
  4: {amount: 1, cooldown: -15}, 5: {amount: 1, radius: 0.34},
  6: {amount: 1}, 7: {amount: 1, cooldown: -15},
  8: {amount: 1, radius: 0.34}
});
// Installed Bone adds 200 ms duration at 2/6/8, area at 2/4, amount
// at 3/5, speed at 4/8, and power at 3/5/7. 059 converts 200 ms to
// 12 ticks; projectile size, speed, base lifetime and bouncing remain local.
const BONE_LEVEL_BONUSES = Object.freeze({
  2: {duration: 12, radius: 0.04}, 3: {amount: 1},
  4: {speed: 1.5, radius: 0.04}, 5: {amount: 1},
  6: {duration: 12}, 7: {},
  8: {duration: 12, speed: 1.5}
});
// The demo lists power/speed at 2/5, power/duration at 3/6, amount at
// 4/7, and duration at 8. These tick and speed values are prototype tuning.
const RUNETRACER_LEVEL_BONUSES = Object.freeze({
  2: {speed: 1.4}, 3: {duration: 15},
  4: {amount: 1}, 5: {speed: 1.4},
  6: {duration: 15}, 7: {amount: 1},
  8: {duration: 30}
});
// Installed Garlic area and interval, with independent local area scaling.
const GARLIC_LEVEL_BONUSES = Object.freeze({
  2: {radius: 0.76}, 3: {pulse: -6},
  4: {radius: 0.38}, 5: {pulse: -6},
  6: {radius: 0.38}, 7: {pulse: -6},
  8: {radius: 0.38}
});
export const MOON_EVENT_OFFSETS = Object.freeze([180,225,270,315,360,405,450,495,540,563,585,608,630,642,654,666,678,690,702,714,726,732,795]);
const MAX_SOUL_HEARTS = 1024, MAX_SOUL_RECOVERED = 1_000_000;
const MAX_BIBLE_SHOTS = 512, MAX_BIRD_RAYS = 512, MAX_GARLIC_AREAS = 512, MAX_AREA_HITS = 4096, MAX_TOTAL_AREA_HITS = 20_000;
const soulBonusFor = hp => Math.fround(Math.min(6, Math.fround(Math.fround(hp) / Math.fround(600))));
const soulPower = (might, bonus) => Math.fround(Math.fround(2 * Math.fround(might)) + Math.fround(bonus));
const PENTAGRAM_HALF_WIDTH = 16;
const PENTAGRAM_HALF_HEIGHT = 9;
const BOUNCE_AXES = Object.freeze([Object.freeze(['x', 15, 'vx']), Object.freeze(['y', 8.5, 'vy'])]);
const CLOCK_DIRECTIONS = Object.freeze(Array.from({length:12},(_,i)=>
  Object.freeze([Math.cos(i*Math.PI/6),-Math.sin(i*Math.PI/6)])));
const NEW_WEAPONS = Object.freeze([
  {id: 'gain-whip', label: '获得鞭子'},
  {id: 'gain-wand', label: '获得魔杖'},
  {id: 'gain-knife', label: '获得飞刀'},
  {id: 'gain-fire-wand', label: '获得火焰魔杖'},
  {id: 'gain-lightning', label: '获得闪电戒指'},
  {id: 'gain-santa-water', label: '获得圣水'},
  {id: 'gain-axe', label: '获得斧头'},
  {id: 'gain-bible', label: '获得圣经 · 环绕攻击'},
  {id: 'gain-cross', label: '获得十字架 · 折返攻击'},
  {id: 'gain-runetracer', label: '获得符文弹'},
  {id: 'gain-garlic', label: '获得蒜香光环'},
  {id: 'gain-laurel', label: '获得月桂护盾 · 抵挡一次伤害'},
  {id: 'gain-clock-lancet', label: '获得时钟柳叶刀 · 冻结敌人'},
  {id: 'gain-pentagram', label: '获得五芒星 · 清除视野内敌人'},
  {id: 'gain-peachone', label: '获得 Peachone · 环绕轰炸'},
  {id: 'gain-ebony-wings', label: '获得 Ebony Wings · 反向环绕轰炸'},
  {id: 'gain-bone', label: '获得 Bone · 弹跳骨头'}
]);

const round = value => Math.round(value * 10000) / 10000;
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
// Selected installed base rows; 059 has fresh local enemies, not Unity pools.
// Freeze/debuff overrides, native geometry and same-type pooling remain open.
const ENEMY_STATUS_PROFILES=Object.freeze(Object.fromEntries([
  ...['bat-1','bat-2','bat-3','bat-4','bat-5','bat-swarm','ghost-swarm','zombie','skeleton','ghost','mudman-1','mudman-2','large-bat','werewolf','mantis','mummy','flower','large-flower'].map(kind=>[kind,Object.freeze({freeze:0,maxKnockback:3,guard:0})]),
  ...['boss-mantis','boss-mummy','boss-flower'].map(kind=>[kind,Object.freeze({freeze:Math.fround(1.1),maxKnockback:1,guard:0})]),
  ['boss-bat',Object.freeze({freeze:1,maxKnockback:1,guard:0})],
  ['boss-werewolf',Object.freeze({freeze:0,maxKnockback:1,guard:0})],
  ['reaper',Object.freeze({freeze:1,maxKnockback:0,guard:1})]
]));
function enemyStatusProfile(kind){requireValue(Object.hasOwn(ENEMY_STATUS_PROFILES,kind),'unknown enemy status profile');return ENEMY_STATUS_PROFILES[kind];}

const copyProjectile = projectile => ({...projectile,
  ...(projectile.hitIds ? {hitIds: [...projectile.hitIds]} : {})});
const LIVE_DAMAGE_SLOTS = Object.freeze({wand:'wand',knife:'knife',fireball:'fireWand',axe:'axe',
  'death-spiral':'axe',cross:'cross','heaven-sword':'cross',bone:'bone',runetracer:'runetracer'});
const LIVE_DAMAGE_EVOLUTIONS = Object.freeze({'evolve-wand':'wand','evolve-knife':'knife',
  'evolve-fire-wand':'fireWand','evolve-axe':'axe','evolve-cross':'cross','evolve-runetracer':'runetracer'});
const copyBird = bird => bird && {...bird, rayTargets:bird.rayTargets.map(point=>({...point}))};
const initialBird = tick => ({level: 1, damage: weaponDamage('peachone'), amount: 4, radius: 0.85, rayTargets: [], rayCursor: 0,
  cooldownTicks: 60, durationTicks: 240, nextTick: tick + 1,
  nextPulseTick: 0, activeUntil: 0, lastCastTick: -100,
  lastPulseTick: -100, casts: 0, hits: 0});
const initialVandalier = tick => ({...initialBird(tick), damage: weaponDamage('vandalier',1,true),
  amount: 20, radius: 1.87, evolved: true});
const initialBone = tick => ({level: 1, damage: weaponDamage('bone'), amount: 1, radius: 0.17,
  speed: 9, cooldownTicks: 180, durationTicks: 180, nextTick: tick + 1,
  casts: 0, hits: 0, bounces: 0});

export function createSurvivorsGame({seed = 1, maxTicks = MAX_TICKS, character = 'antonio', equipmentUnlocks = DEFAULT_EQUIPMENT_UNLOCKS} = {}) {
  requireValue(validateEquipmentUnlocks(equipmentUnlocks), 'invalid equipment unlocks');
  let initialEquipmentUnlocks = [...equipmentUnlocks];
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be uint32');
  if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > MAX_TICKS) throw new Error('invalid time limit');
  if (!CHARACTERS.includes(character)) throw new Error('unsupported character');
  let state;
  let compactedGems=false, pendingGemDrops=[], areaHitCount=0;
  let schema;
  const weaponSchemas = {};
  let rewardIds;

  function random() {
    let value = state.rng >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    state.rng = value >>> 0;
    return state.rng / 0x100000000;
  }

  function weaponSlots() {
    return {used: WEAPON_FIELDS.filter(field => state[field]).length, max: MAX_WEAPON_SLOTS};
  }

  function passiveSlots() {
    return {used: PASSIVE_FIELDS.filter(field => state[field] > 0).length, max: MAX_PASSIVE_SLOTS};
  }

  function canOfferPassive(field) {
    return state[field] < PASSIVE_METADATA[field].maxLevel && (state[field] > 0 || state.runEquipmentUnlocks.includes(field) && passiveSlots().used < MAX_PASSIVE_SLOTS);
  }

  function upgradeChoices(treasurePool = false) {
    const whipOption = state.whip && !state.whip.evolved && state.whip.level < WEAPON_METADATA.whip.maxLevel
      ? {id: 'whip-level', label: `鞭子升至 LV ${state.whip.level + 1}`} : null;
    const wandOption = state.wand && !state.wand.evolved && state.wand.level < WEAPON_METADATA.wand.maxLevel
      ? {id: 'wand-level', label: `魔杖升至 LV ${state.wand.level + 1}`} : null;
    const knifeOption = state.knife && !state.knife.evolved && state.knife.level < WEAPON_METADATA.knife.maxLevel
      ? {id: 'knife-level', label: `飞刀升至 LV ${state.knife.level + 1}`} : null;
    const fireWandOption = state.fireWand && !state.fireWand.evolved && state.fireWand.level < WEAPON_METADATA.fireWand.maxLevel
      ? {id: 'fire-wand-level', label: `火焰魔杖升至 LV ${state.fireWand.level + 1}`} : null;
    const lightningOption = state.lightning && !state.lightning.evolved && state.lightning.level < WEAPON_METADATA.lightning.maxLevel
      ? {id: 'lightning-level', label: `闪电戒指升至 LV ${state.lightning.level + 1}`} : null;
    const santaWaterOption = state.santaWater && !state.santaWater.evolved && state.santaWater.level < WEAPON_METADATA.santaWater.maxLevel
      ? {id: 'santa-water-level', label: `圣水升至 LV ${state.santaWater.level + 1}`} : null;
    const axeOption = state.axe && !state.axe.evolved && state.axe.level < WEAPON_METADATA.axe.maxLevel
      ? {id: 'axe-level', label: `斧头升至 LV ${state.axe.level + 1}`} : null;
    const bibleOption = state.bible && !state.bible.evolved && state.bible.level < WEAPON_METADATA.bible.maxLevel
      ? {id: 'bible-level', label: `圣经升至 LV ${state.bible.level + 1}`} : null;
    const crossOption = state.cross && !state.cross.evolved && state.cross.level < WEAPON_METADATA.cross.maxLevel
      ? {id: 'cross-level', label: `十字架升至 LV ${state.cross.level + 1}`} : null;
    const laurelOption = state.laurel && state.laurel.level < WEAPON_METADATA.laurel.maxLevel
      ? {id: 'laurel-level', label: `月桂护盾升至 LV ${state.laurel.level + 1}`} : null;
    const clockLancetOption = state.clockLancet && state.clockLancet.level < WEAPON_METADATA.clockLancet.maxLevel
      ? {id: 'clock-lancet-level', label: `时钟柳叶刀升至 LV ${state.clockLancet.level + 1}`} : null;
    const pentagramOption = state.pentagram && !state.pentagram.evolved && state.pentagram.level < WEAPON_METADATA.pentagram.maxLevel
      ? {id: 'pentagram-level', label: `五芒星升至 LV ${state.pentagram.level + 1}`} : null;
    const peachoneOption = state.peachone && state.peachone.level < WEAPON_METADATA.peachone.maxLevel
      ? {id: 'peachone-level', label: `Peachone 升至 LV ${state.peachone.level + 1}`} : null;
    const ebonyWingsOption = state.ebonyWings && state.ebonyWings.level < WEAPON_METADATA.ebonyWings.maxLevel
      ? {id: 'ebony-wings-level', label: `Ebony Wings 升至 LV ${state.ebonyWings.level + 1}`} : null;
    const vandalierOption = state.vandalier && state.vandalier.level < WEAPON_METADATA.vandalier.maxLevel
      ? {id: 'vandalier-level', label: `Vandalier 升至 LV ${state.vandalier.level + 1}`} : null;
    const boneOption = state.bone && state.bone.level < WEAPON_METADATA.bone.maxLevel
      ? {id: 'bone-level', label: `Bone 升至 LV ${state.bone.level + 1}`} : null;
    const runetracerOption = state.runetracer && !state.runetracer.evolved && state.runetracer.level < WEAPON_METADATA.runetracer.maxLevel
      ? {id: 'runetracer-level', label: `符文弹升至 LV ${state.runetracer.level + 1}`} : null;
    const garlicOption = state.garlic && !state.garlic.evolved && state.garlic.level < WEAPON_METADATA.garlic.maxLevel
      ? {id: 'garlic-level', label: `蒜香光环升至 LV ${state.garlic.level + 1}`} : null;
    const heartOption = canOfferPassive('hollowHeartLevel')
      ? {id: 'hollow-heart', label: `空心之心 LV ${state.hollowHeartLevel + 1} · 最大生命 +20%`} : null;
    const tomeOption = canOfferPassive('emptyTomeLevel')
      ? {id: 'empty-tome', label: `空白之书 LV ${state.emptyTomeLevel + 1} · 武器冷却 -8%`} : null;
    const bracerOption = canOfferPassive('bracerLevel')
      ? {id: 'bracer', label: `Bracer LV ${state.bracerLevel + 1} · 投射物速度 +10%`} : null;
    const spinachOption = canOfferPassive('spinachLevel')
      ? {id: 'spinach', label: `菠菜 LV ${state.spinachLevel + 1} · 伤害 +10%`} : null;
    const candelabradorOption = canOfferPassive('candelabradorLevel')
      ? {id: 'candelabrador', label: `Candelabrador LV ${state.candelabradorLevel + 1} · 攻击范围 +10%`} : null;
    const spellbinderOption = canOfferPassive('spellbinderLevel')
      ? {id: 'spellbinder', label: `Spellbinder LV ${state.spellbinderLevel + 1} · 持续时间 +10%`} : null;
    const cloverOption = canOfferPassive('cloverLevel')
      ? {id: 'clover', label: `Clover LV ${state.cloverLevel + 1} · 幸运 +10%`} : null;
    const crownOption = canOfferPassive('crownLevel')
      ? {id: 'crown', label: `Crown LV ${state.crownLevel + 1} · 经验 +8%`} : null;
    const pummarolaOption = canOfferPassive('pummarolaLevel')
      ? {id: 'pummarola', label: `Pummarola LV ${state.pummarolaLevel + 1} · 每秒回复 0.2 生命`} : null;
    const duplicatorOption = state.duplicatorLevel < PASSIVE_METADATA.duplicatorLevel.maxLevel &&
      (state.duplicatorLevel > 0 || state.runEquipmentUnlocks.includes('duplicatorLevel') && passiveSlots().used < MAX_PASSIVE_SLOTS)
      ? {id: 'duplicator', label: `Duplicator LV ${state.duplicatorLevel + 1} · 投射物 +1`} : null;
    const options = [...COMMON_UPGRADES.filter(option => canOfferPassive(option.field))
      .map(option => ({id: option.id, label: option.id === 'magnet'
        ? `${option.label} · 拾取范围 +${Math.round((MAGNET_FACTORS[state.attractorLevel + 1] - 1) * 100)}% · LV ${state.attractorLevel + 1}`
        : `${option.label} · LV ${state[option.field] + 1}`})),
      ...(heartOption ? [heartOption] : []),
      ...(tomeOption ? [tomeOption] : []),
      ...(bracerOption ? [bracerOption] : []),
      ...(spinachOption ? [spinachOption] : []),
      ...(candelabradorOption ? [candelabradorOption] : []),
      ...(spellbinderOption ? [spellbinderOption] : []),
      ...(cloverOption ? [cloverOption] : []),
      ...(crownOption ? [crownOption] : []),
      ...(pummarolaOption ? [pummarolaOption] : []),
      ...(duplicatorOption ? [duplicatorOption] : []),
      ...(whipOption ? [whipOption] : []),
      ...(wandOption ? [wandOption] : []),
      ...(knifeOption ? [knifeOption] : []),
      ...(fireWandOption ? [fireWandOption] : []),
      ...(lightningOption ? [lightningOption] : []),
      ...(santaWaterOption ? [santaWaterOption] : []),
      ...(axeOption ? [axeOption] : []),
      ...(bibleOption ? [bibleOption] : []),
      ...(crossOption ? [crossOption] : []),
      ...(laurelOption ? [laurelOption] : []),
      ...(clockLancetOption ? [clockLancetOption] : []),
      ...(pentagramOption ? [pentagramOption] : []),
      ...(peachoneOption ? [peachoneOption] : []),
      ...(ebonyWingsOption ? [ebonyWingsOption] : []),
      ...(vandalierOption ? [vandalierOption] : []),
      ...(boneOption ? [boneOption] : []),
      ...(runetracerOption ? [runetracerOption] : []),
      ...(garlicOption ? [garlicOption] : []),
      ...NEW_WEAPONS.filter(option => weaponSlots().used < MAX_WEAPON_SLOTS &&
        state.runEquipmentUnlocks.includes(optionEquipmentField(option.id)) && !state[optionEquipmentField(option.id)])];
    if (treasurePool) return options;
    if (!options.length) return [
      ...(state.gold <= 9_999_975 ? [{id: 'bonus-coin', label: '金币袋 · 获得 25 金币'}] : []),
      {id: 'bonus-heal', label: '烤鸡 · 恢复 20 生命'}
    ];
    // Two probabilistic existing-equipment attempts precede weighted draws in
    // the installed build. The fourth slot depends on the owner's luck.
    const chosen = [];
    const existing = options.filter(option => option.id.endsWith('-level') ||
      (PASSIVE_OPTION_FIELDS[option.id] && state[PASSIVE_OPTION_FIELDS[option.id]] > 0))
      .sort((a,b) => Number(!a.id.endsWith('-level')) - Number(!b.id.endsWith('-level')));
    const chance = Math.max(0, 1 + (state.player.level % 2 === 0 ? 2 : 1) * 0.3 - 1 / state.player.luck);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (random() > chance || !existing.length) continue;
      const candidate = random() > 0.5 ? existing[0] : existing[Math.floor(random() * existing.length)];
      if (!chosen.some(item => item.id === candidate.id)) chosen.push(candidate);
    }
    const synergies = new Set(Object.entries(SYNERGY_OPTIONS)
      .filter(([slot]) => state[slot]).map(([,id]) => optionKey(id)));
    const weighted = option => (LEVEL_RARITY[optionKey(option.id)] ?? 0) * (synergies.has(optionKey(option.id)) ? 2 : 1);
    const choiceCount = 3 + Number(random() > 1 / state.player.luck);
    while (chosen.length < Math.min(choiceCount, options.length)) {
      let pool = options.filter(option => !chosen.some(item => item.id === option.id) && weighted(option) > 0);
      if (state.player.level <= 3 && weaponSlots().used < MAX_WEAPON_SLOTS) {
        const weapons = pool.filter(option => option.id.startsWith('gain-') || option.id.endsWith('-level'));
        if (weapons.length) pool = weapons;
      }
      if (!pool.length) break;
      const total = pool.reduce((sum,option) => sum + weighted(option),0);
      let roll = Math.floor(random() * total), selected = pool[pool.length - 1];
      for (const option of pool) { roll -= weighted(option); if (roll < 0) {selected = option; break;} }
      chosen.push(selected);
    }
    return chosen.map(option => ({...option}));
  }

  // The same recipe predicates drive the read-only guide and chest rewards.
  // An unavailable implementation is visible as missing functionality, never as a reward.
  function evolutionRecipes() {
    return EVOLUTION_RECIPES.filter(([,slot,,parts])=>
      (slot==='vandalier' ? !state.vandalier : !state[slot]?.evolved) &&
      parts.some(([kind,field])=>kind==='weapon' && !!state[field]))
      .map(([id,slot,implementation,parts])=>{
        const requirements=parts.map(([kind,field,minLevel])=>{
          const currentLevel=kind==='weapon' ? state[field]?.level ?? 0 : state[field];
          return {kind,field,minLevel,currentLevel,met:currentLevel>=minLevel};
        });
        return {id,result:evolutionResults[id],requirements,ownedEligible:implementation==='available' && requirements.every(part=>part.met),implementation};
      });
  }

  const evolutionResults = Object.freeze({
    'evolve-vandalier':'Vandalier','evolve-runetracer':'NO FUTURE','evolve-santa-water':'La Borra',
    'evolve-lightning':'雷电环','evolve-whip':'血鞭','evolve-wand':'圣魔杖','evolve-knife':'千刃',
    'evolve-fire-wand':'地狱火','evolve-axe':'死亡螺旋','evolve-bible':'Unholy Vespers',
    'evolve-cross':'Heaven Sword','evolve-pentagram':'Gorgeous Moon','evolve-garlic':'Soul Eater'
  });
  const evolutionLabels = Object.freeze({
    'evolve-vandalier':'合成 Vandalier · 双环轰炸','evolve-runetracer':'进化为 NO FUTURE · 弹跳爆炸',
    'evolve-santa-water':'进化为 La Borra · 追随圣水','evolve-lightning':'进化为雷电环 · 双次落雷',
    'evolve-whip':'进化为血鞭 · 暴击与吸血','evolve-wand':'进化为圣魔杖 · 高速连射',
    'evolve-knife':'进化为千刃 · 高速穿透飞刀','evolve-fire-wand':'进化为地狱火 · 穿透敌群',
    'evolve-axe':'进化为死亡螺旋 · 放射穿透飞斧','evolve-bible':'进化为 Unholy Vespers · 常驻环绕圣经',
    'evolve-cross':'进化为 Heaven Sword · 暴击折返','evolve-pentagram':'进化为 Gorgeous Moon · 清除与吸取经验','evolve-garlic':'进化为 Soul Eater · 吸取生命'
  });
  function evolutionChoices() {
    return evolutionRecipes().filter(recipe=>recipe.ownedEligible).map(recipe=>({id:recipe.id,label:evolutionLabels[recipe.id]}));
  }

  function effectiveCooldown(baseTicks) {
    return Math.max(1, Math.floor(baseTicks * Math.max(0.1,
      state.player.cooldownMultiplier - state.emptyTomeLevel * 0.08)));
  }

  function effectiveDuration(baseTicks) {
    return Math.max(1, Math.floor(baseTicks * ((state.character === 'exdash' ? 0.9 : 1) +
      state.spellbinderLevel * 0.1)));
  }

  function updateMight() {
    state.player.might = round((state.character === 'antonio'
      ? antonioDamageMultiplier(state.player.level) : state.character === 'exdash' ? 0.9 : 1) +
      state.spinachLevel * 0.1);
  }

  function updateGrowth() {
    state.player.growth = round((state.character === 'imelda'
      ? imeldaExperienceMultiplier(state.player.level) : 1) +
      state.crownLevel * 0.08 +
      ([20, 40].includes(state.player.level) ? 1 : 0));
  }

  function updateProjectileAmount() {
    state.player.bonusProjectiles = (state.character === 'gennaro' ? 1 : 0) +
      (state.character === 'mortaccio' ? mortaccioProjectileBonus(state.player.level) : 0) +
      state.duplicatorLevel;
  }

  function updateProjectileSpeed() {
    state.player.projectileSpeed = round(
      (state.character === 'pasqualina' ? pasqualinaProjectileSpeedMultiplier(state.player.level)
        : state.character === 'exdash' ? 0.5 : 1) +
      state.bracerLevel * 0.1);
  }

  function updateArea() {
    state.player.area = round((state.character === 'porta' ? 1.3
      : state.character === 'exdash' ? 0.9 : 1) +
      state.candelabradorLevel * 0.1);
  }

  function reset(nextSeed = seed, nextCharacter = character, nextUnlocks = initialEquipmentUnlocks) {
    requireValue(validateEquipmentUnlocks(nextUnlocks), 'invalid equipment unlocks');
    if (!Number.isInteger(nextSeed) || nextSeed < 0 || nextSeed > 0xffffffff) throw new Error('seed must be uint32');
    if (!CHARACTERS.includes(nextCharacter)) throw new Error('unsupported character');
    compactedGems=false; pendingGemDrops=[];
    initialEquipmentUnlocks = [...nextUnlocks];
    seed = nextSeed;
    character = nextCharacter;
    state = {
      seed, character, rng: seed || 0x9e3779b9, tick: 0, done: false, reason: null,
      runEquipmentUnlocks: [...initialEquipmentUnlocks], achievementEvents: [],
      progression: {receipts: [], encounters: [], shop: null, shopRevision: 0},
      kills: 0, killTrackingV1: {version:1,fromKills:0,skeleton:0,coverage:'complete'},
      bossKills: 0, chestsOpened: 0, gold: 0, pickupsCollected: 0,
      roastsCollected: 0, vacuumsCollected: 0, cloversCollected: 0, rerollosCollected:0, rerolls:0, breakablesBroken: 0,
      rosariesCollected: 0, rosaryKills: 0, lastRosaryTick: -1000,
      orologionsCollected: 0, orologionFreezes: 0, lastOrologionTick: -1000,
      nduja: null,
      goldFever:null, goldHalfRemainder:0,
      orologionUntil: 0,
      stageEventIndex: 0, stageEventVersion: 2, stageEventsTriggered: 0, lastStageEvent: null,
      nextId: 1, nextSpawnTick: FOREST_PRESSURE[0].intervalTicks, nextBreakableTick: 60, waveMinute: 0,
      lastAttackTick: -100, lastGarlicTick: -100, lastLightningTick: -100,
      pendingUpgrade: null, pendingUpgradeKind: null, lastTreasure: null,
      bibleShots: [], birdRays: [], legacyBirdVolleys: [], garlicAreas: [],
      recentEnemyDeaths: [], whipStrikes: [], pendingWhips: [], pendingVolleys: [], pendingLoopStrikes: [], nextVolleyId: 1, enemies: [], gems: [], chests: [], breakables: [], pickups: [], projectiles: [], lightningStrikes: [], santaWaterZones: [], carnageExplosions: [],
      player: {character, x: 0, y: 0, hp: ['antonio', 'gennaro'].includes(character) ? 120 : character === 'exdash' ? 77 : 100,
        maxHp: ['antonio', 'gennaro'].includes(character) ? 120 : character === 'exdash' ? 77 : 100,
        armor: character === 'antonio' ? 1 : 0, level: 1,
        xp: 0, xpEarned: 0, gemsCollected: 0, xpToNext: experienceToNextLevel(1),
        might: character === 'exdash' ? 0.9 : 1, growth: 1,
        speed: PLAYER_BASE_SPEED * (character === 'exdash' ? .9 : 1),
        magnet: 0.7, facing: 1, facingX: 1, facingY: 0,
        projectileSpeed: character === 'exdash' ? 0.5 : character === 'pasqualina' ? 1.1 : 1,
        area: character === 'porta' ? 1.3 : character === 'exdash' ? 0.9 : 1,
        luck: character === 'exdash' ? 2 : 1,
        bonusProjectiles: character === 'gennaro' ? 1 : 0,
        cooldownMultiplier: character === 'porta' ? portaCooldownMultiplier(1)
          : character === 'exdash' ? 1.1 : 1,
        invulnerableUntil: 0},
      hollowHeartLevel: 0, emptyTomeLevel: 0, bracerLevel: 0, spinachLevel: 0,
      candelabradorLevel: 0, spellbinderLevel: 0, cloverLevel: 0,
      wingsLevel: 0, armorLevel: 0, attractorLevel: 0, crownLevel: 0, duplicatorLevel: 0, pummarolaLevel: 0,
      whip: character === 'antonio' ? {damage: weaponDamage('whip'), cooldownTicks: 81, level: 1,
        strikes: 1, area: 1, evolved: false, criticalHits: 0, lifeStealHealed: 0, nextHealTick: 0,
        nextTick: 1} : null,
      wand: character === 'imelda' ? {damage: weaponDamage('wand'), cooldownTicks: 72, speed: 7,
        level: 1, amount: 1, pierce: 1, evolved: false, nextTick: 1} : null,
      knife: character === 'gennaro' ? {damage: weaponDamage('knife'), cooldownTicks: 60, speed: 10,
        level: 1, amount: 1, pierce: 1, evolved: false, nextTick: 1} : null,
      fireWand: character === 'arca' ? {damage: weaponDamage('fireWand'), cooldownTicks: 180, speed: 9,
        level: 1, amount: 3, evolved: false, nextTick: 1} : null,
      lightning: character === 'porta' ? {damage: weaponDamage('lightning'), cooldownTicks: 270,
        level: 1, amount: 2, radius: 1.05, evolved: false, nextTick: 1} : null,
      santaWater: null,
      axe: null,
      bible: null,
      cross: null,
      runetracer: character === 'pasqualina' ? {damage: weaponDamage('runetracer'), cooldownTicks: 180,
        speed: 7, amount: 1, durationTicks: 135, level: 1, evolved: false, nextRetaliationTick: 0, nextTick: 1} : null,
      garlic: null,
      soulHearts: [],
      laurel: null,
      clockLancet: null,
      pentagram: null,
      moonCycle: null,
      peachone: null,
      ebonyWings: character === 'exdash' ? initialBird(0) : null,
      vandalier: null,
      bone: character === 'mortaccio' ? initialBone(0) : null
    };
    for (let index = 0; index < 7; index++) spawnInitialBreakable();
    // Each installed startup HandleSpawning call performs its ordinary batch
    // and then the same minimum-population check as the repeating timer.
    for (let index = 0; index < 10; index++) spawnNormalBatchToMinimum(MAD_FOREST_WAVES[0],FOREST_PRESSURE[0].minimum);
    return snapshot();
  }

  function applyUpgrade(index) {
    if (!state.pendingUpgrade || !Number.isInteger(index) || index < 0 || index >= state.pendingUpgrade.length)
      throw new Error('invalid upgrade choice');
    const id = state.pendingUpgrade[index].id;
    const eligible = upgradeChoices(true);
    requireValue(eligible.some(option => option.id === id) || !eligible.length && ['bonus-coin','bonus-heal'].includes(id), 'missing dependency: upgrade');
    const receiptId = `level:${state.player.level}`;
    requireValue(state.progression.receipts.length < 4096 && !state.progression.receipts.some(receipt => receipt.id === receiptId), 'upgrade ledger capacity or duplicate');
    applyReward(id);
    state.progression.receipts.push({id: receiptId, kind: 'upgrade', tick: state.tick, rewards: [id], gold: 0});
    state.pendingUpgrade = null;
    state.pendingUpgradeKind = null;
    return id;
  }

  // Called by level selection and engine-owned treasure settlement; never by UI.
  function applyReward(id) {
    const {player, whip, wand, knife, fireWand, lightning, santaWater, axe, bible,
      cross, laurel, clockLancet, pentagram, peachone, ebonyWings, bone} = state;
    const evolvingSlot = LIVE_DAMAGE_EVOLUTIONS[id];
    if (evolvingSlot) for (const shot of state.projectiles) {
      if (shot.liveWeaponDamage === true && LIVE_DAMAGE_SLOTS[shot.kind] === evolvingSlot) {
        shot.damage = state[evolvingSlot].damage;
        delete shot.liveWeaponDamage;
      }
    }
    if (id === 'evolve-whip' && state.whipStrikes.some(strike=>strike.liveWeaponDamage===true)) {
      const damage=whip.damage*player.might;
      requireValue(Number.isFinite(damage) && damage>=0 && damage<=10_000_000,'whip snapshot damage capacity');
      for(const strike of state.whipStrikes)if(strike.liveWeaponDamage===true){
        strike.damage=damage;delete strike.liveWeaponDamage;
      }
    }
    if (id === 'whip-level') {
      whip.level++;
      const bonus = WHIP_LEVEL_BONUSES[whip.level];
      whip.strikes += bonus.strikes ?? 0;
      whip.area = round(whip.area + (bonus.area ?? 0));
    } else if (id === 'evolve-whip') {
      state.pendingWhips = [];
      whip.evolved = true; whip.strikes = 2; whip.area = 1.3;
    } else if (id === 'wand-level') {
      wand.level++;
      const bonus = WAND_LEVEL_BONUSES[wand.level];
      wand.amount += bonus.amount ?? 0;
      wand.pierce += bonus.pierce ?? 0;
      wand.cooldownTicks = Math.max(24, wand.cooldownTicks + (bonus.cooldown ?? 0));
    } else if (id === 'evolve-wand') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'wand');
      wand.evolved = true;
      wand.speed = 14;
      wand.cooldownTicks = 30;
      wand.amount = 4;
      wand.pierce = Math.max(2, wand.pierce);
    } else if (id === 'knife-level') {
      knife.level++;
      const bonus = KNIFE_LEVEL_BONUSES[knife.level];
      knife.amount += bonus.amount ?? 0;
      knife.pierce += bonus.pierce ?? 0;
      // Installed knife level entries shorten the repeat interval, not the base cooldown.
    } else if (id === 'evolve-knife') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'knife');
      knife.evolved = true;
      knife.speed = 15;
      knife.cooldownTicks = 21;
      knife.amount = 6;
      knife.pierce = Math.max(3, knife.pierce);
    } else if (id === 'fire-wand-level') {
      fireWand.level++;
      const bonus = FIRE_WAND_LEVEL_BONUSES[fireWand.level];
      fireWand.speed = round(fireWand.speed + (bonus.speed ?? 0));
    } else if (id === 'evolve-fire-wand') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'fireWand');
      fireWand.evolved = true;
      fireWand.speed = 15;
      fireWand.amount = 2;
      fireWand.cooldownTicks = 180;
    } else if (id === 'lightning-level') {
      lightning.level++;
      const bonus = LIGHTNING_LEVEL_BONUSES[lightning.level];
      lightning.amount += bonus.amount ?? 0;
      lightning.radius = round(lightning.radius + (bonus.radius ?? 0));
    } else if (id === 'evolve-lightning') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'lightning');
      lightning.evolved = true; lightning.amount = 6; lightning.cooldownTicks = 270;
    } else if (id === 'santa-water-level') {
      santaWater.level++;
      const bonus = SANTA_WATER_LEVEL_BONUSES[santaWater.level];
      santaWater.amount += bonus.amount ?? 0;
      santaWater.radius = round(santaWater.radius + (bonus.radius ?? 0));
      santaWater.durationTicks += bonus.duration ?? 0;
    } else if (id === 'evolve-santa-water') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'santaWater');
      santaWater.evolved = true; santaWater.amount = 4; santaWater.radius = 1.6;
      santaWater.durationTicks = 240; santaWater.cooldownTicks = 240;
    } else if (id === 'axe-level') {
      axe.level++;
      const bonus = AXE_LEVEL_BONUSES[axe.level];
      axe.amount += bonus.amount ?? 0;
      axe.pierce += bonus.pierce ?? 0;
    } else if (id === 'evolve-axe') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'axe');
      axe.evolved = true;
      axe.cooldownTicks = 240;
      axe.pierce = 1000;
    } else if (id === 'bible-level') {
      bible.level++;
      const bonus = BIBLE_LEVEL_BONUSES[bible.level];
      bible.amount += bonus.amount ?? 0;
      bible.angularSpeed = round(bible.angularSpeed + (bonus.speed ?? 0));
      bible.orbitRadius = round(bible.orbitRadius + (bonus.area ?? 0));
      bible.durationTicks += bonus.duration ?? 0;
    } else if (id === 'evolve-bible') {
      for (const shot of state.bibleShots) areaHitCount -= shot.hitIds.length;
      state.bibleShots = []; bible.legacyArea = false; bible.activeUntil = state.tick;
      bible.evolved = true; bible.durationTicks = 180; bible.cooldownTicks = 180; bible.nextTick = state.tick + 1;
      bible.amount = Math.max(4, bible.amount);
      bible.orbitRadius = round(bible.orbitRadius + 0.25);
      bible.angularSpeed = round(bible.angularSpeed + 0.5);
    } else if (id === 'cross-level') {
      cross.level++;
      const bonus = CROSS_LEVEL_BONUSES[cross.level];
      cross.speed = round(cross.speed + (bonus.speed ?? 0));
      cross.radius = round(cross.radius + (bonus.radius ?? 0));
      cross.amount += bonus.amount ?? 0;
    } else if (id === 'evolve-cross') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'cross');
      cross.evolved = true;
      cross.speed = 18;
      cross.radius = 0.3;
      cross.cooldownTicks = 198;
      cross.amount = 1;
    } else if (id === 'laurel-level') {
      laurel.level++;
      const bonus = LAUREL_LEVEL_BONUSES[laurel.level];
      laurel.rechargeTicks += bonus.recharge ?? 0;
      laurel.maxCharges += bonus.charges ?? 0;
      laurel.charges = Math.min(laurel.maxCharges, laurel.charges + (bonus.charges ?? 0));
      if (laurel.charges < laurel.maxCharges) {
        laurel.nextChargeTick = Math.min(laurel.nextChargeTick,
          state.tick + effectiveCooldown(laurel.rechargeTicks));
      }
    } else if (id === 'clock-lancet-level') {
      clockLancet.level++;
      const bonus = CLOCK_LANCET_LEVEL_BONUSES[clockLancet.level];
      clockLancet.freezeTicks += bonus.duration ?? 0;
      clockLancet.cooldownTicks += bonus.cooldown ?? 0;
      clockLancet.nextTick = Math.min(clockLancet.nextTick,
        state.tick + effectiveCooldown(clockLancet.cooldownTicks));
    } else if (id === 'pentagram-level') {
      pentagram.level++;
      const bonus = PENTAGRAM_LEVEL_BONUSES[pentagram.level];
      pentagram.cooldownTicks += bonus.cooldown ?? 0;
      pentagram.preserveChance = Math.min(1, round(pentagram.preserveChance + (bonus.preserveChance ?? 0)));
      pentagram.nextTick = Math.min(pentagram.nextTick,
        state.tick + effectiveCooldown(pentagram.cooldownTicks));
    } else if (id === 'evolve-pentagram') {
      pentagram.evolved = true; pentagram.cooldownTicks = 3600; pentagram.preserveChance = 1;
      pentagram.nextTick = state.tick + 6;
    } else if (id === 'peachone-level' || id === 'ebony-wings-level') {
      const bird = id === 'peachone-level' ? peachone : ebonyWings;
      bird.level++;
      const bonus = BIRD_LEVEL_BONUSES[bird.level];
      bird.amount += bonus.amount ?? 0;
      bird.radius = round(bird.radius + (bonus.radius ?? 0));
      bird.cooldownTicks += bonus.cooldown ?? 0;
    } else if (id === 'evolve-vandalier') {
      const removed = new Set(state.pendingVolleys.filter(shot=>['peachone','ebonyWings'].includes(shot.slot)).map(shot=>shot.volleyId));
      state.pendingVolleys = state.pendingVolleys.filter(shot => !['peachone','ebonyWings'].includes(shot.slot));
      state.legacyBirdVolleys = state.legacyBirdVolleys.filter(id=>!removed.has(id));
      for(const ray of state.birdRays)if(['peachone','ebonyWings'].includes(ray.slot))areaHitCount-=ray.hitIds.length;
      state.birdRays = state.birdRays.filter(ray=>!['peachone','ebonyWings'].includes(ray.slot));
      state.peachone = null; state.ebonyWings = null; state.vandalier = initialVandalier(state.tick);
    } else if (id === 'vandalier-level') {
      const bird = state.vandalier; bird.level++;
      if ([2,4,6,8].includes(bird.level)) bird.radius = round(bird.radius + 0.17);
      if ([3,5,7].includes(bird.level)) bird.cooldownTicks -= 15;
    } else if (id === 'bone-level') {
      bone.level++;
      const bonus = BONE_LEVEL_BONUSES[bone.level];
      bone.amount += bonus.amount ?? 0;
      bone.radius = round(bone.radius + (bonus.radius ?? 0));
      bone.speed = round(bone.speed + (bonus.speed ?? 0));
      bone.durationTicks += bonus.duration ?? 0;
    } else if (id === 'evolve-runetracer') {
      state.pendingVolleys = state.pendingVolleys.filter(shot => shot.slot !== 'runetracer');
      const rune = state.runetracer; rune.evolved = true; rune.amount = 1;
      rune.speed = 19.6; rune.durationTicks = 180; rune.cooldownTicks = 60;
    } else if (id === 'runetracer-level') {
      const rune = state.runetracer;
      rune.level++;
      const bonus = RUNETRACER_LEVEL_BONUSES[rune.level];
      rune.speed = round(rune.speed + (bonus.speed ?? 0));
      rune.amount += bonus.amount ?? 0;
      rune.durationTicks += bonus.duration ?? 0;
    } else if (id === 'evolve-garlic') {
      const garlic = state.garlic;
      for(const area of state.garlicAreas)areaHitCount-=area.hitIds.length;
      state.garlicAreas=[];garlic.legacyArea=false;
      garlic.evolved = true; garlic.recoveredHp = 0; garlic.soulBonus = 0;
      garlic.radius = 5.7; garlic.pulseTicks = 60; garlic.nextTick = state.tick + 1;
    } else if (id === 'garlic-level') {
      const garlic = state.garlic;
      garlic.level++;
      const bonus = GARLIC_LEVEL_BONUSES[garlic.level];
      garlic.radius = round(garlic.radius + (bonus.radius ?? 0));
      garlic.pulseTicks += bonus.pulse ?? 0;
      garlic.nextTick = Math.min(garlic.nextTick, state.tick + effectiveCooldown(garlic.pulseTicks));
    }
    else if (id === 'gain-whip') state.whip = {damage: weaponDamage('whip'), cooldownTicks: 81, level: 1,
      strikes: 1, area: 1, evolved: false, criticalHits: 0, lifeStealHealed: 0, nextHealTick: 0,
      nextTick: state.tick + 1};
    else if (id === 'gain-wand') state.wand = {damage: weaponDamage('wand'), cooldownTicks: 72, speed: 7,
      level: 1, amount: 1, pierce: 1, evolved: false, nextTick: state.tick + 1};
    else if (id === 'gain-knife') state.knife = {damage: weaponDamage('knife'), cooldownTicks: 60, speed: 10,
      level: 1, amount: 1, pierce: 1, evolved: false, nextTick: state.tick + 1};
    else if (id === 'gain-fire-wand') state.fireWand = {damage: weaponDamage('fireWand'), cooldownTicks: 180, speed: 9,
      level: 1, amount: 3, evolved: false, nextTick: state.tick + 1};
    else if (id === 'gain-lightning') state.lightning = {damage: weaponDamage('lightning'), cooldownTicks: 270,
      level: 1, amount: 2, radius: 1.05, evolved: false, nextTick: state.tick + 1};
    else if (id === 'gain-santa-water') state.santaWater = {damage: weaponDamage('santaWater'), cooldownTicks: 270,
      level: 1, amount: 1, radius: 0.8, durationTicks: 120, hits: 0, evolved: false, nextTick: state.tick + 1};
    else if (id === 'gain-axe') state.axe = {damage: weaponDamage('axe'), cooldownTicks: 240,
      level: 1, amount: 1, pierce: 3, evolved: false, hits: 0, nextTick: state.tick + 1};
    else if (id === 'gain-bible') state.bible = {damage: weaponDamage('bible'), cooldownTicks: 180,
      durationTicks: 180, angularSpeed: 2.4, orbitRadius: 2.15,
      level: 1, amount: 1, evolved: false, legacyArea: false, hits: 0,
      activeUntil: 0, nextTick: state.tick + 1, nextHitTick: state.tick + 1};
    else if (id === 'gain-cross') state.cross = {damage: weaponDamage('cross'), cooldownTicks: 120,
      speed: 9, radius: 0.25, level: 1, amount: 1, evolved: false,
      hits: 0, criticalHits: 0, nextTick: state.tick + 1};
    else if (id === 'gain-runetracer') state.runetracer = {damage: weaponDamage('runetracer'), cooldownTicks: 180,
      speed: 7, amount: 1, durationTicks: 135, level: 1, evolved: false, nextRetaliationTick: 0, nextTick: state.tick + 1};
    else if (id === 'gain-garlic') state.garlic = {damage: weaponDamage('garlic'), radius: 1.9, pulseTicks: 78, level: 1, evolved: false, recoveredHp: 0, soulBonus: 0, legacyArea: false, nextTick: state.tick + 1};
    else if (id === 'gain-laurel') state.laurel = {level: 1, charges: 1, maxCharges: 1,
      rechargeTicks: 600, nextChargeTick: 0, absorbedHits: 0, lastBlockTick: -100};
    else if (id === 'gain-clock-lancet') state.clockLancet = {level: 1, cooldownTicks: 120,
      freezeTicks: 120, nextTick: state.tick + 1, sweepModel:'clock12', phase: 9, lastDirection: 9,
      lastCastTick: -100, casts: 0, freezes: 0};
    else if (id === 'gain-pentagram') state.pentagram = {level: 1, evolved: false, cooldownTicks: 5400,
      preserveChance: 0.1, nextTick: state.tick + 1, lastCastTick: -100,
      casts: 0, erasedEnemies: 0, erasedItems: 0, preservedCasts: 0};
    else if (id === 'gain-peachone') state.peachone = initialBird(state.tick);
    else if (id === 'gain-ebony-wings') state.ebonyWings = initialBird(state.tick);
    else if (id === 'gain-bone') state.bone = initialBone(state.tick);
    else if (id === 'move-speed') { state.wingsLevel++; player.speed = round(PLAYER_BASE_SPEED * ((state.character === 'exdash' ? 0.9 : 1) + state.wingsLevel * 0.1)); }
    else if (id === 'hollow-heart') {
      state.hollowHeartLevel++;
      // Accessory applies relative MaxHp without changing current health.
      player.maxHp = round(player.maxHp * 1.2);
    }
    else if (id === 'empty-tome') state.emptyTomeLevel++;
    else if (id === 'bracer') { state.bracerLevel++; updateProjectileSpeed(); }
    else if (id === 'spinach') { state.spinachLevel++; updateMight(); }
    else if (id === 'candelabrador') { state.candelabradorLevel++; updateArea(); }
    else if (id === 'spellbinder') state.spellbinderLevel++;
    else if (id === 'clover') {
      state.cloverLevel++;
      // Add to the saved value so character milestones and old runs survive.
      player.luck = round(player.luck + 0.1);
    }
    else if (id === 'crown') { state.crownLevel++; updateGrowth(); }
    else if (id === 'pummarola') state.pummarolaLevel++;
    else if (id === 'duplicator') { state.duplicatorLevel++; updateProjectileAmount(); }
    else if (id === 'armor') { state.armorLevel++; player.armor += 1; }
    else if (id === 'magnet') { state.attractorLevel++; player.magnet = round(player.magnet * MAGNET_FACTORS[state.attractorLevel]); }
    else if (id === 'bonus-coin') {
      requireValue(state.gold <= 9_999_975, 'bonus gold capacity');
      state.gold += 25;
    }
    else if (id === 'bonus-heal') setHealedHp(Math.min(player.maxHp, player.hp + 20));
    for (const key of DAMAGE_WEAPONS) {
      const weapon = state[key];
      if (weapon) weapon.damage = weaponDamage(key, weapon.level, !!weapon.evolved);
    }
    return id;
  }

  function spawnEnemy(kind, eventSpawn = null, encounter = null) {
    if (!eventSpawn && !encounter && state.enemies.length >= MAX_ENEMIES) return;
    requireValue(integer(state.nextId,1,9_999_999),'enemy identity capacity');
    const stats = enemyStats(kind, state.player.level);
    const position = eventSpawn ?? outsideViewPosition(state.player, random);
    const treasureTier = encounter ? rollTreasureTier(encounter.chances, state.player.luck, random) : 0;
    state.enemies.push({id: state.nextId++, ...stats, freezeResistance:enemyStatusProfile(kind).freeze, kind, boss: !!encounter, treasureTier,
      x: round(position.x), y: round(position.y),
      frozenUntil: state.orologionUntil > state.tick ? state.orologionUntil : 0,
      ...(encounter ? {spawnMinute: state.waveMinute} : {}),
      hitUntil: 0, recoilUntil: 0, recoilX: 0, recoilY: 0, recoilSpeed: 0,
      ...(eventSpawn ? {eventType: eventSpawn.eventType, expiresTick: eventSpawn.expiresTick,
        fixedDirection: eventSpawn.fixedDirection, directionX: null, directionY: null} : {})});
    if (state.orologionUntil > state.tick) state.orologionFreezes++;
  }

  function spawnNormalBatchToMinimum(kinds,minimum) {
    let normal=0;for(const enemy of state.enemies)if(!enemy.eventType)normal++;
    const batch=()=>{
      if(normal>=300 || state.enemies.length>=MAX_ENEMIES)return false;
      let spawned=false;
      for(const kind of kinds){
        if(state.enemies.length>=MAX_ENEMIES)break;
        spawnEnemy(kind);normal++;spawned=true;
      }
      return spawned;
    };
    if(!batch())return;
    while(normal<Math.min(minimum,300) && batch()){}
  }

  function spawnWave() {
    const candidate = waveContract(state.waveMinute);
    const pressure = candidate ?? FOREST_PRESSURE[state.waveMinute];
    if (!pressure) return;
    state.nextSpawnTick = state.tick + pressure.intervalTicks;
    // Global clock pickup suspends normal spawns as well as movement.
    if (state.tick < state.orologionUntil) return;
    const kinds = candidate?.composition ?? MAD_FOREST_WAVES[state.waveMinute];
    // A successful ordinary batch is followed by the installed SwarmCheck:
    // refill toward this minute's minimum, checking the permanent cap for
    // each batch. Events are excluded from that permanent count.
    spawnNormalBatchToMinimum(kinds,pressure.minimumAlive ?? pressure.minimum);
  }

  function updateStageEvents() {
    if (state.waveMinute >= 30) return;
    while (state.stageEventIndex < FOREST_EVENTS.length &&
      FOREST_EVENTS[state.stageEventIndex].tick <= state.tick) {
      const event = FOREST_EVENTS[state.stageEventIndex++];
      // StageEventManager gates ordinary event formations at 500 total
      // enemies before dispatch; a permitted formation may cross that mark.
      if (state.enemies.length >= 500 || !shouldTriggerEvent(event, state.player.luck, random)) continue;
      for (const enemy of eventFormation(event, state.player, random)) spawnEnemy(enemy.kind, enemy);
      state.stageEventsTriggered++;
      state.lastStageEvent = {type: event.type, tick: state.tick};
    }
  }

  function cullEnemies() {
    state.enemies = state.enemies.filter(enemy => {
      // Event enemies are kept until their timer expires, even off screen.
      // Expiry is not a combat kill and must not award experience or treasure.
      if (enemy.eventType) return state.tick < enemy.expiresTick;
      if (!outsideActiveArea(enemy, state.player)) return true;
      // Ordinary off-screen enemies disappear without kills or drops. Bosses
      // retain health/status and re-enter out of sight, like the demo's bosses.
      if (!enemy.boss) return false;
      const position = outsideViewPosition(state.player, random);
      enemy.x = round(position.x); enemy.y = round(position.y);
      return true;
    });
  }

  // The demo contains destructible map objects and a pickup table. Placement,
  // drop weights, and prop health here are independent prototype tuning.
  function spawnInitialBreakable() {
    state.breakables = state.breakables.filter(item => distanceSquared(item, state.player) < 30 ** 2);
    if (state.breakables.length >= 28) return;
    const angle = random() * Math.PI * 2;
    const radius = 3.5 + random() * 5.5;
    state.breakables.push({id: state.nextId++, kind: 'candelabra',
      x: round(state.player.x + Math.cos(angle) * radius),
      y: round(state.player.y + Math.sin(angle) * radius), hp: 3, radius: 0.48});
  }

  // Single-player Forest: a one-second timer rolls against the stage's
  // luck-adjusted chance; a successful creation culls the furthest prop if
  // the pool exceeds its stage maximum. Placement uses the local fixed view,
  // an approximation of the original screen geometry. The seven legacy
  // initial props remain until their original initialization is established.
  function spawnTimedBreakable() {
    if (random() * 100 > Math.min(10 * state.player.luck, 50)) return;
    const position = outsideViewPosition(state.player, random);
    state.breakables.push({id: state.nextId++, kind: 'candelabra',
      x: round(position.x), y: round(position.y), hp: 3, radius: 0.48});
    while (state.breakables.length > 10) {
      let furthest = 0;
      for (let i = 1; i < state.breakables.length; i++)
        if (distanceSquared(state.breakables[i], state.player) > distanceSquared(state.breakables[furthest], state.player)) furthest = i;
      state.breakables.splice(furthest, 1);
    }
  }

  // Local pool limit: keep a prop's pre-hit health and its unrolled reward
  // until a later attack can create the drop. A full pool must not roll back
  // movement or repeatedly lock the player into an automatic weapon contact.
  function damageBreakable(index, damage) {
    const item=state.breakables[index],remaining=round(item.hp-damage);
    if(remaining<=0 && state.pickups.length>=4096)return;
    item.hp=remaining;
    if(item.hp<=0)breakBreakable(index);
  }

  function breakBreakable(index) {
    const [item] = state.breakables.splice(index, 1);
    state.breakablesBroken++;
    const roll = random();
    requireValue(state.pickups.length<4096 && integer(state.nextId,1,Number.MAX_SAFE_INTEGER-1),'pickup capacity');
    const kind=selectModeledLoot(state.player.level,state.player.luck,roll);
    state.pickups.push({id: state.nextId++, kind, x: item.x, y: item.y});
  }

  function updateWave() {
    const minute = Math.floor(state.tick / (60 * TICK_HZ));
    if (minute <= state.waveMinute) return;
    state.waveMinute = minute;
    if (minute === 30) {
      // The demo stage table lists ERASE_ENEMIES and BOSS_XLDEATH at 30:00.
      // Species health/speed follow balance.mjs; the one-minute safety cap is local.
      state.enemies = [];
      state.stageEventIndex = FOREST_EVENTS.length;
      state.nextSpawnTick = MAX_TICKS + 1;
      spawnEnemy('reaper', null, FOREST_BOSSES[30]);
      return;
    }
    // There is no ordinary pressure table at minute 31. The terminal tick
    // below settles the run after the final Reaper phase.
    if (minute > 30) {state.nextSpawnTick=MAX_TICKS+1;return;}
    const encounter = FOREST_BOSSES[minute];
    if (encounter) spawnEnemy(encounter.kind, null, encounter);
    state.nextSpawnTick = state.tick + FOREST_PRESSURE[minute].intervalTicks;
  }

  function defeatEnemy(index) {
    requireValue(integer(state.kills,0,9_999_999), 'kill counter capacity');
    const [enemy] = state.enemies.splice(index, 1);
    const value = enemyExperience(enemy, random);
    if (value > 0) {
      requireValue(integer(state.nextId,1,Number.MAX_SAFE_INTEGER-1),'gem identity capacity');
      pendingGemDrops.push({id:state.nextId++,x:enemy.x,y:enemy.y,value});
    }
    if(state.goldFever?.active && random()<=0.75){
      if(state.pickups.length>=4096){
        // Keep all half-gold, even at capacity. The existing stack location is
        // a local approximation; no original pickup is silently discarded.
        let stack=state.pickups.find(item=>item.kind==='fever-coin' && (item.halfUnits??1)<20_000_001);
        if(!stack){
          stack=state.pickups.find(item=>['coin','coin-bag','big-coin-bag'].includes(item.kind));
          if(!stack){
            const pending=state.goldFever.pending;
            if(pending){requireValue(pending.halfUnits<20_000_001,'fever overflow capacity');pending.halfUnits++;}
            else state.goldFever.pending={x:enemy.x,y:enemy.y,halfUnits:1};
          }else{
            const halfUnits=stack.kind==='coin'?2:stack.kind==='coin-bag'?20:200;
            const feverTicks=stack.kind==='coin'?30:stack.kind==='coin-bag'?300:600;
            stack.kind='fever-coin';stack.halfUnits=halfUnits;stack.feverTicks=feverTicks;
          }
        }
        if(stack){
          const units=stack.halfUnits??1,feverTicks=stack.feverTicks??units*30;
          requireValue(units<20_000_001 && feverTicks<=600_000_000,'fever pickup capacity');
          stack.halfUnits=units+1;stack.feverTicks=feverTicks+30;
        }
      }else{
        requireValue(integer(state.nextId,1,Number.MAX_SAFE_INTEGER-1),'fever pickup capacity');
        state.pickups.push({id:state.nextId++,kind:'fever-coin',halfUnits:1,x:enemy.x,y:enemy.y});
      }
    }
    let chestId = null;
    if (enemy.boss && enemy.kind !== 'reaper') {
      state.bossKills++;
      if (enemy.treasureTier) {
        chestId = state.nextId++;
        state.chests.push({id: chestId, x: enemy.x, y: enemy.y, tier: enemy.treasureTier,
          boss: true, sourceEncounterId: enemy.id, dropTick: state.tick,
          ...(enemy.spawnMinute === undefined ? {} : {sourceMinute: enemy.spawnMinute})});
      }
    }
    if (enemy.boss) state.progression.encounters.push({id: enemy.id, kind: enemy.kind, outcome: 'defeated', tick: state.tick,
      ...(enemy.spawnMinute === undefined ? {} : {sourceMinute: enemy.spawnMinute}),
      ...(chestId === null ? {} : {chestId, chestTier: enemy.treasureTier})});
    state.kills++;
    if (enemy.kind === 'skeleton') state.killTrackingV1.skeleton++;
    state.recentEnemyDeaths.push({id: enemy.id, tick: state.tick});
  }


  function flushGemDrops() {
    if (!pendingGemDrops.length) return;
    const batch=pendingGemDrops;pendingGemDrops=[];
    const result=depositGemBatch(state.gems,batch,state.player,state.player.gemsCollected,!compactedGems);
    if(result.merged)compactedGems=true;
  }

  function fireWhip() {
    const {player, whip} = state;
    whip.nextTick = state.tick + effectiveCooldown(whip.cooldownTicks);
    // Weapon.PAmount adds the weapon amount and the owner's bonus capped at
    // ten; the inherited six-total cap discarded valid additional strikes.
    const count = whip.strikes + Math.min(10, player.bonusProjectiles);
    requireValue(state.pendingWhips.length + count <= 128, 'whip queue capacity');
    for (let index = 0; index < count; index++) {
      state.pendingWhips.push({tick: state.tick + index * WHIP_REPEAT_TICKS, index});
    }
  }

  function pulseWhips() {
    const {player, whip} = state;
    requireValue(state.whipStrikes.length + state.pendingWhips.filter(shot=>shot.tick<=state.tick).length <= 128, 'whip strike capacity');
    for (const shot of state.pendingWhips) {
      if (shot.tick > state.tick) continue;
      const damage=whip.damage*player.might;
      requireValue(Number.isFinite(damage) && damage>=0 && damage<=10_000_000,'whip snapshot damage capacity');
      state.whipStrikes.push({...createWhipStrike(player, whip, state.tick, shot.index, state.nextId++),liveWeaponDamage:true});
      state.lastAttackTick = state.tick;
    }
    state.pendingWhips = state.pendingWhips.filter(shot => shot.tick > state.tick);
    for (const strike of state.whipStrikes) {
      const bounds = whipBounds(strike, state.tick);
      if (!bounds) continue;
      let hitSet = null, overlapChecks = 0;
      for (let index = state.enemies.length - 1; index >= 0; index--) {
        const enemy = state.enemies[index];
        if (!whipContains(strike, enemy, state.tick, bounds)) continue;
        if (!hitSet && strike.hitIds.length >= 32 && ++overlapChecks === 8) hitSet = new Set(strike.hitIds);
        if (hitSet ? hitSet.has(enemy.id) : strike.hitIds.includes(enemy.id)) continue;
        const damage=whipContactPower(strike);
        strike.hitIds.push(enemy.id); if (hitSet) hitSet.add(enemy.id);
        const critical = strike.evolved && random() < 0.1 * player.luck;
        enemy.hp = round(enemy.hp - damage * (critical ? 2 : 1));
        applyEnemyImpact(enemy, player, state.tick, 5);
        if (critical) {
          whip.criticalHits++;
          if (state.tick >= whip.nextHealTick) {
            whip.nextHealTick = state.tick + 60;
            const healed = Math.min(8, player.maxHp - player.hp);
            setHealedHp(round(player.hp + healed));
            whip.lifeStealHealed = round(whip.lifeStealHealed + healed);
          }
        }
        if (enemy.hp <= 0) defeatEnemy(index);
      }
      for (let index = state.breakables.length - 1; index >= 0; index--) {
        const item = state.breakables[index];
        if (!whipContains(strike, item, state.tick, bounds)) continue;
        if (!hitSet && strike.hitIds.length >= 32 && ++overlapChecks === 8) hitSet = new Set(strike.hitIds);
        if (hitSet ? hitSet.has(item.id) : strike.hitIds.includes(item.id)) continue;
        const damage=whipContactPower(strike);
        strike.hitIds.push(item.id); if (hitSet) hitSet.add(item.id);
        damageBreakable(index, damage);
      }
    }
  }
  function whipContactPower(strike) {
    if (strike.liveWeaponDamage!==true) return strike.damage;
    const damage=state.whip.damage*state.player.might;
    requireValue(Number.isFinite(damage) && damage>=0 && damage<=16_000_000,'whip contact damage capacity');
    return damage;
  }

  // Queues only the separately emitted projectile weapons. Other weapon
  // families retain their own attack state until their firing paths are traced.
  const VOLLEY_SLOTS = ['wand', 'knife', 'fireWand', 'axe', 'cross', 'runetracer', 'bone', 'lightning', 'santaWater', 'peachone', 'ebonyWings', 'vandalier'];
  const MAX_PENDING_VOLLEYS = 512, MAX_PROJECTILES = 2048;
  function queueVolley(slot, count, intervalMs, angle = null) {
    requireValue(integer(count, 1, slot === 'vandalier' ? 30 : 26) && integer(state.nextVolleyId, 1, 9_999_999), 'invalid volley count or identity');
    requireValue(state.pendingVolleys.length + count - 1 <= MAX_PENDING_VOLLEYS, 'volley queue capacity');
    const volleyId = state.nextVolleyId++;
    const evolved = !!state[slot].evolved;
    for (let index = 1; index < count; index++) state.pendingVolleys.push({
      source: ENGINE_ID, version: 2, slot, volleyId, index, total: count, evolved, angle, selected: [],
      dueTick: state.tick + Math.ceil(index * intervalMs * TICK_HZ / 1000)
    });
    return volleyId;
  }
  function recordVolleyTarget(volleyId, targetId) {
    for (const pending of state.pendingVolleys) if (pending.volleyId === volleyId) pending.selected.push(targetId);
  }
  function pushVolleyProjectile(projectile) {
    requireValue(state.projectiles.length < MAX_PROJECTILES, 'projectile capacity');
    if (Object.hasOwn(LIVE_DAMAGE_SLOTS, projectile.kind)) projectile.liveWeaponDamage = true;
    state.projectiles.push(projectile);
  }
  function pulseVolleys() {
    const emit = {wand: fireWand, knife: fireKnife, fireWand: fireFireWand,
      axe: fireAxe, cross: fireCross, runetracer: fireRunetracer, bone: fireBone,
      lightning: fireLightning, santaWater: castSantaWater,
      peachone: fireBirdShot, ebonyWings: fireBirdShot, vandalier: fireBirdShot};
    for (;;) {
      const index = state.pendingVolleys.findIndex(shot => shot.dueTick <= state.tick);
      if (index < 0) break;
      const [shot] = state.pendingVolleys.splice(index, 1);
      const legacy = state.legacyBirdVolleys.includes(shot.volleyId);
      if (state[shot.slot] && !!state[shot.slot].evolved === shot.evolved) emit[shot.slot](shot, legacy);
      if (legacy && !state.pendingVolleys.some(pending=>pending.volleyId===shot.volleyId))
        state.legacyBirdVolleys=state.legacyBirdVolleys.filter(id=>id!==shot.volleyId);
    }
  }

  function fireWand(shot = null) {
    const {player, wand} = state;
    // The installed projectile chooses the nearest enemy at each emission,
    // falling back to player-facing direction when none exists. Its random
    // spawn offset remains a local approximation at the player position.
    const target = state.enemies.reduce((best, enemy) => !best ||
      distanceSquared(enemy,player) < distanceSquared(best,player) ||
      distanceSquared(enemy,player) === distanceSquared(best,player) && enemy.id < best.id ? enemy : best, null);
    const count = shot?.total ?? (wand.amount + Math.min(10, player.bonusProjectiles));
    if (!shot) queueVolley('wand', count, 100);
    const angle = target ? Math.atan2(target.y-player.y,target.x-player.x) : Math.atan2(player.facingY,player.facingX);
    pushVolleyProjectile({id: state.nextId++, kind: 'wand', x: player.x, y: player.y,
      vx: round(Math.cos(angle) * wand.speed * player.projectileSpeed),
      vy: round(Math.sin(angle) * wand.speed * player.projectileSpeed),
      damage: wand.damage, ttl: 180, remainingHits: wand.pierce, hitIds: []});
    if (!shot) wand.nextTick = state.tick + effectiveCooldown(wand.cooldownTicks);
  }

  function fireKnife(shot = null) {
    const {player, knife} = state;
    const count = shot?.total ?? (knife.amount + Math.min(10, player.bonusProjectiles));
    if (!shot) queueVolley('knife', count, knife.evolved ? 50 : Math.max(40, 100 - 20 * [4, 6, 8].filter(level => knife.level >= level).length));
    for (let index = shot ? shot.index : 0; index < (shot ? shot.index + 1 : 1); index++) {
      const spread = (index - (count - 1) / 2) * 0.28;
      pushVolleyProjectile({id: state.nextId++, kind: 'knife',
        x: round(player.x - player.facingY * spread), y: round(player.y + player.facingX * spread),
        vx: round(player.facingX * knife.speed * player.projectileSpeed),
        vy: round(player.facingY * knife.speed * player.projectileSpeed),
        damage: knife.damage, ttl: 110, remainingHits: knife.pierce, hitIds: []});
    }
    if (!shot) knife.nextTick = state.tick + effectiveCooldown(knife.cooldownTicks);
  }

  // Installed Fireball/Hellfire select a random target before their volley;
  // local seeded selection and retained-target fallback remain approximations.
  const FIREBALL_SPREAD = [0,5,-5,10,-10,15,-15,20,-20,25,-25,30,-30,35,-35,40,-40,45,-45];
  const HELLFIRE_SPREAD = [0,10,-10,20,-20,30,-30,40,-40];
  function fireFireWand(shot = null) {
    const {player, fireWand} = state;
    const legacy = shot && shot.angle === null && shot.selected.length === 0;
    let target = shot?.selected.length ? state.enemies.find(enemy => enemy.id === shot.selected[0]) : null;
    if (!shot || legacy) target = state.enemies.length ? state.enemies[Math.floor(random() * state.enemies.length)] : null;
    if (!target && (!shot || legacy)) {if (!shot) fireWand.nextTick = state.tick + 6; return;}
    const baseAngle = target ? Math.atan2(target.y-player.y,target.x-player.x) : shot.angle;
    const count = shot?.total ?? (fireWand.amount + Math.min(10, player.bonusProjectiles));
    if (!shot) {
      const volleyId = queueVolley('fireWand', count, fireWand.evolved ? 200 : 20, baseAngle);
      recordVolleyTarget(volleyId, target.id);
    }
    const index = shot?.index ?? 0, spread = fireWand.evolved ? HELLFIRE_SPREAD : FIREBALL_SPREAD;
    const angle = baseAngle + spread[index % spread.length] * Math.PI / 180;
    pushVolleyProjectile({id: state.nextId++, kind: 'fireball', evolved: fireWand.evolved,
      x: player.x, y: player.y,
      vx: round(Math.cos(angle) * fireWand.speed * player.projectileSpeed),
      vy: round(Math.sin(angle) * fireWand.speed * player.projectileSpeed),
      damage: fireWand.damage, ttl: 180,
      remainingHits: fireWand.evolved ? 1_000_000 : 1, hitIds: []});
    if (!shot) fireWand.nextTick = state.tick + effectiveCooldown(fireWand.cooldownTicks);
  }

  // The demo describes Lightning Ring as random strikes in the lower half of
  // the view. Candidate selection follows that description; strike size,
  // damage, cadence and the fallback empty strike are prototype design.
  function lightningImpact(x, y, radius, damage) {
    requireValue(state.lightningStrikes.length < 256, 'lightning capacity');
    state.lightningStrikes.push({id: state.nextId++, x, y, radius, until: state.tick + 15});
    for (let index = state.enemies.length - 1; index >= 0; index--) {
      const enemy = state.enemies[index];
      if (distanceSquared({x, y}, enemy) > (radius + enemy.radius) ** 2) continue;
      enemy.hp = round(enemy.hp - damage); applyEnemyImpact(enemy, state.player, state.tick, 5);
      if (enemy.hp <= 0) defeatEnemy(index);
    }
    for (let index = state.breakables.length - 1; index >= 0; index--) {
      const item = state.breakables[index];
      if (distanceSquared({x, y}, item) > (radius + item.radius) ** 2) continue;
      damageBreakable(index, damage);
    }
  }
  function pulseLoopStrikes() {
    while (state.pendingLoopStrikes.length && state.pendingLoopStrikes[0].dueTick <= state.tick) {
      const strike = state.pendingLoopStrikes[0];
      const damage=strike.liveWeaponDamage===true ? state.lightning.damage*state.player.might : strike.damage;
      if(strike.liveWeaponDamage===true) requireValue(Number.isFinite(damage) && damage>=0 && damage<=16_000_000,'loop contact damage capacity');
      state.pendingLoopStrikes.shift();
      lightningImpact(strike.x, strike.y, strike.radius, damage);
    }
  }
  function fireLightning(shot = null) {
    const {player, lightning} = state;
    const damage = lightning.damage * player.might;
    if(lightning.evolved) {
      requireValue(Number.isFinite(damage) && damage>=0 && damage<=1_000_000,'loop snapshot damage capacity');
      requireValue(state.pendingLoopStrikes.length < 256, 'loop strike capacity');
    }
    if (!shot) {state.lastLightningTick = state.tick; lightning.nextTick = state.tick + effectiveCooldown(lightning.cooldownTicks);}
    const count = shot?.total ?? (lightning.amount + Math.min(10, player.bonusProjectiles));
    const radius = round(lightning.radius * player.area);
    const volleyId = shot?.volleyId ?? queueVolley('lightning', count, lightning.evolved ? 0 : 50);
    const selected = new Set(shot?.selected ?? []);
    for (let strike = shot ? shot.index : 0; strike < (shot ? shot.index + 1 : 1); strike++) {
      const lower = state.enemies.filter(enemy => enemy.y >= player.y &&
        enemy.y <= player.y + 9 && Math.abs(enemy.x - player.x) <= 16 && !selected.has(enemy.id));
      const target = lower.length ? lower[Math.floor(random() * lower.length)] : null;
      if (target) { selected.add(target.id); recordVolleyTarget(volleyId, target.id); }
      const x = target ? target.x : round(player.x + (random() * 2 - 1) * 12);
      const y = target ? target.y : round(player.y + 1 + random() * 7);
      lightningImpact(x, y, radius, damage);
      if (lightning.evolved) {
        // Installed 60ms ground tween + 200ms delayed second activation;
        // local fixed-tick rounding and collision geometry remain approximations.
        state.pendingLoopStrikes.push({x, y, radius, damage, dueTick: state.tick + 16,liveWeaponDamage:true});
      }
    }
  }

  // Santa Water's static description says it creates damaging zones. The
  // targeting radius, pulse interval, lifespan and damage are prototype rules.
  function castSantaWater(shot = null) {
    const {player, santaWater} = state;
    if (!shot) santaWater.nextTick = state.tick + effectiveCooldown(santaWater.cooldownTicks);
    const count = shot?.total ?? (santaWater.amount + Math.min(10, player.bonusProjectiles));
    const volleyId = shot?.volleyId ?? queueVolley('santaWater', count, 300);
    const selected = new Set(shot?.selected ?? []);
    for (let cast = shot ? shot.index : 0; cast < (shot ? shot.index + 1 : 1); cast++) {
      const nearby = state.enemies.filter(enemy =>
        distanceSquared(player, enemy) <= 10 ** 2 && !selected.has(enemy.id));
      const target = nearby.length ? nearby[Math.floor(random() * nearby.length)] : null;
      if (target) { selected.add(target.id); recordVolleyTarget(volleyId, target.id); }
      const angle = random() * Math.PI * 2;
      const distance = 2 + random() * 5;
      const x = target ? target.x : round(player.x + Math.cos(angle) * distance);
      const y = target ? target.y : round(player.y + Math.sin(angle) * distance);
      requireValue(state.santaWaterZones.length < 256 && integer(state.nextId,1,9_999_999), 'water zone capacity');
      requireValue(state.enemies.length * (state.projectiles.length + state.whipStrikes.length + state.santaWaterZones.length + state.carnageExplosions.length + state.bibleShots.length + state.birdRays.length + state.garlicAreas.length + 1) <= 1_000_000, 'area collision work capacity');
      const damage=round(santaWater.damage * player.might);
      requireValue(Number.isFinite(damage) && damage >= 0 && damage <= 1_000_000, 'water damage capacity');
      state.santaWaterZones.push({id: state.nextId++, x, y,
        radius: round(santaWater.radius * player.area),
        damage,
        until: state.tick + effectiveDuration(santaWater.durationTicks), nextPulseTick: state.tick + 30, hitIds: [], dynamicDamage:true,
        ...(santaWater.evolved ? {mode:'bora', bornTick:state.tick,
          initialRadius:round(santaWater.radius * player.area),
          targetRadius:round(santaWater.radius * player.area * Math.min(6 / player.area,
            Math.max(1, player.speed / PLAYER_BASE_SPEED) * player.projectileSpeed))} : {})});
    }
  }

  function pulseSantaWaterZones() {
    const contactDamage = zone => {
      if (!zone.dynamicDamage) return zone.damage;
      const damage = round(state.santaWater.damage * state.player.might);
      requireValue(Number.isFinite(damage) && damage >= 0 && damage <= 1_000_000, 'water damage capacity');
      return damage;
    };
    for (const zone of state.santaWaterZones) {
      if (zone.mode === 'bora') {
        // Direction and modifiers follow the installed projectile; the local
        // velocity/world-unit conversion remains a prototype approximation.
        const dx=state.player.x-zone.x, dy=state.player.y-zone.y, distance=Math.hypot(dx,dy);
        const speed=0.15 * PLAYER_BASE_SPEED * Math.max(1,state.player.speed/PLAYER_BASE_SPEED) * state.player.projectileSpeed / TICK_HZ;
        if (distance > 0) { const delta=Math.min(distance,speed);zone.x=round(zone.x+dx/distance*delta);zone.y=round(zone.y+dy/distance*delta); }
        const elapsed=state.tick-zone.bornTick, duration=zone.until-zone.bornTick;
        const progress=Math.max(0,Math.min(1,(elapsed-12)/Math.max(1,duration-12)));
        zone.radius=round(zone.initialRadius+(zone.targetRadius-zone.initialRadius)*progress);
      }
      const legacy = !Object.hasOwn(zone, 'hitIds');
      if (legacy && state.tick < zone.nextPulseTick) continue;
      if (state.tick >= zone.nextPulseTick) {
        if (!legacy) clearAreaHits(zone);
        zone.nextPulseTick = state.tick + 30;
      }
      for (let index = state.enemies.length - 1; index >= 0; index--) {
        const enemy = state.enemies[index];
        if (distanceSquared(zone, enemy) > (zone.radius + enemy.radius) ** 2) continue;
        if (!legacy && zone.hitIds.includes(enemy.id)) continue;
        const damage=contactDamage(zone);
        if (!legacy) markAreaHit(zone, enemy.id);
        state.santaWater.hits++;
        enemy.hp = round(enemy.hp - damage);
        applyEnemyImpact(enemy, state.player, state.tick, 0);
        if (enemy.hp <= 0) defeatEnemy(index);
      }
      for (let index = state.breakables.length - 1; index >= 0; index--) {
        const item = state.breakables[index];
        if (distanceSquared(zone, item) > (zone.radius + item.radius) ** 2) continue;
        if (!legacy && zone.hitIds.includes(item.id)) continue;
        const damage=contactDamage(zone);
        if (!legacy) markAreaHit(zone, item.id);
        damageBreakable(index, damage);
      }
    }
  }

  // The sample calls Axe a high-damage weapon and Death Spiral its penetrating
  // evolution. The lob, gravity, spread and radial flight are prototype rules.
  function fireAxe(shot = null) {
    const {axe, player} = state;
    const count = shot?.total ?? ((axe.evolved ? 9 : axe.amount) + Math.min(10, player.bonusProjectiles));
    if (!shot) queueVolley('axe', count, axe.evolved ? 50 : 200);
    for (let index = shot ? shot.index : 0; index < (shot ? shot.index + 1 : 1); index++) {
      const heading = index * Math.PI * 2 / count;
      pushVolleyProjectile(axe.evolved
        ? {id: state.nextId++, kind: 'death-spiral', x: player.x, y: player.y,
          vx: round(Math.cos(heading) * 9 * player.projectileSpeed),
          vy: round(Math.sin(heading) * 9 * player.projectileSpeed),
          damage: axe.damage, radius: round(0.35 * player.area), ttl: 150,
          remainingHits: axe.pierce, hitIds: []}
        : {id: state.nextId++, kind: 'axe', x: player.x, y: player.y,
          vx: round(player.facing * (2.2 + index * 0.8) * player.projectileSpeed),
          vy: round((-9.5 + index * 0.35) * player.projectileSpeed),
          damage: axe.damage, radius: round(0.25 * player.area), ttl: 210,
          remainingHits: axe.pierce, hitIds: []});
    }
    if (!shot) axe.nextTick = state.tick + effectiveCooldown(axe.cooldownTicks);
  }

  function clearAreaHits(area) { areaHitCount -= area.hitIds.length; area.hitIds = []; }
  function markAreaHit(area,id) {
    if (area.hitIds.includes(id)) return false;
    requireValue(area.hitIds.length < MAX_AREA_HITS && areaHitCount < MAX_TOTAL_AREA_HITS, 'area hit history capacity');
    area.hitIds.push(id); areaHitCount++; return true;
  }
  function bibleOrb(index,total,evolved) {
    const {bible,player}=state, radius=bible.orbitRadius*player.area;
    const angle=state.tick*bible.angularSpeed/TICK_HZ + index*Math.PI*2/total;
    return {x:round(player.x+Math.cos(angle)*radius),y:round(player.y+Math.sin(angle)*radius),
      radius:round((evolved?0.5:0.42)*player.area)};
  }
  function bibleOrbs() {
    const {bible,player}=state;
    if (!bible) return [];
    if (bible.legacyArea) {
      if (!bible.evolved && state.tick >= bible.activeUntil) return [];
      const count=bible.amount+Math.min(10,player.bonusProjectiles);
      return Array.from({length:count},(_,i)=>bibleOrb(i,count,bible.evolved));
    }
    return state.bibleShots.map(shot=>bibleOrb(shot.index,shot.total,shot.evolved));
  }
  function castBible() {
    const {bible,player}=state, count=bible.amount+Math.min(10,player.bonusProjectiles);
    requireValue(state.bibleShots.length+count<=MAX_BIBLE_SHOTS && integer(state.nextId,1,10_000_000-count), 'bible shot capacity');
    requireValue(state.enemies.length*(state.projectiles.length+state.whipStrikes.length+state.santaWaterZones.length+state.carnageExplosions.length+state.bibleShots.length+state.birdRays.length+state.garlicAreas.length+count)<=1_000_000, 'area collision work capacity');
    const until=state.tick+effectiveDuration(bible.durationTicks);
    bible.activeUntil=Math.max(bible.activeUntil,until);
    for(let index=0;index<count;index++)state.bibleShots.push({id:state.nextId++,index,total:count,bornTick:state.tick,until,nextResetTick:state.tick+102,evolved:bible.evolved,hitIds:[]});
    bible.nextTick=state.tick+effectiveCooldown(bible.cooldownTicks);
  }
  function pulseBible() {
    const {bible,player}=state;
    if(!bible)return;
    if(bible.legacyArea && !bible.evolved && state.tick>=bible.nextTick) {
      bible.legacyArea=false; bible.activeUntil=state.tick;
    }
    if(!bible.legacyArea && state.tick>=bible.nextTick) castBible();
    if(bible.legacyArea) {
      if(state.tick<bible.nextHitTick)return;
      const orbs=bibleOrbs();if(!orbs.length)return;
      bible.nextHitTick=state.tick+6;
      for(let i=state.enemies.length-1;i>=0;i--){const enemy=state.enemies[i];
        if(!orbs.some(orb=>distanceSquared(orb,enemy)<=(orb.radius+enemy.radius)**2))continue;
        bible.hits++;enemy.hp=round(enemy.hp-bible.damage*player.might);applyEnemyImpact(enemy,player,state.tick,5);if(enemy.hp<=0)defeatEnemy(i);
      }
      for(let i=state.breakables.length-1;i>=0;i--){const item=state.breakables[i];
        if(!orbs.some(orb=>distanceSquared(orb,item)<=(orb.radius+item.radius)**2))continue;
        damageBreakable(i, bible.damage*player.might);
      }
      return;
    }
    for(const shot of state.bibleShots){
      if(state.tick>=shot.nextResetTick){clearAreaHits(shot);shot.nextResetTick+=102;}
      const orb=bibleOrb(shot.index,shot.total,shot.evolved);
      for(let i=state.enemies.length-1;i>=0;i--){const enemy=state.enemies[i];
        if(distanceSquared(orb,enemy)>(orb.radius+enemy.radius)**2 || !markAreaHit(shot,enemy.id))continue;
        bible.hits++;enemy.hp=round(enemy.hp-bible.damage*player.might);applyEnemyImpact(enemy,player,state.tick,5);if(enemy.hp<=0)defeatEnemy(i);
      }
      for(let i=state.breakables.length-1;i>=0;i--){const item=state.breakables[i];
        if(distanceSquared(orb,item)>(orb.radius+item.radius)**2 || !markAreaHit(shot,item.id))continue;
        damageBreakable(i, bible.damage*player.might);
      }
    }
  }

  // Fixed initial velocity and linear acceleration follow selected installed
  // source methods; world scale, lifetime and contact rules remain local.
  function fireCross(shot = null) {
    const {cross, player} = state;
    const target = state.enemies.reduce((best, enemy) => {
      if (!best) return enemy;
      const distance = distanceSquared(player, enemy);
      const bestDistance = distanceSquared(player, best);
      return distance < bestDistance || distance === bestDistance && enemy.id < best.id ? enemy : best;
    }, null);
    const angle = Math.atan2(target ? target.y - player.y : player.facingY,
      target ? target.x - player.x : player.facingX);
    const count = shot?.total ?? (cross.amount + Math.min(10, player.bonusProjectiles));
    if (!shot) queueVolley('cross', count, cross.evolved ? 500 : 100);
    for (let index = shot ? shot.index : 0; index < (shot ? shot.index + 1 : 1); index++) {
      const heading = angle + (index - (count - 1) / 2) * 0.18;
      const launchVx = round(Math.cos(heading) * cross.speed * player.projectileSpeed);
      const launchVy = round(Math.sin(heading) * cross.speed * player.projectileSpeed);
      const initial = cross.evolved ? 2 : 1.5 + 0.1 * index;
      requireValue(Math.max(Math.abs(launchVx),Math.abs(launchVy))*Math.max(initial,2)<=1000,'cross trajectory capacity');
      pushVolleyProjectile({id: state.nextId++,
        kind: cross.evolved ? 'heaven-sword' : 'cross',
        x: player.x, y: player.y,
        vx: launchVx, vy: launchVy, trajectoryModel:'source-linear-v1',
        bornTick:state.tick, launchVx, launchVy, shotIndex:index,
        damage: cross.damage, radius: round(cross.radius * player.area),
        ttl: 145, turnTick: state.tick + (cross.evolved ? 30 : Math.ceil(60*initial/(initial+2))), phase: 'out',
        remainingHits: 1000, hitIds: []});
    }
    if (!shot) cross.nextTick = state.tick + effectiveCooldown(cross.cooldownTicks);
  }

function fireRunetracer(shot = null) {
  const {player, runetracer} = state;
  const count = shot?.total ?? (runetracer.amount + Math.min(10, player.bonusProjectiles));
  const angle = shot ? shot.angle : random() * Math.PI * 2;
  if (!shot) queueVolley('runetracer', count, runetracer.evolved ? 0 : 200, angle);
    for (let index = shot ? shot.index : 0; index < (shot ? shot.index + 1 : 1); index++) {
    const heading = angle + index * Math.PI * 2 / count;
    pushVolleyProjectile({id: state.nextId++, kind: 'runetracer', x: player.x, y: player.y,
      vx: round(Math.cos(heading) * runetracer.speed * player.projectileSpeed),
      vy: round(Math.sin(heading) * runetracer.speed * player.projectileSpeed),
      damage: runetracer.damage, ttl: effectiveDuration(runetracer.durationTicks), hitIds: [],
      evolved: !!runetracer.evolved, nextExplosionTick: 0});
  }
  // ResetFiringTimer adds raw weapon Duration when intervalDependsOnDuration.
  if (!shot) runetracer.nextTick = state.tick + effectiveCooldown(runetracer.cooldownTicks) +
    (runetracer.evolved ? runetracer.durationTicks : 0);
}

  // The sample describes Bone as a bouncing projectile. Aimed volleys,
  // finite contact memory and the player-centered bounds are prototype rules.
  function fireBone(shot = null) {
    const {bone, player} = state;
    requireValue(integer(state.tick+2,0),'bone bounce clock capacity');
    const target = state.enemies.reduce((nearest, enemy) =>
      !nearest || distanceSquared(player, enemy) < distanceSquared(player, nearest)
        ? enemy : nearest, null);
    if (!target) {if (!shot) bone.nextTick = state.tick + 6; return;}
    requireValue(integer(state.nextId,1,9_999_999),'bone projectile identity capacity');
    const count = shot?.total ?? (bone.amount + Math.min(10, player.bonusProjectiles));
    const baseAngle = Math.atan2(target.y - player.y, target.x - player.x);
    if (!shot) queueVolley('bone', count, 0);
    for (let index = shot ? shot.index : 0; index < (shot ? shot.index + 1 : 1); index++) {
      const heading = baseAngle + (index - (count - 1) / 2) * 0.28;
      pushVolleyProjectile({id: state.nextId++, kind: 'bone',
        x: player.x, y: player.y,
        vx: round(Math.cos(heading) * bone.speed * player.projectileSpeed),
        vy: round(Math.sin(heading) * bone.speed * player.projectileSpeed),
        damage: bone.damage, radius: round(bone.radius * player.area),
        ttl: effectiveDuration(bone.durationTicks), remainingHits: 1000, hitIds: [], boneBounceReadyTick:state.tick});
    }
    if (!shot) bone.casts++;
    if (!shot) bone.nextTick = state.tick + effectiveCooldown(bone.cooldownTicks);
  }

  function reboundBone(projectile, target) {
    const dx = projectile.x - target.x, dy = projectile.y - target.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = dx / length, ny = dy / length;
    const dot = projectile.vx * nx + projectile.vy * ny;
    if (dot < 0) {
      projectile.vx = round(projectile.vx - 2 * dot * nx);
      projectile.vy = round(projectile.vy - 2 * dot * ny);
    }
    projectile.x = round(target.x + nx * (target.radius + projectile.radius + 0.02));
    projectile.y = round(target.y + ny * (target.radius + projectile.radius + 0.02));
    state.bone.bounces++;
  }

  // Legacy Bone projectiles have no ready tick and retain their old behavior.
  // At capacity a ready bounce can clear without creating a transient 20001st ID.
  function prepareBoneContact(projectile,target) {
    requireValue(integer(state.tick+2,0),'bone bounce clock capacity');
    const ready=state.tick>=projectile.boneBounceReadyTick;
    if(ready){
      reboundBone(projectile,target);
      projectile.boneBounceReadyTick=state.tick+2;
      projectile.hitIds=[];
    } else {
      requireValue(projectile.hitIds.length<20_000,'bone hit history capacity');
      projectile.hitIds.push(target.id);
    }
  }

  // All existing heal sources retain their old HP calculation and timing.
  function setHealedHp(hp) {
    const player = state.player, increase = Math.max(0, hp - player.hp);
    if (state.garlic?.evolved && increase > 0) {
      const recovered = round(state.garlic.recoveredHp + increase);
      requireValue(recovered <= MAX_SOUL_RECOVERED, 'soul recovery capacity');
      state.garlic.recoveredHp = recovered;
    }
    player.hp = hp;
  }

  // Source timing and collision projection into 059 units are local approximations.
  function moveSoulHearts() {
    const player = state.player;
    for (let i = 0; i < state.soulHearts.length;) {
      const heart = state.soulHearts[i], dx = player.x-heart.x, dy = player.y+0.08-heart.y;
      const length = Math.hypot(dx,dy), distance = heart.speed * 0.01 / TICK_HZ;
      const nx = length ? heart.x + dx / length * distance : heart.x;
      const ny = length ? heart.y + dy / length * distance : heart.y;
      const sx = nx-heart.x, sy = ny-heart.y, segment = sx*sx+sy*sy;
      const t = segment ? Math.max(0,Math.min(1,((player.x-heart.x)*sx+(player.y-heart.y)*sy)/segment)) : 0;
      const hitX = heart.x+t*sx-player.x, hitY = heart.y+t*sy-player.y;
      heart.x = round(nx); heart.y = round(ny); heart.speed++;
      if (hitX*hitX+hitY*hitY <= 0.25**2 || heart.speed > 65536) {
        state.soulHearts.splice(i,1);
        setHealedHp(round(Math.min(player.maxHp, player.hp + 1 * (1 + 0.2 * state.pummarolaLevel))));
      } else i++;
    }
  }

  function pulseGarlic() {
    const {garlic} = state, duration=effectiveCooldown(garlic.pulseTicks);
    if(!garlic.legacyArea){
      requireValue(integer(duration,1,1248) && integer(state.tick+duration,0) && integer(state.nextId,1,9_999_999), 'garlic area lifetime or identity capacity');
      requireValue(state.garlicAreas.length<MAX_GARLIC_AREAS, 'garlic area capacity');
      requireValue(state.enemies.length*(state.projectiles.length+state.whipStrikes.length+state.santaWaterZones.length+state.carnageExplosions.length+state.bibleShots.length+state.birdRays.length+state.garlicAreas.length+1)<=1_000_000,'area collision work capacity');
    }
    state.lastGarlicTick = state.tick;
    garlic.nextTick = state.tick + duration;
    if (garlic.evolved) garlic.soulBonus = soulBonusFor(garlic.recoveredHp);
    if(garlic.legacyArea)hitGarlicArea(null);
    else state.garlicAreas.push({id:state.nextId++,bornTick:state.tick,untilTick:state.tick+duration,evolved:garlic.evolved,hitIds:[]});
  }
  function applyGarlicDebuff(enemy) {
    // No field means an old checkpoint enemy, whose existing behavior survives.
    if(!Object.hasOwn(enemy,'freezeResistance'))return;
    const profile=enemyStatusProfile(enemy.kind);
    if(profile.guard>=1)return;
    if(enemy.knockback<profile.maxKnockback)enemy.knockback=Math.fround(Math.fround(enemy.knockback)+Math.fround(.3));
    if(enemy.freezeResistance>0)enemy.freezeResistance=Math.fround(Math.fround(enemy.freezeResistance)-Math.fround(.1));
  }
  function hitGarlicArea(area) {
    const {garlic,player}=state;
    for (let index = state.enemies.length - 1; index >= 0; index--) {
      const enemy = state.enemies[index];
      if (distanceSquared(player, enemy) > (garlic.radius * player.area + enemy.radius) ** 2 || area && !markAreaHit(area,enemy.id)) continue;
      if(area)applyGarlicDebuff(enemy);
      const power = garlic.evolved ? soulPower(player.might, garlic.soulBonus) : null;
      enemy.hp = round(enemy.hp - (garlic.evolved ? round(10 * power) : garlic.damage * player.might));
      applyEnemyImpact(enemy, state.player, state.tick, 0);
      if (enemy.hp <= 0) {
        const {x,y} = enemy;
        defeatEnemy(index);
        if (garlic.evolved) {
          const r = Math.fround(random()), nextPower = soulPower(player.might, garlic.soulBonus);
          const threshold = Math.fround(Math.fround(0.15) * Math.fround(nextPower / Math.fround(7)));
          if (r < threshold) {
            requireValue(state.soulHearts.length < MAX_SOUL_HEARTS && integer(state.nextId,1,Number.MAX_SAFE_INTEGER-1), 'soul heart capacity');
            const offset = Math.fround(Math.fround(Math.fround(r-Math.fround(.5))*Math.fround(10))*Math.fround(.01));
            state.soulHearts.push({id:state.nextId++,x:round(x+offset),y:round(y+offset),speed:250});
          }
        }
      }
    }
  }

  function pulseGarlicAreas() {
    for(const area of state.garlicAreas)hitGarlicArea(area);
  }

  // Twelve fixed directions begin downward and advance counterclockwise in
  // screen coordinates. Beam width and range remain local prototype values.
  function fireClockLancet() {
    const {clockLancet, player} = state;
    const direction = clockLancet.phase;
    const [vx, vy] = CLOCK_DIRECTIONS[direction];
    clockLancet.phase = (direction + 1) % CLOCK_DIRECTIONS.length;
    clockLancet.lastDirection = direction;
    clockLancet.lastCastTick = state.tick;
    clockLancet.casts++;
    clockLancet.nextTick = state.tick + effectiveCooldown(clockLancet.cooldownTicks);
    for (const enemy of state.enemies) {
      const dx = enemy.x - player.x, dy = enemy.y - player.y;
      const forward = dx * vx + dy * vy;
      const sideways = Math.abs(dx * vy - dy * vx);
      if (forward < -enemy.radius || forward > 8 + enemy.radius || sideways > 0.48 + enemy.radius) continue;
      if(Object.hasOwn(enemy,'freezeResistance') && (enemy.freezeResistance>1 || enemy.frozenUntil>state.tick))continue;
      enemy.frozenUntil = Math.max(enemy.frozenUntil,
        state.tick + effectiveDuration(clockLancet.freezeTicks));
      clockLancet.freezes++;
    }
  }

  // The sample describes erasing what is in sight and a levelled chance to
  // spare items. Visible bounds, boss behavior and one roll per cast are
  // explicitly prototype rules; no original runtime code is reused.
  function firePentagram() {
    const {pentagram, player} = state;
    const visible = item => Math.abs(item.x - player.x) <= PENTAGRAM_HALF_WIDTH &&
      Math.abs(item.y - player.y) <= PENTAGRAM_HALF_HEIGHT;
    pentagram.lastCastTick = state.tick;
    pentagram.casts++;
    pentagram.nextTick = state.tick + effectiveCooldown(pentagram.cooldownTicks);
    const preserved = random() < Math.min(1, pentagram.preserveChance * player.luck);
    pentagram.lastPreserved = preserved;
    if (preserved) pentagram.preservedCasts++;
    for (let index = state.enemies.length - 1; index >= 0; index--) {
      if (!visible(state.enemies[index])) continue;
      defeatEnemy(index);
      pentagram.erasedEnemies++;
    }
    // The existing erase pass includes gems created by these kills.
    flushGemDrops();
    if (preserved) return;
    for (const key of ['gems', 'chests', 'pickups']) {
      const before = state[key].length;
      state[key] = state[key].filter(item => {
        if (!visible(item)) return true;
        if (key === 'chests') {
          const source = linkedChestSource(item, state.progression.encounters, state.tick);
          if (source) {
            const encounter = state.progression.encounters.find(row => row.id === source.sourceEncounterId);
            encounter.chestErasedTick = state.tick;
          }
        }
        return false;
      });
      pentagram.erasedItems += before - state[key].length;
    }
  }

  // Source-informed callback schedule, quantized to local 60 Hz ticks. The
  // screen shape and drop positions are local approximations of Unity physics.
  function startMoon() {
    requireValue(!state.moonCycle, 'moon cycle overlap');
    const weapon = state.pentagram;
    state.moonCycle = {startTick: state.tick, nextEventIndex: 0};
    weapon.lastCastTick = state.tick; weapon.casts++;
    weapon.nextTick = state.tick + Math.max(900, effectiveCooldown(weapon.cooldownTicks));
  }

  function moonDamage(index) {
    const enemy = state.enemies[index];
    requireValue(Object.hasOwn(ENEMY_PROFILES, enemy.kind), 'unknown moon enemy kind');
    if (enemy.kind === 'reaper') return;
    const {x, y} = enemy;
    enemy.hp -= Math.max(660, enemy.maxHp);
    if (enemy.hp <= 0) { defeatEnemy(index); state.pentagram.erasedEnemies++; }
    requireValue(integer(state.nextId, 1, Number.MAX_SAFE_INTEGER - 1), 'gem identity capacity');
    pendingGemDrops.push({id: state.nextId++, x, y, value: 1});
  }

  function processMoonCycle() {
    const cycle = state.moonCycle;
    while (cycle && cycle.nextEventIndex < MOON_EVENT_OFFSETS.length &&
        state.tick >= cycle.startTick + MOON_EVENT_OFFSETS[cycle.nextEventIndex]) {
      const event = cycle.nextEventIndex++;
      if (event < 20) {
        let closest = -1, distance = Infinity;
        for (let i = 0; i < state.enemies.length; i++) {
          const candidate = distanceSquared(state.player, state.enemies[i]);
          if (candidate < distance) { closest = i; distance = candidate; }
        }
        if (closest >= 0) moonDamage(closest);
      } else if (event === 21) {
        for (let i = state.enemies.length - 1; i >= 0; i--) {
          const enemy = state.enemies[i];
          const dx = Math.max(0, Math.abs(enemy.x - state.player.x) - PENTAGRAM_HALF_WIDTH);
          const dy = Math.max(0, Math.abs(enemy.y - state.player.y) - PENTAGRAM_HALF_HEIGHT);
          if (dx * dx + dy * dy <= enemy.radius * enemy.radius) moonDamage(i);
        }
      } else if (event === 22) {
        for (const gem of state.gems) if (!gem.attraction)
          gem.attraction = {startTick: state.tick, startX: gem.x, startY: gem.y};
        state.moonCycle = null;
      }
    }
  }

  // The sample names two birds that bombard a circling zone. This moving
  // cluster, pulse cadence and collision radius are independent prototype
  // rules. They follow the player so the Agent can plan around their arc.
  function birdZone(bird, kind, count, index) {
    const age = state.tick - bird.lastCastTick;
    const zoneKind = kind === 'vandalier' ? (index % 2 ? 'vandalier-dark' : 'vandalier-light') : kind;
    const direction = ['ebony-wings','vandalier-dark'].includes(zoneKind) ? -1 : 1;
    const base = (direction < 0 ? Math.PI : 0) + direction * age * 0.055;
    const angle = base + direction * (index - (count - 1) / 2) * 0.18;
    return {kind: zoneKind, index, x: round(state.player.x + Math.cos(angle) * 4.5),
      y: round(state.player.y + Math.sin(angle) * 3.2),
      radius: round(bird.radius * state.player.area), until: bird.activeUntil};
  }
  function birdZones(bird, kind, total = null) {
    if (!bird || state.tick >= bird.activeUntil) return [];
    const count = total ?? (bird.amount + Math.min(10, state.player.bonusProjectiles));
    return Array.from({length: count}, (_, index) => birdZone(bird, kind, count, index));
  }

  function fireLegacyBirdShot(shot) {
    const bird = state[shot.slot], kind = shot.slot === 'vandalier' ? 'vandalier' : shot.slot === 'peachone' ? 'peachone' : 'ebony-wings';
    const zone = bird && state.tick < bird.activeUntil && shot.index >= 0 && shot.index < shot.total
      ? birdZone(bird, kind, shot.total, shot.index) : undefined;
    if (!zone) return;
    bird.lastPulseTick = state.tick;
    const damage = round(bird.damage * state.player.might);
    for (let index = state.enemies.length - 1; index >= 0; index--) {
      const enemy = state.enemies[index];
      if (distanceSquared(zone, enemy) > (zone.radius + enemy.radius) ** 2) continue;
      bird.hits++;
      enemy.hp = round(enemy.hp - damage);
      applyEnemyImpact(enemy, state.player, state.tick);
      if (enemy.hp <= 0) defeatEnemy(index);
    }
    for (let index = state.breakables.length - 1; index >= 0; index--) {
      const item = state.breakables[index];
      if (distanceSquared(zone, item) > (zone.radius + item.radius) ** 2) continue;
      damageBreakable(index, damage);
    }
  }

  function generateBirdTargets(bird,slot) {
    const kind=slot==='vandalier'?'vandalier':slot==='peachone'?'peachone':'ebony-wings';
    const centers=slot==='vandalier'?[birdZone(bird,kind,2,0),birdZone(bird,kind,2,1)]:[birdZone(bird,kind,1,0)];
    const points=[];
    for(const center of centers)for(let i=0;i<12;i++){
      const angle=2*Math.PI*random(), sum=random()+random(), radius=(sum<=1?sum:2-sum)*center.radius;
      const point={x:round(center.x+radius*Math.cos(angle)),y:round(center.y+radius*Math.sin(angle))};
      requireValue([point.x,point.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1_000_000),'bird target coordinate capacity');points.push(point);
    }
    bird.rayTargets=points;bird.rayCursor%=points.length;
  }
  function fireBirdShot(shot, legacy=false) {
    if(legacy)return fireLegacyBirdShot(shot);
    const bird=state[shot.slot];
    if(!bird || state.tick>=bird.activeUntil || shot.index<0 || shot.index>=shot.total)return;
    const expected=shot.slot==='vandalier'?24:12;
    requireValue(bird.rayTargets.length===expected && integer(bird.rayCursor,0,expected-1),'missing bird targets');
    requireValue(state.birdRays.length<MAX_BIRD_RAYS && integer(state.nextId,1,9_999_999),'bird ray capacity');
    requireValue(state.enemies.length*(state.projectiles.length+state.whipStrikes.length+state.santaWaterZones.length+state.carnageExplosions.length+state.bibleShots.length+state.birdRays.length+state.garlicAreas.length+1)<=1_000_000,'area collision work capacity');
    const target=bird.rayTargets[bird.rayCursor];bird.rayCursor=(bird.rayCursor+1)%expected;
    const angle=(bird.rayCursor%2?-1:1)*(10+20*random()),dx=state.player.x-target.x,dy=state.player.y-target.y;
    const controlX=round(target.x+dx*Math.cos(angle)-dy*Math.sin(angle)),controlY=round(target.y+dx*Math.sin(angle)+dy*Math.cos(angle));
    const radius=round(bird.radius*state.player.area),impactTick=state.tick+(shot.slot==='vandalier'?24:30),untilTick=impactTick+12;
    requireValue(integer(impactTick,0)&&integer(untilTick,0)&&[controlX,controlY,target.x,target.y,state.player.x,state.player.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1_000_000)&&Number.isFinite(radius)&&radius>0&&radius<=512,'bird ray geometry capacity');
    state.birdRays.push({id:state.nextId++,slot:shot.slot,volleyId:shot.volleyId,bornTick:state.tick,impactTick,untilTick,startX:state.player.x,startY:state.player.y,controlX,controlY,targetX:target.x,targetY:target.y,radius,hitIds:[]});
    bird.lastPulseTick=state.tick;
  }
  function catmull(a,b,c,d,t){const u=t*t,v=u*t,m=(c-a)*0.5,n=(d-b)*0.5;return (2*b-2*c+m+n)*v+(-3*b+3*c-2*m-n)*u+m*t+b;}
  function birdRayPosition(ray) {
    if(state.tick>=ray.impactTick)return {x:ray.targetX,y:ray.targetY,phase:'impact'};
    const t=Math.max(0,Math.min(1,(state.tick-ray.bornTick)/(ray.impactTick-ray.bornTick)))*2;
    const index=Math.min(1,Math.floor(t)),local=t-index;
    const xs=[ray.startX,ray.controlX,ray.targetX],ys=[ray.startY,ray.controlY,ray.targetY];
    const sample=values=>round(catmull(values[Math.max(0,index-1)],values[index],values[index+1],values[Math.min(2,index+2)],local));
    return {x:sample(xs),y:sample(ys),phase:'flight'};
  }
  function pulseBirdRays() {
    for(const ray of state.birdRays){
      if(state.tick<ray.impactTick)continue;
      const bird=state[ray.slot],point={x:ray.targetX,y:ray.targetY},damage=round(bird.damage*state.player.might);
      for(let i=state.enemies.length-1;i>=0;i--){const enemy=state.enemies[i];
        if(distanceSquared(point,enemy)>(ray.radius+enemy.radius)**2 || !markAreaHit(ray,enemy.id))continue;
        bird.hits++;enemy.hp=round(enemy.hp-damage);applyEnemyImpact(enemy,state.player,state.tick);if(enemy.hp<=0)defeatEnemy(i);
      }
      for(let i=state.breakables.length-1;i>=0;i--){const item=state.breakables[i];
        if(distanceSquared(point,item)>(ray.radius+item.radius)**2 || !markAreaHit(ray,item.id))continue;
        damageBreakable(i, damage);
      }
    }
  }

  function pulseBird(bird, slot) {
    if (!bird || state.tick < bird.nextTick) return;
    if (state.tick >= bird.activeUntil) bird.activeUntil = state.tick + effectiveDuration(bird.durationTicks);
    bird.lastCastTick = state.tick;
    bird.casts++;
    bird.nextTick = state.tick + effectiveCooldown(bird.cooldownTicks);
    if (bird.nextTick >= bird.activeUntil)
      bird.nextTick = bird.activeUntil + effectiveCooldown(effectiveDuration(bird.durationTicks));
    const count = bird.amount + Math.min(10, state.player.bonusProjectiles);
    // SilfWeapon.Fire replaces repeatInterval by raw interval / PAmountDivisor.
    const repeatMs = bird.cooldownTicks * 1000 / TICK_HZ / Math.max(1, count);
    generateBirdTargets(bird,slot);
    const volleyId = queueVolley(slot, count, repeatMs);
    fireBirdShot({slot, volleyId, index: 0, total: count});
    bird.nextPulseTick = state.tick;
  }

  // Local 60 Hz conversion of selected Nduja timing and stats. Scatter,
  // collider size and the one-hit contact rule remain prototype choices.
  function pulseNduja() {
    if(!state.nduja)return;
    const player=state.player;
    const collisionOthers=state.whipStrikes.length+state.santaWaterZones.length+state.carnageExplosions.length+
      state.bibleShots.length+state.birdRays.length+state.garlicAreas.length;
    const collisionSlots=state.enemies.length ? Math.floor(1_000_000/state.enemies.length)-collisionOthers-state.projectiles.length : MAX_PROJECTILES;
    const availableSlots=Math.max(0,Math.min(MAX_PROJECTILES-state.projectiles.length,collisionSlots));
    const result=advanceNdujaScheduler(state.nduja,state.tick,{area:player.area,bonusProjectiles:player.bonusProjectiles,
      character:state.character,cooldownMultiplier:player.cooldownMultiplier,emptyTomeLevel:state.emptyTomeLevel,
      facingX:player.facingX,facingY:player.facingY,projectileSpeed:player.projectileSpeed,spellbinderLevel:state.spellbinderLevel},
      availableSlots);
    state.nduja=result.state;
    for(const shot of result.emitted){
      const angle=Math.atan2(shot.facingY,shot.facingX)+(shot.index-(shot.total-1)/2)*0.08;
      pushVolleyProjectile({id:state.nextId++,kind:'nduja',x:player.x,y:player.y,
        vx:round(Math.cos(angle)*3*shot.projectileSpeed),vy:round(Math.sin(angle)*3*shot.projectileSpeed),
        damage:3,radius:round(0.16*shot.area),ttl:effectiveDuration(60),remainingHits:1,hitIds:[]});
    }
  }

  function attack() {
    if (state.whip && state.tick >= state.whip.nextTick) fireWhip();
    pulseWhips();
    if (state.wand && state.tick >= state.wand.nextTick) fireWand();
    if (state.knife && state.tick >= state.knife.nextTick) fireKnife();
    if (state.fireWand && state.tick >= state.fireWand.nextTick) fireFireWand();
    if (state.lightning && state.tick >= state.lightning.nextTick) fireLightning();
    if (state.santaWater && state.tick >= state.santaWater.nextTick) castSantaWater();
    if (state.axe && state.tick >= state.axe.nextTick) fireAxe();
    pulseBible();
    if (state.cross && state.tick >= state.cross.nextTick) fireCross();
    if (state.runetracer && state.tick >= state.runetracer.nextTick) fireRunetracer();
    if (state.bone && state.tick >= state.bone.nextTick) fireBone();
    if (state.garlic && state.tick >= state.garlic.nextTick) pulseGarlic();
    if (state.garlicAreas.length) pulseGarlicAreas();
    if (state.clockLancet && state.tick >= state.clockLancet.nextTick) fireClockLancet();
    if (state.pentagram && state.tick >= state.pentagram.nextTick) {
      if (state.pentagram.evolved) startMoon(); else firePentagram();
    }
    pulseBird(state.peachone, 'peachone');
    pulseBird(state.ebonyWings, 'ebonyWings');
    pulseBird(state.vandalier, 'vandalier');
    pulseVolleys();
    pulseBirdRays();
    pulseLoopStrikes();
    pulseSantaWaterZones();
    // Schedule deferred local fire after other attacks have taken their slots.
    pulseNduja();
  }

  function moveProjectiles() {
    function contactPower(projectile) {
      if (projectile.liveWeaponDamage !== true) return projectile.damage * state.player.might;
      const slot=LIVE_DAMAGE_SLOTS[projectile.kind], power=state[slot].damage;
      requireValue(Number.isFinite(power) && power >= 0 && power <= 1_000_000, 'projectile damage capacity');
      const damage=power * state.player.might;
      requireValue(Number.isFinite(damage) && damage >= 0 && damage <= 16_000_000, 'projectile damage capacity');
      return damage;
    }
    for (let index = state.projectiles.length - 1; index >= 0; index--) {
      const projectile = state.projectiles[index];
      if(projectile.kind==='bone' && Object.hasOwn(projectile,'boneBounceReadyTick'))requireValue(integer(state.tick+2,0),'bone bounce clock capacity');
      if (projectile.kind === 'axe') projectile.vy = round(projectile.vy + 0.08);
      if (projectile.kind === 'cross' || projectile.kind === 'heaven-sword') {
        const age = state.tick - projectile.bornTick;
        if (projectile.phase === 'out' && state.tick >= projectile.turnTick) {
          projectile.phase = 'return';
          if(projectile.kind === 'heaven-sword') projectile.hitIds = [];
        }
        const initial = projectile.kind === 'heaven-sword' ? 2 : 1.5 + 0.1 * projectile.shotIndex;
        const factor = projectile.kind === 'heaven-sword'
          ? age <= 30 ? 2 * (1 - age / 30) : -2 * Math.min((age - 30) / 30, 1)
          : initial + (-2 - initial) * Math.min(age / 60, 1);
        projectile.vx = round(projectile.launchVx * factor);
        projectile.vy = round(projectile.launchVy * factor);
      }
      projectile.x = round(projectile.x + projectile.vx / TICK_HZ);
      projectile.y = round(projectile.y + projectile.vy / TICK_HZ);
      projectile.ttl--;
      if (projectile.kind === 'bone') {
        const player = state.player;
        for (const [axis, halfSize, velocity] of BOUNCE_AXES) {
          const lower = player[axis] - halfSize, upper = player[axis] + halfSize;
          if (projectile[axis] < lower || projectile[axis] > upper) {
            projectile[axis] = round(Math.max(lower, Math.min(upper, projectile[axis])));
            projectile[velocity] = -projectile[velocity];
            state.bone.bounces++;
          }
        }
      }
      if (projectile.kind === 'runetracer') {
        const player = state.player; let bounced = false;
        for (const [axis, halfSize, velocity] of BOUNCE_AXES) {
          const lower = player[axis] - halfSize, upper = player[axis] + halfSize;
          if (projectile[axis] < lower || projectile[axis] > upper) {
            projectile[axis] = round(Math.max(lower, Math.min(upper, projectile[axis])));
            projectile[velocity] = -projectile[velocity]; bounced = true;
          }
        }
        if (bounced) {
          projectile.hitIds = [];
          if (projectile.evolved && state.tick >= projectile.nextExplosionTick) {
            projectile.nextExplosionTick = state.tick + 12;
            spawnCarnageExplosion(projectile.x, projectile.y, contactPower(projectile), projectile.liveWeaponDamage === true);
          }
        }
        // Build an ephemeral lookup only when repeated overlapping candidates
        // would otherwise scan a long hit list. The authoritative array remains
        // in original insertion order and the lookup never leaves this tick.
        let hitSet = null, overlapChecks = 0;
        for (let target = state.enemies.length - 1; target >= 0; target--) {
          const enemy = state.enemies[target];
          if (distanceSquared(projectile, enemy) > (enemy.radius + 0.08) ** 2) continue;
          if (!hitSet && projectile.hitIds.length >= 32 && ++overlapChecks === 8) hitSet = new Set(projectile.hitIds);
          if (hitSet ? hitSet.has(enemy.id) : projectile.hitIds.includes(enemy.id)) continue;
          const damage=contactPower(projectile);
          projectile.hitIds.push(enemy.id); if (hitSet) hitSet.add(enemy.id);
          enemy.hp = round(enemy.hp - damage);
          applyEnemyImpact(enemy, state.player, state.tick, 5);
          if (enemy.hp <= 0) defeatEnemy(target);
        }
        for (let target = state.breakables.length - 1; target >= 0; target--) {
          const item = state.breakables[target];
          if (distanceSquared(projectile, item) > (item.radius + 0.08) ** 2) continue;
          if (!hitSet && projectile.hitIds.length >= 32 && ++overlapChecks === 8) hitSet = new Set(projectile.hitIds);
          if (hitSet ? hitSet.has(item.id) : projectile.hitIds.includes(item.id)) continue;
          const damage=contactPower(projectile);
          projectile.hitIds.push(item.id); if (hitSet) hitSet.add(item.id);
          damageBreakable(target, damage);
        }
        if (projectile.ttl <= 0) state.projectiles.splice(index, 1);
        continue;
      }
      const propRadius = projectile.kind === 'fireball' ? (projectile.evolved ? 0.35 : 0.17) * state.player.area : projectile.radius ?? 0.02;
      const enemyRadius = projectile.kind === 'knife' ? -0.08 : propRadius;
      let hitSet = null, overlapChecks = 0;
      const hasHit = id => {
        const ids = projectile.hitIds;
        if (!ids) return false;
        if (!hitSet && ids.length >= 32 && ++overlapChecks === 8) hitSet = new Set(ids);
        return hitSet ? hitSet.has(id) : ids.includes(id);
      };
      const hit = state.enemies.findIndex(enemy => distanceSquared(projectile, enemy) <=
        (enemy.radius + enemyRadius) ** 2 && !hasHit(enemy.id));
      if (hit >= 0) {
        const enemy = state.enemies[hit];
        let damage = contactPower(projectile);
        const newBone=projectile.kind==='bone' && Object.hasOwn(projectile,'boneBounceReadyTick');
        if(newBone)prepareBoneContact(projectile,enemy);
        else if(projectile.kind==='bone')requireValue(projectile.hitIds.length<20_000,'bone hit history capacity');
        if (state.axe && (projectile.kind === 'axe' || projectile.kind === 'death-spiral')) state.axe.hits++;
        if (projectile.kind === 'bone') state.bone.hits++;
        if (projectile.kind === 'cross' || projectile.kind === 'heaven-sword') {
          state.cross.hits++;
          if (projectile.kind === 'heaven-sword' && random() < 0.1 * state.player.luck) {
            damage *= 2.5;
            state.cross.criticalHits++;
          }
        }
        enemy.hp = round(enemy.hp - damage);
        applyEnemyImpact(enemy, state.player, state.tick, projectile.kind === 'knife' ? 0.5 : 5);
        if (enemy.hp <= 0) defeatEnemy(hit);
        if (projectile.kind === 'bone') {
          if(!newBone){projectile.hitIds.push(enemy.id);reboundBone(projectile, enemy);}
        } else if (projectile.remainingHits > 1 && projectile.ttl > 0) {
          projectile.hitIds.push(enemy.id);
          projectile.remainingHits--;
        } else state.projectiles.splice(index, 1);
      } else {
        const propHit = state.breakables.findIndex(item => distanceSquared(projectile, item) <=
          (item.radius + propRadius) ** 2 && !hasHit(item.id));
        if (propHit >= 0) {
          const item = state.breakables[propHit];
          const damage=contactPower(projectile);
          const newBone=projectile.kind==='bone' && Object.hasOwn(projectile,'boneBounceReadyTick');
          if(newBone)prepareBoneContact(projectile,item);
          else if(projectile.kind==='bone')requireValue(projectile.hitIds.length<20_000,'bone hit history capacity');
          damageBreakable(propHit, damage);
          if (projectile.kind === 'bone') {
            if(!newBone){projectile.hitIds.push(item.id);reboundBone(projectile, item);}
          } else if (projectile.remainingHits > 1 && projectile.ttl > 0) {
            projectile.hitIds.push(item.id);
            projectile.remainingHits--;
          } else state.projectiles.splice(index, 1);
        } else if (projectile.ttl <= 0) state.projectiles.splice(index, 1);
      }
      // New Bone retains the existing contact-before-expiry ordering, but its
      // expired projectile must not survive a contact with ttl zero in a save.
      if(projectile.kind==='bone' && Object.hasOwn(projectile,'boneBounceReadyTick') && projectile.ttl<=0 && state.projectiles[index]===projectile)
        state.projectiles.splice(index,1);
    }
  }

  function moveEnemies() {
    for (const enemy of state.enemies) moveEnemy(enemy, state.player, state.tick, TICK_HZ);
  }

  function collectGems() {
    const player = state.player;
    const radiusSquared = player.magnet ** 2;
    const gems = state.gems;
    let removed = null, removedCount = 0;
    try {
    for (let index = gems.length - 1; index >= 0; index--) {
      const gem=state.gems[index];
      if (!gem.attraction) {
        if (distanceSquared(player, gem) > radiusSquared) continue;
        gem.attraction={startTick:state.tick,startX:gem.x,startY:gem.y};
      }
      const t=Math.min(1,(state.tick-gem.attraction.startTick)/30), ease=t*t;
      gem.x=round(gem.attraction.startX+(player.x-gem.attraction.startX)*ease);
      gem.y=round(gem.attraction.startY+(player.y-gem.attraction.startY)*ease);
      if (t<1) continue;
      // Original Gem.GetTaken passes Value * PGrowth through AddPlayerXp.
      // The local run has no stage/arcana XP multiplier, so both are 1 here.
      const units=gemUnits(gem), aggregated=gem.rawValue!==undefined;
      const perUnit=Math.fround(Math.fround(aggregated?gemRawValue(gem):gem.value) * Math.fround(player.growth));
      const applications=aggregated?1:units;
      requireValue(Number.isFinite(perUnit) && player.xp+perUnit*applications<=900_000_000_000 && player.xpEarned+perUnit*applications<=900_000_000_000 && player.gemsCollected+units<=MAX_GEM_UNITS,'gem capacity XP budget');
      let xp=player.xp, earned=player.xpEarned;
      for(let unit=0;unit<applications;unit++) { xp=Math.fround(xp+perUnit); earned=Math.fround(earned+perUnit); }
      requireValue(Number.isFinite(xp) && Number.isFinite(earned) && xp<=900_000_000_000 && earned<=900_000_000_000,'gem capacity XP budget');
      player.xp = xp;
      player.xpEarned = earned;
      player.gemsCollected+=units;
      // Preserve the cheap sparse path, then compact large batches once. If
      // a later pickup throws, finally commits precisely the earlier removals
      // before the outer transaction restores (or propagates) the error.
      if (!removed && ++removedCount < 32) gems.splice(index, 1);
      else {
        if (!removed) removed = new Uint8Array(gems.length);
        removed[index] = 1;
      }
    }
    } finally {
      if (removed) {
        let write = 0;
        for (let read = 0; read < gems.length; read++) if (!removed[read]) gems[write++] = gems[read];
        gems.length = write;
      }
    }
    if (player.xp < player.xpToNext) return;
    requireValue(player.level<1000,'level capacity reached');
    player.xp = Math.fround(player.xp - player.xpToNext);
    player.level++;
    // Installed Exdash character data grants luck at levels 10, 20, 30, 40
    // and 50. Apply only the newly reached milestone, not retroactive grants
    // to runs saved under earlier versions of this prototype.
    if (state.character === 'exdash' && player.level <= 50 && player.level % 10 === 0)
      player.luck = round(player.luck + 0.1);
    updateMight();
    updateGrowth();
    player.cooldownMultiplier = state.character === 'arca' ? arcaCooldownMultiplier(player.level)
      : state.character === 'porta' ? portaCooldownMultiplier(player.level)
        : state.character === 'exdash' ? 1.1 : 1;
    updateProjectileAmount();
    updateProjectileSpeed();
    player.xpToNext = experienceToNextLevel(player.level);
    state.pendingUpgrade = upgradeChoices();
    state.pendingUpgradeKind = 'level';
  }

  function linkedChestSource(chest, encounters, tick) {
    const hasSource = Object.hasOwn(chest, 'sourceEncounterId');
    requireValue(hasSource === Object.hasOwn(chest, 'dropTick'), 'incomplete chest origin');
    if (!hasSource) return null; // Older marked and unmarked checkpoints remain honest.
    requireValue(chest.boss === true && integer(chest.sourceEncounterId, 1) &&
      integer(chest.dropTick, 0, tick), 'invalid chest origin');
    const encounter = encounters.find(row => row.id === chest.sourceEncounterId);
    requireValue(encounter?.outcome === 'defeated' && encounter.kind !== 'reaper' &&
      encounter.tick === chest.dropTick && encounter.chestId === chest.id &&
      encounter.chestTier === chest.tier, 'chest origin mismatch');
    requireValue(chest.sourceMinute === encounter.sourceMinute &&
      (chest.sourceMinute === undefined || integer(chest.sourceMinute, 0, Math.min(29, Math.floor(chest.dropTick / 3600))) &&
        FOREST_BOSSES[chest.sourceMinute]?.kind === encounter.kind), 'chest source minute mismatch');
    return {origin: 'boss-encounter', sourceEncounterId: chest.sourceEncounterId,
      dropTick: chest.dropTick, ...(chest.sourceMinute === undefined ? {} : {sourceMinute: chest.sourceMinute})};
  }

  function collectChests() {
    if (state.pendingUpgrade) return;
    const player = state.player;
    for (let index = state.chests.length - 1; index >= 0; index--) {
      if (distanceSquared(player, state.chests[index]) > (player.magnet + 0.4) ** 2) continue;
      const chest = state.chests[index];
      const claim = claimChest(chest, {wave: Math.floor(state.tick / (60 * 60)), boss: chest.boss===true, legacyTick:state.tick, claimedIds: new Set()});
      const linkedSource = linkedChestSource(chest, state.progression.encounters, state.tick);
      const tier = chest.tier === 3 ? 3 : chest.tier === 2 ? 2 : 1;
      // Keep the chest in the world if its complete transaction cannot fit.
      // Preview the same gold roll without consuming RNG on a deferred claim.
      if (state.progression.receipts.length >= 4096) continue;
      const previousRng = state.rng;
      const gold = treasureGold(tier, random);
      if (state.gold + gold + 125 > 10_000_000) { state.rng = previousRng; continue; }
      state.chests.splice(index, 1);
      state.chestsOpened++;
      state.gold += gold;
      const eligibleOwned = () => upgradeChoices(true).filter(option => option.id.endsWith('-level') ||
        (PASSIVE_OPTION_FIELDS[option.id] && state[PASSIVE_OPTION_FIELDS[option.id]] > 0));
      const prizeTypes = linkedSource?.sourceMinute === undefined ? null : forestTreasurePrizeTypes(linkedSource.sourceMinute);
      const choose = prizeTypes ? pool => {
        // Evolution selection and the unmodeled unlock/arcana branches remain
        // local rules; ordinary owned equipment uses installed rarity weights.
        if (pool.some(option => option.id.startsWith('evolve-'))) return pool[Math.floor(random() * pool.length)];
        const weight = option => LEVEL_RARITY[optionKey(option.id)] ?? 0;
        const total = pool.reduce((sum, option) => sum + weight(option), 0);
        if (!total) return pool[Math.floor(random() * pool.length)];
        let roll = Math.floor(random() * total);
        for (const option of pool) { roll -= weight(option); if (roll < 0) return option; }
        return pool[pool.length - 1];
      } : null;
      const rewards = settleTreasure({tier, random, evolutions: evolutionChoices,
        upgrades: () => upgradeChoices(true), existingWeapons: () => eligibleOwned().filter(option => option.id.endsWith('-level')),
        existingAny: eligibleOwned, prizeTypes, choose, apply: reward => applyReward(reward.id)});
      state.lastTreasure = {id: state.chestsOpened, tick: state.tick, tier, gold,
        rewards, ...(linkedSource ?? (claim.origin ? {origin: claim.origin} : {}))};
      state.progression.receipts.push({id: `chest:${chest.id}`, kind: 'treasure', tick: state.tick,
        gold, tier, rewards: rewards.map(reward => reward.id),
        ...(linkedSource ?? (claim.origin ? {origin: claim.origin} : {}))});
      break;
    }
  }

  function pickupAtCapacity(item) {
    if(state.pickupsCollected>=10_000_000)return true;
    if(item.kind==='little-clover' && round(state.player.luck+0.1)>16)return true;
    if(item.kind==='rerollo' && state.rerolls>=MAX_REROLLS)return true;
    const halfValue=item.kind==='coin'?2:item.kind==='coin-bag'?20:item.kind==='big-coin-bag'?200:item.kind==='fever-coin'?(item.halfUnits??1):0;
    return halfValue>0 && (state.gold*2+state.goldHalfRemainder+halfValue>20_000_001 ||
      !!state.goldFever?.active && state.goldFever.totalHalf+halfValue>20_000_001);
  }
  function pickupLimit() {
    if(state.pickups.length>=4096 && state.breakables.length)return {kind:'candelabra',reason:'capacity'};
    const player=state.player;
    const item=state.pickups.find(row=>distanceSquared(player,row)<=(player.magnet+0.25)**2 && pickupAtCapacity(row));
    return item?{kind:item.kind,reason:'capacity'}:null;
  }

  function collectPickups() {
    if (state.pendingUpgrade) return;
    const player = state.player;
    for (let index = state.pickups.length - 1; index >= 0; index--) {
      const item = state.pickups[index];
      if(item.attraction){
        const t=Math.min(1,(state.tick-item.attraction.startTick)/30),ease=t*t;
        item.x=round(item.attraction.startX+(player.x-item.attraction.startX)*ease);
        item.y=round(item.attraction.startY+(player.y-item.attraction.startY)*ease);
        if(t<1)continue;
      }
      if (distanceSquared(player, item) > (player.magnet + 0.25) ** 2) continue;
      // A full resource leaves its pickup in place while movement continues;
      // rolling back the whole movement tick would trap the player inside it.
      if(pickupAtCapacity(item))continue;
      state.pickups.splice(index, 1);
      state.pickupsCollected++;
      if (item.kind === 'coin') state.gold++;
      else if (item.kind === 'coin-bag') state.gold += 10;
      else if (item.kind === 'big-coin-bag') state.gold += 100;
      else if (item.kind === 'little-clover') { state.cloversCollected++; player.luck=round(player.luck+0.1); }
      else if (item.kind === 'rerollo') {state.rerollosCollected++;state.rerolls++;}
      else if (item.kind === 'fever-coin') {const half=state.gold*2+state.goldHalfRemainder+(item.halfUnits??1);state.gold=Math.floor(half/2);state.goldHalfRemainder=half%2;}
      else if (item.kind === 'gilded-clover') {
        if(state.goldFever?.active)state.goldFever.elapsedUnits=0;
        else state.goldFever={active:true,elapsedUnits:0,totalHalf:0,pending:state.goldFever?.pending??null};
        for(const gold of state.pickups)if(['coin','coin-bag','big-coin-bag','fever-coin'].includes(gold.kind) && !gold.attraction)
          gold.attraction={startTick:state.tick,startX:gold.x,startY:gold.y};
      }
      else if (item.kind === 'nduja') {
        state.nduja=pickupNdujaScheduler(state.nduja,state.tick);
      }
      else if (item.kind === 'roast') {
        state.roastsCollected++;
        setHealedHp(Math.min(player.maxHp, player.hp + 30));
      } else if (item.kind === 'vacuum') {
        state.vacuumsCollected++;
        for (const gem of state.gems) if(!gem.attraction)gem.attraction={startTick:state.tick,startX:gem.x,startY:gem.y};
        collectGems();
        if (state.pendingUpgrade) break;
      } else if (item.kind === 'rosary') {
        state.rosariesCollected++;
        state.lastRosaryTick = state.tick;
        for (let enemyIndex = state.enemies.length - 1; enemyIndex >= 0; enemyIndex--) {
          const enemy = state.enemies[enemyIndex];
          if (Math.abs(enemy.x - player.x) > PENTAGRAM_HALF_WIDTH ||
              Math.abs(enemy.y - player.y) > PENTAGRAM_HALF_HEIGHT) continue;
          defeatEnemy(enemyIndex);
          state.rosaryKills++;
        }
        // Later pickups in this tick (including Vacuum) can see these drops.
        flushGemDrops();
      } else if (item.kind === 'orologion') {
        state.orologionsCollected++;
        state.lastOrologionTick = state.tick;
        state.orologionUntil = Math.max(state.orologionUntil, state.tick + 10 * TICK_HZ);
        for (const enemy of state.enemies) {
          enemy.frozenUntil = Math.max(enemy.frozenUntil, state.orologionUntil);
          state.orologionFreezes++;
        }
      }
      const fever=state.goldFever;
      if(fever?.active && ['coin','coin-bag','big-coin-bag','fever-coin'].includes(item.kind)){
        const halfValue=item.kind==='coin'?2:item.kind==='coin-bag'?20:item.kind==='big-coin-bag'?200:(item.halfUnits??1);
        const extension=item.kind==='coin-bag'?300:item.kind==='big-coin-bag'?600:item.kind==='fever-coin'?(item.feverTicks??30*(item.halfUnits??1)):30;
        fever.totalHalf+=halfValue;fever.elapsedUnits=Math.max(0,fever.elapsedUnits-extension*1000);
      }
    }
  }

  function advanceGoldFever() {
    const fever=state.goldFever;if(!fever?.active)return;
    const total=fever.totalHalf/2,rate=total>20000 ? 1+0.15*Math.floor(total/10000) : total>10000 ? 1.1 : 1;
    fever.elapsedUnits+=Math.round(rate*1000*(state.tick<state.orologionUntil?0.5:1));
    if(fever.elapsedUnits>=600_000){fever.active=false;fever.elapsedUnits=0;}
  }

  function flushFeverOverflow() {
    const fever=state.goldFever,pending=fever?.pending;
    if(!pending || state.pickups.length>=4096)return;
    requireValue(integer(state.nextId,1,Number.MAX_SAFE_INTEGER-1),'fever pickup capacity');
    state.pickups.push({id:state.nextId++,kind:'fever-coin',x:pending.x,y:pending.y,
      halfUnits:pending.halfUnits,feverTicks:pending.halfUnits*30});
    fever.pending=null;
  }

  function rechargeLaurel() {
    const laurel = state.laurel;
    if (!laurel || laurel.charges >= laurel.maxCharges || state.tick < laurel.nextChargeTick) return;
    laurel.charges++;
    laurel.nextChargeTick = laurel.charges < laurel.maxCharges
      ? state.tick + effectiveCooldown(laurel.rechargeTicks) : 0;
  }

  function spawnCarnageExplosion(x, y, damage, liveWeaponDamage = false) {
    requireValue(state.carnageExplosions.length < 256, 'carnage explosion capacity');
    requireValue(Number.isFinite(damage) && damage >= 0 && damage <= 1_000_000, 'carnage damage capacity');
    requireValue(state.enemies.length * (state.projectiles.length + state.whipStrikes.length + state.santaWaterZones.length + state.carnageExplosions.length + state.bibleShots.length + state.birdRays.length + state.garlicAreas.length + 1) <= 1_000_000, 'carnage collision capacity');
    // The original expands its collider over 120ms. The 1.2-world-unit
    // maximum below is a local mapping pending original prefab/unit evidence.
    state.carnageExplosions.push({id:state.nextId++,x,y,damage,radius:round(1.2*state.player.area),
      tick:state.tick,until:state.tick+8,hitIds:[],...(liveWeaponDamage ? {liveWeaponDamage:true} : {})});
  }
  function retaliateCarnage() {
    const rune=state.runetracer;
    if (!rune?.evolved || state.tick < rune.nextRetaliationTick) return;
    rune.nextRetaliationTick=state.tick+30;
    spawnCarnageExplosion(state.player.x,state.player.y,rune.damage*state.player.might,true);
  }
  function pulseCarnageExplosions() {
    const contactPower = blast => {
      if (!blast.liveWeaponDamage) return blast.damage;
      const damage=state.runetracer.damage*state.player.might;
      requireValue(Number.isFinite(damage) && damage>=0 && damage<=1_000_000,'carnage damage capacity');
      return damage;
    };
    for (const blast of state.carnageExplosions) {
      const radius=blast.radius*Math.min(1,(state.tick-blast.tick+1)/8);
      let hitSet=null, overlapChecks=0;
      for (let index=state.enemies.length-1;index>=0;index--) {
        const enemy=state.enemies[index];
        if (distanceSquared(blast,enemy)>(radius+enemy.radius)**2) continue;
        if(!hitSet && blast.hitIds.length>=32 && ++overlapChecks===8)hitSet=new Set(blast.hitIds);
        if(hitSet ? hitSet.has(enemy.id) : blast.hitIds.includes(enemy.id))continue;
        const damage=contactPower(blast);
        blast.hitIds.push(enemy.id);if(hitSet)hitSet.add(enemy.id);enemy.hp=round(enemy.hp-damage);
        applyEnemyImpact(enemy,state.player,state.tick,5);if(enemy.hp<=0)defeatEnemy(index);
      }
      for (let index=state.breakables.length-1;index>=0;index--) {
        const item=state.breakables[index];
        if (distanceSquared(blast,item)>(radius+item.radius)**2) continue;
        if(!hitSet && blast.hitIds.length>=32 && ++overlapChecks===8)hitSet=new Set(blast.hitIds);
        if(hitSet ? hitSet.has(item.id) : blast.hitIds.includes(item.id))continue;
        const damage=contactPower(blast);
        blast.hitIds.push(item.id);if(hitSet)hitSet.add(item.id);damageBreakable(index, damage);
      }
    }
  }
  function contactDamage() {
    const player = state.player;
    if (state.tick < player.invulnerableUntil) return;
    const contact = state.enemies.find(enemy => enemy.frozenUntil <= state.tick &&
      distanceSquared(player, enemy) <= enemy.radius ** 2);
    if (!contact) return;
    if (state.laurel?.charges > 0) {
      const laurel = state.laurel;
      laurel.charges--;
      laurel.absorbedHits++;
      retaliateCarnage();
      laurel.lastBlockTick = state.tick;
      if (!laurel.nextChargeTick) laurel.nextChargeTick = state.tick + effectiveCooldown(laurel.rechargeTicks);
      // Default shield guard is 240ms with no extra invulnerability bonus.
      player.invulnerableUntil = state.tick + 15;
      return;
    }
    const damage = player.armor > 0 ? Math.max(1, contact.damage - player.armor) : contact.damage;
    player.hp = contact.kind === 'reaper' ? 0 : Math.max(0, player.hp - damage);
    // Original no-bonus contact guard is 120ms; quantize up to local 60Hz.
    player.invulnerableUntil = state.tick + 8;
    retaliateCarnage();
    if (player.hp === 0) { state.done = true; state.reason = contact.kind === 'reaper' ? 'reaper' : 'death'; }
  }

  function validateAction(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('invalid action');
    if(Object.hasOwn(action,'reroll') && (action.reroll!==true || Object.hasOwn(action,'choice') || action.moveX!==0 || action.moveY!==0 || Object.keys(action).sort().join(',')!=='moveX,moveY,reroll')) throw new Error('invalid reroll action');
    for (const key of ['moveX', 'moveY']) {
      if (action[key] !== undefined && (typeof action[key] !== 'number' || !Number.isFinite(action[key]) || Math.abs(action[key]) > 1)) {
        throw new Error('invalid movement');
      }
    }
    if (action.choice !== undefined && !Number.isInteger(action.choice)) throw new Error('invalid upgrade choice');
  }

  // Local approximation: evaluate source-backed single-run predicates on
  // each completed tick and equipment choice. Native check scheduling is open.
  function achievementConditions() { return evaluateAchievementConditions(state,TICK_HZ); }
  function recordAchievementTransitions(before) {
    const after=achievementConditions();
    for(const [achievementId,met] of Object.entries(after)) {
      if (met && !before[achievementId] && !state.runEquipmentUnlocks.includes(ACHIEVEMENT_UNLOCKS[achievementId]) &&
          !state.achievementEvents.some(event=>event.achievementId===achievementId))
        state.achievementEvents.push({achievementId,tick:state.tick});
    }
  }
  function stepCore(action = {}, frames = 1) {
    validateAction(action);
    if (!Number.isInteger(frames) || frames < 1 || frames > 6) throw new Error('frames must be 1..6');
    if(action.reroll===true){
      requireValue(!state.done && state.pendingUpgradeKind==='level' && Array.isArray(state.pendingUpgrade) && state.pendingUpgrade.length>0 && state.rerolls>0,'reroll unavailable');
      const beforeRng=state.rng,choices=upgradeChoices();
      requireValue(choices.length>0,'reroll unavailable');
      if(state.rng===beforeRng)random();
      state.rerolls--;state.pendingUpgrade=choices;
      return snapshot();
    }
    if (state.done) return snapshot();
    areaHitCount=state.bibleShots.reduce((n,shot)=>n+shot.hitIds.length,0)+state.santaWaterZones.reduce((n,zone)=>n+(zone.hitIds?.length??0),0)+state.birdRays.reduce((n,ray)=>n+ray.hitIds.length,0)+state.garlicAreas.reduce((n,area)=>n+area.hitIds.length,0);
    if (state.pendingUpgrade) { const before=achievementConditions(); applyUpgrade(action.choice); recordAchievementTransitions(before); }
    else if (action.choice !== undefined) throw new Error('no upgrade is pending');
    const moveX = action.moveX ?? 0, moveY = action.moveY ?? 0;
    const magnitude = Math.max(1, Math.hypot(moveX, moveY));
    for (let index = 0; index < frames; index++) {
      const previousChestCount = state.chestsOpened;
      const previousAchievements=achievementConditions();
      state.tick++;
      advanceGoldFever();
      flushFeverOverflow();
      state.recentEnemyDeaths = state.recentEnemyDeaths.filter(death => state.tick - death.tick < 12);
      state.whipStrikes = state.whipStrikes.filter(strike => strike.until > state.tick);
      state.lightningStrikes = state.lightningStrikes.filter(strike => strike.until > state.tick);
      for(const area of state.garlicAreas)if(area.untilTick<=state.tick)areaHitCount-=area.hitIds.length;
      state.garlicAreas=state.garlicAreas.filter(area=>area.untilTick>state.tick);
      for(const ray of state.birdRays)if(ray.untilTick<=state.tick)areaHitCount-=ray.hitIds.length;
      state.birdRays=state.birdRays.filter(ray=>ray.untilTick>state.tick);
      for(const shot of state.bibleShots)if(shot.until<=state.tick)areaHitCount-=shot.hitIds.length;
      state.bibleShots = state.bibleShots.filter(shot=>shot.until>state.tick);
      for(const zone of state.santaWaterZones)if(zone.until<=state.tick && zone.hitIds)areaHitCount-=zone.hitIds.length;
      state.santaWaterZones = state.santaWaterZones.filter(zone => zone.until > state.tick);
      state.carnageExplosions = state.carnageExplosions.filter(blast => blast.until > state.tick);
      updateWave();
      const player = state.player;
      player.x = round(player.x + moveX / magnitude * player.speed / TICK_HZ);
      player.y = round(player.y + moveY / magnitude * player.speed / TICK_HZ);
      if (moveX !== 0 || moveY !== 0) {
        const length = Math.hypot(moveX, moveY);
        player.facingX = round(moveX / length);
        player.facingY = round(moveY / length);
        if (moveX !== 0) player.facing = moveX < 0 ? -1 : 1;
      }
      cullEnemies();
      updateStageEvents();
      if (state.tick >= state.nextSpawnTick) spawnWave();
      if (state.tick >= state.nextBreakableTick) {
        spawnTimedBreakable();
        state.nextBreakableTick = state.tick + 60;
      }
      moveEnemies();
      moveSoulHearts();
      processMoonCycle();
      if (state.pummarolaLevel && state.tick % TICK_HZ === 0 && !state.done)
        setHealedHp(round(Math.min(player.maxHp, player.hp + state.pummarolaLevel * 0.2)));
      attack();
      moveProjectiles();
      // Weapon deaths batch before the existing same-tick gem collection.
      flushGemDrops();
      collectGems();
      collectChests();
      collectPickups();
      rechargeLaurel();
      contactDamage();
      pulseCarnageExplosions();
      // Retaliation deaths occur after normal collection but before snapshot.
      flushGemDrops();
      recordAchievementTransitions(previousAchievements);
      if (!state.done && state.tick >= maxTicks) { state.done = true; state.reason = 'time-limit'; break; }
      if (state.done || state.pendingUpgrade || state.chestsOpened !== previousChestCount) break;
    }
    return snapshot();
  }

  function step(action = {}, frames = 1) {
    // Preserve the terminal fast return, including legal large Bone saves.
    if(state.done && state.bone)return stepCore(action,frames);
    // Only high-density/extreme states need a rollback copy. Ordinary play
    // follows the unchanged fast path; bounded errors cannot strand half a tick.
    // A six-frame step can spawn a boss, award several chest items, evolve
    // Runetracer and retaliate before returning. Keep one rollback snapshot
    // whenever the run already owns Runetracer; no conditional event tree can
    // safely rule out all of those paths at the start of the step.
    let risky = Object.hasOwn(action ?? {},'reroll') || !!state.goldFever?.active || !!state.goldFever?.pending || !!state.nduja?.active || !!state.nduja?.pendingShots.length || state.pickups.length+state.breakables.length>=4096 || state.pickups.some(item=>['little-clover','coin-bag','big-coin-bag','nduja','rerollo','gilded-clover','fever-coin'].includes(item.kind)) || !!state.bone || !!state.peachone || !!state.ebonyWings || !!state.vandalier || state.birdRays.length>0 || state.legacyBirdVolleys.length>0 || !!state.pendingUpgrade || state.chests.some(chest=>distanceSquared(state.player,chest)<=(state.player.magnet+0.4+state.player.speed*0.1)**2) || state.enemies.some(enemy=>enemy.boss) || state.tick%3600>=3594 || !!state.bible || !!state.santaWater || state.bibleShots.length > 0 || state.santaWaterZones.length > 0 || !!state.runetracer || !!state.garlic || state.garlicAreas.length > 0 || state.soulHearts.length > 0 || !!(state.moonCycle &&
      state.moonCycle.startTick + MOON_EVENT_OFFSETS[state.moonCycle.nextEventIndex] <= state.tick + 6) ||
      !!(state.pentagram?.evolved && state.pentagram.nextTick <= state.tick + 6);
    if(!risky && !state.done) {
      const endTick=state.tick+frames;
      risky=!!state.whip && (state.whip.nextTick<=endTick || state.pendingWhips.some(shot=>shot.tick<=endTick) ||
        state.whipStrikes.some(strike=>strike.liveWeaponDamage===true)) ||
        !!state.cross && (state.cross.nextTick<=endTick || state.pendingVolleys.some(shot=>shot.slot==='cross' && shot.dueTick<=endTick)) ||
        state.pendingLoopStrikes.some(strike=>strike.liveWeaponDamage===true && strike.dueTick<=endTick) ||
        !!state.lightning?.evolved && (state.lightning.nextTick<=endTick ||
          state.pendingVolleys.some(shot=>shot.slot==='lightning' && shot.dueTick<=endTick));
    }
    if (!risky) {
      const maximumWhips=state.whip ? state.whip.strikes+Math.min(10,state.player.bonusProjectiles) : 0;
      const volleyWeapons = VOLLEY_SLOTS.map(slot => state[slot]).filter(Boolean);
      const volleyBudget = state.pendingUpgrade ? 6 * 6 * 30 : volleyWeapons.reduce((sum, weapon) => {
        const count = (weapon === state.axe && weapon.evolved ? 9 : weapon.amount) + Math.min(10, state.player.bonusProjectiles);
        const launches = Math.min(6, 1 + Math.floor(6 / Math.max(1, effectiveCooldown(weapon.cooldownTicks))));
        return sum + launches * (Number.isInteger(count) && count >= 1 && count <= 30 ? count : 512);
      }, 0);
      let aggregateNearLimits=false;
      if(compactedGems){let units=state.player.gemsCollected,raw=0;
        for(const gem of state.gems){units+=gemUnits(gem);raw+=gemRawValue(gem);}
        aggregateNearLimits=units+6144>=MAX_GEM_UNITS || raw+6_144_000_000>=MAX_RAW_GEM_XP;
      }
      risky=state.gold >= 9_998_000 || state.kills >= 9_998_000 || state.pickupsCollected>=9_999_000 || state.progression.receipts.length >= 4090 ||
        state.nextVolleyId >= 9_999_964 || state.pendingVolleys.length + volleyBudget > MAX_PENDING_VOLLEYS ||
        state.projectiles.length + state.pendingVolleys.length + volleyBudget + 200 > MAX_PROJECTILES ||
        state.lightningStrikes.length + state.pendingVolleys.length + state.pendingLoopStrikes.length + 2 * volleyBudget > 256 ||
        state.pendingLoopStrikes.length + volleyBudget > 256 ||
        state.santaWaterZones.length + state.pendingVolleys.length + volleyBudget > 256 ||
        state.pendingWhips.length+maximumWhips*6>128 || state.whipStrikes.length+maximumWhips*6>128 ||
        state.gems.length>=MAX_GEMS-6144 ||
        state.player.gemsCollected+state.gems.length+6144>=MAX_GEM_UNITS ||
        state.nextId>=9_990_000 || state.player.level>=1000 ||
        state.player.xp>100_000_000_000 || state.player.xpEarned>100_000_000_000 || aggregateNearLimits ||
        state.gems.some(gem=>gem.value>=56_000) || state.enemies.some(enemy=>enemy.xp>666_666);
    }
    // Keep the exact same JSON rollback image as clone(state), but delay its
    // parse until an exception actually needs restoration. The successful path
    // does not publish this string or change any validation or state shape.
    const before=risky?JSON.stringify(state):null, wasCompacted=compactedGems;
    try{const result=stepCore(action,frames);
      if(state.nduja?.active || state.nduja?.pendingShots.length || state.bible || state.santaWater || state.bibleShots.length || state.santaWaterZones.length || state.peachone || state.ebonyWings || state.vandalier || state.birdRays.length || state.legacyBirdVolleys.length || state.garlic || state.garlicAreas.length || state.bone) {
        requireValue(state.enemies.length*(state.projectiles.length+state.whipStrikes.length+state.santaWaterZones.length+state.carnageExplosions.length+state.bibleShots.length+state.birdRays.length+state.garlicAreas.length)<=1_000_000, 'area collision work capacity');
        const entities=['garlicAreas','birdRays','bibleShots','soulHearts','enemies','projectiles','gems','chests','breakables','pickups','lightningStrikes','santaWaterZones','carnageExplosions','whipStrikes','pendingWhips','recentEnemyDeaths'].reduce((n,key)=>n+state[key].length,0);
        requireValue(entities<=20_000,'area entity capacity');
        requireValue(new TextEncoder().encode(JSON.stringify({maxTicks,state})).length<=MAX_SAVE_BYTES-1024,'area save byte capacity');
      }
      return result;}catch(error){pendingGemDrops=[];if(before!==null){state=JSON.parse(before);compactedGems=wasCompacted;}throw error;}
  }

  function snapshot() {
    return {engine: ENGINE_ID, seed: state.seed, character: state.character, stage: 'mad-forest',
      waveMinute: state.waveMinute, stageEventsTriggered: state.stageEventsTriggered,
      lastStageEvent: state.lastStageEvent && {...state.lastStageEvent}, tickHz: TICK_HZ, tick: state.tick,
      done: state.done, reason: state.reason, kills: state.kills,
      killTrackingV1: {...state.killTrackingV1},
      bossKills: state.bossKills, chestsOpened: state.chestsOpened,
      gold: state.gold, pickupsCollected: state.pickupsCollected,
      pickupLimit:pickupLimit(),
      nduja:state.nduja && {...state.nduja,pendingShots:state.nduja.pendingShots.map(shot=>({...shot}))},
      goldFever:state.goldFever && {...state.goldFever,pending:state.goldFever.pending && {...state.goldFever.pending}}, goldHalfRemainder:state.goldHalfRemainder,
      roastsCollected: state.roastsCollected, vacuumsCollected: state.vacuumsCollected, cloversCollected: state.cloversCollected, rerollosCollected:state.rerollosCollected, rerolls:state.rerolls,
      breakablesBroken: state.breakablesBroken,
      rosariesCollected: state.rosariesCollected, rosaryKills: state.rosaryKills,
      lastRosaryTick: state.lastRosaryTick,
      orologionsCollected: state.orologionsCollected,
      orologionFreezes: state.orologionFreezes, orologionUntil: state.orologionUntil,
      lastOrologionTick: state.lastOrologionTick,
      weaponSlots: weaponSlots(), passiveSlots: passiveSlots(),
      evolutionRecipes: evolutionRecipes(), runEquipmentUnlocks: [...state.runEquipmentUnlocks],
      achievementEvents: state.achievementEvents.map(event=>({...event})),
      player: {...state.player}, hollowHeartLevel: state.hollowHeartLevel,
      emptyTomeLevel: state.emptyTomeLevel, bracerLevel: state.bracerLevel,
      spinachLevel: state.spinachLevel, candelabradorLevel: state.candelabradorLevel,
      spellbinderLevel: state.spellbinderLevel, cloverLevel: state.cloverLevel,
      wingsLevel: state.wingsLevel, armorLevel: state.armorLevel,
      attractorLevel: state.attractorLevel, crownLevel: state.crownLevel, pummarolaLevel: state.pummarolaLevel,
      duplicatorLevel: state.duplicatorLevel,
      recentEnemyDeaths: state.recentEnemyDeaths.map(death => ({...death})),
      whipStrikes: state.whipStrikes.map(copyWhipStrike),
      pendingWhips: state.pendingWhips.map(shot => ({...shot})),
      pendingLoopStrikes: state.pendingLoopStrikes.map(strike=>({...strike})),
      whip: state.whip && {...state.whip}, wand: state.wand && {...state.wand},
      knife: state.knife && {...state.knife}, fireWand: state.fireWand && {...state.fireWand},
      lightning: state.lightning && {...state.lightning},
      santaWater: state.santaWater && {...state.santaWater},
      axe: state.axe && {...state.axe},
      bible: state.bible && {...state.bible}, bibleOrbs: bibleOrbs(),
      bibleShots: state.bibleShots.map(shot=>({...shot,hitIds:[...shot.hitIds]})),
      cross: state.cross && {...state.cross},
      runetracer: state.runetracer && {...state.runetracer},
      garlic: state.garlic && {...state.garlic},
      garlicAreas: state.garlicAreas.map(area=>({...area,hitIds:[...area.hitIds]})),
      soulHearts: state.soulHearts.map(heart => ({...heart})),
      laurel: state.laurel && {...state.laurel},
      clockLancet: state.clockLancet && {...state.clockLancet},
      pentagram: state.pentagram && {...state.pentagram},
      moonCycle: state.moonCycle && {...state.moonCycle},
      peachone: copyBird(state.peachone),
      ebonyWings: copyBird(state.ebonyWings),
      vandalier: copyBird(state.vandalier),
      bone: state.bone && {...state.bone},
      birdRays: state.birdRays.map(ray=>({...ray,hitIds:[...ray.hitIds],...birdRayPosition(ray)})),
      birdZones: [...birdZones(state.peachone, 'peachone'),
        ...birdZones(state.ebonyWings, 'ebony-wings'), ...birdZones(state.vandalier, 'vandalier')],
      enemies: state.enemies.map(enemy => ({...enemy})),
      gems: state.gems.map(gem => ({...gem,...(gem.attraction?{attraction:{...gem.attraction}}:{})})), chests: state.chests.map(chest => ({...chest})),
      breakables: state.breakables.map(item => ({...item})),
      pickups: state.pickups.map(item => ({...item,...(item.attraction?{attraction:{...item.attraction}}:{})})),
      projectiles: state.projectiles.map(copyProjectile),
      carnageExplosions: state.carnageExplosions.map(copyProjectile),
      lightningStrikes: state.lightningStrikes.map(strike => ({...strike})),
      santaWaterZones: state.santaWaterZones.map(zone => ({...zone,...(zone.hitIds?{hitIds:[...zone.hitIds]}:{})})),
      pendingUpgrade: state.pendingUpgrade?.map(option => ({...option})) ?? null,
      pendingUpgradeKind: state.pendingUpgradeKind,
      lastTreasure: state.lastTreasure && {...state.lastTreasure,
        rewards: state.lastTreasure.rewards.map(reward => ({...reward}))},
      lastAttackTick: state.lastAttackTick, lastGarlicTick: state.lastGarlicTick,
      lastLightningTick: state.lastLightningTick};
  }

  function observe() {
    const {player} = state;
    // Retain the same distance/id ordering while bounding temporary storage.
    // Dense late runs can have thousands of gems, but the protocol exposes 24.
    const nearest = list => {
      const selected=[];
      const compare=(a,b)=>a.distance-b.distance || a.item.id-b.item.id || a.index-b.index;
      for(let index=0;index<list.length;index++){
        const item=list[index],distance=distanceSquared(player,item);
        // Avoid allocating a candidate for the overwhelmingly common rejected item.
        if(selected.length===24){const last=selected[23];
          if(distance>last.distance || distance===last.distance && (item.id>last.item.id || item.id===last.item.id && index>=last.index)) continue;
        }
        const candidate={item,index,distance};
        let low=0,high=selected.length;
        while(low<high){const mid=(low+high)>>>1;if(compare(candidate,selected[mid])<0)high=mid;else low=mid+1;}
        selected.splice(low,0,candidate);if(selected.length>24)selected.pop();
      }
      return selected.map(({item})=>({...item,...(item.attraction?{attraction:{...item.attraction}}:{})}));
    };
    return {engine: ENGINE_ID, character: state.character, stage: 'mad-forest',
      waveMinute: state.waveMinute, stageEventsTriggered: state.stageEventsTriggered,
      lastStageEvent: state.lastStageEvent && {...state.lastStageEvent}, tick: state.tick, seconds: round(state.tick / TICK_HZ),
      weaponSlots: weaponSlots(), passiveSlots: passiveSlots(),
      evolutionRecipes: evolutionRecipes(), runEquipmentUnlocks: [...state.runEquipmentUnlocks],
      achievementEvents: state.achievementEvents.map(event=>({...event})),
      killTrackingV1: {...state.killTrackingV1},
      player: {...player}, hollowHeartLevel: state.hollowHeartLevel,
      emptyTomeLevel: state.emptyTomeLevel, bracerLevel: state.bracerLevel,
      spinachLevel: state.spinachLevel, candelabradorLevel: state.candelabradorLevel,
      spellbinderLevel: state.spellbinderLevel, cloverLevel: state.cloverLevel,
      wingsLevel: state.wingsLevel, armorLevel: state.armorLevel,
      attractorLevel: state.attractorLevel, crownLevel: state.crownLevel, pummarolaLevel: state.pummarolaLevel,
      duplicatorLevel: state.duplicatorLevel,
      recentEnemyDeaths: state.recentEnemyDeaths.map(death => ({...death})),
      whipStrikes: state.whipStrikes.map(copyWhipStrike),
      pendingLoopStrikes: state.pendingLoopStrikes.slice(0,24).map(strike=>({...strike})),
      pendingWhips: state.pendingWhips.map(shot => ({...shot})),
      whip: state.whip && {...state.whip}, wand: state.wand && {...state.wand},
      knife: state.knife && {...state.knife}, fireWand: state.fireWand && {...state.fireWand},
      lightning: state.lightning && {...state.lightning},
      santaWater: state.santaWater && {...state.santaWater},
      axe: state.axe && {...state.axe},
      bible: state.bible && {...state.bible}, bibleOrbs: bibleOrbs().slice(0,24),
      bibleShots: [...state.bibleShots].sort((a,b)=>a.id-b.id).slice(0,24).map(({hitIds,...shot})=>({...shot,hitCount:hitIds.length})),
      cross: state.cross && {...state.cross},
      enemies: nearest(state.enemies),
      runetracer: state.runetracer && {...state.runetracer},
      garlic: state.garlic && {...state.garlic},
      garlicAreas: state.garlicAreas.slice(0,24).map(({hitIds,...area})=>({...area,hitCount:hitIds.length})),
      soulHearts: nearest(state.soulHearts),
      laurel: state.laurel && {...state.laurel},
      clockLancet: state.clockLancet && {...state.clockLancet},
      pentagram: state.pentagram && {...state.pentagram},
      moonCycle: state.moonCycle && {...state.moonCycle},
      peachone: copyBird(state.peachone),
      ebonyWings: copyBird(state.ebonyWings),
      vandalier: copyBird(state.vandalier),
      bone: state.bone && {...state.bone},
      birdRays: nearest(state.birdRays.map(({hitIds,...ray})=>({...ray,...birdRayPosition(ray),hitCount:hitIds.length}))),
      birdZones: [...birdZones(state.peachone, 'peachone'),
        ...birdZones(state.ebonyWings, 'ebony-wings'), ...birdZones(state.vandalier, 'vandalier')].slice(0, 24),
      gems: nearest(state.gems), chests: nearest(state.chests),
      breakables: nearest(state.breakables), pickups: nearest(state.pickups),
      enemyCount: state.enemies.length,
      projectiles: state.projectiles.slice(0, 24).map(copyProjectile),
      carnageExplosions: state.carnageExplosions.slice(0,24).map(copyProjectile),
      lightningStrikes: state.lightningStrikes.slice(0, 24).map(strike => ({...strike})),
      santaWaterZones: state.santaWaterZones.slice(0, 24).map(({hitIds,...zone}) => ({...zone,...(hitIds ? {hitCount:hitIds.length} : {})})),
      pendingUpgrade: state.pendingUpgrade?.map(option => ({...option})) ?? null,
      pendingUpgradeKind: state.pendingUpgradeKind,
      lastTreasure: state.lastTreasure && {...state.lastTreasure,
        rewards: state.lastTreasure.rewards.map(reward => ({...reward}))},
      kills: state.kills, bossKills: state.bossKills, chestsOpened: state.chestsOpened,
      gold: state.gold, pickupsCollected: state.pickupsCollected,
      pickupLimit:pickupLimit(),
      nduja:state.nduja && {...state.nduja,pendingShots:state.nduja.pendingShots.map(shot=>({...shot}))},
      goldFever:state.goldFever && {...state.goldFever,pending:state.goldFever.pending && {...state.goldFever.pending}}, goldHalfRemainder:state.goldHalfRemainder,
      roastsCollected: state.roastsCollected, vacuumsCollected: state.vacuumsCollected, cloversCollected: state.cloversCollected, rerollosCollected:state.rerollosCollected, rerolls:state.rerolls,
      rosariesCollected: state.rosariesCollected, rosaryKills: state.rosaryKills,
      lastRosaryTick: state.lastRosaryTick,
      orologionsCollected: state.orologionsCollected,
      orologionFreezes: state.orologionFreezes, orologionUntil: state.orologionUntil,
      lastOrologionTick: state.lastOrologionTick,
      done: state.done, reason: state.reason};
  }


  // Candidate shop: prices/rerolls are local tuning; inventory eligibility is
  // the same rule used by level choices and treasure. No UI can apply rewards.
  function shopAction(action = {}) {
    requireValue(!state.done && !state.pendingUpgrade, 'shop unavailable');
    const before = clone(state);
    const previousAchievements = achievementConditions();
    try {
      if (action.type === 'open' || action.type === 'reroll') {
        if (action.type === 'open' && state.progression.shop) return clone(state.progression.shop);
        if (action.type === 'reroll') {
          requireValue(state.progression.shop, 'shop not open');
          requireValue(state.gold >= 20, 'insufficient gold');
          state.gold -= 20;
        }
        const pool = upgradeChoices(true).filter(option => !option.id.startsWith('bonus-'));
        const offers = [];
        while (pool.length && offers.length < 3) offers.push({...pool.splice(Math.floor(random() * pool.length), 1)[0], cost: 50});
        state.progression.shop = {revision: ++state.progression.shopRevision, offers};
      } else if (action.type === 'buy') {
        const shop = state.progression.shop;
        requireValue(shop && action.revision === shop.revision, 'stale shop');
        const offer = shop.offers.find(item => item.id === action.id);
        requireValue(offer, 'unknown or duplicate offer');
        requireValue(upgradeChoices(true).some(item => item.id === offer.id), 'missing dependency or full slots');
        requireValue(state.gold >= offer.cost, 'insufficient gold');
        const receiptId = `shop:${shop.revision}:${offer.id}`;
        requireValue(state.progression.receipts.length < 4096 && !state.progression.receipts.some(receipt => receipt.id === receiptId), 'shop ledger capacity or duplicate');
        state.gold -= offer.cost;
        applyReward(offer.id);
        state.progression.receipts.push({id: receiptId, kind: 'purchase', tick: state.tick, gold: -offer.cost, rewards: [offer.id]});
        shop.offers = shop.offers.filter(item => item.id !== offer.id);
      } else throw new Error('invalid shop action');
      recordAchievementTransitions(previousAchievements);
      return clone(state.progression.shop);
    } catch (error) { state = before; throw error; }
  }

  function exportState() { return clone({maxTicks, state}); }
  function restoreState(checkpoint) {
    validateJSON(checkpoint);
    // Inspect before JSON cloning: cloning would erase sparse/extra array keys.
    const denseArray = array => Array.isArray(array) && array.length<=20_000 && Reflect.ownKeys(array).length === array.length + 1 &&
      Array.from({length:array.length},(_,i)=>Object.hasOwn(array,i)).every(Boolean);
    const raw=checkpoint?.state;
    if(Array.isArray(raw?.enemies))for(const enemy of raw.enemies)if(enemy && Object.hasOwn(enemy,'freezeResistance'))requireValue(Object.prototype.propertyIsEnumerable.call(enemy,'freezeResistance') && typeof enemy.freezeResistance==='number' && Number.isFinite(enemy.freezeResistance) && Math.fround(enemy.freezeResistance)===enemy.freezeResistance && enemy.freezeResistance>=Math.fround(-.1) && enemy.freezeResistance<=Math.fround(1.1), 'invalid enemy freeze resistance');
    if(Array.isArray(raw?.projectiles))for(const shot of raw.projectiles)if(shot && Object.hasOwn(shot,'boneBounceReadyTick'))requireValue(Object.prototype.propertyIsEnumerable.call(shot,'boneBounceReadyTick') && shot.kind==='bone' && Number.isSafeInteger(raw.tick+2) && integer(shot.boneBounceReadyTick,0,raw.tick+2), 'invalid bone bounce clock');
    if(Array.isArray(raw?.projectiles))for(const shot of raw.projectiles)if(shot && Object.hasOwn(shot,'liveWeaponDamage'))requireValue(Object.prototype.propertyIsEnumerable.call(shot,'liveWeaponDamage') && shot.liveWeaponDamage===true && Object.hasOwn(LIVE_DAMAGE_SLOTS,shot.kind) && !!raw[LIVE_DAMAGE_SLOTS[shot.kind]] &&
      (shot.kind!=='runetracer' || typeof shot.evolved==='boolean' && Object.hasOwn(shot,'nextExplosionTick')), 'invalid live projectile damage');
    if(Array.isArray(raw?.carnageExplosions))for(const blast of raw.carnageExplosions)if(blast && Object.hasOwn(blast,'liveWeaponDamage'))requireValue(Object.prototype.propertyIsEnumerable.call(blast,'liveWeaponDamage') && blast.liveWeaponDamage===true && raw.runetracer?.evolved===true, 'invalid live carnage damage');
    if(Array.isArray(raw?.whipStrikes))for(const strike of raw.whipStrikes)if(strike && Object.hasOwn(strike,'liveWeaponDamage'))requireValue(Object.prototype.propertyIsEnumerable.call(strike,'liveWeaponDamage') && strike.liveWeaponDamage===true && !!raw.whip && typeof strike.evolved==='boolean' && strike.evolved===!!raw.whip.evolved, 'invalid live whip damage');
    if(Array.isArray(raw?.pendingLoopStrikes))for(const strike of raw.pendingLoopStrikes)if(strike && Object.hasOwn(strike,'liveWeaponDamage'))requireValue(Object.prototype.propertyIsEnumerable.call(strike,'liveWeaponDamage') && strike.liveWeaponDamage===true && raw.lightning?.evolved===true, 'invalid live loop damage');
    if(Object.hasOwn(raw ?? {},'garlicAreas'))requireValue(denseArray(raw.garlicAreas) && raw.garlicAreas.length<=MAX_GARLIC_AREAS && raw.garlicAreas.every(area=>area && typeof area==='object' && !Array.isArray(area) && Reflect.ownKeys(area).length===5 && ['id','bornTick','untilTick','evolved','hitIds'].every(key=>Object.hasOwn(area,key)) && denseArray(area.hitIds)), 'invalid garlic areas array');
    if(Object.hasOwn(raw ?? {},'birdRays'))requireValue(denseArray(raw.birdRays) && raw.birdRays.length<=MAX_BIRD_RAYS && raw.birdRays.every(ray=>denseArray(ray?.hitIds)), 'invalid bird rays array');
    if(Object.hasOwn(raw ?? {},'legacyBirdVolleys'))requireValue(denseArray(raw.legacyBirdVolleys), 'invalid legacy bird volleys array');
    for(const slot of ['peachone','ebonyWings','vandalier'])if(raw?.[slot] && Object.hasOwn(raw[slot],'rayTargets'))requireValue(denseArray(raw[slot].rayTargets), 'invalid bird targets array');
    if (Object.hasOwn(raw ?? {},'bibleShots')) requireValue(denseArray(raw.bibleShots) && raw.bibleShots.every(shot=>denseArray(shot?.hitIds)), 'invalid bible shots array');
    if (Array.isArray(raw?.santaWaterZones)) for(const zone of raw.santaWaterZones)
      if(zone && Object.hasOwn(zone,'hitIds'))requireValue(denseArray(zone.hitIds), 'invalid area hits array');
    requireValue(integer(checkpoint?.maxTicks, 1, MAX_TICKS), 'invalid time limit');
    const next = clone(checkpoint.state);
    requireValue(next && typeof next === 'object', 'missing state');
    // Older 061 checkpoints have no per-kind history. Preserve that unknown
    // prefix rather than treating it as zero recorded skeleton kills.
    if (!Object.hasOwn(next,'killTrackingV1')) {
      requireValue(integer(next.kills), 'invalid kill tracking migration');
      next.killTrackingV1={version:1,fromKills:next.kills,skeleton:0,coverage:'partial'};
    }
    const tracking=next.killTrackingV1;
    requireValue(tracking && typeof tracking==='object' && !Array.isArray(tracking) &&
      Object.keys(tracking).sort().join(',')==='coverage,fromKills,skeleton,version' && tracking.version===1 &&
      integer(next.kills) && integer(tracking.fromKills,0,next.kills) && integer(tracking.skeleton,0,next.kills-tracking.fromKills) &&
      (tracking.coverage==='partial' || tracking.coverage==='complete' && tracking.fromKills===0), 'invalid kill tracking');
    const hadGarlicAreas=Object.hasOwn(next,'garlicAreas'), hadGarlicLegacy=!!next.garlic && Object.hasOwn(next.garlic,'legacyArea');
    if(next.garlic)requireValue(hadGarlicAreas===hadGarlicLegacy,'partial garlic area migration');
    if(!hadGarlicAreas)next.garlicAreas=[];
    if(next.garlic && !hadGarlicLegacy)next.garlic.legacyArea=true;
    const hadBirdRays=Object.hasOwn(next,'birdRays'),hadLegacyVolleys=Object.hasOwn(next,'legacyBirdVolleys');
    requireValue(hadBirdRays===hadLegacyVolleys,'partial bird migration');
    for(const slot of ['peachone','ebonyWings','vandalier'])if(next[slot]){
      const hasTargets=Object.hasOwn(next[slot],'rayTargets'),hasCursor=Object.hasOwn(next[slot],'rayCursor');
      requireValue(hasTargets===hasCursor && hasTargets===hadBirdRays,'partial bird migration');
      if(!hasTargets){next[slot].rayTargets=[];next[slot].rayCursor=0;}
    }
    if(!hadBirdRays){next.birdRays=[];next.legacyBirdVolleys=[...new Set((next.pendingVolleys??[]).filter(shot=>['peachone','ebonyWings','vandalier'].includes(shot.slot)).map(shot=>shot.volleyId))];}
    const hadBibleShots=Object.hasOwn(next,'bibleShots'), hadBibleLegacy=!!next.bible && Object.hasOwn(next.bible,'legacyArea');
    if(next.bible)requireValue(hadBibleShots===hadBibleLegacy, 'partial bible migration');
    if(!hadBibleShots)next.bibleShots=[];
    if(next.bible && !hadBibleLegacy)next.bible.legacyArea=true;
    if (!Object.hasOwn(next, 'soulHearts')) next.soulHearts = [];
    if (next.garlic && ['evolved','recoveredHp','soulBonus'].every(key=>!Object.hasOwn(next.garlic,key))) Object.assign(next.garlic,{evolved:false,recoveredHp:0,soulBonus:0});
    if (!Object.hasOwn(next, 'moonCycle')) next.moonCycle = null;
    if (next.pentagram && !Object.hasOwn(next.pentagram, 'evolved')) next.pentagram.evolved = false;
    if (!Object.hasOwn(next, 'vandalier')) next.vandalier = null;
    if (!Object.hasOwn(next, 'pummarolaLevel')) next.pummarolaLevel = 0;
    if (!Object.hasOwn(next, 'runEquipmentUnlocks')) {
      const inherited = new Set(DEFAULT_EQUIPMENT_UNLOCKS);
      for (const id of Object.keys(EQUIPMENT_UNLOCK_MANIFEST)) if (id.endsWith('Level') ? next[id] > 0 : !!next[id]) inherited.add(id);
      if (Array.isArray(next.pendingUpgrade)) for (const option of next.pendingUpgrade) {
        const field = typeof option?.id === 'string' ? optionEquipmentField(option.id) : null;
        if (field && Object.hasOwn(EQUIPMENT_UNLOCK_MANIFEST, field)) inherited.add(field);
      }
      next.runEquipmentUnlocks = [...inherited].sort();
    }
    requireValue(validateEquipmentUnlocks(next.runEquipmentUnlocks), 'invalid equipment unlocks');
    if (!Object.hasOwn(next, 'achievementEvents')) next.achievementEvents = [];
    if (!Object.hasOwn(next, 'nduja')) next.nduja=null;
    if(!Object.hasOwn(next,'goldFever') && !Object.hasOwn(next,'goldHalfRemainder')) {next.goldFever=null;next.goldHalfRemainder=0;}
    if(next.goldFever && !Object.hasOwn(next.goldFever,'pending'))next.goldFever.pending=null;
    if (!Object.hasOwn(next, 'rerolls') && !Object.hasOwn(next, 'rerollosCollected')) {next.rerolls=0;next.rerollosCollected=0;}
    if (!Object.hasOwn(next, 'cloversCollected')) {
      requireValue(!next.achievementEvents.some(event=>event?.achievementId==='FindAClover'), 'partial clover migration');
      next.cloversCollected=0;
    }
    const legacyKillAchievements = new Set(['Defeat5000Enemies','Defeat3000Skeletons']);
    requireValue(Array.isArray(next.achievementEvents) && next.achievementEvents.length <= Object.keys(ACHIEVEMENT_UNLOCKS).length + legacyKillAchievements.size &&
      new Set(next.achievementEvents.map(event=>event?.achievementId)).size === next.achievementEvents.length &&
      next.achievementEvents.every(event=>event && typeof event==='object' && !Array.isArray(event) &&
        Object.keys(event).length===2 && (Object.hasOwn(ACHIEVEMENT_UNLOCKS,event.achievementId) || legacyKillAchievements.has(event.achievementId)) && integer(event.tick,0,next.tick)), 'invalid achievement events');
    if (!Object.hasOwn(next, 'pendingLoopStrikes')) next.pendingLoopStrikes = [];
    if (next.whip && !Object.hasOwn(next.whip, 'nextHealTick')) next.whip.nextHealTick = 0;
    if (!Object.hasOwn(next, 'carnageExplosions')) next.carnageExplosions = [];
    if (next.runetracer && !Object.hasOwn(next.runetracer, 'evolved') && !Object.hasOwn(next.runetracer, 'nextRetaliationTick')) { next.runetracer.evolved = false; next.runetracer.nextRetaliationTick = 0; }
    if (Array.isArray(next.projectiles)) for (const shot of next.projectiles) if (shot.kind === 'runetracer' && !Object.hasOwn(shot, 'evolved') && !Object.hasOwn(shot, 'nextExplosionTick')) {shot.evolved=false;shot.nextExplosionTick=0;}
    if (next.lightning && !Object.hasOwn(next.lightning, 'evolved')) next.lightning.evolved = false;
    if (next.santaWater && !Object.hasOwn(next.santaWater, 'evolved')) next.santaWater.evolved = false;
    if (!Object.hasOwn(next, 'stageEventVersion')) {
      // Earlier same-engine candidate payloads used a different event table. Do not replay
      // earlier events after restoring; schedule the new future events by tick.
      next.stageEventVersion = 2;
      next.stageEventIndex = FOREST_EVENTS.findIndex(event => event.tick > next.tick);
      if (next.stageEventIndex < 0) next.stageEventIndex = FOREST_EVENTS.length;
    }
    if (!Object.hasOwn(next, 'pendingVolleys') && !Object.hasOwn(next, 'nextVolleyId')) { next.pendingVolleys = []; next.nextVolleyId = 1; }
    if (Array.isArray(next.pendingVolleys)) next.pendingVolleys = next.pendingVolleys.map(shot =>
      shot?.version === 1 && !Object.hasOwn(shot, 'selected') && ['wand','knife','fireWand','axe','cross','runetracer','bone'].includes(shot.slot)
        ? {...shot, version: 2, selected: []} : shot);
    for (const [key, value] of Object.entries(schema)) {
      requireValue(Object.hasOwn(next, key), `missing state field: ${key}`);
      if (value !== null) requireValue(Array.isArray(value) ? Array.isArray(next[key]) : typeof next[key] === typeof value, `invalid state field: ${key}`);
    }
    requireValue(Object.keys(next).every(key => Object.hasOwn(schema, key)), 'unknown state field');
    requireValue(integer(next.rng, 1, 0xffffffff) && integer(next.seed, 0, 0xffffffff), 'missing or invalid RNG');
    requireValue(integer(next.tick, 0, checkpoint.maxTicks) && integer(next.nextId, 1), 'invalid clock or entity ID');
    requireValue(CHARACTERS.includes(next.character) && next.player?.character === next.character, 'invalid character');
    requireValue(Object.keys(next.player).every(key => Object.hasOwn(schema.player,key)), 'unknown player field');
    for (const [key, value] of Object.entries(schema.player)) requireValue(typeof next.player[key] === typeof value, `invalid player: ${key}`);
    requireValue(integer(next.player.level, 1) && next.player.maxHp > 0 && next.player.hp >= 0 && next.player.hp <= next.player.maxHp && next.player.xp >= 0 && typeof next.player.xpToNext === 'number' && Number.isFinite(next.player.xpToNext) && next.player.xpToNext > 0 && next.player.speed >= 0 && next.player.magnet > 0, 'invalid player stats');
    requireValue(integer(next.gold) && integer(next.kills) && integer(next.chestsOpened), 'invalid counters');
    for (const key of ['bossKills','chestsOpened','pickupsCollected','roastsCollected','vacuumsCollected','cloversCollected','rerollosCollected','breakablesBroken','rosariesCollected','rosaryKills','orologionsCollected','orologionFreezes','stageEventsTriggered']) requireValue(integer(next[key]), 'invalid counter: '+key);
    requireValue(integer(next.rerolls,0,MAX_REROLLS) && next.rerollosCollected<=next.pickupsCollected && next.rerolls<=next.rerollosCollected,'invalid reroll count');
    requireValue(integer(next.goldHalfRemainder,0,1) && (next.goldHalfRemainder===0 || next.goldFever!==null),'invalid gold remainder');
    if(next.goldFever!==null){const fever=next.goldFever;requireValue(fever && typeof fever==='object' && !Array.isArray(fever) &&
      Object.keys(fever).sort().join(',')==='active,elapsedUnits,pending,totalHalf' && typeof fever.active==='boolean' &&
      integer(fever.elapsedUnits,0,599_999) && (fever.active || fever.elapsedUnits===0) && integer(fever.totalHalf,0,20_000_001) &&
      (fever.pending===null || fever.pending && typeof fever.pending==='object' && !Array.isArray(fever.pending) &&
        Object.keys(fever.pending).sort().join(',')==='halfUnits,x,y' && integer(fever.pending.halfUnits,1,20_000_001) &&
        [fever.pending.x,fever.pending.y].every(value=>typeof value==='number' && Number.isFinite(value) && Math.abs(value)<=1_000_000)),'invalid gold fever');}
    requireValue(next.cloversCollected<=next.pickupsCollected &&
      (!next.achievementEvents.some(event=>event.achievementId==='FindAClover') || next.cloversCollected>0), 'invalid clover count');
    if(next.nduja!==null)validateNdujaScheduler(next.nduja,next.tick);
    requireValue(next.done ? ['death', 'reaper', 'time-limit'].includes(next.reason) : next.reason === null, 'invalid terminal state');
    for (const field of PASSIVE_FIELDS) requireValue(integer(next[field], 0, PASSIVE_METADATA[field].maxLevel), 'invalid passive');
    for (const field of WEAPON_FIELDS) {
      const weapon = next[field];
      if (weapon === null) continue;
      requireValue(weapon && typeof weapon === 'object' && integer(weapon.level, 1, WEAPON_METADATA[field].maxLevel), 'invalid weapon');
      requireValue(Object.keys(weapon).every(key => (Object.hasOwn(weaponSchemas[field],key) || field === 'pentagram' && key === 'lastPreserved' && typeof weapon[key] === 'boolean')), `unknown weapon field: ${field}.${Object.keys(weapon).filter(key=>!Object.hasOwn(weaponSchemas[field],key)).join(',')}`);
      for (const [key, value] of Object.entries(weaponSchemas[field])) requireValue(typeof weapon[key] === typeof value, `invalid weapon field: ${field}.${key}`);
    }
    requireValue(WEAPON_FIELDS.filter(field => next[field]).length <= MAX_WEAPON_SLOTS && PASSIVE_FIELDS.filter(field => next[field] > 0).length <= MAX_PASSIVE_SLOTS, 'full slots');
    const dependencies = {whip: 'hollowHeartLevel', wand: 'emptyTomeLevel', knife: 'bracerLevel', fireWand: 'spinachLevel', lightning: 'duplicatorLevel', santaWater: 'attractorLevel', runetracer: 'armorLevel', axe: 'candelabradorLevel', bible: 'spellbinderLevel', cross: 'cloverLevel', pentagram: 'crownLevel', garlic: 'pummarolaLevel'};
    for (const [field, passive] of Object.entries(dependencies)) if (next[field]?.evolved) requireValue(next[field].level === 8 && next[passive] > 0, 'missing evolution dependency');
    if (next.garlic) {
      const garlic = next.garlic;
      requireValue(Number.isFinite(garlic.recoveredHp) && garlic.recoveredHp >= 0 && garlic.recoveredHp <= MAX_SOUL_RECOVERED &&
        Number.isFinite(garlic.soulBonus) && garlic.soulBonus >= 0 && garlic.soulBonus <= soulBonusFor(garlic.recoveredHp) &&
        (garlic.evolved || garlic.recoveredHp === 0 && garlic.soulBonus === 0) &&
        (!garlic.evolved || garlic.damage === 20 && garlic.radius === 5.7 && garlic.pulseTicks === 60), 'invalid soul eater');
    }
    if (next.pentagram?.evolved) requireValue(next.pentagram.cooldownTicks === 3600, 'invalid moon cooldown');
    if (next.moonCycle !== null) {
      const cycle = next.moonCycle;
      requireValue(cycle && typeof cycle === 'object' && !Array.isArray(cycle) &&
        Object.keys(cycle).length === 2 && Object.hasOwn(cycle, 'startTick') && Object.hasOwn(cycle, 'nextEventIndex') &&
        integer(cycle.startTick, 0, next.tick) && integer(cycle.nextEventIndex, 0, MOON_EVENT_OFFSETS.length - 1) &&
        next.pentagram?.evolved && next.pentagram.nextTick >= cycle.startTick + 900 &&
        cycle.startTick + MOON_EVENT_OFFSETS[cycle.nextEventIndex] > next.tick &&
        (cycle.nextEventIndex === 0 || cycle.startTick + MOON_EVENT_OFFSETS[cycle.nextEventIndex - 1] <= next.tick), 'invalid moon cycle');
    }
    const ids = new Set();
    const collections = {soulHearts: ['speed'], enemies: ['hp','maxHp','baseHp','spawnLevel','xp','speed','radius','damage','knockback','frozenUntil','hitUntil','recoilUntil','recoilX','recoilY','recoilSpeed'], gems: ['value'], chests: ['tier'], breakables: ['hp','radius'], pickups: [], projectiles: ['vx','vy','damage','ttl'], lightningStrikes: ['radius','until'], santaWaterZones: ['radius','damage','until','nextPulseTick'], carnageExplosions: ['radius','damage','tick','until'], whipStrikes: ['tick','until','index','direction','area','damage']};
    for (const [collection, fields] of Object.entries(collections)) for (const entity of next[collection]) {
      requireValue(integer(entity?.id, 1, next.nextId - 1) && !ids.has(entity.id), 'invalid or duplicate entity ID'); ids.add(entity.id);
      for (const key of ['x','y',...fields]) requireValue(typeof entity[key] === 'number', `invalid ${collection}.${key}`);
      if (['projectiles','whipStrikes','carnageExplosions'].includes(collection)) requireValue(Array.isArray(entity.hitIds) && entity.hitIds.every(id => integer(id, 1, next.nextId - 1)), 'invalid hit IDs');
    }
    let totalAreaHits=0;
    const validAreaHits = hits => denseArray(hits) && hits.length<=MAX_AREA_HITS &&
      hits.every(id=>integer(id,1,next.nextId-1)) && new Set(hits).size===hits.length;
    requireValue(denseArray(next.garlicAreas) && next.garlicAreas.length<=MAX_GARLIC_AREAS &&
      (!next.garlicAreas.length || next.garlic && !next.garlic.legacyArea), 'invalid garlic areas');
    let previousGarlicId=0;
    for(const area of next.garlicAreas){
      requireValue(area && typeof area==='object' && !Array.isArray(area) &&
        Object.keys(area).sort().join(',')==='bornTick,evolved,hitIds,id,untilTick' &&
        integer(area.id,previousGarlicId+1,next.nextId-1) && !ids.has(area.id) &&
        integer(area.bornTick,0,next.tick) && integer(area.untilTick,next.tick+1) &&
        integer(area.untilTick-area.bornTick,1,1248) && typeof area.evolved==='boolean' && area.evolved===next.garlic.evolved &&
        validAreaHits(area.hitIds), 'invalid garlic area');
      previousGarlicId=area.id;ids.add(area.id);totalAreaHits+=area.hitIds.length;
    }
    const groups=new Map();
    requireValue(denseArray(next.bibleShots) && next.bibleShots.length<=MAX_BIBLE_SHOTS &&
      (!next.bibleShots.length || next.bible && !next.bible.legacyArea), 'invalid bible shots');
    for(const shot of next.bibleShots){
      requireValue(shot && typeof shot==='object' && !Array.isArray(shot) &&
        Object.keys(shot).sort().join(',')==='bornTick,evolved,hitIds,id,index,nextResetTick,total,until' &&
        integer(shot.id,1,next.nextId-1) && !ids.has(shot.id) && integer(shot.total,1,26) && integer(shot.index,0,shot.total-1) &&
        integer(shot.bornTick,0,next.tick) && integer(shot.until,next.tick+1,shot.bornTick+MAX_TICKS*2) &&
        integer(shot.nextResetTick,next.tick+1,next.tick+102) && (shot.nextResetTick-shot.bornTick)%102===0 &&
        typeof shot.evolved==='boolean' && shot.evolved===next.bible.evolved && validAreaHits(shot.hitIds), 'invalid bible shot');
      ids.add(shot.id);totalAreaHits+=shot.hitIds.length;
      const group=groups.get(shot.bornTick)??{total:shot.total,until:shot.until,evolved:shot.evolved,indices:new Set()};
      requireValue(group.total===shot.total && group.until===shot.until && group.evolved===shot.evolved && !group.indices.has(shot.index), 'invalid bible shot group');
      group.indices.add(shot.index);groups.set(shot.bornTick,group);
    }
    for(const group of groups.values())requireValue(group.indices.size===group.total, 'incomplete bible shot group');
    requireValue(denseArray(next.legacyBirdVolleys) && next.legacyBirdVolleys.length<=MAX_PENDING_VOLLEYS &&
      new Set(next.legacyBirdVolleys).size===next.legacyBirdVolleys.length && next.legacyBirdVolleys.every(id=>integer(id,1,next.nextVolleyId-1) &&
        next.pendingVolleys.some(shot=>shot.volleyId===id && ['peachone','ebonyWings','vandalier'].includes(shot.slot))), 'invalid legacy bird volleys');
    for(const slot of ['peachone','ebonyWings','vandalier'])if(next[slot]){
      const bird=next[slot],count=slot==='vandalier'?24:12;
      requireValue(denseArray(bird.rayTargets) && (bird.rayTargets.length===0 || bird.rayTargets.length===count) &&
        integer(bird.rayCursor,0,bird.rayTargets.length?count-1:0) && bird.rayTargets.every(point=>point && typeof point==='object' && !Array.isArray(point) &&
          Object.keys(point).sort().join(',')==='x,y' && [point.x,point.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1_000_000)), 'invalid bird target set');
      if(!bird.rayTargets.length)requireValue(!next.birdRays.some(ray=>ray?.slot===slot) &&
        !next.pendingVolleys.some(shot=>shot.slot===slot && !next.legacyBirdVolleys.includes(shot.volleyId)), 'missing bird targets');
    }
    requireValue(denseArray(next.birdRays) && next.birdRays.length<=MAX_BIRD_RAYS,'invalid bird rays');
    for(const ray of next.birdRays){
      requireValue(ray && typeof ray==='object' && !Array.isArray(ray) && Object.keys(ray).sort().join(',')==='bornTick,controlX,controlY,hitIds,id,impactTick,radius,slot,startX,startY,targetX,targetY,untilTick,volleyId' &&
        ['peachone','ebonyWings','vandalier'].includes(ray.slot) && next[ray.slot] && next[ray.slot].rayTargets.length===(ray.slot==='vandalier'?24:12) &&
        integer(ray.id,1,next.nextId-1) && !ids.has(ray.id) && integer(ray.volleyId,1,next.nextVolleyId-1) && !next.legacyBirdVolleys.includes(ray.volleyId) &&
        next.pendingVolleys.filter(shot=>shot.volleyId===ray.volleyId).every(shot=>shot.slot===ray.slot) &&
        integer(ray.bornTick,0,next.tick) && Number.isSafeInteger(ray.bornTick+(ray.slot==='vandalier'?24:30)+12) &&
        ray.impactTick===ray.bornTick+(ray.slot==='vandalier'?24:30) && ray.untilTick===ray.impactTick+12 && integer(ray.untilTick,next.tick+1) &&
        [ray.startX,ray.startY,ray.controlX,ray.controlY,ray.targetX,ray.targetY].every(v=>Number.isFinite(v)&&Math.abs(v)<=1_000_000) &&
        Number.isFinite(ray.radius) && ray.radius>0 && ray.radius<=512 && validAreaHits(ray.hitIds) && (next.tick>=ray.impactTick || ray.hitIds.length===0), 'invalid bird ray');
      ids.add(ray.id);totalAreaHits+=ray.hitIds.length;
    }
    requireValue(next.soulHearts.length <= MAX_SOUL_HEARTS && (!next.soulHearts.length || next.garlic?.evolved) &&
      next.soulHearts.every(heart=>Object.keys(heart).length===4 && ['id','x','y','speed'].every(key=>Object.hasOwn(heart,key)) &&
        [heart.x,heart.y].every(n=>Number.isFinite(n) && Math.abs(n)<=1_000_000) && integer(heart.speed,250,65537)), 'invalid soul hearts');
    validateGemCapacity(next.gems,next.player.gemsCollected);
    for(const gem of next.gems) if(gem.attraction!=null){
      const a=gem.attraction;
      requireValue(a && typeof a==='object' && !Array.isArray(a) &&
        Object.keys(a).length===3 && ['startTick','startX','startY'].every(key=>Object.hasOwn(a,key)) &&
        integer(a.startTick,0,next.tick) && [a.startX,a.startY].every(value=>typeof value==='number' && Number.isFinite(value) && Math.abs(value)<=1_000_000), 'invalid gem attraction');
    }
    for (const zone of next.santaWaterZones) {
      const zoneKeys=['id','x','y','radius','damage','until','nextPulseTick',...(zone.mode==='bora'?['mode','bornTick','initialRadius','targetRadius']:[]),...(Object.hasOwn(zone,'hitIds')?['hitIds']:[]),...(Object.hasOwn(zone,'dynamicDamage')?['dynamicDamage']:[])];
      requireValue(Object.keys(zone).length===zoneKeys.length && zoneKeys.every(key=>Object.hasOwn(zone,key)), 'invalid water zone fields');
      if(Object.hasOwn(zone,'dynamicDamage'))requireValue(zone.dynamicDamage === true && Object.hasOwn(zone,'hitIds'), 'invalid water damage mode');
      if(Object.hasOwn(zone,'hitIds')) {
        requireValue(validAreaHits(zone.hitIds) && integer(zone.nextPulseTick,next.tick+1,next.tick+30) && integer(zone.until,next.tick+1,next.tick+MAX_TICKS*2) && zone.radius>0 && zone.radius<=512 && zone.damage>=0 && zone.damage<=1_000_000, 'invalid water hit history');
        totalAreaHits+=zone.hitIds.length;
      }
      requireValue(zone.mode === undefined || zone.mode === 'bora', 'invalid water mode');
      if (zone.mode === 'bora') requireValue(next.santaWater?.evolved && integer(zone.bornTick, 0, next.tick) &&
        integer(zone.until, next.tick+1, zone.bornTick+MAX_TICKS) && [zone.initialRadius,zone.targetRadius].every(v=>Number.isFinite(v)&&v>0&&v<=512), 'invalid bora zone');
      else requireValue(zone.bornTick === undefined && zone.initialRadius === undefined && zone.targetRadius === undefined, 'invalid water provenance');
    }
    requireValue(totalAreaHits<=MAX_TOTAL_AREA_HITS, 'area hit history capacity');
    for (const enemy of next.enemies) {
      enemyStats(enemy.kind, next.player.level); // rejects unknown enemy dependencies
      enemyStatusProfile(enemy.kind);
      requireValue(typeof enemy.sprite === 'string' && typeof enemy.levelScaled === 'boolean' && enemy.hp > 0 && enemy.maxHp >= enemy.hp && typeof enemy.boss === 'boolean' && integer(enemy.treasureTier, 0, 3), 'invalid enemy');
    }
    for (const enemy of next.enemies) if (enemy.spawnMinute !== undefined)
      requireValue(enemy.boss && integer(enemy.spawnMinute, 0, Math.min(30, Math.floor(next.tick / 3600))) && FOREST_BOSSES[enemy.spawnMinute]?.kind === enemy.kind, 'invalid enemy spawn minute');
    for (const enemy of next.enemies) if (enemy.eventType !== undefined) {
      requireValue(typeof enemy.eventType === 'string' && integer(enemy.expiresTick) && typeof enemy.fixedDirection === 'boolean' && [enemy.directionX,enemy.directionY].every(value=>value===null || typeof value==='number'), 'invalid event enemy');
    }
    for (const strike of next.whipStrikes) {
      requireValue(typeof strike.evolved === 'boolean', 'invalid whip strike');
      if(Object.hasOwn(strike,'liveWeaponDamage'))requireValue(strike.liveWeaponDamage===true && !!next.whip && strike.evolved===!!next.whip.evolved, 'invalid live whip damage');
    }
    for (const chest of next.chests) {
      requireValue(integer(chest.tier, 1, 3) && (chest.boss===undefined || typeof chest.boss==='boolean'), 'invalid chest tier or origin');
      claimChest(chest,{wave:Math.floor(next.tick/3600),boss:chest.boss===true,legacyTick:next.tick});
    }
    for (const item of next.pickups) {
      requireValue(['coin','coin-bag','big-coin-bag','roast','vacuum','rosary','orologion','little-clover','nduja','rerollo','gilded-clover','fever-coin'].includes(item.kind), 'unknown pickup');
      if(Object.hasOwn(item,'halfUnits'))requireValue(item.kind==='fever-coin' && integer(item.halfUnits,1,20_000_001),'invalid fever coin units');
      if(Object.hasOwn(item,'feverTicks'))requireValue(item.kind==='fever-coin' && integer(item.feverTicks,1,600_000_030) && item.feverTicks<=30*(item.halfUnits??1),'invalid fever coin duration');
      if(Object.hasOwn(item,'attraction')){const a=item.attraction;requireValue(['coin','coin-bag','big-coin-bag','fever-coin'].includes(item.kind) &&
        a && typeof a==='object' && !Array.isArray(a) && Object.keys(a).sort().join(',')==='startTick,startX,startY' &&
        integer(a.startTick,0,next.tick) && [a.startX,a.startY].every(value=>typeof value==='number' && Number.isFinite(value) && Math.abs(value)<=1_000_000),'invalid gold attraction');}
    }
    const projectileWeapons = {wand:'wand',knife:'knife',fireball:'fireWand',axe:'axe','death-spiral':'axe',cross:'cross','heaven-sword':'cross',bone:'bone',runetracer:'runetracer',nduja:'nduja'};
    for (const shot of next.projectiles) requireValue(next[projectileWeapons[shot.kind]], 'missing projectile dependency');
    requireValue(!next.whipStrikes.length && !next.pendingWhips.length || next.whip, 'missing whip dependency');
    requireValue(!next.santaWaterZones.length || next.santaWater, 'missing water dependency');
    requireValue(!next.carnageExplosions.length || next.runetracer?.evolved, 'missing carnage dependency');
    for (const blast of next.carnageExplosions) requireValue(integer(blast.tick,0,next.tick) && integer(blast.until,next.tick+1,blast.tick+8) && blast.radius>0 && blast.radius<=512 && blast.damage>=0 && blast.damage<=1_000_000 && new Set(blast.hitIds).size===blast.hitIds.length, 'invalid carnage explosion');
    for (const shot of next.projectiles) if(Object.hasOwn(shot,'boneBounceReadyTick')) requireValue(shot.kind==='bone' && integer(shot.boneBounceReadyTick,0,next.tick+2), 'invalid bone bounce clock');
    for (const shot of next.projectiles) if (shot.kind==='runetracer') requireValue(typeof shot.evolved==='boolean' && integer(shot.nextExplosionTick,0,next.tick+12) && (shot.evolved ? next.runetracer.evolved : shot.nextExplosionTick===0), 'invalid runetracer projectile');
    for (const shot of next.pendingWhips) requireValue(integer(shot.tick) && integer(shot.index, 0, 25), 'invalid pending whip');
    requireValue(integer(next.nextVolleyId, 1, 10_000_000) && next.pendingVolleys.length <= MAX_PENDING_VOLLEYS, 'invalid volley queue');
    requireValue(Array.isArray(next.pendingLoopStrikes) && next.pendingLoopStrikes.length <= 256 &&
      (!next.pendingLoopStrikes.length || next.lightning?.evolved), 'invalid loop strike dependency');
    for (const strike of next.pendingLoopStrikes) requireValue(strike && Object.keys(strike).sort().join(',') === (Object.hasOwn(strike,'liveWeaponDamage')?'damage,dueTick,liveWeaponDamage,radius,x,y':'damage,dueTick,radius,x,y') &&
      (!Object.hasOwn(strike,'liveWeaponDamage') || strike.liveWeaponDamage===true && next.lightning?.evolved===true) &&
      integer(strike.dueTick, next.tick + 1, next.tick + 16) && [strike.x,strike.y,strike.radius,strike.damage].every(Number.isFinite) &&
      Math.abs(strike.x) <= 1_000_000 && Math.abs(strike.y) <= 1_000_000 && strike.radius > 0 && strike.radius <= 512 && strike.damage >= 0 && strike.damage <= 1_000_000, 'invalid loop strike');
    requireValue(next.pendingLoopStrikes.every((strike,i,a)=>i===0 || a[i-1].dueTick <= strike.dueTick), 'unordered loop strikes');
    const volleyKeys = new Set(), volleyInfo = new Map();
    for (const shot of next.pendingVolleys) {
      requireValue(shot && Object.keys(shot).sort().join(',') === 'angle,dueTick,evolved,index,selected,slot,source,total,version,volleyId' &&
        shot.source === ENGINE_ID && shot.version === 2 && VOLLEY_SLOTS.includes(shot.slot) && next[shot.slot] &&
        shot.evolved === !!next[shot.slot].evolved && integer(shot.volleyId, 1, next.nextVolleyId - 1) &&
        integer(shot.total, 2, shot.slot === 'vandalier' ? 30 : 26) && integer(shot.index, 1, shot.total - 1) &&
        integer(shot.dueTick, next.tick + 1, next.tick + 12000) &&
        (shot.slot === 'runetracer' ? typeof shot.angle === 'number' && Number.isFinite(shot.angle) :
          shot.slot === 'fireWand' ? shot.angle === null || typeof shot.angle === 'number' && Number.isFinite(shot.angle) : shot.angle === null) &&
        Array.isArray(shot.selected) && shot.selected.length <= shot.index &&
        new Set(shot.selected).size === shot.selected.length && shot.selected.every(id => integer(id, 1, next.nextId - 1)) &&
        (['lightning','santaWater'].includes(shot.slot) || shot.slot === 'fireWand' ?
          shot.slot !== 'fireWand' || (shot.angle === null ? shot.selected.length === 0 : shot.selected.length === 1) : shot.selected.length === 0), 'invalid pending volley');
      const key = `${shot.volleyId}:${shot.index}`, info = `${shot.slot}:${shot.total}:${shot.evolved}:${shot.angle}:${JSON.stringify(shot.selected)}`;
      requireValue(!volleyKeys.has(key) && (!volleyInfo.has(shot.volleyId) || volleyInfo.get(shot.volleyId) === info), 'conflicting pending volley');
      volleyKeys.add(key); volleyInfo.set(shot.volleyId, info);
    }
    for (const death of next.recentEnemyDeaths) requireValue(integer(death.id, 1, next.nextId - 1) && integer(death.tick, 0, next.tick), 'invalid death');
    requireValue(next.stageEventVersion === 2 && integer(next.stageEventIndex, 0, FOREST_EVENTS.length) && integer(next.waveMinute, 0, 31), 'invalid stage');
    if (next.lastStageEvent !== null) requireValue(typeof next.lastStageEvent?.type === 'string' && integer(next.lastStageEvent.tick, 0, next.tick), 'invalid event');
    for (const shot of next.projectiles) {
      if(Object.hasOwn(shot,'liveWeaponDamage')) {
        const slot=LIVE_DAMAGE_SLOTS[shot.kind];
        requireValue(shot.liveWeaponDamage===true && Object.hasOwn(LIVE_DAMAGE_SLOTS,shot.kind) && !!next[slot] &&
          (shot.kind!=='axe' || !next.axe.evolved) && (shot.kind!=='death-spiral' || next.axe.evolved) &&
          (shot.kind!=='cross' || !next.cross.evolved) && (shot.kind!=='heaven-sword' || next.cross.evolved) &&
          (shot.kind!=='fireball' || shot.evolved===!!next.fireWand.evolved) &&
          (shot.kind!=='runetracer' || shot.evolved===!!next.runetracer.evolved), 'invalid live projectile damage');
      }
      if (shot.kind !== 'runetracer') requireValue(integer(shot.remainingHits, 1), 'invalid projectile hits');
      if (['cross','heaven-sword'].includes(shot.kind)) {
        const initial=shot.kind==='heaven-sword'?2:1.5+0.1*shot.shotIndex;
        requireValue(shot.trajectoryModel==='source-linear-v1' && integer(shot.bornTick,0,next.tick) && integer(shot.shotIndex,0,25) &&
          Number.isFinite(shot.launchVx) && Number.isFinite(shot.launchVy) &&
          Math.max(Math.abs(shot.launchVx),Math.abs(shot.launchVy))*Math.max(initial,2)<=1000 &&
          shot.turnTick===shot.bornTick+(shot.kind==='heaven-sword'?30:Math.ceil(60*initial/(initial+2))) &&
          shot.phase===(next.tick>=shot.turnTick?'return':'out'), 'invalid cross trajectory');
      } else requireValue(!['trajectoryModel','bornTick','launchVx','launchVy','shotIndex'].some(key=>Object.hasOwn(shot,key)), 'unexpected cross trajectory');
      if (shot.kind === 'fireball') requireValue(typeof shot.evolved === 'boolean', 'invalid fireball');
    }
    for(const blast of next.carnageExplosions)if(Object.hasOwn(blast,'liveWeaponDamage'))
      requireValue(blast.liveWeaponDamage===true && next.runetracer?.evolved===true, 'invalid live carnage damage');
    const progress = next.progression;
    requireValue(progress && Array.isArray(progress.receipts) && Array.isArray(progress.encounters) && integer(progress.shopRevision), 'invalid progression');
    const receiptIds = new Set();
    for (const receipt of progress.receipts) {
      requireValue(typeof receipt.id === 'string' && !receiptIds.has(receipt.id) && ['upgrade','treasure','purchase'].includes(receipt.kind) && integer(receipt.tick, 0, next.tick) && Number.isSafeInteger(receipt.gold) && Array.isArray(receipt.rewards) && receipt.rewards.every(id => rewardIds.has(id)), 'invalid or duplicate receipt');
      if (receipt.kind === 'treasure') {
        requireValue(/^chest:[0-9]+$/.test(receipt.id) && receipt.gold >= 0 && integer(receipt.tier,1,3) && receipt.rewards.length === [0,1,3,5][receipt.tier], 'invalid treasure ledger');
        const linked = receipt.origin === 'boss-encounter';
        const legacy = receipt.origin === 'legacy-unmarked-drop-rule';
        requireValue(receipt.origin === undefined || linked || legacy, 'invalid treasure origin');
        requireValue(linked === Object.hasOwn(receipt,'sourceEncounterId') &&
          linked === Object.hasOwn(receipt,'dropTick'), 'incomplete treasure origin');
        if (linked) requireValue(integer(receipt.sourceEncounterId,1,next.nextId-1) &&
          integer(receipt.dropTick,0,receipt.tick), 'invalid treasure origin');
        if (legacy) requireValue((receipt.tier===2 && receipt.tick>=3*3600) ||
          (receipt.tier===3 && receipt.tick>=5*3600), 'invalid legacy treasure age');
      }
      else requireValue(receipt.rewards.length === 1 && receipt.gold === (receipt.kind === 'purchase' ? -50 : 0), 'invalid receipt value');
      receiptIds.add(receipt.id);
    }
    requireValue(progress.receipts.filter(row=>row.kind==='treasure').length === next.chestsOpened, 'treasure ledger mismatch');
    const unions = progress.receipts.filter(row => row.kind === 'treasure' && row.rewards.includes('evolve-vandalier'));
    requireValue(next.vandalier ? unions.length === 1 && next.vandalier.evolved === true && next.vandalier.amount === 20 : unions.length === 0, 'invalid vandalier union origin');
    const linkedChestIds = new Set();
    for (const encounter of progress.encounters) {
      requireValue(integer(encounter.id, 1, next.nextId - 1) && encounter.outcome === 'defeated' && typeof encounter.kind === 'string' && integer(encounter.tick, 0, next.tick), 'invalid encounter receipt');
      if (encounter.sourceMinute !== undefined) requireValue(integer(encounter.sourceMinute, 0, Math.min(30, Math.floor(encounter.tick / 3600))) &&
        FOREST_BOSSES[encounter.sourceMinute]?.kind === encounter.kind, 'invalid encounter source minute');
      const linked = Object.hasOwn(encounter,'chestId');
      requireValue(linked === Object.hasOwn(encounter,'chestTier'), 'incomplete encounter drop');
      if (!linked) {
        requireValue(!Object.hasOwn(encounter,'chestErasedTick'), 'orphan chest erasure');
        continue;
      }
      requireValue(encounter.kind !== 'reaper' && integer(encounter.chestId,1,next.nextId-1) &&
        integer(encounter.chestTier,1,3) && !linkedChestIds.has(encounter.chestId), 'invalid encounter drop');
      linkedChestIds.add(encounter.chestId);
      const worldChest = next.chests.find(chest => chest.id === encounter.chestId);
      const claimed = progress.receipts.find(receipt => receipt.id === `chest:${encounter.chestId}`);
      const erased = Object.hasOwn(encounter,'chestErasedTick');
      requireValue(Number(Boolean(worldChest)) + Number(Boolean(claimed)) + Number(erased) === 1,
        'missing or duplicate encounter chest');
      if (erased) requireValue(integer(encounter.chestErasedTick,encounter.tick,next.tick) &&
        next.pentagram?.casts > 0 && next.pentagram.erasedItems > 0 &&
        encounter.chestErasedTick <= next.pentagram.lastCastTick, 'invalid chest erasure');
      if (worldChest) linkedChestSource(worldChest, progress.encounters, next.tick);
      else if (claimed) requireValue(claimed.kind === 'treasure' && claimed.origin === 'boss-encounter' &&
        claimed.sourceEncounterId === encounter.id && claimed.dropTick === encounter.tick &&
        claimed.tier === encounter.chestTier && claimed.sourceMinute === encounter.sourceMinute, 'encounter treasure mismatch');
    }
    requireValue(progress.encounters.filter(row => Object.hasOwn(row,'chestErasedTick')).length <=
      (next.pentagram?.erasedItems ?? 0), 'chest erasure count mismatch');
    for (const chest of next.chests) if (Object.hasOwn(chest,'sourceEncounterId') ||
      Object.hasOwn(chest,'dropTick')) linkedChestSource(chest, progress.encounters, next.tick);
    for (const receipt of progress.receipts) if (receipt.origin === 'boss-encounter') {
      const encounter = progress.encounters.find(row => row.id === receipt.sourceEncounterId);
      requireValue(encounter?.chestId === Number(receipt.id.slice(6)) &&
        encounter?.tick === receipt.dropTick && encounter?.chestTier === receipt.tier && encounter?.sourceMinute === receipt.sourceMinute,
      'orphan treasure origin');
    }
    if (next.lastTreasure !== null) requireValue(integer(next.lastTreasure.id, 1, next.chestsOpened) && integer(next.lastTreasure.tick, 0, next.tick) && integer(next.lastTreasure.tier, 1, 3) && integer(next.lastTreasure.gold) && Array.isArray(next.lastTreasure.rewards) && next.lastTreasure.rewards.length === [0,1,3,5][next.lastTreasure.tier] && next.lastTreasure.rewards.every(item => typeof item.id === 'string' && typeof item.label === 'string'), 'invalid treasure receipt');
    if (next.lastTreasure) {
      const receipt = progress.receipts.filter(row=>row.kind==='treasure').at(-1);
      requireValue(receipt && receipt.gold === next.lastTreasure.gold && receipt.tick === next.lastTreasure.tick && JSON.stringify(receipt.rewards) === JSON.stringify(next.lastTreasure.rewards.map(row=>row.id)) &&
        (receipt.origin === next.lastTreasure.origin || receipt.origin === undefined &&
          next.lastTreasure.origin === 'legacy-unmarked-drop-rule') &&
        receipt.sourceEncounterId === next.lastTreasure.sourceEncounterId &&
        receipt.dropTick === next.lastTreasure.dropTick && receipt.sourceMinute === next.lastTreasure.sourceMinute, 'treasure receipt mismatch');
    } else requireValue(next.chestsOpened === 0, 'missing treasure receipt');
    validateStateBounds(next,WEAPON_FIELDS,checkpoint.maxTicks);
    // Eligibility depends on restored inventory; use it temporarily without exposing
    // it to callers. Any failed validation restores the original reference.
    const before = state;
    try {
      state = next;
      const eligible = upgradeChoices(true);
      if (next.pendingUpgrade !== null) requireValue(next.pendingUpgradeKind === 'level' && Array.isArray(next.pendingUpgrade) && next.pendingUpgrade.length > 0 && next.pendingUpgrade.length <= 4 && new Set(next.pendingUpgrade.map(item=>item.id)).size===next.pendingUpgrade.length && next.pendingUpgrade.every(item => typeof item.label === 'string' && (eligible.some(option => option.id === item.id) || !eligible.length && ['bonus-coin','bonus-heal'].includes(item.id))), 'invalid pending upgrade');
      else requireValue(next.pendingUpgradeKind === null, 'invalid pending kind');
      if (progress.shop !== null) requireValue(integer(progress.shop?.revision, 1, progress.shopRevision) && Array.isArray(progress.shop.offers) && progress.shop.offers.length <= 3 && new Set(progress.shop.offers.map(item=>item.id)).size===progress.shop.offers.length && progress.shop.offers.every(item => item.cost === 50 && typeof item.label === 'string' && rewardIds.has(item.id)), 'invalid shop');
    } finally { state = before; }
    state = next; compactedGems=next.gems.some(gem=>gem.units!==undefined || gem.rawValue!==undefined);pendingGemDrops=[];maxTicks = checkpoint.maxTicks; seed = next.seed; character = next.character;
    return snapshot();
  }

  reset(seed);
  schema = clone(state);
  const initial = state;
  state = clone(state);
  for (let index = 0; index < NEW_WEAPONS.length; index++) {
    applyReward(NEW_WEAPONS[index].id);
    weaponSchemas[WEAPON_FIELDS[index]] = clone(state[WEAPON_FIELDS[index]]);
  }
  weaponSchemas.vandalier = initialVandalier(0);
  // Receipt validation covers every known reward, including equipment unlocked
  // after a profile snapshot. Eligibility remains checked at award time.
  state.runEquipmentUnlocks = Object.keys(EQUIPMENT_UNLOCK_MANIFEST);
  rewardIds = new Set([...NEW_WEAPONS, ...upgradeChoices(true)].map(row=>row.id).concat(['bonus-coin','bonus-heal','evolve-whip','evolve-wand','evolve-knife','evolve-fire-wand','evolve-axe','evolve-bible','evolve-cross','evolve-lightning','evolve-santa-water','evolve-runetracer','evolve-vandalier','vandalier-level','evolve-pentagram','evolve-garlic']));
  state = initial;
  return Object.freeze({reset, step, snapshot, observe, exportState, restoreState, shopAction, progression: () => clone(state.progression)});
}
