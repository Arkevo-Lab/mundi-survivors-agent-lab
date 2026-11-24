const WINDOW = 600;
const MAX_SAMPLES = 256;
const validTick = n => Number.isSafeInteger(n) && n >= 0;
const finite = Number.isFinite;

// Stores only public samples and the already-supported frame odometry, never a world checkpoint.
export function createStrategyMemory() {
  let runId = null;
  let samples = [];
  let actions = [];
  function observe({observation, frame, hitsTaken}) {
    const tick = observation?.tick, player = frame?.player;
    if (!validTick(tick) || !observation.run_id || frame?.tick !== tick ||
        !finite(player?.x) || !finite(player?.y) || !finite(observation.player?.hp) ||
        !validTick(frame.gemsCollected) || !validTick(hitsTaken) ||
        (runId && observation.run_id !== runId) || (samples.length && tick < samples.at(-1).tick)) return false;
    runId = observation.run_id;
    const sample = {tick, x:player.x, y:player.y, hp:observation.player.hp,
      hits:hitsTaken, pickups:frame.gemsCollected};
    if (samples.at(-1)?.tick === tick) samples[samples.length-1] = sample;
    else samples.push(sample);
    samples = samples.filter(row => row.tick >= tick-WINDOW).slice(-MAX_SAMPLES);
    actions = actions.filter(row => row.tick >= tick-WINDOW);
    return true;
  }
  function recordAction({applied_tick, action_id}) {
    if (!validTick(applied_tick) || typeof action_id !== 'string' || !samples.length ||
        applied_tick < samples.at(-1).tick-WINDOW || applied_tick > samples.at(-1).tick+WINDOW) return false;
    actions.push({tick:applied_tick, action_id});
    actions = actions.slice(-MAX_SAMPLES);
    return true;
  }
  function snapshot() {
    if (!samples.length) return null;
    const first=samples[0], last=samples.at(-1);
    const selected = new Set([0,samples.length-1]);
    for (let i=1;i<samples.length-1;i++) {
      const a=samples[i-1], b=samples[i], c=samples[i+1];
      const x1=Math.sign(b.x-a.x), y1=Math.sign(b.y-a.y), x2=Math.sign(c.x-b.x), y2=Math.sign(c.y-b.y);
      if ((x1 || y1 || x2 || y2) && (x1!==x2 || y1!==y2)) selected.add(i);
    }
    const turns=[...selected].sort((a,b)=>a-b);
    const indices=turns.length<=21 ? turns : Array.from({length:21},(_,i)=>turns[Math.round(i*(turns.length-1)/20)]);
    if (indices.length<21 && samples.length>indices.length) {
      for (let i=1;i<20 && indices.length<21;i++) {const index=Math.round(i*(samples.length-1)/20); if (!indices.includes(index)) indices.push(index);}
      indices.sort((a,b)=>a-b);
    }
    const trajectory=indices.map(i=>({tick:samples[i].tick,dx:samples[i].x-last.x,dy:samples[i].y-last.y}));
    const counts={};
    for (const row of actions) if (row.tick >= first.tick && row.tick <= last.tick)
      counts[row.action_id] = (counts[row.action_id] ?? 0) + 1;
    return {schema:'survivors-strategy-history-v1',run_id:runId,from_tick:first.tick,to_tick:last.tick,
      coverage_ticks:last.tick-first.tick,window_ticks:WINDOW,
      displacement:{dx:last.x-first.x,dy:last.y-first.y},hp_delta:last.hp-first.hp,
      hits_delta:last.hits-first.hits,pickups_delta:last.pickups-first.pickups,action_counts:counts,trajectory};
  }
  function exportState() { return structuredClone({schema:'survivors-strategy-memory-v1',run_id:runId,samples,actions:actions.filter(a=>a.tick<= (samples.at(-1)?.tick ?? -1))}); }
  function importState(state, newRunId) {
    if (state?.schema !== 'survivors-strategy-memory-v1' || typeof newRunId !== 'string' || !newRunId ||
        !Array.isArray(state.samples) || state.samples.length > MAX_SAMPLES || !Array.isArray(state.actions) ||
        state.actions.length > MAX_SAMPLES || state.samples.some((s,i) => !validTick(s.tick) || !finite(s.x) ||
          !finite(s.y) || !finite(s.hp) || !validTick(s.hits) || !validTick(s.pickups) || i>0 && s.tick<=state.samples[i-1].tick) ||
        state.actions.some(a => !validTick(a.tick) || typeof a.action_id !== 'string') ||
        (state.samples.length && (state.samples.at(-1).tick-state.samples[0].tick > WINDOW ||
          state.actions.some(a => a.tick>state.samples.at(-1).tick || a.tick<state.samples.at(-1).tick-WINDOW)))) {
      throw new TypeError('Invalid strategy memory state');
    }
    runId=newRunId; samples=structuredClone(state.samples); actions=structuredClone(state.actions);
  }
  return {observe,recordAction,snapshot,exportState,importState};
}
