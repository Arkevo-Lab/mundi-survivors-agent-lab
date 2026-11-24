import {researchMovement,RESEARCH_SEQUENCE_MAX_SEGMENTS,researchSequenceTicks,TICK_HZ} from '../../shared/survivors-research-contract.js';

const relevant = new Set(['action_applied','movement_ended','movement_plan_ended','player_hit','observation_sampled','upgrade_selected','movement_plan_truncated']);
const direction = id => /^move:(up|down|left|right):hold:\d+$/.exec(id)?.[1] ?? null;

export function createExecutionWindow(node) {
  const base = node.source.tick;
  const inherited=node.node_state?.harness;
  const initial=inherited?.movement;
  const queued=inherited?.movementPlan;
  const initialHits=node.facts.hits_taken;
  const profile=node.source.config.action_profile;
  const planBudget=researchSequenceTicks(profile);
  const duration=entry=>Math.ceil(entry.amount*TICK_HZ/1000);
  const remainingAtBase=initial?.deadline-base;
  const planStart=inherited?.planInfo?.started_tick;
  const inheritedActive=initial?.entry?.kind==='hold'&&direction(initial.entry.id)&&
    Number.isSafeInteger(initial.startTick)&&initial.startTick>=1&&initial.startTick<=base+1&&
    Number.isSafeInteger(planStart)&&planStart>=1&&planStart<=base&&planStart<=initial.startTick&&
    Number.isSafeInteger(remainingAtBase)&&remainingAtBase>0&&Array.isArray(queued)&&
    queued.length<RESEARCH_SEQUENCE_MAX_SEGMENTS&&queued.every(part=>part?.entry?.kind==='hold'&&
      direction(part.entry.id)&&Number.isSafeInteger(part.duration)&&part.duration>0)&&
    remainingAtBase+queued.reduce((sum,part)=>sum+part.duration,0)<=planBudget
    ? {id:initial.entry.id,start:initial.startTick,end:initial.deadline,
      pending:queued.map(({entry,duration})=>({id:entry.id,duration})),planStart} : null;
  const knownIdle=initial?.entry?.id==='stop'&&inherited.planInfo===null&&Array.isArray(queued)&&queued.length===0;
  const events = [];
  const watermarks = new Map();
  let previous = null;
  let previousAvailable = false;

  function record(event) {
    if (!relevant.has(event.type)) return;
    if (event.type === 'observation_sampled') {
      if(!watermarks.has(event.observation_id))watermarks.set(event.observation_id,
        {tick:event.tick,count:events.length,terminal:event.terminal===true});
      return;
    }
    events.push(structuredClone(event));
  }

  function recover(tick, count) {
    const byTick = new Map();
    for (const event of events.slice(0,count)) {
      if (!Number.isSafeInteger(event.tick) || event.tick <= base || event.tick > tick) return null;
      const group = byTick.get(event.tick) ?? [];
      group.push(event);
      byTick.set(event.tick, group);
    }
    const frames = new Map();
    let active = inheritedActive;
    let known = Boolean(inheritedActive) || knownIdle;
    let hitsThrough = initialHits;
    let explicitStop = false;
    for (let frame = base + 1; frame <= tick; frame++) {
      const group = byTick.get(frame) ?? [];
      const acknowledgements = group.filter(event => event.type === 'action_applied');
      const ends = group.filter(event => event.type === 'movement_ended');
      const planEnds = group.filter(event => event.type === 'movement_plan_ended');
      const hitEvents = group.filter(event => event.type === 'player_hit');
      if (hitEvents.length > 1 || hitEvents.some(event => event.hits_taken !== ++hitsThrough)) return null;
      const hits = hitEvents.length;
      if (acknowledgements.length > 1) return null;
      const ack = acknowledgements[0];
      const upgrades = group.filter(event=>event.type==='upgrade_selected');
      const truncations = group.filter(event=>event.type==='movement_plan_truncated');
      if (ack) {
        if (ack.applied_tick !== frame) return null;
        const seq = ack.action_ids;
        if (!Array.isArray(seq) || seq[0] !== ack.action_id) return null;
        const upgrade = /^choose:([^:]+):([^:]+)$/.exec(ack.action_id);
        if (upgrade ? seq.length!==1 || upgrades.length!==1 || upgrades[0].offer_id!==upgrade[1] ||
            upgrades[0].option_id!==upgrade[2] : upgrades.length) return null;
        const stop = ack.action_id==='stop' && seq.length===1;
        const reason = stop ? 'stopped' : 'replaced';
        if (known) {
          if (active && active.start < frame) {
            const close = ends.shift();
            if (close?.action_id !== active.id || close.started_tick !== active.start || close.reason !== reason) return null;
          }
          if (active) {
            const close = planEnds.shift();
            if (close?.started_tick !== active.planStart || close.reason !== reason) return null;
          }
        } else {
          // A replacement ACK establishes state even when the inherited prefix was unavailable.
          if (ends[0]?.reason===reason) ends.shift();
          if (planEnds[0]?.reason===reason) planEnds.shift();
        }
        if (stop || upgrade) {
          active = null;
          explicitStop = stop;
          if (truncations.length) return null;
        } else {
          let remaining=planBudget;
          let requested=0;
          const segments=[];
          for (const id of seq) {
            const entry=researchMovement(profile,id);
            if (entry?.kind!=='hold' || !direction(id)) return null;
            const ticks=duration(entry);
            requested+=ticks;
            const scheduled=Math.min(ticks,remaining);
            if (scheduled>0) segments.push({id,duration:scheduled});
            remaining-=scheduled;
          }
          const [first,...pending]=segments;
          if (!first) return null;
          const truncated=truncations[0];
          if (requested>planBudget
            ? truncations.length!==1 || truncated.requested_ticks!==requested ||
              truncated.scheduled_ticks!==planBudget || truncated.action_ids?.join()!==seq.join()
            : truncations.length) return null;
          active={id:first.id,start:frame,end:frame+first.duration-1,pending,planStart:frame};
          explicitStop=false;
        }
        known=true;
      } else if (upgrades.length || truncations.length) return null;
      if (!known) {
        frames.set(frame,null);
        continue;
      }
      frames.set(frame, {action:active ? direction(active.id) : explicitStop ? 'stop' : null,hits});
      if (active?.end === frame) {
        const close = ends.shift();
        if (close?.action_id !== active.id || close.started_tick !== active.start || close.reason !== 'hold-expired') return null;
        const [next,...pending] = active.pending;
        if (next) active = {id:next.id, start:frame+1, end:frame+next.duration, pending, planStart:active.planStart};
        else {
          const closePlan = planEnds.shift();
          if (closePlan?.started_tick !== active.planStart || closePlan.reason !== 'completed') return null;
          active = null;
        }
      }
      if (ends.length || planEnds.length) return null;
    }
    return {frames,known,active};
  }

  function observe(observation,{omitWatermark=false,includeRemainingPlan=false}={}) {
    const tick=observation.tick;
    const watermark=omitWatermark?null:watermarks.get(observation.observation_id);
    const matched=watermark?.tick===tick;
    const recovered=matched?recover(tick,watermark.count):null;
    const frames=recovered?.known?recovered.frames:null;
    const from=previous;
    const available=previousAvailable&&frames&&tick>previous;
    previous=tick;
    previousAvailable=!!frames;
    let interval=null;
    if(from!==null&&available){
      const segments=[];
      let lastAction=null,hits_taken=0;
      for(let current=from+1;current<=tick;current++){
        const row=frames.get(current);
        if(!row)break;
        hits_taken+=row.hits;
        if(row.action){
          if(row.action===lastAction)segments.at(-1).executed_ticks++;
          else segments.push({action:row.action,executed_ticks:1});
        }
        lastAction=row.action;
        if(current===tick)interval={from_tick_exclusive:from,through_tick_inclusive:tick,segments,hits_taken};
      }
    }
    if(!includeRemainingPlan)return interval;
    const active=recovered?.active;
    // The current tick has already run. The first count starts at tick + 1.
    const terminal=matched&&watermark.terminal&&observation.terminal===true;
    const segments=terminal||!recovered?.known||!active?[]:[
      {direction:direction(active.id),remaining_ticks:active.end-tick},
      ...active.pending.map(part=>({direction:direction(part.id),remaining_ticks:part.duration})),
    ];
    const status=terminal?'idle':!recovered?.known?'unknown':segments.length?'active':'idle';
    return {interval,remaining_plan:{status,as_of_tick:tick,segments}};
  }
  return {record,observe};
}
