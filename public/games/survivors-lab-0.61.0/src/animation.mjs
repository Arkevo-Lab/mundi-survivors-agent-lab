// Pure presentation state mapping. It consumes copied frame data and never mutates simulation state.
export const ANIMATION_STATES = Object.freeze(['idle', 'run', 'attack', 'hit', 'death']);
const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function frameIndex(state, elapsed, tick, reducedMotion) {
  if (reducedMotion || state === 'idle' || state === 'hit') return 0;
  if (state === 'run') return Math.floor(tick / 7) % 4;
  if (state === 'attack') return Math.min(2, Math.floor(elapsed / 2));
  return Math.min(7, Math.floor(elapsed / 2));
}

export function resolveAnimationState({tick = 0, moving = false, lastAttackTick = -Infinity, hitUntil = 0,
  deathTick = -Infinity, done = false, facing = 1, reducedMotion = false, attackWindow = 8, deathWindow = 18} = {}) {
  const now = number(tick);
  let state = 'idle', elapsed = 0;
  if (done || now >= deathTick && now - deathTick < deathWindow) { state = 'death'; elapsed = Math.max(0, now - deathTick); }
  else if (now < number(hitUntil, -Infinity)) { state = 'hit'; elapsed = Math.max(0, now - number(hitUntil, now)); }
  else if (now >= lastAttackTick && now - lastAttackTick < attackWindow) { state = 'attack'; elapsed = now - lastAttackTick; }
  else if (moving) state = 'run';
  return Object.freeze({state, frameIndex: frameIndex(state, elapsed, now, reducedMotion), facing: facing < 0 ? -1 : 1,
    reducedMotion: !!reducedMotion, elapsed});
}

export function playerAnimationState(frame, {moving = false, reducedMotion = false, facing = frame?.player?.facing} = {}) {
  const player = frame?.player || {};
  return resolveAnimationState({tick:frame?.tick, moving, reducedMotion, facing,
    lastAttackTick:frame?.lastAttackTick, hitUntil:player.invulnerableUntil, done:!!frame?.done});
}

export function enemyAnimationState(frame, enemy, {moving = false, reducedMotion = false, facing = 1} = {}) {
  const tick = number(frame?.tick), death = frame?.recentEnemyDeaths?.find(item => item.id === enemy?.id);
  return resolveAnimationState({tick, moving, reducedMotion, facing, hitUntil:enemy?.hitUntil,
    deathTick:death?.tick, done:false});
}
