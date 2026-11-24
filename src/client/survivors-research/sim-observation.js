import {OBSERVATION_SCHEMA, RESEARCH_CLOSED_PLAN_FEEDBACK, RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK,
  RESEARCH_COVERAGE_SEQUENCE_PROFILE, RESEARCH_EXECUTED_PLAN_FEEDBACK, RESEARCH_SEQUENCE_PROFILE,
  RESEARCH_SLOT_MS, RESEARCH_SLOTS_COUNT, RESEARCH_SLOTS_PROFILE,
  TICK_MS, researchCandidates} from '../../shared/survivors-research-contract.js';
import {PASSIVE_METADATA, WEAPON_METADATA} from '../../../public/games/survivors-lab-0.61.0/src/content-metadata.mjs';
import {WHIP_REPEAT_TICKS, createWhipStrike, whipBounds} from '../../../public/games/survivors-lab-0.61.0/src/combat.mjs';
import {gemRawValue} from '../../../public/games/survivors-lab-0.61.0/src/gem-capacity.mjs';

const LIMITS = {
  'state-compact-v1': {precision: 10, enemies: 24, hazards: 32, loot: 16},
  'state-detail-v1': {precision: 100, enemies: 128, hazards: 128, loot: 64},
  'state-full-v1': {precision: 1_000_000, enemies: Infinity, hazards: Infinity, loot: Infinity},
};
const COIN_VALUES = Object.freeze({coin: 1, 'coin-bag': 10, 'big-coin-bag': 100});
const EFFECT_FIELDS = [
  'damage', 'cooldownTicks', 'speed', 'amount', 'pierce', 'radius', 'area', 'strikes',
  'durationTicks', 'orbitRadius', 'angularSpeed', 'rechargeTicks', 'pulseTicks', 'evolved',
];
const PASSIVE_VALUES = {
  hollowHeartLevel: 'maxHp', emptyTomeLevel: 'cooldownMultiplier', bracerLevel: 'projectileSpeed',
  spinachLevel: 'might', candelabradorLevel: 'area', cloverLevel: 'luck', wingsLevel: 'speed',
  armorLevel: 'armor', attractorLevel: 'magnet', crownLevel: 'growth', duplicatorLevel: 'bonusProjectiles',
};

const weaponKey = id => id.replace(/^(?:gain-|evolve-)|-level$/g, '')
  .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const passiveKeys = {'hollow-heart': 'hollowHeartLevel', 'empty-tome': 'emptyTomeLevel',
  'move-speed': 'wingsLevel', magnet: 'attractorLevel'};

export function projectOffer(snapshot) {
  if (snapshot.done || !snapshot.pendingUpgrade) return null;
  return {
    offer_id: `level-${snapshot.player.level}`,
    options: snapshot.pendingUpgrade.map(({id, label}) => {
      const metadata = WEAPON_METADATA[weaponKey(id)]
        ?? PASSIVE_METADATA[passiveKeys[id] ?? `${weaponKey(id)}Level`];
      return {
        option_id: id,
        name: metadata?.name ?? label,
        description: label,
      };
    }),
  };
}

function equipment(snapshot, detail) {
  const weapons = Object.entries(WEAPON_METADATA).filter(([field]) => snapshot[field]).map(([field, metadata]) => {
    const weapon = snapshot[field];
    const stats = Object.fromEntries(EFFECT_FIELDS.filter(key => Object.hasOwn(weapon, key)).map(key => [key, weapon[key]]));
    return {id: field, name: metadata.name, level: weapon.level,
      ...(detail && {effect: metadata.effect, base_stats: stats})};
  });
  const passives = Object.entries(PASSIVE_METADATA).filter(([field]) => snapshot[field] > 0).map(([field, metadata]) => {
    const stat = PASSIVE_VALUES[field];
    const effective = field === 'emptyTomeLevel' ? Math.max(0.1, snapshot.player[stat] - snapshot[field] * 0.08)
      : field === 'pummarolaLevel' ? snapshot[field] * 0.2 : snapshot.player[stat];
    return {id: field, name: metadata.name, level: snapshot[field],
      ...(detail && {effect: metadata.effect, effective_value: effective})};
  });
  return [...weapons, ...passives];
}

