// Local single-player configuration with no arcana, relic modifiers or seals.
// Each positive-weight item under this local configuration has a represented pickup.
// The original account's loaded content, RNG stream and modifiers are unknown.
const ENTRIES=Object.freeze([
  {kind:'coin',level:0,weight:50}, {kind:'coin-bag',level:0,weight:10},
  {kind:'big-coin-bag',level:5,weight:1,rare:true}, {kind:'rosary',level:8,weight:1,rare:true},
  {kind:'nduja',level:0,weight:1,rare:true}, {kind:'orologion',level:4,weight:2,rare:true},
  {kind:'vacuum',level:12,weight:2,rare:true}, {kind:'roast',level:0,weight:12,rare:true},
  {kind:'gilded-clover',level:30,weight:1}, {kind:'little-clover',level:0,weight:.5},
  {kind:'rerollo',level:0,weight:1}
]);
export function selectModeledLoot(level,luck,roll) {
  if(!Number.isInteger(level)||level<1||level>1000||!Number.isFinite(luck)||luck<=0||!Number.isFinite(roll)||roll<0||roll>=1)throw new Error('invalid loot selection');
  const eligible=ENTRIES.filter(entry=>level>=entry.level);
  const total=eligible.reduce((sum,entry)=>sum+entry.weight*(entry.rare?luck:1),0);
  let remainder=roll*total;
  for(const entry of eligible){remainder-=entry.weight*(entry.rare?luck:1);if(remainder<0)return entry.kind;}
  return eligible.at(-1).kind;
}
