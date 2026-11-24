export const TREASURE_CLAIM_CONTRACT='survivors.treasure-claim.v1';
export const DROP_TABLE=Object.freeze({coin:50,roast:20,vacuum:10,chest:20});
export function dropTable(luck=1){if(!Number.isFinite(luck)||luck<0)throw new Error('invalid luck');return Object.freeze({...DROP_TABLE,rare:Math.min(25,Math.floor(luck*5))});}
export function chestRarity(tier,locked=false){if(!Number.isInteger(tier)||tier<1||tier>3)throw new Error('invalid chest tier');return Object.freeze({tier,rarity:tier===3?'legendary':tier===2?'rare':'common',locked:!!locked});}
// Frozen S2 0.54 generated chests only in boss defeatEnemy(), without an
// origin field. Its first possible rare drop is minute3 and legendary minute5.
// This grants legacy eligibility, not a claim that an individual chest is proven boss loot.
export function legacyChestEligible(chest,tick) {
  return !Object.hasOwn(chest,'boss') && Number.isInteger(tick) &&
    (chest.tier===2 && tick>=3*3600 || chest.tier===3 && tick>=5*3600);
}
export function claimChest(chest,{wave=0,boss=false,legacyTick=null,claimedIds=new Set()}={}) {
  if(!chest?.id||claimedIds.has(chest.id))throw new Error('invalid or duplicate claim');
  if(chest.locked&&!boss)throw new Error('locked chest');
  const legacy=legacyChestEligible(chest,legacyTick);
  if(wave<0||(!boss&&!legacy&&chest.tier>1&&wave<5))throw new Error('wave gate');
  return Object.freeze({id:chest.id,tier:chest.tier,boss:!!boss,contract:TREASURE_CLAIM_CONTRACT,
    ...(legacy?{origin:'legacy-unmarked-drop-rule'}:{})});
}
export function pickupOrder(items=[]){return [...items].sort((a,b)=>(a.distance??0)-(b.distance??0)||(a.id??0)-(b.id??0)).map(x=>x.id);}
export function rollbackClaim(candidate){const valid=candidate?.contract===TREASURE_CLAIM_CONTRACT&&candidate?.hash&&!candidate?.duplicate;return Object.freeze({valid:!!valid,fallback:valid?null:'programmatic-fallback'});}