function weaponState(snapshot, visibleEnemies) {
  const {player, tick, whip} = snapshot;
  const precise = value => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  const countdown = at => Number.isSafeInteger(at) ? Math.max(0, at - tick) : null;
  const visibleEnemyIds = new Set(visibleEnemies.map(enemy => enemy.id));
  const rectangle = bounds => ({
    shape: 'rectangle',
    half_width: precise((bounds.right - bounds.left) / 2),
    half_height: precise((bounds.bottom - bounds.top) / 2),
  });
  return Object.keys(WEAPON_METADATA).filter(id => snapshot[id]).map(id => {
    if (id !== 'whip') return {id, combat: null};
    const damage = precise(whip.damage * player.might);
    const area = whip.area * player.area;
    const template = Number.isFinite(area)
      ? createWhipStrike({...player, x: 0, y: 0, facing: 1}, whip, 0, 0, 0)
      : null;
    const maxBounds = template && whipBounds({...template, x: 0, y: 0}, WHIP_REPEAT_TICKS);
    const pending = snapshot.pendingWhips?.map(shot => ({index: shot.index, in_ticks: countdown(shot.tick)}));
    const active = snapshot.whipStrikes?.filter(strike => strike.until > tick).map(strike => {
      const bounds = whipBounds(strike, tick);
      const fullBounds = whipBounds(strike, strike.tick + WHIP_REPEAT_TICKS);
      return {
        id: strike.id, index: strike.index, direction: strike.direction,
        dx: precise(strike.x - player.x), dy: precise(strike.y - player.y),
        bounds: bounds ? rectangle(bounds) : null,
        max_bounds: fullBounds ? rectangle(fullBounds) : null,
        remaining_ticks: countdown(strike.until),
        damage: strike.liveWeaponDamage === true ? damage : precise(strike.damage),
        already_hit_enemy_ids: (strike.hitIds ?? []).filter(enemyId => visibleEnemyIds.has(enemyId)),
      };
    });
    return {id, combat: {
      damage,
      range: maxBounds && {
        shape: 'rectangle',
        max_half_width: precise(maxBounds.right),
        max_half_height: precise(maxBounds.bottom),
        center_forward: precise(template.x),
        center_y_step: precise(template.y),
      },
      strikes_per_cycle: Number.isSafeInteger(whip.strikes) && Number.isSafeInteger(player.bonusProjectiles)
        ? whip.strikes + Math.min(10, player.bonusProjectiles) : null,
      repeat_ticks: WHIP_REPEAT_TICKS,
      direction_mode: 'alternating_at_emission',
      cooldown_remaining_ticks: countdown(whip.nextTick),
      pending_strikes: pending ?? null,
      active_strikes: active ?? null,
    }};
  });
}

function currentEffects(snapshot) {
  const {tick, player} = snapshot;
  const withKind = (items, kind, stationary = false) =>
    items.map(item => ({...item, kind, ...(stationary && {vx: 0, vy: 0})}));
  return [
    ...snapshot.projectiles,
    ...withKind(snapshot.lightningStrikes, 'lightning-strike', true),
    ...withKind(snapshot.santaWaterZones, 'santa-water-zone'),
    ...withKind(snapshot.carnageExplosions, 'carnage-explosion', true),
    ...snapshot.birdRays.map(ray => ({...ray, kind: `${ray.slot}-ray`, until: ray.untilTick})),
    ...snapshot.bibleShots.map((shot, index) => ({...shot, ...snapshot.bibleOrbs[index], kind: 'bible-orb'})),
    ...snapshot.garlicAreas.map(area => ({...area, x: player.x, y: player.y, kind: 'garlic-area',
      radius: snapshot.garlic.radius * player.area, until: area.untilTick})),
    ...snapshot.whipStrikes.flatMap(strike => {
      const bounds = whipBounds(strike, tick);
      return bounds ? [{...strike, kind: 'whip-strike', vx: 0, vy: 0, halfWidth: (bounds.right - bounds.left) / 2,
        halfHeight: (bounds.bottom - bounds.top) / 2}] : [];
    }),
  ];
}

function selectVisible(rows, player, limit, project) {
  const visible = [];
  for (const item of rows) {
    const dx = item.x - player.x, dy = item.y - player.y;
    if (Math.abs(dx) <= 16 && Math.abs(dy) <= 9) visible.push({item, dx, dy, d2: dx * dx + dy * dy});
  }
  visible.sort((a, b) => a.d2 - b.d2 || a.item.id - b.item.id);
  const items = visible.slice(0, limit).map(({item, dx, dy}) => project(item, dx, dy));
  return {items, coverage: {visible: visible.length, sent: items.length, truncated: visible.length > items.length}};
}

