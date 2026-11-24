// The official demo reverses enemy pursuit briefly after a hit, scaled by
// weapon and enemy knockback. Distances and durations here are prototype tuning.
const HIT_TICKS = 8;
const round = value => Math.round(value * 1e6) / 1e6;

export function applyEnemyImpact(enemy, player, tick, strength = 5) {
  if (enemy.hp <= 0) return;
  enemy.hitUntil = tick + HIT_TICKS;
  // The demo gives Death knockback resistance. It must keep pursuing.
  if (enemy.kind === 'reaper') return;
  const dx = enemy.x - player.x, dy = enemy.y - player.y;
  const distance = Math.hypot(dx, dy);
  enemy.recoilX = round(distance ? dx / distance : player.facing || 1);
  enemy.recoilY = round(distance ? dy / distance : 0);
  const resistance = enemy.knockback;
  enemy.recoilSpeed = round(Math.min(12, enemy.speed * strength * resistance));
  // Replace, rather than accumulate impulses: rapid hits cannot launch a foe
  // arbitrarily far. Zero-knockback attacks still briefly interrupt pursuit.
  enemy.recoilUntil = tick + HIT_TICKS;
}

export function moveEnemy(enemy, player, tick, tickHz = 60) {
  if (tick < enemy.frozenUntil) return;
  if (tick < enemy.recoilUntil) {
    enemy.x = round(enemy.x + enemy.recoilX * enemy.recoilSpeed / tickHz);
    enemy.y = round(enemy.y + enemy.recoilY * enemy.recoilSpeed / tickHz);
    return;
  }
  if (enemy.fixedDirection) {
    if (enemy.directionX === null || enemy.directionY === null) {
      const dx = player.x - enemy.x, dy = player.y - enemy.y, distance = Math.hypot(dx, dy) || 1;
      enemy.directionX = round(dx / distance); enemy.directionY = round(dy / distance);
    }
    enemy.x = round(enemy.x + enemy.directionX * enemy.speed / tickHz);
    enemy.y = round(enemy.y + enemy.directionY * enemy.speed / tickHz);
    return;
  }
  const dx = player.x - enemy.x, dy = player.y - enemy.y;
  const distance = Math.hypot(dx, dy) || 1;
  enemy.x = round(enemy.x + dx / distance * enemy.speed / tickHz);
  enemy.y = round(enemy.y + dy / distance * enemy.speed / tickHz);
}

// Each slash is fixed in world space when it is emitted. Repeat shots use the
// player's position/facing at their own emission tick, as in the demo timers.
export const WHIP_REPEAT_TICKS = 6;
export const WHIP_LIFETIME_TICKS = 12;
export function createWhipStrike(player, whip, tick, index, id) {
  const area = whip.area * player.area;
  const direction = player.facing * (index % 2 ? -1 : 1);
  return {id, tick, until: tick + WHIP_LIFETIME_TICKS, index, direction,
    x: round(player.x + direction * 1.5 * area),
    y: round(player.y - 0.53 * (index + 1)),
    area, evolved: whip.evolved, damage: whip.damage * player.might, hitIds: []};
}

// The collision rectangle and artwork share growing bounds. World dimensions
// are independent tuning; the sample supports 100 ms grow + 100 ms fade.
export function whipBounds(strike, tick) {
  const age = tick - strike.tick;
  if (age <= 0 || tick >= strike.until) return null;
  const scale = Math.min(1, age / WHIP_REPEAT_TICKS);
  const halfWidth = 1.8 * strike.area * scale, halfHeight = 1.25 * strike.area * scale;
  return {left: strike.x - halfWidth, right: strike.x + halfWidth,
    top: strike.y - halfHeight, bottom: strike.y + halfHeight,
    alpha: age <= WHIP_REPEAT_TICKS ? 1 : (strike.until - tick) / WHIP_REPEAT_TICKS};
}
export function whipContains(strike, target, tick, bounds = whipBounds(strike, tick)) {
  if (!bounds) return false;
  const dx = target.x - Math.max(bounds.left, Math.min(bounds.right, target.x));
  const dy = target.y - Math.max(bounds.top, Math.min(bounds.bottom, target.y));
  return dx * dx + dy * dy <= (target.radius ?? 0) ** 2;
}
export function copyWhipStrike(strike) { return {...strike, hitIds: [...strike.hitIds]}; }
