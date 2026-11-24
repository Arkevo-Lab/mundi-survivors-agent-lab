// Authored same-tick visual example. It is independent of the live experiment.
const at = (x, y, fields = {}) => ({x, y, ...fields});
export const exampleFrame = {
  schema: 'survivors-visual-frame-v1',
  tick: 1890, character: 'antonio', waveMinute: 0, gemsCollected: 18,
  player: at(0, 0, {hp: 89, maxHp: 120, xp: 7, xpToNext: 13, level: 3, facing: 1}),
  enemies: [
    at(-7.7, 2.5, {id: 1, kind: 'bat', sprite: 'bat', radius: .37}),
    at(-6.9, 3.6, {id: 2, kind: 'bat', sprite: 'bat', radius: .37}),
    at(-5.7, 2.8, {id: 3, kind: 'bat', sprite: 'bat', radius: .37}),
    at(3.5, 2.3, {id: 4, kind: 'skeleton', sprite: 'skeleton', radius: .48}),
    at(5.1, 3.2, {id: 5, kind: 'skeleton', sprite: 'skeleton', radius: .48}),
    at(-4.2, -3.1, {id: 6, kind: 'ghost', sprite: 'ghost', radius: .55}),
    at(-3.3, -4, {id: 7, kind: 'ghost', sprite: 'ghost', radius: .55}),
    at(8.7, -3.5, {id: 8, kind: 'zombie', sprite: 'zombie', radius: .6, boss: true})
  ].map(enemy => ({...enemy, frozenUntil: 0, hitUntil: 0})),
  gems: [at(2.1, -1.7, {value: 1}), at(1.4, -2.4, {value: 1}), at(-.8, 2.3, {value: 6}), at(-1.5, 2.8, {value: 2})],
  chests: [at(6.6, 1.9, {tier: 1})],
  pickups: [at(-6.1, -.7, {kind: 'coin'}), at(10, 3.8, {kind: 'roast'})],
  breakables: [at(-10, -2.9), at(10.8, -1.4)],
  projectiles: [at(3.2, -.8, {vx: 5, vy: -1}), at(4.1, -1.1, {vx: 5, vy: -1})],
  santaWaterZones: [at(-6, 3.5, {radius: 1.05})],
  whipStrikes: [at(2.5, -.25, {tick: 1885, until: 1897, area: 1})],
};
export const exampleObservation = {
  tick: exampleFrame.tick,
  player: {
    hp: 89, max_hp: 120, level: 3, xp: 7, xp_to_next: 13, movement: [1, 0],
    equipment: [{name: 'Whip', level: 2}, {name: 'Magic Wand', level: 1}],
  },
  upgrade_offer: {options: [{name: 'Armor'}, {name: 'Whip'}, {name: 'Wings'}]},
};
