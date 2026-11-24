const bandHalfWidth = 7.7;

function horizontalBand(columns, rows, stagger = 0) {
  return Object.freeze(rows.flatMap((y, row) => Array.from({length: columns}, (_, column) => {
    const offset = (2 * column / (columns - 1) - 1) * bandHalfWidth + stagger * (row % 2 ? 1 : -1);
    return Object.freeze({x: Number(offset.toFixed(4)), y});
  })));
}

const enemyPositions = horizontalBand(12, [2.5, 3.7]);
const gemPositions = horizontalBand(15, [4.75, 5.3, 5.85, 6.4], 0.275);
const ids = (count, after = 0) => Object.freeze(Array.from({length: count}, (_, index) => after + index + 1));

export const BAT_CRYSTAL_BANDS = Object.freeze({
  id: 'bat-crystal-bands-v1',
  seed: 154,
  character: 'antonio',
  enemyKind: 'bat-3',
  enemyPositions,
  gemPositions,
  initialEnemyIds: ids(enemyPositions.length),
  initialGemIds: ids(gemPositions.length, enemyPositions.length),
  enemyRespawns: false,
});
