import assert from 'node:assert/strict';
import test from 'node:test';
import {drawLocalMicro} from '../src/client/survivors-research/micro-visual-render.js';

test('local micro draws the shared projection, facing and no scene or HUD data', () => {
  const calls = [];
  const ctx = new Proxy({}, {get(target, key) {
    return key in target ? target[key] : (...args) => calls.push([key, target.fillStyle, ...args]);
  }});
  const projection = {
    viewport: {scale_px_per_unit: 20, local_radius:3.2},
    player: {facing: -1, movement: [0, 1], xp: 111, hp: 100},
    threats: [
      {type: 'enemy', shape: 'circle', dx: -2, dy: 1, radius: 0.4},
      {type: 'hazard', shape: 'rectangle', dx: 1, dy: -1, half_width: 0.5, half_height: 0.25},
      {type: 'hazard', shape: 'unknown', dx: 3, dy: 2},
    ],
    local_gems: [{dx: 0.4, dy: 0.3},{dx:2,dy:0}],
    near_gems: [{dx: 0.4, dy: 0.3}],
    loot: [{id: 4, dx: 6, dy: 0}],
  };
  drawLocalMicro(ctx, projection);
  assert.deepEqual(calls.filter(([method]) => method === 'fillRect'), [
    ['fillRect', '#111c26', 0, 0, 480, 270],
    ['fillRect', '#dfaa80', 250, 110, 20, 10],
    ['fillRect', '#dfaa80', 298, 173, 4, 4],
  ]);
  assert.ok(calls.some(([method, color, x, y, radius]) => method === 'arc' && color === '#df8b91' && x === 200 && y === 155 && radius === 8));
  assert.equal(calls.filter(([method, color]) => method === 'fill' && color === '#69dca9').length, 2);
  assert.ok(calls.some(([method,,x,y,radius]) => method === 'arc' && x === 240 && y === 135 && radius === 64));
  assert.ok(calls.findIndex(([method]) => method === 'clip') < calls.findIndex(([method,color]) => method === 'fill' && color === '#69dca9'));
  assert.equal(calls.filter(([method, color]) => method === 'fill' && color === '#e9f7f5').length, 1);
  assert.ok(calls.some(([method, , x, y]) => method === 'lineTo' && x === 237 && y === 119));
  assert.ok(calls.every(([method]) => method !== 'fillText' && method !== 'drawImage'));
});
