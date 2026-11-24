// Per-renderer immutable pixel grids only. This cache owns no original assets.
const WIDTH=28, HEIGHT=34, MAX_ENTRIES=96, MAX_PIXELS=1_048_576;
function defaultCanvas(width,height){
  if(typeof OffscreenCanvas==='function')return new OffscreenCanvas(width,height);
  if(typeof document!=='undefined' && document.createElement){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}
  return null;
}
function safeTarget(ctx,scale){
  if(typeof ctx.isContextLost==='function' && ctx.isContextLost())return false;
  if(!Number.isSafeInteger(scale)||scale<1||scale>64 || typeof ctx.drawImage!=='function' || typeof ctx.getTransform!=='function')return false;
  if(ctx.globalAlpha!==1 || ctx.globalCompositeOperation!=='source-over' ||
      (ctx.filter && ctx.filter!=='none' && ctx.filter!=='brightness(2.5)'))return false;
  if(ctx.shadowBlur!==0 || ctx.shadowOffsetX!==0 || ctx.shadowOffsetY!==0 || !['rgba(0, 0, 0, 0)','transparent'].includes(ctx.shadowColor))return false;
  const t=ctx.getTransform();
  return !!t && [t.a,t.b,t.c,t.d,t.e,t.f].every(Number.isFinite) && t.b===0 && t.c===0 &&
    Number.isSafeInteger(t.a) && Number.isSafeInteger(t.d) && Math.abs(t.a)>=1 && Math.abs(t.d)>=1 &&
    (ctx.filter!=='brightness(2.5)' || Number.isSafeInteger(t.e) && Number.isSafeInteger(t.f));
}
export function createSpriteRasterCache({createCanvas=defaultCanvas,maxEntries=MAX_ENTRIES,maxPixels=MAX_PIXELS}={}){
  const entryLimit=Number.isSafeInteger(maxEntries)?Math.max(0,Math.min(MAX_ENTRIES,maxEntries)):0;
  const pixelLimit=Number.isSafeInteger(maxPixels)?Math.max(0,Math.min(MAX_PIXELS,maxPixels)):0;
  const entries=new Map(), variants=new WeakMap(), checked=new WeakMap(), targetStates=new WeakMap(), monitors=new Map();let pixels=0;
  function detach(state){
    if(state.monitor){state.canvas.removeEventListener('contextlost',state.lostHandler);state.canvas.removeEventListener('contextrestored',state.restoredHandler);monitors.delete(state.ctx);state.monitor=false;}
  }
  function remove(entry){
    if(!entries.delete(entry))return;
    pixels-=WIDTH*HEIGHT;
    const pair=variants.get(entry.rows)?.get(entry.ctx);if(pair)pair[entry.flash?1:0]=null;
    if(entry.sourceListener)entry.canvas.removeEventListener('contextlost',entry.sourceListener);
    const state=targetStates.get(entry.ctx);if(state){state.refs--;if(!state.refs && !state.lost)detach(state);}
    try{entry.canvas.width=0;entry.canvas.height=0;}catch{}
  }
  function targetState(ctx){
    let state=targetStates.get(ctx);
    if(!state){state={ctx,canvas:ctx.canvas,refs:0,lost:false,monitor:false};targetStates.set(ctx,state);}
    if(state.lost && typeof ctx.isContextLost==='function' && !ctx.isContextLost())state.lost=false;
    if(state.lost)return null;
    const canvas=state.canvas;
    if(!state.monitor && canvas?.addEventListener && canvas?.removeEventListener){
      // Lost contexts retain a bounded monitor until restoration, even though their rasters are gone.
      if(monitors.size>=MAX_ENTRIES)return null;
      state.lostHandler=()=>{state.lost=true;for(const entry of [...entries.keys()])if(entry.ctx===ctx)remove(entry);};
      state.restoredHandler=()=>{state.lost=false;if(!state.refs)detach(state);};
      canvas.addEventListener('contextlost',state.lostHandler);
      try{canvas.addEventListener('contextrestored',state.restoredHandler);}
      catch(error){canvas.removeEventListener('contextlost',state.lostHandler);throw error;}
      state.monitor=true;monitors.set(ctx,state);
    }
    return state;
  }
  function trusted(rows){
    if(!Array.isArray(rows) || !Object.isFrozen(rows))return false;
    if(checked.has(rows))return checked.get(rows);
    const good=rows.length===HEIGHT && rows.every(row=>Array.isArray(row) && Object.isFrozen(row) && row.length===WIDTH && row.every(value=>value===null || typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value)));
    checked.set(rows,good);return good;
  }
  function draw(ctx,rows,scale,flash=false){
    let entry=null,canvas=null;
    try {
      if(typeof ctx.isContextLost==='function' && ctx.isContextLost()){
        let state=targetStates.get(ctx);if(!state){state={ctx,canvas:ctx.canvas,refs:0,lost:true,monitor:false};targetStates.set(ctx,state);}
        state.lost=true;for(const old of [...entries.keys()])if(old.ctx===ctx)remove(old);
        return false;
      }
      if(!safeTarget(ctx,scale) || !trusted(rows) || entryLimit<1 || pixelLimit<WIDTH*HEIGHT)return false;
      const prior=targetStates.get(ctx);
      if(prior?.lost){if(typeof ctx.isContextLost==='function' && !ctx.isContextLost())prior.lost=false;else return false;}
      let contexts=variants.get(rows),pair=contexts?.get(ctx);entry=pair?.[flash?1:0];
      if(entry && typeof entry.raster.isContextLost==='function' && entry.raster.isContextLost()){remove(entry);entry=null;}
      if(entry){entries.delete(entry);entries.set(entry,entry);}
      else {
        canvas=createCanvas(WIDTH,HEIGHT);if(!canvas)return false;
        canvas.width=WIDTH;canvas.height=HEIGHT;const raster=canvas.getContext?.('2d');
        if(!raster || typeof raster.fillRect!=='function'){canvas.width=0;canvas.height=0;return false;}
        for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++)if(rows[y][x]){
          raster.fillStyle=flash?'#fff0d6':rows[y][x];raster.fillRect(x,y,1,1);
        }
        if(typeof raster.isContextLost==='function' && raster.isContextLost()){canvas.width=0;canvas.height=0;return false;}
        while(entries.size>=entryLimit || pixels+WIDTH*HEIGHT>pixelLimit)remove(entries.keys().next().value);
        const state=targetState(ctx);if(!state){canvas.width=0;canvas.height=0;return false;}
        entry={canvas,raster,ctx,rows,flash:!!flash,sourceListener:null};
        if(canvas.addEventListener && canvas.removeEventListener){entry.sourceListener=()=>remove(entry);canvas.addEventListener('contextlost',entry.sourceListener);}
        state.refs++;
        contexts=variants.get(rows)||new WeakMap();pair=contexts.get(ctx)||[null,null];pair[flash?1:0]=entry;contexts.set(ctx,pair);variants.set(rows,contexts);
        entries.set(entry,entry);pixels+=WIDTH*HEIGHT;
      }
      ctx.save();try{ctx.imageSmoothingEnabled=false;ctx.drawImage(entry.canvas,-WIDTH/2*scale,-HEIGHT*scale,WIDTH*scale,HEIGHT*scale);}finally{ctx.restore();}
      return true;
    }catch{
      if(entry && entries.has(entry))remove(entry);
      else {const state=targetStates.get(ctx);if(state && !state.refs && !state.lost)detach(state);if(canvas)try{canvas.width=0;canvas.height=0;}catch{}}
      return false;
    }
  }
  function clear(){for(const key of [...entries.keys()])remove(key);for(const state of [...monitors.values()])detach(state);}
  return Object.freeze({draw,clear});
}
