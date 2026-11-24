import {VIEW} from '../../../public/games/survivors-lab-0.61.0/src/stage.mjs';
import {projectClockLancet} from '../../../public/games/survivors-lab-0.61.0/src/feedback.mjs';
import {PASSIVE_METADATA, WEAPON_METADATA} from '../../../public/games/survivors-lab-0.61.0/src/content-metadata.mjs';

export const VISUAL_FRAME_SCHEMA = 'survivors-visual-frame-v1';

const halfWidth = VIEW.width / (2 * VIEW.scale);
const halfHeight = VIEW.height / (2 * VIEW.scale);
const PLAYER_FIELDS = ['x', 'y', 'facing', 'facingX', 'facingY', 'hp', 'maxHp', 'level',
  'xp', 'xpToNext', 'area', 'invulnerableUntil'];
const ENTITY_FIELDS = {
  enemies: ['id', 'kind', 'sprite', 'radius', 'boss', 'frozenUntil', 'hitUntil', 'recoilUntil', 'fixedDirection', 'directionX'],
  breakables: ['id', 'kind', 'radius'],
  gems: ['id', 'value'],
  pickups: ['id', 'kind', 'halfUnits'],
  chests: ['id', 'tier'],
  soulHearts: ['id'],
  projectiles: ['id', 'kind', 'radius', 'vx', 'vy', 'evolved'],
  santaWaterZones: ['id', 'radius', 'until'],
  birdZones: ['kind', 'index', 'radius', 'until'],
  birdRays: ['id', 'slot', 'phase', 'radius'],
  bibleOrbs: ['radius'],
  whipStrikes: ['id', 'tick', 'until', 'area', 'direction', 'evolved'],
  carnageExplosions: ['id', 'radius', 'tick', 'until'],
  lightningStrikes: ['id', 'radius', 'until'],
  recentEnemyDeaths: ['id', 'kind', 'sprite', 'tick'],
};
const COLLECTION_FIELDS = {
  enemies: ['enemies', 'recentEnemyDeaths'],
  loot: ['breakables', 'gems', 'pickups', 'chests', 'soulHearts'],
  hazards: ['projectiles', 'santaWaterZones', 'birdZones', 'birdRays', 'bibleOrbs',
    'whipStrikes', 'carnageExplosions', 'lightningStrikes', 'garlicAreas'],
};
const WEAPON_FIELDS = ['level', 'evolved'];
const PROJECTED_WEAPONS = Object.entries(WEAPON_METADATA);
const PROJECTED_PASSIVES = Object.entries(PASSIVE_METADATA);

function fields(object, keys) {
  const projection = {};
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined) projection[key] = value;
  }
  return projection;
}

export function projectVisualFrame(snapshot, movement, sampledAt, now, selectedFields, actualTrail) {
  const {player, character, stage, waveMinute, tick, done, lastAttackTick} = snapshot;
  const frame = {
    schema: VISUAL_FRAME_SCHEMA,
    tick, character, stage, waveMinute, done, gemsCollected: player.gemsCollected, lastAttackTick,
    sampled_at_ms: sampledAt,
    player: fields(player, PLAYER_FIELDS),
    movement: [...movement],
    pendingUpgrade: done ? null : snapshot.pendingUpgrade?.map(({id, label}) => ({id, label})) ?? null,
    equipment: [],
  };

  for (const [collection, keys] of Object.entries(ENTITY_FIELDS)) {
    const entities = [];
    for (const entity of snapshot[collection]) {
      const dx = entity.x - player.x;
      const dy = entity.y - player.y;
      if (!(Math.abs(dx) <= halfWidth && Math.abs(dy) <= halfHeight)) continue;
      const projected = {x: entity.x, y: entity.y, ...fields(entity, keys)};
      // The original paints a health bar for bosses only.
      if (collection === 'enemies' && entity.boss) {
        projected.hp = entity.hp;
        projected.maxHp = entity.maxHp;
      }
      entities.push(projected);
    }
    frame[collection] = entities;
  }

  for (const [id, {name}] of PROJECTED_WEAPONS) {
    const item = snapshot[id];
    frame[id] = item ? fields(item, WEAPON_FIELDS) : null;
    if (item) frame.equipment.push({id, name, level: item.level, evolved: item.evolved === true});
  }
  for (const [id, {name}] of PROJECTED_PASSIVES) {
    const level = snapshot[id];
    if (level > 0) frame.equipment.push({id, name, level});
  }
  frame.garlicAreas = snapshot.garlic && (snapshot.garlic.legacyArea || snapshot.garlicAreas.length) ? [{
    x: player.x, y: player.y, radius: snapshot.garlic.radius * player.area, evolved: snapshot.garlic.evolved,
  }] : [];
  frame.clockLancetBeam = projectClockLancet(snapshot);
  if (selectedFields) {
    for (const [field, collections] of Object.entries(COLLECTION_FIELDS)) {
      if (!selectedFields.includes(field)) {
        for (const collection of collections) frame[collection] = [];
      }
    }
    if (!selectedFields.includes('hazards')) {
      frame.clockLancetBeam = null;
      delete frame.lastAttackTick;
    }
    if (!selectedFields.includes('health')) {
      delete frame.player.hp;
      delete frame.player.maxHp;
      delete frame.player.invulnerableUntil;
    }
    if (!selectedFields.includes('progress')) {
      delete frame.player.level;
      delete frame.player.xp;
      delete frame.player.xpToNext;
    }
    if (!selectedFields.includes('score')) {
      delete frame.gemsCollected;
    }
    if (!selectedFields.includes('movement')) {
      frame.movement = [0, 0];
      Object.assign(frame.player, {facing: 1, facingX: 1, facingY: 0});
    }
    if (!selectedFields.includes('equipment')) {
      frame.equipment = [];
      for (const [id] of PROJECTED_WEAPONS) frame[id] = null;
    }
  }
  if (actualTrail?.length && !done && !frame.pendingUpgrade &&
      (!selectedFields || selectedFields.includes('movement'))) {
    frame.actual_trail = actualTrail;
  }
  frame.projected_at_ms = now();
  return frame;
}
