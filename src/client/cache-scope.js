// Local storage is shared by every login on an origin. Identity is mandatory;
// never claim an unlabelled old entry just because somebody signed in today.
export const validCacheOwner=owner=>typeof owner==='string'&&owner.length>0&&owner.length<=256;
export const accountCacheKey=(owner,id)=>validCacheOwner(owner)&&typeof id==='string'&&id?'account:'+encodeURIComponent(owner)+':'+encodeURIComponent(id):null;
export const matchParticipant=(match,owner)=>validCacheOwner(owner)&&(match?.owner_id===owner||match?.opponent_id===owner);
export function cacheEntryOwned(entry,owner){
 if(!entry||!validCacheOwner(owner))return false;
 if(entry.ownerId!=null)return entry.ownerId===owner;
 if(entry.userId!=null)return entry.userId===owner;
 // Old automatic trace caches had no ownerId. Only their actual participants
 // may retain them; ambiguous/unrelated imports remain stored but invisible.
 return matchParticipant(entry.match,owner);
}
export function scopedReplayEntries(entries,owner){
 const own=new Map();
 for(const entry of entries||[]){
  const id=entry?.match?.id;if(!id||!cacheEntryOwned(entry,owner))continue;
  if(!own.has(id)||entry.id===accountCacheKey(owner,id))own.set(id,{...entry,id});
 }
 return [...own.values()];
}