export function projectObservation({
  snapshot, config, runId, movement, movementReceipts, movementReceiptOffset, previousMovement, movementHistory, sampledAt, now,
}) {
  const {player, tick} = snapshot;
  const profile = config.observation_profile;
  const full = profile === 'state-full-v1';
  const detail = profile !== 'state-compact-v1';
  const fields = config.observation_fields;
  const has = field => !fields || fields.includes(field);
  const limits = LIMITS[profile];
  const round = n => Math.round(n * limits.precision) / limits.precision || 0;
  const point = (item, dx, dy) => ({id: item.id, kind: item.kind, dx: round(dx), dy: round(dy)});
  const velocity = item => [item.vx, item.vy].every(Number.isFinite) ? [round(item.vx), round(item.vy)] : null;
  const enemies = has('enemies') && selectVisible(snapshot.enemies, player, limits.enemies, (item, dx, dy) => ({
    ...point(item, dx, dy), radius: round(item.radius),
    ...(detail && {velocity: velocity(item), hp: item.hp, frozen: item.frozenUntil > tick}),
  }));
  const hazards = has('hazards') && selectVisible(currentEffects(snapshot), player, limits.hazards, (item, dx, dy) => ({
    ...point(item, dx, dy), hostile: false, velocity: velocity(item),
    ...(item.radius === undefined ? {shape: 'rectangle', half_width: round(item.halfWidth), half_height: round(item.halfHeight)}
      : {shape: 'circle', radius: round(item.radius)}),
    ...(detail && {remaining_ticks: item.ttl ?? (item.until === undefined ? null : Math.max(0, item.until - tick)),
      ...(item.phase && {phase: item.phase})}),
  }));
  const visibleLoot = has('loot') && [
    ...snapshot.gems.map(item => ({...item, kind: 'experience', value: gemRawValue(item)})),
    ...snapshot.pickups.map(item => ({...item, value: item.kind === 'fever-coin'
      ? (item.halfUnits ?? 1) / 2 : COIN_VALUES[item.kind]})),
    ...snapshot.chests.map(item => ({...item, kind: 'chest'})),
    ...snapshot.soulHearts.map(item => ({...item, kind: 'soul-heart'})),
    ...(full ? snapshot.breakables : []),
  ];
  const loot = visibleLoot && selectVisible(visibleLoot, player, limits.loot, (item, dx, dy) => ({
    ...point(item, dx, dy),
    ...(item.attraction ? {being_collected: true} : {}),
    ...(detail && {
      ...(item.value === undefined ? {} : {value: item.value}),
      ...(item.kind === 'chest' ? {tier: item.tier} : {}),
    }),
  }));
  const upgrade_offer = projectOffer(snapshot);
  const slotDistance = player.speed * RESEARCH_SLOT_MS / 1000;
  const observation = {
    schema: OBSERVATION_SCHEMA, run_id: runId, observation_id: `obs-${tick}`, tick,
    sim_time_ms: tick * TICK_MS, sampled_at_ms: sampledAt, profile,
    player: {
      ...(has('health') && {hp: player.hp, max_hp: player.maxHp}),
      ...(has('progress') && {level: player.level, xp: player.xp, xp_to_next: player.xpToNext}),
      ...(has('movement') && {speed: player.speed, movement}),
      ...(has('movement') && config.action_profile === RESEARCH_SLOTS_PROFILE && {movement_distance: {
        unobstructed_50_ms: slotDistance, unobstructed_100_ms: slotDistance * 2,
        unobstructed_500_ms: slotDistance * RESEARCH_SLOTS_COUNT,
      }}),
      ...(has('movement') && config.action_profile === RESEARCH_SLOTS_PROFILE && movementReceipts?.length > 0 &&
        (config.movement_feedback === 'receipts' || config.movement_feedback === 'trajectory') &&
        {movement_receipts: movementReceipts, ...(movementReceiptOffset && {movement_receipt_offset: movementReceiptOffset})}),
      ...(previousMovement && !snapshot.done && !upgrade_offer && has('movement') && has('health') &&
        config.action_profile === RESEARCH_SEQUENCE_PROFILE &&
        (config.movement_feedback === RESEARCH_EXECUTED_PLAN_FEEDBACK ||
          config.movement_feedback === RESEARCH_CLOSED_PLAN_FEEDBACK) &&
        {previous_movement: previousMovement}),
      ...(movementHistory?.length > 0 && !snapshot.done && !upgrade_offer && has('movement') && has('health') &&
        config.action_profile === RESEARCH_SEQUENCE_PROFILE && config.movement_feedback === RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK &&
        {movement_history: movementHistory}),
      ...(has('equipment') && {equipment: equipment(snapshot, detail)}),
      ...(detail && has('equipment') && config.action_profile === RESEARCH_COVERAGE_SEQUENCE_PROFILE &&
        {weapon_state: weaponState(snapshot, enemies?.items ?? [])}),
      ...(loot && {gem_pickup_radius: player.magnet}),
    },
    ...(enemies && {enemies: enemies.items}), ...(hazards && {hazards: hazards.items}),
    ...(loot && {loot: loot.items}),
    ...((full || fields) && has('score') && {score: {gems_collected: player.gemsCollected, wave: snapshot.waveMinute + 1}}),
    coverage: {
      ...(enemies && {enemies: enemies.coverage}), ...(hazards && {hazards: hazards.coverage}),
      ...(loot && {loot: loot.coverage}),
    },
    upgrade_offer, terminal: snapshot.done, reason: snapshot.reason,
  };
  const candidates = snapshot.done ? [] : researchCandidates(config.action_profile, upgrade_offer);
  observation.projected_at_ms = now();
  return {observation, candidates};
}
