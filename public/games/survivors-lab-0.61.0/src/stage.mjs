// Counts and timer periods selected from the installed Steam build 25984009
// Mad Forest table. World-space distances and special modes remain simplified.
export const MAX_ENEMIES = 500;
export const FOREST_PRESSURE = Object.freeze([
  [15, 60], [30, 60], [50, 30], [40, 15], [30, 30],
  [10, 60], [20, 30], [80, 30], [100, 90], [30, 30],
  [10, 30], [300, 6], [20, 15], [150, 30], [20, 6],
  [100, 6], [100, 6], [20, 60], [60, 30], [100, 30],
  [100, 6], [300, 6], [200, 6], [300, 6], [300, 6],
  [100, 6], [150, 6], [300, 6], [300, 6], [300, 6]
].map(([minimum, intervalTicks]) => Object.freeze({minimum, intervalTicks})));

// A fixed simulation camera keeps Agent runs and replays independent of CSS
// window size. The renderer fits this 960 x 540 view at 30 pixels/world unit.
export const VIEW = Object.freeze({width: 960, height: 540, scale: 30});
const innerX = VIEW.width / VIEW.scale / 2 + 2.5;
const innerY = VIEW.height / VIEW.scale / 2 + 2.5;
const outerX = innerX + 2.5, outerY = innerY + 2.5;
const horizontalArea = 4 * outerX * (outerY - innerY);
const verticalArea = 4 * innerY * (outerX - innerX);

// Uniformly sample four non-overlapping bands outside the whole viewport.
export function outsideViewPosition(player, random) {
  const horizontal = random() * (horizontalArea + verticalArea) < horizontalArea;
  const side = random() < 0.5 ? -1 : 1;
  const along = random() * 2 - 1, depth = random();
  return horizontal
    ? {x: player.x + along * outerX, y: player.y + side * (innerY + depth * (outerY - innerY))}
    : {x: player.x + side * (innerX + depth * (outerX - innerX)), y: player.y + along * innerY};
}

export function outsideActiveArea(enemy, player) {
  return Math.abs(enemy.x - player.x) > VIEW.width / VIEW.scale ||
    Math.abs(enemy.y - player.y) > VIEW.height / VIEW.scale;
}


// [minute, type, delay in ticks, additional repeats, chance percent, lifetime].
// Zero/missing chance is unconditional in the demo; luck reduces hazard odds.
const EVENT_ROWS = [
  [2,'bat-swarm',300,2], [3,'bat-swarm',300,1,10], [4,'bat-swarm',300,1,10],
  [5,'flower-wall',0,0,0,1800], [6,'bat-swarm',300,1,10],
  [7,'bat-swarm',300,5,80], [8,'bat-swarm',900,2,80], [9,'bat-swarm',900,2,70],
  [10,'flower-wall',0,0], [11,'bat-swarm',300,1,10], [12,'bat-swarm',300,1,10],
  [13,'ghost-swarm',72,20,70], [13,'ghost-swarm',138,20,70],
  [15,'flower-wall',0,0,80],
  [20,'bat-swarm',72,20,70], [20,'bat-swarm',138,20,70],
  [25,'flower-wall',600,5,0,600],
  [27,'ghost-swarm',0,0], [27,'ghost-swarm',180,19],
  [29,'bat-swarm',0,0], [29,'bat-swarm',180,19]
];

// Timers survive minute transitions. The 30-minute clear takes precedence over
// any event due at that tick so the final swarm cannot replace the Reaper.
export const FOREST_EVENTS = Object.freeze(EVENT_ROWS.flatMap(([minute,type,delay,repeats,chance=0,duration]) =>
  Array.from({length: repeats+1},(_,i)=>Object.freeze({
    tick: minute*3600+delay*(i+1), type, chance,
    duration: duration ?? (type==='flower-wall'?3600:600)
  }))).filter(event=>event.tick<30*3600).sort((a,b)=>a.tick-b.tick));

export function shouldTriggerEvent(event, luck, random) {
  return !event.chance || random()*100 <= event.chance/Math.max(0.01,luck);
}

// Count, arc spacing and lifetime follow the sample. World-unit translation
// uses our fixed camera; sprite sizes/stats remain independently tuned.
export function eventFormation(event, player, random) {
  const flower=event.type==='flower-wall';
  const count=flower?100:event.type==='bat-swarm'?50:20;
  const angle=random()*Math.PI*2, spacing=flower?Math.PI/50:Math.PI/500;
  return Array.from({length:count},(_,index)=>{
    const theta=angle+index*spacing;
    return {x:player.x+Math.cos(theta)*VIEW.width/VIEW.scale*.72,
      y:player.y+Math.sin(theta)*VIEW.height/VIEW.scale*.72,
      kind:flower?'flower':event.type, eventType:event.type,
      expiresTick:event.tick+event.duration, fixedDirection:!flower};
  });
}

