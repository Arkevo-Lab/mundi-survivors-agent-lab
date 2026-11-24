import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {crc32,deflateSync,inflateSync} from 'node:zlib';

const width=480;
const height=270;
const pixelCount=width*height;
const radius=4;
const maxPng=96*1024;
const prefix='data:image/png;base64,';
export const imageDigest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function decodePng(png) {
  assert.ok(png.length<=maxPng,'PNG size limit');
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  let offset=8, size=0, ended=false;
  const idat=[];
  while (offset < png.length) {
    const length=png.readUInt32BE(offset);
    const kind=png.toString('ascii',offset+4,offset+8);
    assert.ok(offset+12+length<=png.length,'Truncated PNG chunk');
    const payload=png.subarray(offset+8,offset+8+length);
    assert.equal(crc32(png.subarray(offset+4,offset+8+length)),png.readUInt32BE(offset+8+length));
    offset+=length+12;
    if (kind==='IHDR') {
      assert.equal(size,0,'Repeated IHDR');
      assert.deepEqual([payload.length,payload.readUInt32BE(0),payload.readUInt32BE(4),payload[8],...payload.subarray(10)],[13,480,270,8,0,0,0]);
      assert.ok([2,6].includes(payload[9]));
      size=payload[9]===2?3:4;
    } else if (kind==='IDAT') {
      idat.push(payload);
    } else if (kind==='IEND') {
      assert.equal(length,0);
      ended=true;
      break;
    } else {
      assert.ok(!['tRNS','acTL','fcTL','fdAT'].includes(kind));
    }
  }
  assert.ok(ended && offset===png.length && size && idat.length);
  const stride=480*size;
  const filtered=inflateSync(Buffer.concat(idat),{maxOutputLength:270*(stride+1)});
  assert.equal(filtered.length,270*(stride+1));
  const rgba=Buffer.alloc(pixelCount*4,255);
  let previous=Buffer.alloc(stride);
  for (let y=0;y<270;y++) {
    const start=y*(stride+1), filter=filtered[start];
    assert.ok(filter<=4);
    const row=Buffer.from(filtered.subarray(start+1,start+1+stride));
    for (let x=0;x<stride;x++) {
      const a=x<size?0:row[x-size], b=previous[x], c=x<size?0:previous[x-size];
      if (filter===1) row[x]+=a;
      if (filter===2) row[x]+=b;
      if (filter===3) row[x]+=(a+b)>>1;
      if (filter===4) {
        const p=a+b-c;
        const distances=[Math.abs(p-a),Math.abs(p-b),Math.abs(p-c)];
        row[x]+=[a,b,c][distances.indexOf(Math.min(...distances))];
      }
    }
    for (let x=0;x<480;x++) row.copy(rgba,(y*480+x)*4,x*size,(x+1)*size);
    previous=row;
  }
  return rgba;
}

export function encodeOpaquePng(rgba) {
  assert.equal(rgba.length,pixelCount*4);
  const stride=1+width*3;
  const lines=Buffer.alloc(height*stride);
  for (let i=0;i<pixelCount;i++) {
    assert.equal(rgba[i*4+3],255);
    const y=Math.floor(i/width),x=i%width;
    rgba.copy(lines,y*stride+1+x*3,i*4,i*4+3);
  }
  const chunk=(label,data)=>{
    const name=Buffer.from(label,'ascii'), header=Buffer.alloc(4), checksum=Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
    return Buffer.concat([header,name,data,checksum]);
  };
  const dimensions=Buffer.alloc(13);
  dimensions.writeUInt32BE(width,0);
  dimensions.writeUInt32BE(height,4);
  dimensions[8]=8;
  dimensions[9]=2;
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',dimensions),
    chunk('IDAT',deflateSync(lines,{level:9})),chunk('IEND',Buffer.alloc(0))]);
  assert.ok(png.length<=96*1024,'Composite PNG exceeds frozen size ceiling');
  return png;
}

export function capturePng(image,tick) {
  assert.deepEqual([image?.profile,image?.tick,image?.mime_type],['local-micro-v1',tick,'image/png']);
  const url=image.data_url;
  assert.ok(typeof url==='string'&&url.startsWith(prefix)&&url.length<=prefix.length+4*Math.ceil(maxPng/3),'Invalid capture image');
  const bytes=Buffer.from(url.slice(prefix.length),'base64');
  assert.ok(bytes.length>0&&bytes.length<=maxPng&&url===prefix+bytes.toString('base64'),'Invalid capture PNG bytes');
  return bytes;
}

