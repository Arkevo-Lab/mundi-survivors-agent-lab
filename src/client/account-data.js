const deletedOwners=new Set();
export const accountWasDeleted=ownerId=>deletedOwners.has(ownerId);
// Never clear whole origin storage: a browser may hold several users' libraries.
export function belongsToAccount(value,userId,ids){
 if(value?.ownerId!=null)return value.ownerId===userId;
 if(value?.userId!=null)return value.userId===userId;
 return value?.match?.owner_id===userId||value?.match?.opponent_id===userId||typeof value?.id==='string'&&ids.has(value.id);
}
async function purgeStore(name,storeName,userId,ids){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(name,1);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(storeName))request.result.createObjectStore(storeName,{keyPath:name==='arkena-outbox'?'userId':'id'});};
  request.onerror=()=>reject(request.error);
  request.onsuccess=()=>{
   const db=request.result;let tx;
   try{tx=db.transaction(storeName,'readwrite');const cursor=tx.objectStore(storeName).openCursor();cursor.onsuccess=()=>{const item=cursor.result;if(!item)return;if(belongsToAccount(item.value,userId,ids)){if(typeof item.value.id==='string')ids.add(item.value.id);item.delete();}item.continue();};}
   catch(error){db.close();reject(error);return;}
   tx.oncomplete=()=>{db.close();resolve();};tx.onerror=tx.onabort=()=>{db.close();reject(tx.error||new Error('本地资料清理失败'));};
  };
 });
}
export async function purgeAccountData(userId,matchIds=[]){
 deletedOwners.add(userId);
 const ids=new Set(matchIds),errors=[];
 // Replay metadata also identifies legacy videos without an ownerId field.
 for(const [db,store] of [['mundi-replays','replays'],['mundi-local-videos','videos'],['arkena-outbox','pending']]){
  try{await purgeStore(db,store,userId,ids);}catch(error){errors.push(error);}
 }
 for(const key of ['mundi.looks.v2.','mundi.batch.','mundi.ranked-videos.'])try{localStorage.removeItem(key+userId);}catch(error){errors.push(error);}
 for(const key of ['mundi-cli-return','mundi-strategy-return'])try{sessionStorage.removeItem(key);}catch(error){errors.push(error);}
 return {complete:errors.length===0};
}
