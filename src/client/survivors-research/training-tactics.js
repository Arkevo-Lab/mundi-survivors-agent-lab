import {RESEARCH_SLOTS_PROFILE, RESEARCH_SLOT_WAIT_ID, researchCandidates, researchMovement}
  from '../../shared/survivors-research-contract.js';
import {createWhipStrike, whipBounds, WHIP_REPEAT_TICKS}
  from '../../../public/games/survivors-lab-0.61.0/src/combat.mjs';

const headings = researchCandidates(RESEARCH_SLOTS_PROFILE).map(({id}) => {
  const {x, y} = researchMovement(RESEARCH_SLOTS_PROFILE, id);
  const magnitude = Math.hypot(x, y) || 1;
  return {direction: id === RESEARCH_SLOT_WAIT_ID ? 'wait' : id.split(':')[1], x: x / magnitude, y: y / magnitude};
});
const round = value => Math.round(value * 100) / 100 || 0;

function segmentDistance({dx, dy}, x, y, distanceSquared) {
  const along = distanceSquared ? Math.max(0, Math.min(1, (dx * x + dy * y) / distanceSquared)) : 0;
  return Math.hypot(dx - x * along, dy - y * along);
}

function whipEnvelope(snapshot, facing) {
  const player = {...snapshot.player, x: 0, y: 0, facing};
  const strike = createWhipStrike(player, snapshot.whip, 0, 0, 0);
  const {left, top, right, bottom} = whipBounds(strike, WHIP_REPEAT_TICKS);
  return [left, top, right, bottom].map(round);
}

export function projectTrainingTactics(snapshot, observation) {
  const distance = observation.player?.movement_distance?.unobstructed_500_ms;
  if (snapshot.tick !== observation.tick || observation.terminal !== false || observation.upgrade_offer ||
      !Number.isFinite(distance) || distance < 0 || ![-1, 1].includes(snapshot.player.facing)) {
    throw new TypeError('Expected a same-tick fixed-slot movement observation for tactical diagnostics');
  }
  const gems = (observation.loot ?? []).filter(gem => gem.kind === 'experience' && !gem.being_collected);
  const enemies = observation.enemies ?? [];
  return {
    facing: snapshot.player.facing === -1 ? 'left' : 'right',
    primary_whip: snapshot.whip ? {
      next_ticks: Math.max(1, snapshot.whip.nextTick - snapshot.tick),
      left: whipEnvelope(snapshot, -1),
      right: whipEnvelope(snapshot, 1),
    } : null,
    headings: headings.map(({direction, x, y}) => {
      const dx = x * distance, dy = y * distance;
      const lengthSquared = dx * dx + dy * dy;
      const fromPath = item => segmentDistance(item, dx, dy, lengthSquared);
      const approach = gems.reduce((best, gem) => Math.max(best, Math.hypot(gem.dx, gem.dy) - fromPath(gem)), 0);
      const clearance = enemies.reduce((nearest, enemy) => Math.min(nearest, fromPath(enemy) - enemy.radius), Infinity);
      return {direction, gem_approach: gems.length ? round(approach) : null,
        enemy_clearance: enemies.length ? round(clearance) : null};
    }),
  };
}
