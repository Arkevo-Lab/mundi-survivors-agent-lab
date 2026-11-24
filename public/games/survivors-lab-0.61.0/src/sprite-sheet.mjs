// Custom-generated candidate sheet. It is intentionally unverified and has no external image assets.
export const SPRITE_SHEET_METADATA = Object.freeze({
  id: 'survivors-custom-candidate-0.84',
  status: 'unverified-custom',
  license: 'custom-generated',
  source: 'procedural-grid',
  externalAssets: false,
  grid: Object.freeze({columns: 4, cellWidth: 28, cellHeight: 34})
});

const W = 28;
const H = 34;
const hashId = id => [...String(id)].reduce((value, char) => (value * 33 + char.charCodeAt(0)) >>> 0, 5381);
const palette = id => {
  const seed = hashId(id);
  const colors = ['#7dc4bb', '#d9b86c', '#d66d67', '#9b8fd1', '#7aa7d8', '#a7c66a'];
  return Object.freeze({body: colors[seed % colors.length], light: '#f4e5bd', shade: '#263141', eye: '#f9f2cb'});
};

function frame(id, pose = 0) {
  const cells = Array.from({length: H}, () => Array(W).fill(null));
  const color = palette(id);
  const step = [0, -1, 0, 1][((pose % 4) + 4) % 4];
  const rect = (x, y, width, height, fill) => {
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) {
      if (xx >= 0 && xx < W && yy >= 0 && yy < H) cells[yy][xx] = fill;
    }
  };
  rect(10, 4, 9, 7, color.light);
  rect(11, 2, 8, 3, color.body);
  rect(8, 11, 13, 13, color.body);
  rect(10, 13, 9, 3, color.light);
  rect(11, 17, 7, 4, color.shade);
  rect(8 - step, 24, 6, 7, color.body);
  rect(17 + step, 24, 6, 7, color.body);
  rect(6 - step, 30, 7, 2, color.shade);
  rect(18 + step, 30, 7, 2, color.shade);
  rect(9, 7, 2, 2, color.eye);
  rect(18, 7, 2, 2, color.eye);
  return Object.freeze(cells.map(row => Object.freeze(row)));
}

export function createSpriteSheetCandidate({enabled = false} = {}) {
  const cache = new Map();
  return Object.freeze({
    enabled: !!enabled,
    metadata: SPRITE_SHEET_METADATA,
    frame(id, pose = 0, facing = 1, {reducedMotion = false} = {}) {
      const normalizedPose = reducedMotion ? 0 : ((Math.trunc(pose) % 4) + 4) % 4;
      const key = `${id}:${normalizedPose}:${facing < 0 ? -1 : 1}`;
      if (!cache.has(key)) cache.set(key, frame(id, normalizedPose));
      return cache.get(key);
    }
  });
}
