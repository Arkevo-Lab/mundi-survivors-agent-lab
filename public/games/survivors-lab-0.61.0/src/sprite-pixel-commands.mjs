// Cache only immutable procedural pixel commands. Every occupied pixel keeps its
// original row-major draw order, rectangle, transform, alpha and filter. In
// particular, adjacent pixels are never merged: fractional-edge coverage matters.
const WIDTH=28, HEIGHT=34, LIMIT=256;
export function createSpritePixelCommands(){
  const entries=new Map();
  function commands(rows){
    if(entries.has(rows))return entries.get(rows);
    if(!Array.isArray(rows)||!Object.isFrozen(rows)||rows.length!==HEIGHT||
      !rows.every(row=>Array.isArray(row)&&Object.isFrozen(row)&&row.length===WIDTH&&
        row.every(color=>color===null||typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color))))return null;
    const pixels=[];
    for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++)if(rows[y][x])pixels.push(x-WIDTH/2,y-HEIGHT,rows[y][x]);
    if(entries.size>=LIMIT)entries.delete(entries.keys().next().value);
    entries.set(rows,pixels);return pixels;
  }
  function draw(ctx,rows,scale,flash=false,flashColor='#fff0d6'){
    const pixels=commands(rows);if(!pixels)return false;
    // Start afresh on each call: callers can change context state between sprites.
    let previous=null;
    for(let i=0;i<pixels.length;i+=3){
      const color=flash?flashColor:pixels[i+2];
      if(color!==previous){ctx.fillStyle=color;previous=color;}
      ctx.fillRect(pixels[i]*scale,pixels[i+1]*scale,scale,scale);
    }
    return true;
  }
  return Object.freeze({draw,clear:()=>entries.clear()});
}
