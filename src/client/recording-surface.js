// Keep enough encoded pixels for a Retina desktop replay. The game canvas is
// already rendered at devicePixelRatio, so a 960px capture would immediately
// be upscaled when the video is shown at roughly 960 CSS pixels on a DPR 2
// screen. The cap is still bounded for low-DPR and large-window captures.
export const RECORDING={width:1920,height:1080,fps:20,videoBitsPerSecond:2000000,audioBitsPerSecond:64000};
export function recordingSize(width,height){
 const ratio=Math.min(1,RECORDING.width/width,RECORDING.height/height);
 return {width:Math.max(2,Math.floor(width*ratio/2)*2),height:Math.max(2,Math.floor(height*ratio/2)*2)};
}
// Downsample before capture: recorder bitrate alone cannot bound resolution.
export function recordingSurface(source,{createCanvas=()=>document.createElement('canvas'),requestFrame=fn=>requestAnimationFrame(fn),cancelFrame=id=>cancelAnimationFrame(id)}={}){
 if(!(source.width>0&&source.height>0))return {canvas:source,release(){}};
 const canvas=createCanvas(),size=recordingSize(source.width,source.height);
 Object.assign(canvas,size);const context=canvas.getContext('2d',{alpha:false});
 if(!context)throw new Error('无法准备本地录屏画面');
 let frame,closed=false,paused=false,last=-Infinity;
 const paint=()=>{
  if(!(source.width>0&&source.height>0))return;
  // Keep the encoded dimensions fixed even if the game/browser is resized.
  const scale=Math.min(1,canvas.width/source.width,canvas.height/source.height),width=source.width*scale,height=source.height*scale;
  context.fillStyle='#000';context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(source,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
 };
 const draw=time=>{if(closed)return;if(!paused&&time-last>=1000/RECORDING.fps){paint();last=time;}frame=requestFrame(draw);};
 paint();frame=requestFrame(draw);
 return {canvas,pause(value){paused=value;if(!paused)last=-Infinity;},release(){if(closed)return;closed=true;cancelFrame(frame);canvas.width=canvas.height=0;}};
}
