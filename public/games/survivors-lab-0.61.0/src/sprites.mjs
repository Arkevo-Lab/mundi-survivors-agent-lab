// Independent pixel drawings. Original game images are not embedded here.
import {SPRITE_SHEET_METADATA} from './sprite-sheet.mjs';
import {createSpriteRasterCache} from './sprite-raster-cache.mjs';
import {createSpritePrefilterCache} from './sprite-prefilter-cache.mjs';
import {createSpritePixelCommands} from './sprite-pixel-commands.mjs';
export const HEROES = ['antonio','imelda','pasqualina','gennaro','arca','porta','exdash','mortaccio'];
export const ENEMIES = ['bat','ghost','skeleton','zombie','mudman','werewolf','mantis','mummy','flower','reaper'];
const W=28,H=34,MAX_GRID_ENTRIES=256,cache=new Map();
const rasterCache=createSpriteRasterCache();
const pixelCommands=createSpritePixelCommands();
let prefilterCache=null;
function painter(){
  const cells=Array.from({length:H},()=>Array(W).fill(null));
  const dot=(x,y,color)=>{x=Math.round(x);y=Math.round(y);if(x>=0&&x<W&&y>=0&&y<H)cells[y][x]=color;};
  const rect=(x,y,w,h,color)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)dot(xx,yy,color);};
  const line=(x,y,xx,yy,color,width=1)=>{const n=Math.max(Math.abs(xx-x),Math.abs(yy-y),1);for(let i=0;i<=n;i++)rect(Math.round(x+(xx-x)*i/n),Math.round(y+(yy-y)*i/n),width,width,color);};
  const poly=(points,color)=>{for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){
      const [xi,yi]=points[i],[xj,yj]=points[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
    }if(inside)dot(x,y,color);
  }};
  const outline=()=>{const copy=cells.map(row=>row.slice());for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(copy[y][x]){
    for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]])if(!copy[y+dy]?.[x+dx])dot(x+dx,y+dy,'#12151f');
  }};
  return {cells,dot,rect,line,poly,outline};
}
const tones={antonio:['#405c3d','#97aa70','#243528'],imelda:['#315b8f','#a0cce8','#23304e'],
  pasqualina:['#61477f','#c3a1d8','#312c4e'],gennaro:['#854b32','#d0a668','#432d28'],
  arca:['#832e40','#d78477','#3b2134'],porta:['#55508e','#b5b4e5','#2a2a50']};