// The installed minute-13 list contains GHOST twice. The spawn loop walks
// the source list even though the enabled pool state is keyed by species.
export const MAD_FOREST_WAVES=Object.freeze([
 ['bat-3'],['zombie','bat-1'],['bat-1','bat-2','bat-3'],['skeleton'],['skeleton','ghost'],
 ['mudman-2'],['zombie','mudman-2'],['bat-2','bat-3','mudman-1'],['zombie'],['large-bat','zombie'],
 ['mudman-1','mudman-2'],['skeleton'],['werewolf','ghost','skeleton'],['werewolf','ghost','ghost'],['large-bat','werewolf'],
 ['werewolf','large-bat','mudman-2'],['mantis','mudman-1','mudman-2'],['mummy'],['mummy','mudman-1'],['mummy','mudman-1'],
 ['mummy','mudman-2','large-bat'],['flower'],['flower','mummy'],['flower','mummy'],['flower','mummy'],
 ['large-flower'],['large-flower','flower'],['mummy','mudman-1','mudman-2'],['large-bat','bat-4'],['bat-4','bat-5']
].map(Object.freeze));

// Candidate encounter ledger consumed by the simulation. These values mirror
// the local tables and are prototype tuning, not original-game parity.
export const ENCOUNTER_PRESSURE_CANDIDATES=Object.freeze(FOREST_PRESSURE.map((pressure, minute) => Object.freeze({
  minute,
  startSecond: minute * 60,
  endSecond: (minute + 1) * 60,
  intervalTicks: pressure.intervalTicks,
  minimumAlive: pressure.minimum,
  refillPerMinute: Math.ceil(MAD_FOREST_WAVES[minute].length * 3600 / pressure.intervalTicks),
  composition: MAD_FOREST_WAVES[minute]
})));

export function encounterPressureAtMinute(minute) {
  const candidate = ENCOUNTER_PRESSURE_CANDIDATES[minute];
  if (!candidate) throw new Error('invalid forest minute');
  return candidate;
}

// A timed encounter is distinct from its species: BAT4/5 and XL enemies also
// appear in ordinary waves. Encounter identity grants teleport-on-cull and
// optional treasure, without changing the species' health or knockback.
const bosses={1:['bat-4',[0,0,30]],3:['bat-4',[0,5,40]],5:['mantis',[1,5,100]],
 7:['bat-4',[3,10,50]],8:['large-bat'],9:['bat-5',[3,10,50]],10:['boss-mantis',[3,10,100]],
 12:['bat-4',[1,5,50]],14:['bat-5',[3,10,100]],15:['boss-werewolf',[3,10,100]],
 16:['bat-4',[1,5,50]],18:['bat-5',[3,10,100]],20:['boss-mummy',[3,10,100]],
 21:['large-flower'],22:['bat-4',[3,10,100]],23:['bat-5',[3,10,100]],24:['large-flower'],
 25:['boss-flower',[3,10,100]],27:['bat-4',[3,10,100]],29:['bat-4',[3,10,100]],30:['reaper']};
export const FOREST_BOSSES=Object.freeze(Object.fromEntries(Object.entries(bosses).map(([minute,[kind,chances]])=>
 [minute,Object.freeze({kind,chances:chances?Object.freeze(chances):null})])));
// Selected FOREST prize type fields attached to each timed boss at spawn.
export function forestTreasurePrizeTypes(minute) {
 if(!Number.isInteger(minute) || !FOREST_BOSSES[minute]?.chances) throw new Error('invalid forest treasure source');
 const first=[3,5,7,9].includes(minute)?'EXISTING_WEAPON':'EVOLUTION';
 return [first,'EXISTING_ANY','EXISTING_ANY',[9,10].includes(minute)?'EXISTING_WEAPON':'EXISTING_ANY',[9,10].includes(minute)?'EXISTING_WEAPON':'EXISTING_ANY'];
}
export function rollTreasureTier(chances,luck,random){
 if(!chances)return 0;
 // Installed SetTreasureLevelFromChance obtains all three draws before
 // testing the legendary, rare and common chances in that order.
 const draws=[random(),random(),random()];
 for(let i=0;i<3;i++)if(draws[i]*100<=chances[i]*luck)return 3-i;
 return 0;
}
