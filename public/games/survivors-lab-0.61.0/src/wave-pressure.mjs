import {ENCOUNTER_PRESSURE_CANDIDATES, FOREST_BOSSES} from './stage.mjs';

export const WAVE_PRESSURE_CONTRACT = 'survivors.wave-pressure.v1';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function waveContract(minute) {
  const row = ENCOUNTER_PRESSURE_CANDIDATES[clamp(Math.trunc(minute), 0, 29)];
  return Object.freeze({contract: WAVE_PRESSURE_CONTRACT, minute: row.minute, intervalTicks: row.intervalTicks, minimumAlive: row.minimumAlive, composition: Object.freeze([...row.composition]), boss: FOREST_BOSSES[row.minute] ?? null});
}

export function spawnBudget(minute, alive = 0) {
  const row = waveContract(minute);
  // Normal outer-rectangle spawning checks the permanent-enemy cap once,
  // then visits each enabled species entry; `alive` excludes event enemies.
  return Math.max(0, Math.trunc(alive)) >= 300 ? 0 : row.composition.length;
}

export function difficultyScale(minute, level = 1) {
  return Number((1 + clamp(minute, 0, 29) * 0.035 + Math.max(0, level - 1) * 0.012).toFixed(4));
}

export function targetPriority(enemy, player = {x: 0, y: 0}) {
  const dx = (enemy?.x ?? 0) - (player?.x ?? 0), dy = (enemy?.y ?? 0) - (player?.y ?? 0);
  return Object.freeze({boss: enemy?.boss ? 1 : 0, distanceSquared: Number((dx * dx + dy * dy).toFixed(4)), id: enemy?.id ?? 0});
}

export function dropPressure(enemy, luck = 1) {
  const base = enemy?.boss ? 3 : enemy?.kind?.includes('large') ? 2 : 1;
  return Number((base * clamp(Number(luck) || 1, 0.25, 4)).toFixed(4));
}

export function rollbackPressure(candidate, expectedContract = WAVE_PRESSURE_CONTRACT) {
  const valid = candidate?.contract === expectedContract && Number.isInteger(candidate?.minute) && Array.isArray(candidate?.composition);
  return Object.freeze({valid, fallback: valid ? null : 'programmatic-fallback', contract: valid ? candidate.contract : expectedContract});
}
