export const COMBAT_CONTEXT_SCHEMA='survivors-combat-context-v1';
export const COMBAT_CONTEXT_INSTRUCTIONS=[
  'combat_context is a same-tick public snapshot, not a prediction. Positions and lengths are in world units, speeds are world units per second, and one game tick is 1/60 second.',
  'The whip range is a maximum horizontal rectangle template, not a radial distance or a current hit. max_half_width and max_half_height are rectangle half-extents; center_forward is the facing-relative horizontal center offset; strike index i starts at 0, and the vertical center offset is (i + 1) * center_y_step.',
  'cooldown_remaining_ticks is the time to the first strike of the next cycle; pending_strikes are separate already queued emissions. The combat_context supplies no active-strike facts; other public observations may still show active hazards. Enemy contact radius is a separate boundary. Null means unknown.',
  'When provider_processing_cap_ms is present, at most that many milliseconds of each provider request are charged to the game clock before frame quantization; the current request’s actual delay is unknown.',
].join(' ');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const num=x=>typeof x==='number'&&Number.isFinite(x);
const nonnegative=x=>num(x)&&x>=0;
const int=x=>Number.isSafeInteger(x)&&x>=0;
const nullable=(x,fn)=>x===null||fn(x);
const range=x=>exact(x,['shape','max_half_width','max_half_height','center_forward','center_y_step'])&&
  x.shape==='rectangle'&&nonnegative(x.max_half_width)&&nonnegative(x.max_half_height)&&
  nonnegative(x.center_forward)&&num(x.center_y_step);
const pending=x=>Array.isArray(x)&&x.length<=128&&x.every(p=>exact(p,['index','in_ticks'])&&int(p.index)&&int(p.in_ticks));
const whipKeys=['status','damage','range','strikes_per_cycle','repeat_ticks','direction_mode','cooldown_remaining_ticks','pending_strikes'];
const factKeys=whipKeys.slice(1);
export function validCombatContext(x,tick){
  if(!exact(x,['schema','tick','facing','whip','provider_processing_cap_ms'])||x.schema!==COMBAT_CONTEXT_SCHEMA||
    !int(x.tick)||x.tick!==tick||![null,-1,1].includes(x.facing)||![null,300].includes(x.provider_processing_cap_ms)||
    !exact(x.whip,whipKeys)||!['equipped','not_equipped','unknown'].includes(x.whip.status))return false;
  const w=x.whip;
  if(w.status!=='equipped')return factKeys.every(k=>w[k]===null);
  return nullable(w.damage,nonnegative)&&nullable(w.range,range)&&nullable(w.strikes_per_cycle,int)&&
    nullable(w.repeat_ticks,int)&&nullable(w.direction_mode,v=>v==='alternating_at_emission')&&
    nullable(w.cooldown_remaining_ticks,int)&&nullable(w.pending_strikes,pending);
}
export function createCombatContext({observation,frame,providerProcessingCapMs=null}){
  const tick=observation?.tick;
  if(!int(tick)||frame?.tick!==tick||![null,300].includes(providerProcessingCapMs))throw new TypeError('Combat context requires a same-tick frame');
  const blank=status=>({status,...Object.fromEntries(factKeys.map(k=>[k,null]))});
  const weapons=observation?.player?.weapon_state;
  let whip=blank('unknown');
  if(Array.isArray(weapons)){
    const matches=weapons.filter(w=>w?.id==='whip');
    if(matches.length===0&&weapons.every(w=>typeof w?.id==='string'))whip=blank('not_equipped');
    else if(matches.length===1){
      const combat=matches[0].combat;
      if(combat&&typeof combat==='object')whip={status:'equipped',...Object.fromEntries(factKeys.map(k=>[k,combat[k]??null]))};
      else whip=blank('equipped');
    }
  }
  const movement=observation?.player?.movement;
  const facingVisible=Array.isArray(movement)&&movement.length===2&&movement.every(num);
  const context={schema:COMBAT_CONTEXT_SCHEMA,tick,facing:facingVisible&&[-1,1].includes(frame.player?.facing)?frame.player.facing:null,
    whip,provider_processing_cap_ms:providerProcessingCapMs};
  if(!validCombatContext(context,tick))throw new TypeError('Invalid public combat facts');
  return context;
}