export function pngImage(bytes,tick) {
  return {profile:'local-micro-v1',tick,mime_type:'image/png',data_url:prefix+bytes.toString('base64')};
}

function gemCenters(projection) {
  assert.equal(projection.schema,'survivors-local-micro-v1');
  const scale=projection.viewport?.scale_px_per_unit;
  assert.ok(Number.isFinite(scale)&&scale>0&&Array.isArray(projection.near_gems));
  return projection.near_gems.map(({dx,dy})=>{
    assert.ok(Number.isFinite(dx)&&Number.isFinite(dy));
    const center=[width/2+dx*scale,height/2+dy*scale];
    assert.ok(center.every(Number.isFinite));
    return center;
  });
}

export function gemSourceMap(projection) {
  const centers=gemCenters(projection);
  return Buffer.from(Uint8Array.from({length:pixelCount},(_,i)=>{
    const x=i%width,y=Math.floor(i/width);
    return Number(centers.some(([cx,cy])=>
      Math.max(x-cx,cx-x-1,0)+Math.max(y-cy,cy-y-1,0)<radius));
  }));
}

export function composeGemImage({projection,original,raw,clock=()=>performance.now()}) {
  const spans={};
  const measure=(name,operation)=>{
    const started=clock();
    try {return operation();}
    finally {spans[name]=clock()-started;}
  };
  const tick=projection.tick;
  const empty=Array.isArray(projection.near_gems)&&projection.near_gems.length===0;
  const a=measure('original_base64_decode_ms',()=>capturePng(original,tick));
  const r=empty?a:measure('raw_base64_decode_ms',()=>capturePng(raw,tick));
  const aPixels=measure('original_png_decode_ms',()=>decodePng(a));
  const rPixels=empty?aPixels:measure('raw_png_decode_ms',()=>decodePng(r));
  const map=measure('geometry_map_ms',()=>gemSourceMap(projection));
  const pixels=measure('rgba_selection_ms',()=>{
    const chosen=Buffer.from(aPixels);
    for(let i=0;i<pixelCount;i++) if (map[i]) rPixels.copy(chosen,4*i,4*i,4*i+4);
    return chosen;
  });
  const png=empty?a:measure('composite_png_encode_ms',()=>encodeOpaquePng(pixels));
  const differences=measure('composite_verification_ms',()=>{
    const decoded=empty?aPixels:decodePng(png);
    assert.ok(decoded.equals(pixels),'Composite PNG alters selected pixels');
    let fromRaw=0;
    const rawDifferences=[], compositeDifferences=[];
    for (let i=0;i<pixelCount;i++) {
      const pos=4*i,from=Boolean(map[i]);
      const aa=aPixels.readUInt32BE(pos),rr=rPixels.readUInt32BE(pos),bb=decoded.readUInt32BE(pos);
      assert.equal(bb,from?rr:aa,'Composite selected the wrong source');
      fromRaw+=Number(from);
      if (aa===rr) continue;
      const point={x:i%width,y:Math.floor(i/width),A:[...aPixels.subarray(pos,pos+4)],
        raw_B:[...rPixels.subarray(pos,pos+4)],composite:[...decoded.subarray(pos,pos+4)],source:from?'raw_B':'original_A'};
      rawDifferences.push(point);
      if (aa!==bb) compositeDifferences.push(point);
    }
    return {from_raw:fromRaw,from_A:pixelCount-fromRaw,raw_differences:rawDifferences,composite_differences:compositeDifferences};
  });
  const image=measure('composite_base64_encode_ms',()=>empty?original:pngImage(png,tick));
  return {image,original:a,raw:r,png,map,spans,evidence:{
    method:'a-outside-raw-b-inside-gem-geometry-v1',tick,width,height,empty_gems:empty,
    original_png_sha256:imageDigest(a),raw_png_sha256:imageDigest(r),composite_png_sha256:imageDigest(png),
    original_rgba_sha256:imageDigest(aPixels),raw_rgba_sha256:imageDigest(rPixels),composite_rgba_sha256:imageDigest(pixels),
    source_map_sha256:imageDigest(map),...differences,
  }};
}
