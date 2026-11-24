// Canonical 059 base-equipment IDs and installed-build default state.
const rows = [["armorLevel",true],["attractorLevel",false],["axe",true],["bible",true],["bone",false],["bracerLevel",false],["candelabradorLevel",false],["clockLancet",false],["cloverLevel",false],["cross",false],["crownLevel",false],["duplicatorLevel",false],["ebonyWings",false],["emptyTomeLevel",false],["fireWand",false],["garlic",false],["hollowHeartLevel",false],["knife",true],["laurel",true],["lightning",false],["peachone",false],["pentagram",false],["pummarolaLevel",false],["runetracer",false],["santaWater",true],["spellbinderLevel",false],["spinachLevel",true],["wand",true],["whip",true],["wingsLevel",false]];
export const EQUIPMENT_UNLOCK_MANIFEST = Object.freeze(Object.fromEntries(rows.map(([id,defaultUnlocked])=>[id,Object.freeze({id,defaultUnlocked})])));
export const DEFAULT_EQUIPMENT_UNLOCKS = Object.freeze(rows.filter(([,value])=>value).map(([id])=>id));
export function validateEquipmentUnlocks(value) {
  return Array.isArray(value) && value.every((id,index)=>typeof id==='string' && Object.hasOwn(EQUIPMENT_UNLOCK_MANIFEST,id) && (index===0 || value[index-1]<id)) && DEFAULT_EQUIPMENT_UNLOCKS.every(id=>value.includes(id));
}
// These rule values drive both the simulation predicate and user-facing text.
const ruleRows = [
  ['Survive1Minute','hollowHeartLevel',{kind:'survive',seconds:60}],
  ['Survive10Minutes','peachone',{kind:'survive',seconds:600}],
  ['Survive20Minutes','pentagram',{kind:'survive',seconds:1200}],
  ['Survive5MinutesWithKnife','pummarolaLevel',{kind:'survive',seconds:300,character:'gennaro',characterName:'Gennaro'}],
  ['Survive5MinutesWithDiamond','runetracer',{kind:'survive',seconds:300,character:'pasqualina',characterName:'Pasqualina'}],
  ['ReachLV5','wingsLevel',{kind:'level',level:5}],
  ['ReachLV10','crownLevel',{kind:'level',level:10}],
  ['GetHolyBookToLevel4','bracerLevel',{kind:'weapon',field:'bible',name:'圣经',level:4}],
  ['GetHolyWaterToLevel4','candelabradorLevel',{kind:'weapon',field:'santaWater',name:'圣水',level:4}],
  ['GetRunetracerToLevel7','spellbinderLevel',{kind:'weapon',field:'runetracer',name:'符文弹',level:7}],
  ['GetMagicMissileToLevel7','duplicatorLevel',{kind:'weapon',field:'wand',name:'魔杖',level:7}],
  ['GetPeachoneToLevel7','ebonyWings',{kind:'weapon',field:'peachone',name:'Peachone',level:7,union:'vandalier'}],
  ['FindAVacuum','attractorLevel',{kind:'pickup',field:'vacuumsCollected',name:'真空吸尘器',count:1}],
  ['FindAnOrologion','clockLancet',{kind:'pickup',field:'orologionsCollected',name:'时钟',count:1}],
  ['FindARosary','cross',{kind:'pickup',field:'rosariesCollected',name:'念珠',count:1}],
  ['FindAClover','cloverLevel',{kind:'pickup',field:'cloversCollected',name:'小三叶草',count:1}],
  ['Eat5PotRoast','garlic',{kind:'pickup',field:'roastsCollected',name:'烤鸡',count:5}]
];
export const ACHIEVEMENT_RULES = Object.freeze(Object.fromEntries(ruleRows.map(([id,equipmentId,rule])=>
  [id,Object.freeze({equipmentId,...rule})])));
// These totals are evaluated by the device profile after a committed terminal
// checkpoint; they are not per-run achievementEvents or server authority.
export const CUMULATIVE_KILL_ACHIEVEMENTS = Object.freeze({
  Defeat5000Enemies:Object.freeze({counter:'totalKills',threshold:5000,equipmentId:'lightning'}),
  Defeat3000Skeletons:Object.freeze({counter:'skeleton',threshold:3000,equipmentId:'bone'})
});
const description = rule => {
  if (rule.kind==='survive') return `${rule.character ? `使用 ${rule.characterName} ` : ''}本局生存${rule.seconds/60}分钟`;
  if (rule.kind==='level') return `本局角色达到 ${rule.level} 级`;
  if (rule.kind==='weapon') return `本局将 ${rule.name} 升至 ${rule.level} 级或获得其进化`;
  return `本局收集${rule.count}个${rule.name}`;
};
const pendingRows = [
  ['Destroy20Candles','fireWand','unknown'],
  ['Have6DifferentWeapons','emptyTomeLevel','unknown']
];
export const ACHIEVEMENT_METADATA = Object.freeze(Object.fromEntries([
  ...ruleRows.map(([id,equipmentId,rule])=>[id,Object.freeze({equipmentId,description:description(rule),scope:'run',implementation:'available'})]),
  ...Object.entries(CUMULATIVE_KILL_ACHIEVEMENTS).map(([id,rule])=>[id,Object.freeze({equipmentId:rule.equipmentId,
    description:rule.counter==='skeleton'?'本机累计击败 3000 个骷髅':'本机累计击败 5000 个敌人',scope:'lifetime',implementation:'available'})]),
  ...pendingRows.map(([id,equipmentId,scope])=>[id,Object.freeze({equipmentId,description:'解锁条件尚未实现',scope,implementation:'pending'})])
]));
export const ACHIEVEMENT_UNLOCKS = Object.freeze(Object.fromEntries(ruleRows.map(([id,equipmentId])=>[id,equipmentId])));
export const EQUIPMENT_UNLOCK_DETAILS = Object.freeze(Object.fromEntries(rows.map(([id,defaultUnlocked])=>
  [id,Object.freeze({defaultUnlocked,achievementIds:Object.freeze(Object.keys(ACHIEVEMENT_METADATA).filter(key=>ACHIEVEMENT_METADATA[key].equipmentId===id))})])));
export function achievementUnlock(achievementId) {
  return Object.hasOwn(ACHIEVEMENT_UNLOCKS,achievementId) ? ACHIEVEMENT_UNLOCKS[achievementId] : null;
}
const ruleEntries = Object.entries(ACHIEVEMENT_RULES);
export function evaluateAchievementConditions(state,tickHz) {
  const result={};
  for (const [id,rule] of ruleEntries) {
    let met;
    if (rule.kind==='survive') met=state.tick>=rule.seconds*tickHz && (!rule.character || state.character===rule.character);
    else if (rule.kind==='level') met=state.player.level>=rule.level;
    else if (rule.kind==='weapon') met=(state[rule.field]?.level??0)>=rule.level || !!state[rule.field]?.evolved || !!(rule.union && state[rule.union]);
    else met=state[rule.field]>=rule.count;
    result[id]=!!met;
  }
  return result;
}