function drawPerson(p,id,pose){
  const {rect:r,line:l,poly}=p,[coat,light,shade]=tones[id];
  const stride=[0,-1,0,1][pose], skin='#d1ae84', skinLight='#f0cf9d', hair=id==='imelda'?'#bfa269':id==='pasqualina'?'#a4b492':'#483b36';
  // Feet alternate relative to the body; an idle pose is exactly stable.
  r(10-stride,26,4,6,'#34333d');r(17+stride,26,4,6,'#34333d');
  r(8-stride,30+(pose===1?-1:0),6,2,'#878477');r(17+stride,30+(pose===3?-1:0),6,2,'#878477');
  if(id==='antonio'){
    poly([[8,10],[17,8],[20,17],[18,29],[5+stride,28],[7,17]],shade);
    poly([[7,11],[14,12],[12,25],[6,26]],coat);l(8,15,6,26,light);
    r(11,10,10,12,coat);r(12,11,7,3,light);r(11,15,10,2,'#333d33');r(11,19,10,3,'#b49b5c');
    r(10,22,12,5,shade);l(10,25,14,23,coat);r(19,12,4,7,skin);r(20,13,2,5,skinLight);
    r(7,12,4,6,skin);r(8,12,2,4,skinLight);r(7,18,5,3,'#50483b');r(19,19,5,3,'#50483b');
  }else if(id==='gennaro'){
    r(10,10,10,12,coat);r(9,11,4,9,skin);r(19,12,4,8,skin);r(9,11,2,6,skinLight);r(21,13,2,4,skinLight);
    r(10,20,12,3,shade);r(10,23,12,4,coat);l(11,11,18,19,'#c8b578',2);l(19,11,12,19,'#b99e61',2);
    r(10,20,12,2,'#b89762');r(14,20,3,2,'#e5cc85');r(6,20,6,2,'#8f7550');l(5,22,8,17,'#dee2dd',2);r(21,19,2,6,'#d5d4c3');
  }else{
    // Each caster has a distinct hem, shoulder and head treatment.
    poly([[10,10],[19,10],[21,22],[24+stride,29],[7,30],[9-stride,21]],shade);
    poly([[11,11],[18,11],[19,23],[21,28],[9,28]],coat);l(11,14,10,27,light);l(17,15,20,28,light);
    r(10,19,11,2,'#b89860');r(14,19,3,3,'#ebd391');r(7,12,4,7,coat);r(7,17,4,3,skin);r(19,12,4,7,coat);r(21,17,3,3,skinLight);
    if(id==='imelda'){poly([[8,9],[11,11],[8,21],[5,24],[6,14]],hair);r(6,11,2,7,'#e4cf8c');r(14,12,3,5,'#d5e1df');l(23,20,24,9,'#9b7550',2);r(23,7,3,4,'#c7ebff');}
    if(id==='pasqualina'){l(4,9,4,30,'#967451',2);r(2,8,6,3,'#b4a6d6');r(3,5,3,4,'#d1b9f2');poly([[11,24],[16,24],[16,31],[8,31]],coat);}
    if(id==='arca'){poly([[7,10],[10,12],[8,25],[2+stride,29],[5,18]],'#462137');l(6,20,3,27,'#ab4a57');r(19,22,6,4,'#c66345');r(21,19,3,6,'#f4b35f');r(22,21,1,3,'#ffe6a0');}
    if(id==='porta'){r(5,13,5,4,light);r(20,13,5,4,light);r(13,11,5,3,'#dac889');l(4,8,5,30,'#9b9dbd',2);r(2,5,6,6,'#8dcce9');r(3,5,3,3,'#edffff');poly([[11,24],[18,24],[17,32],[12,32]],light);}
  }
  r(12,3,8,8,hair);r(13,5,7,5,skin);r(14,6,6,2,skinLight);r(18,6,1,2,'#292636');r(15,9,4,2,skin);
  if(id==='antonio'){r(12,3,9,2,'#5f71a2');r(10,5,3,2,'#8793b7');r(18,9,3,1,'#574839');}
  if(id==='imelda'){r(10,3,4,11,hair);r(11,3,2,10,'#e0c98c');r(12,2,8,2,hair);}
  if(id==='pasqualina'){poly([[15,0],[10,8],[22,8]],coat);r(8,7,16,2,shade);r(11,6,10,1,light);}
  if(id==='gennaro'){r(11,2,9,4,'#4f3431');r(11,6,2,6,'#4f3431');r(13,9,4,3,'#593d35');r(12,4,9,1,'#bb774f');}
  if(id==='arca'){poly([[12,1],[18,2],[23,9],[19,11],[20,5],[14,4],[11,9],[9,9]],coat);r(11,3,2,5,light);}
  if(id==='porta'){r(11,2,10,3,'#9ba3cd');r(10,4,4,7,'#b5b4d8');r(19,4,3,8,'#777daa');r(12,2,8,1,'#e1d1a4');}
}
function skeleton(p,pose,hero){
  const {rect:r,line:l}=p,bone=hero?'#ece5ce':'#c9d1c4',shadow='#8d9587',stride=[0,-2,0,2][pose];
  r(10,3,10,9,bone);r(9,4,12,6,bone);r(11,6,3,3,'#23252d');r(16,6,3,3,'#23252d');r(14,9,2,2,shadow);r(12,12,6,2,bone);r(13,12,1,2,shadow);r(16,12,1,2,shadow);
  r(14,14,2,9,bone);l(9,16,20,16,bone);for(let y=18;y<23;y+=2){r(10,y,10,1,bone);r(14,y,2,1,shadow);}
  l(8,16,6+stride,22,bone,2);l(21,16,23-stride,22,bone,2);r(5+stride,22,3,3,bone);r(22-stride,22,3,3,bone);
  r(11,23,9,2,bone);l(12,25,9-stride,30,bone,2);l(18,25,20+stride,30,bone,2);r(7-stride,31,5,1,bone);r(19+stride,31,5,1,bone);
  if(hero){r(13,2,5,1,'#cfb674');r(20,10,2,3,'#d9c6a0');}
}
function ghost(p,pose,hero){
  const {rect:r,poly}=p,base=hero?'#b4e7ed':'#cddcdd',shade=hero?'#6488ba':'#899fae';
  const wave=[0,1,0,-1][pose];poly([[9,7],[18,5],[22,10],[22,22],[25,28],[19,26+wave],[15,30],[11,27-wave],[6,29],[7,17]],shade);
  poly([[10,8],[17,7],[20,10],[20,22],[21,25],[15,24],[11,26],[8,24],[9,17]],base);
  r(12,12,2,5,'#25314d');r(17,11,2,5,'#25314d');r(14,19,3,2,'#425a79');r(10,10,2,3,'#ebffff');
  if(hero){r(8,5,13,2,'#8b9ed1');r(11,3,7,3,'#a8b9e4');r(19,8,3,2,'#dbe9ff');}
}
function beast(p,id,pose){
  const {rect:r,line:l,poly}=p,stride=[0,-1,0,1][pose];
  if(id==='bat'){
    const wing=pose%2?6:15;
    poly([[12,14],[7,7],[1,wing],[1,23],[5,18],[8,21],[11,18]],'#242334');
    poly([[16,14],[21,7],[27,wing],[27,23],[23,18],[20,21],[17,18]],'#242334');
    l(3,wing+1,9,15,'#66566e');l(25,wing+1,19,15,'#66566e');l(7,10,11,17,'#8a7087');l(21,10,17,17,'#8a7087');
    r(12,12,5,10,'#51435d');r(11,10,2,5,'#51435d');r(16,10,2,5,'#51435d');r(12,15,1,1,'#f2ad79');r(16,15,1,1,'#f2ad79');r(14,19,2,2,'#dbc7aa');return;
  }
  if(id==='reaper'){
    poly([[12,1],[18,4],[20,12],[22,21],[25,31],[5,31],[9,20],[8,11]],'#302638');
    poly([[12,5],[17,7],[17,13],[11,13]],'#10101b');r(12,9,2,1,'#e6647d');r(16,9,2,1,'#e6647d');l(10,17,8+stride,29,'#65506b');l(21,6,23,31,'#a7a9a0',2);poly([[21,3],[14,1],[5,3],[2,9],[9,5],[21,6]],'#cad2ca');return;
  }
  if(id==='flower'){
    l(13,23,11+stride,32,'#46724d',2);poly([[9,24],[3,20],[4,26],[11,28]],'#698649');
    for(const [x,y] of [[7,5],[15,4],[3,12],[17,12],[7,18],[14,19]]){r(x,y,6,7,'#9d577e');r(x+1,y+1,3,3,'#d58b9c');}
    r(9,10,8,10,'#e5bd6c');r(11,12,2,2,'#44323c');r(15,12,2,2,'#44323c');r(12,17,3,1,'#73573d');return;
  }
  if(id==='mantis'){
    poly([[12,8],[17,8],[19,24],[11,24]],'#506b43');poly([[8,4],[21,4],[17,12],[12,12]],'#7f9d5c');r(9,5,3,3,'#d0ce76');r(18,5,3,3,'#d0ce76');
    l(10,13,5,18,'#8ca863',2);l(5,18,3,12,'#b5bd83',2);l(18,13,24,18,'#8ca863',2);l(24,18,25,11,'#b5bd83',2);
    for(const [x,d] of [[12,-1],[17,1]]){l(x,22,x+d*(5+stride),27,'#87995d');l(x+d*(5+stride),27,x+d*7,31,'#87995d');}return;
  }
  const body={zombie:'#68865a',mudman:'#6d5540',werewolf:'#726c68',mummy:'#b4a789'}[id];
  const light={zombie:'#a2ae76',mudman:'#9d8057',werewolf:'#b7aaa0',mummy:'#e5d5ab'}[id];
  const wide=id==='mudman'||id==='werewolf';
  poly([[wide?7:10,12],[20,10],[23,21],[20,26],[8,27],[wide?5:9,20]],body);
  r(10,4,11,9,body);r(12,5,7,5,light);r(12,8,2,2,'#292b2b');r(18,7,2,2,'#292b2b');r(15,11,6,2,light);
  r(wide?4:7,15,5,10,body);r(21,14,4,10,body);r(wide?3:6,23,5,3,light);r(22,22,4,4,light);
  r(9-stride,26,5,5,body);r(17+stride,25,5,6,body);r(7-stride,30,6,2,light);r(18+stride,30,6,2,light);
  if(id==='zombie'){r(9,16,12,7,'#514c59');r(11,18,3,4,body);r(18,15,3,3,body);r(11,3,8,2,'#373b33');r(13,12,5,1,'#4b3034');}
  if(id==='mudman'){r(6,17,7,5,light);r(17,22,6,2,'#4e4034');r(11,10,3,2,'#d1b56f');r(18,9,3,2,'#d1b56f');}
  if(id==='werewolf'){poly([[9,7],[8,1],[13,5]],body);poly([[17,5],[23,1],[22,9]],body);r(18,10,7,4,light);r(23,10,2,2,'#1c2229');r(21,13,3,2,'#e5d9c1');r(11,15,8,8,light);l(6,24,3,26,'#d8d5c5');l(24,24,27,26,'#d8d5c5');}
  if(id==='mummy'){for(let y=5;y<31;y+=4){r(10,y,10,1,'#7c7766');r(11,y+1,9,1,'#e5d5ab');}r(11,8,10,2,'#37382f');r(12,8,2,1,'#b39a5e');r(18,8,2,1,'#b39a5e');l(8,16,3+stride,21,'#d1bd93',2);}
}
export function spritePixels(id,pose=0,variant=''){
  const key=id+':'+pose+':'+variant;if(cache.has(key))return cache.get(key);
  const p=painter();if(tones[id])drawPerson(p,id,pose);else if(id==='mortaccio'||id==='skeleton')skeleton(p,pose,id==='mortaccio');
  else if(id==='exdash'||id==='ghost')ghost(p,pose,id==='exdash');else beast(p,id,pose);
  // Independent palettes distinguish the stat variants without using original art.
  const palettes={
    'bat-1':{'#51435d':'#725049','#8a7087':'#af8370'},
    'bat-2':{'#51435d':'#555886','#8a7087':'#929cc2'},
    'bat-4':{'#51435d':'#96554e','#8a7087':'#e3a66d','#242334':'#41272d'},
    'bat-5':{'#51435d':'#756f39','#8a7087':'#c1bd75','#242334':'#35351f'},
    'mudman-2':{'#6d5540':'#716f69','#9d8057':'#aaa38b','#4e4034':'#464944'}
  };
  const palette=palettes[variant];if(palette)for(const row of p.cells)for(let i=0;i<row.length;i++)if(palette[row[i]])row[i]=palette[row[i]];
  p.outline();const result=Object.freeze(p.cells.map(row=>Object.freeze(row)));
  if(cache.size>=MAX_GRID_ENTRIES)cache.delete(cache.keys().next().value);
  cache.set(key,result);return result;
}
export function drawSprite(ctx,id,x,y,{scale=1.5,tick=0,moving=false,facing=1,flash=false,reducedMotion=false,variant='',animation=null,spriteSheet=null,prefilter=false,solidFlash=false}={}){
  const pose=animation?.frameIndex ?? (moving&&!reducedMotion?Math.floor(tick/7)%4:0),rows=spritePixels(id,pose,variant);
  let candidateRows=null;
  if(spriteSheet?.enabled && typeof spriteSheet.frame==='function'){
    try{candidateRows=spriteSheet.frame(id, pose, facing, {reducedMotion});}catch{candidateRows=null;}
  }
  const renderedRows = candidateRows || rows;
  const direction=animation?.facing ?? facing;
  ctx.save();try{ctx.translate(Math.round(x),Math.round(y));if(direction<0)ctx.scale(-1,1);
  // Default-off visual comparison: keep every cell and its order. The Canvas
  // filter's coverage rounding can differ, so this is not pixel-equivalent.
  if(solidFlash===true&&flash&&!candidateRows&&Number.isFinite(scale)&&scale>0&&
    ctx.filter==='brightness(2.5)'&&ctx.globalAlpha===1&&ctx.globalCompositeOperation==='source-over'&&
    ctx.shadowBlur===0&&ctx.shadowOffsetX===0&&ctx.shadowOffsetY===0&&
    ['rgba(0, 0, 0, 0)','#00000000'].includes(ctx.shadowColor)){
    let painted=false;ctx.save();
    try{ctx.filter='none';painted=pixelCommands.draw(ctx,renderedRows,scale,true,'#ffffff');}
    finally{ctx.restore();}
    if(painted)return;
  }
  let prefiltered=false;
  if(prefilter===true && !candidateRows && ctx.filter==='brightness(2.5)'){
    if(!prefilterCache)prefilterCache=createSpritePrefilterCache();
    prefiltered=prefilterCache.draw(ctx,renderedRows,scale,flash);
  }
  if(!prefiltered && !rasterCache.draw(ctx,renderedRows,scale,flash) && !pixelCommands.draw(ctx,renderedRows,scale,flash))for(let yy=0;yy<H;yy++)for(let xx=0;xx<W;xx++)if(renderedRows[yy][xx]){
    ctx.fillStyle=flash?'#fff0d6':renderedRows[yy][xx];ctx.fillRect((xx-W/2)*scale,(yy-H)*scale,scale,scale);
  }}finally{ctx.restore();}
}

// Cached grids are renderer-only and contain no game state. Release on run transitions.
export function clearSpriteRenderCaches(){
  rasterCache.clear();pixelCommands.clear();if(prefilterCache){prefilterCache.clear();prefilterCache=null;}cache.clear();
}

export {SPRITE_SHEET_METADATA};
