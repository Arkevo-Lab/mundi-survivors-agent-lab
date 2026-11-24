// Pure scene-material and HUD feedback mapping for the presentation layer.
const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

const MATERIALS = Object.freeze({
  grass: Object.freeze({base: '#263e29', accent: '#3e5833', overlay: '#07110f', overlayAlpha: 0.08}),
  cave: Object.freeze({base: '#283239', accent: '#5b6870', overlay: '#111923', overlayAlpha: 0.16}),
  night: Object.freeze({base: '#1a2438', accent: '#536b91', overlay: '#080d22', overlayAlpha: 0.3})
});

function materialLayer(frame) {
  const minute = Math.max(0, number(frame?.waveMinute));
  if (minute >= 20) return 'night';
  if (minute >= 10) return 'cave';
  return 'grass';
}

export function sceneMaterial(frame, reducedMotion = false, customEnabled = true) {
  const layer = customEnabled ? materialLayer(frame) : 'grass';
  const material = MATERIALS[layer];
  return Object.freeze({
    layer,
    tileSize: 48,
    base: material.base,
    accent: material.accent,
    overlay: material.overlay,
    overlayAlpha: customEnabled ? (reducedMotion ? material.overlayAlpha * 0.7 : material.overlayAlpha) : 0,
    drift: reducedMotion ? 0 : number(frame?.tick) % 48,
    reducedMotion: !!reducedMotion
  });
}

export function tileMaterial(tx, ty, frame, reducedMotion = false, customEnabled = true) {
  const material = sceneMaterial(frame, reducedMotion, customEnabled);
  const value = tileMaterialHash(tx, ty, material.layer);
  return Object.freeze({
    layer: material.layer,
    variant: value % 4,
    accent: value % 5 === 0 ? material.accent : material.base,
    material
  });
}

function tileMaterialHash(tx, ty, layer) {
  const seed = Math.imul(Math.trunc(tx), 73856093) ^ Math.imul(Math.trunc(ty), 19349663) ^ Math.imul(layer.length, 83492791);
  return (seed ^ (seed >>> 16)) >>> 0;
}

export function tileMaterialVariant(tx, ty, layer) { return tileMaterialHash(tx, ty, layer) % 4; }

export function hudFeedback(frame, selectedWeapon = '', reducedMotion = false, customEnabled = true) {
  const tick = number(frame?.tick);
  const hasSelection = typeof selectedWeapon === 'string' && selectedWeapon.length > 0;
  const pulse = hasSelection && customEnabled && !reducedMotion ? 0.5 + 0.5 * Math.sin(tick * 0.22) : 0;
  return Object.freeze({
    selected: hasSelection ? selectedWeapon : null,
    pulse,
    scale: 1 + pulse * 0.08,
    reducedMotion: !!reducedMotion
  });
}
