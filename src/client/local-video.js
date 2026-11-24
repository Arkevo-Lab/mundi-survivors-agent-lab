import {accountWasDeleted} from './account-data.js';
import {accountCacheKey,validCacheOwner,matchParticipant} from './cache-scope.js';
import {fixWebmDuration} from '@fix-webm-duration/fix';
import {RECORDING,recordingSurface} from './recording-surface.js';
// Private, origin-local media. Nothing in this module uploads recordings.
const DB='mundi-local-videos',STORE='videos',MAX_BYTES=256*1024*1024,MAX_LIBRARY=2*1024*1024*1024;
let database;
let persistence;
export function retainLocalVideos(storage=globalThis.navigator?.storage){
 return persistence??=Promise.resolve().then(()=>storage?.persist?.()).then(Boolean).catch(()=>false);
}
function open(){
 return database??=new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB,1);
  req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>{database=null;reject(req.error);};
 });
}
async function transaction(mode,action){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode),request=action(tx.objectStore(STORE));tx.oncomplete=()=>resolve(request?.result);tx.onabort=tx.onerror=()=>reject(tx.error||new Error('本地视频保存失败'));});}
export function videoFrames(frames){return frames.map(({tick,tickHz,scores,done,round,players})=>({tick,tickHz,scores,done,round,players:players?.map(p=>({alive:p.alive}))}));}
export async function finalizeVideo(video){return {...video,blob:video.blob.type==='video/webm'&&video.mediaVersion!==1?await fixWebmDuration(video.blob,video.duration*1000,{logger:false}):video.blob,mediaVersion:1};}
export async function readLocalVideo(id,ownerId,{match}={}){
 const key=accountCacheKey(ownerId,id);if(!key||accountWasDeleted(ownerId))return null;
 try{const video=await transaction('readonly',store=>store.get(key))||await transaction('readonly',store=>store.get(id));
  if(!video||accountWasDeleted(ownerId))return null;
  const storedOwner=video.ownerId??video.userId;
  if(storedOwner!=null?storedOwner!==ownerId:!match||match.id!==id||match.localOnly||!matchParticipant(match,ownerId))return null;
  void retainLocalVideos();return video.mediaVersion===1?video:await finalizeVideo(video);
 }catch{return null;}
}
export async function saveLocalVideo(id,video){
 if(!validCacheOwner(video.ownerId))throw new Error('缺少录像所属账号');
 const key=accountCacheKey(video.ownerId,id);if(!key)throw new Error('录像编号无效');
 if(accountWasDeleted(video.ownerId))throw new Error('账户已删除，不能保存录像');
 if(!(video.blob instanceof Blob)||!video.blob.size||video.blob.size>MAX_BYTES)throw new Error('本地视频超出单场 256 MB 上限；已有视频保留');
 video=await finalizeVideo(video);
 if(!(video.blob instanceof Blob)||!video.blob.size||video.blob.size>MAX_BYTES)throw new Error('本地视频超出单场 256 MB 上限');
 const db=await open();
 void retainLocalVideos();
 await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),request=store.openCursor();let total=video.blob.size;
   request.onsuccess=()=>{const cursor=request.result;if(cursor){if(cursor.key!==key)total+=cursor.value.blob.size;cursor.continue();}else if(total>MAX_LIBRARY){tx.abort();}else if(accountWasDeleted(video.ownerId))tx.abort();else store.put({...video,id:key,created:Date.now()});};
  tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(new Error('本地录屏空间不足，本次仅保留对局记录；已有视频不会被删除'));
 });
 return video;
}
// Cues map wall-clock video time to simulation ticks, including faster games.
export function interpolateCue(cues,value,axis=0){
 if(!cues?.length)return 0;
 const other=1-axis;if(value<=cues[0][axis])return cues[0][other];
 for(let i=1;i<cues.length;i++)if(value<=cues[i][axis]){const a=cues[i-1],b=cues[i],span=b[axis]-a[axis];return span>0?a[other]+(b[other]-a[other])*(value-a[axis])/span:b[other];}
 return cues.at(-1)[other];
}
export function recordLocalVideo(canvas,{onError=()=>{},now=()=>performance.now(),Recorder=globalThis.MediaRecorder,audio}={}){
 if(!canvas?.captureStream||!Recorder)throw new Error('当前浏览器不支持本地视频录制');
 const mime=['video/webm;codecs=vp8,opus','video/webm','video/mp4'].find(type=>Recorder.isTypeSupported(type));
 if(!mime)throw new Error('当前浏览器没有可用的视频编码器');
 const surface=recordingSurface(canvas);let stream,recorder;
 const tracks=audio?.stream?.getAudioTracks()||[];
 try{stream=surface.canvas.captureStream(RECORDING.fps);for(const track of tracks)stream.addTrack(track.clone());recorder=new Recorder(stream,{mimeType:mime,videoBitsPerSecond:RECORDING.videoBitsPerSecond,audioBitsPerSecond:RECORDING.audioBitsPerSecond});}catch(error){stream?.getTracks().forEach(t=>t.stop());surface.release();audio?.release();throw error;}
 const chunks=[],cues=[[0,0]];let bytes=0,elapsed=0,started=now(),paused=false,ended=false,discard=false,failure;
 const time=()=>elapsed+(paused?0:(now()-started)/1000);
 let cleaned=false;
 const clean=()=>{if(cleaned)return;cleaned=true;clearTimeout(deadline);stream.getTracks().forEach(t=>t.stop());surface.release();audio?.release();};
 let resolveDone,rejectDone;
 const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});done.catch(()=>{});
 function fail(message){if(failure)return;failure=new Error(message);onError(failure);discard=true;if(recorder.state!=='inactive')recorder.stop();else{clean();rejectDone(failure);}}
 recorder.ondataavailable=event=>{if(discard||!event.data?.size)return;bytes+=event.data.size;if(bytes>MAX_BYTES){fail('本场视频超过 256 MB，未保存视频；对局记录仍保留');return;}chunks.push(event.data);};
 recorder.onerror=()=>fail('浏览器录制失败；对局记录仍保留');
 recorder.onstop=()=>{clean();if(failure){rejectDone(failure);return;}if(discard){resolveDone(null);return;}const blob=new Blob(chunks,{type:mime.split(';')[0]});resolveDone({blob,cues,duration:elapsed,audio:tracks.length>0});};
 const deadline=setTimeout(()=>fail('本地视频录制达到 30 分钟上限；对局记录仍保留'),30*60*1000);
 try{recorder.start(1000);}catch(error){clean();throw error;}
 stream.getVideoTracks()[0].addEventListener('ended',()=>{if(!ended)fail('游戏画面已关闭，未保存不完整视频；对局记录仍保留');});
 return {
  mark(tick){if(!ended&&Number.isFinite(tick)&&tick>=cues.at(-1)[1]){const t=time();if(t-cues.at(-1)[0]>=0.1)cues.push([t,tick]);}},
  pause(value){if(ended||value===paused||recorder.state==='inactive')return;surface.pause?.(value);if(value){elapsed=time();paused=true;recorder.pause();}else{started=now();paused=false;recorder.resume();}},
  finish(tick){if(!ended){elapsed=time();ended=true;paused=true;cues.push([elapsed,Math.max(cues.at(-1)[1],tick||0)]);if(recorder.state!=='inactive')recorder.stop();}return done;},
  cancel(){discard=true;ended=true;if(recorder.state!=='inactive')recorder.stop();else clean();return done;}
 };
}
export function downloadLocalVideo(video,id){const url=URL.createObjectURL(video.blob),a=document.createElement('a');a.href=url;a.download='mundi-'+id+(video.blob.type.includes('mp4')?'.mp4':'.webm');a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
