import {createResearchPainter} from './render.js';
import {drawSprite} from '../../../public/games/survivors-lab-0.61.0/src/sprites.mjs';
import {whipBounds} from '../../../public/games/survivors-lab-0.61.0/src/combat.mjs';
import {VIEW} from '../../../public/games/survivors-lab-0.61.0/src/stage.mjs';

import {STRUCTURED_NEAR_PROFILE, STRUCTURED_TRAIL_PROFILE, VISUAL_PROFILES, VISUAL_WIDTH, VISUAL_HEIGHT, MAX_VISUAL_IMAGE_BYTES} from './models/visual-input.js';
import {RESEARCH_ACTUAL_TRAIL_MAX_AGE_TICKS} from '../../shared/survivors-research-contract.js';

const scale = VISUAL_WIDTH / VIEW.width;
const overviewWorldScale = VISUAL_WIDTH / 32;
const nearWorldScale = VISUAL_WIDTH / 16;
const center = [VISUAL_WIDTH / 2, VISUAL_HEIGHT / 2];

function ellipse(ctx, x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}
function line(ctx, x, y, x2, y2, color) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.stroke();
}
function diamond(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawActualTrail(ctx, frame, point) {
  const trail = frame.actual_trail;
  if (!Array.isArray(trail) || trail.length !== Math.min(frame.tick, RESEARCH_ACTUAL_TRAIL_MAX_AGE_TICKS) + 1 ||
      trail.at(-1)?.x !== frame.player.x || trail.at(-1)?.y !== frame.player.y ||
      trail.some((position, index) => position?.tick !== frame.tick - trail.length + index + 1 ||
        !Number.isFinite(position.x) || !Number.isFinite(position.y))) {
    throw Error('移动轨迹缺失或与视觉帧的 tick 不一致');
  }
  const first = trail[0];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(...point(first));
  let previous = first;
  let moved = false;
  for (const position of trail.slice(1)) {
    if (position.x === previous.x && position.y === previous.y) continue;
    ctx.lineTo(...point(position));
    previous = position;
    moved = true;
  }
  if (moved) {
    ctx.strokeStyle = '#ba93ff';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

function simpleScene(ctx, frame, observation, schematic, worldScale, trail) {
  const [cx, cy] = center;
  const point = item => [cx + (item.x - frame.player.x) * worldScale, cy + (item.y - frame.player.y) * worldScale];
  ctx.fillStyle = schematic ? '#1c302b' : '#111c26';
  ctx.fillRect(0, 0, VISUAL_WIDTH, VISUAL_HEIGHT);
  const spacing = 2 * worldScale;
  const offsetX = schematic ? ((cx - frame.player.x * worldScale) % spacing + spacing) % spacing : cx % spacing;
  const offsetY = schematic ? ((cy - frame.player.y * worldScale) % spacing + spacing) % spacing : cy % spacing;
  for (let x = offsetX; x < VISUAL_WIDTH; x += spacing) line(ctx, x, 0, x, VISUAL_HEIGHT, schematic ? '#273d35' : '#233343');
  for (let y = offsetY; y < VISUAL_HEIGHT; y += spacing) line(ctx, 0, y, VISUAL_WIDTH, y, schematic ? '#273d35' : '#233343');
  if (trail) drawActualTrail(ctx, frame, point);

  for (const zone of [...(frame.santaWaterZones ?? []), ...(frame.lightningStrikes ?? []), ...(frame.birdZones ?? []),
    ...(frame.garlicAreas ?? []), ...(frame.carnageExplosions ?? [])]) {
    if (!(zone.radius > 0)) continue;
    const r = zone.radius * worldScale;
    ellipse(ctx, ...point(zone), r, r, '#5da4d34a');
  }
  for (const strike of frame.whipStrikes ?? []) {
    const bounds = whipBounds(strike, frame.tick);
    if (!bounds) continue;
    const [x, y] = point({x: bounds.left, y: bounds.top});
    const w = (bounds.right - bounds.left) * worldScale;
    const h = (bounds.bottom - bounds.top) * worldScale;
    if (schematic) ellipse(ctx, x + w / 2, y + h / 2, w / 2, h / 3, '#e4b97170');
    else {
      ctx.fillStyle = '#e4b97150';
      ctx.fillRect(x, y, w, h);
    }
  }
  for (const item of frame.breakables ?? []) {
    const [x, y] = point(item);
    ctx.fillStyle = '#a77e4c';
    ctx.fillRect(x - 3, y - 5, 6, 10);
  }
  for (const item of frame.gems ?? []) diamond(ctx, ...point(item), schematic ? 4 : 8, '#69dca9');
  for (const item of frame.soulHearts ?? []) diamond(ctx, ...point(item), 5, '#f49ab2');
  for (const item of frame.pickups ?? []) ellipse(ctx, ...point(item), 4, 4, '#f0ca71');
  for (const item of frame.chests ?? []) {
    const [x, y] = point(item);
    ctx.fillStyle = '#f6ad5d';
    ctx.fillRect(x - 6, y - 4, 12, 8);
    ctx.fillStyle = '#522f21';
    ctx.fillRect(x - 1, y - 1, 2, 4);
  }
  for (const shot of [...(frame.projectiles ?? []), ...(frame.bibleOrbs ?? []), ...(frame.birdRays ?? [])]) {
    const [x, y] = point(shot);
    ellipse(ctx, x, y, 3, 3, '#83d9f6');
    if (!schematic && Number.isFinite(shot.vx) && Number.isFinite(shot.vy)) {
      line(ctx, x, y, x + shot.vx * 2, y + shot.vy * 2, '#83d9f6');
    }
  }
  for (const enemy of frame.enemies ?? []) {
    const [x, y] = point(enemy);
    const r = Math.max(4, (enemy.radius ?? .3) * worldScale);
    const color = enemy.boss ? '#ff765f' : '#df8b91';
    ellipse(ctx, x, y, r, r, schematic ? '#713a44' : color);
    if (schematic) drawSprite(ctx, enemy.sprite ?? enemy.kind, x, y + 7, {
      scale: enemy.boss ? .78 : .57, facing: x > cx ? -1 : 1, variant: enemy.kind, reducedMotion: true
    });
  }
  const [dx, dy] = observation.player.movement ?? [];
  if (schematic) drawSprite(ctx, frame.character, cx, cy + 9, {scale: .84, facing: frame.player.facing, reducedMotion: true});
  else diamond(ctx, cx, cy, 8, '#e9f7f5');
  if (Number.isFinite(dx) && Number.isFinite(dy) && (dx || dy)) {
    line(ctx, cx + dx * 10, cy + dy * 10, cx + dx * 24, cy + dy * 24, '#f3fbfa');
  }
  const {facing} = frame.player;
  if (!schematic && Array.isArray(observation.player.movement) && (facing === -1 || facing === 1)) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - facing * 4, cy - 22);
    ctx.lineTo(cx + facing * 3, cy - 16);
    ctx.lineTo(cx - facing * 4, cy - 10);
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111c26';
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffcd72';
    ctx.stroke();
    ctx.restore();
  }
}

function drawHud(ctx, frame, observation, profile) {
  const full = profile === 'full-v1';
  const player = observation.player;
  const seconds = Math.floor(frame.tick / 60);
  const time = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const hp = Math.max(0, Math.min(1, player.hp / player.max_hp));
  const xp = Math.max(0, Math.min(1, player.xp / player.xp_to_next));
  ctx.fillStyle = full ? '#111d13ed' : '#111b24ee';
  ctx.fillRect(0, 0, VISUAL_WIDTH, 53);
  ctx.fillRect(0, VISUAL_HEIGHT - 28, VISUAL_WIDTH, 28);
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillStyle = '#f5e9ce';
  const score = frame.gemsCollected === undefined ? [] : ['WAVE ' + (frame.waveMinute + 1), 'GEMS ' + frame.gemsCollected];
  ctx.fillText([time, ...(player.level === undefined ? [] : ['LV ' + player.level]), ...score].join('    '), 12, 19);
  const bar = (x, ratio, color, label) => {
    ctx.fillStyle = '#3a3035';
    ctx.fillRect(x, 28, 104, 7);
    ctx.fillStyle = color;
    ctx.fillRect(x, 28, ratio * 104, 7);
    ctx.fillStyle = '#e7eae0';
    ctx.fillText(label, x, 47);
  };
  ctx.font = '10px system-ui, sans-serif';
  if (Number.isFinite(hp)) bar(12, hp, '#df6e69', `HP ${Math.round(player.hp)}/${Math.round(player.max_hp)}`);
  if (Number.isFinite(xp)) bar(131, xp, '#7eb6ed', `XP ${Math.round(player.xp)}/${Math.round(player.xp_to_next)}`);
  if (observation.upgrade_offer?.options?.length) {
    const options = observation.upgrade_offer.options.map(option => option.name).join('  /  ');
    ctx.fillStyle = '#f1d68c';
    ctx.fillText('UPGRADE  ' + options, 246, 41, 222);
  }
  if (player.equipment) {
    ctx.fillStyle = '#e7eae0';
    ctx.fillText(player.equipment.map(item => item.name + ' ' + item.level).join('  ·  '), 12, VISUAL_HEIGHT - 10, 294);
  }
  if (profile === 'structured-v1') {
    const labels = [['#df8b91', 'ENEMY'], ['#69dca9', 'LOOT'], ['#83d9f6', 'EFFECT']];
    for (const [index, [color, label]] of labels.entries()) {
      const x = 309 + index * 53;
      ellipse(ctx, x, VISUAL_HEIGHT - 13, 2.5, 2.5, color);
      ctx.fillStyle = '#c6d3dd';
      ctx.fillText(label, x + 6, VISUAL_HEIGHT - 10);
    }
  }
}

export function createVisualCapture() {
  const surface = document.createElement('canvas');
  surface.width = VISUAL_WIDTH;
  surface.height = VISUAL_HEIGHT;
  const fullSurface = document.createElement('canvas');
  const full = createResearchPainter(fullSurface, {scale, fixedMotion: true});
  const ctx = surface.getContext('2d', {alpha: false});
  ctx.imageSmoothingEnabled = false;

  return async function capture({visual_frame, observation, profile, signal}) {
    signal?.throwIfAborted();
    const near = profile === STRUCTURED_NEAR_PROFILE;
    const trail = profile === STRUCTURED_TRAIL_PROFILE;
    if ((!near && !trail && (profile === 'none-v1' || !VISUAL_PROFILES.includes(profile))) || !visual_frame?.player || visual_frame.tick !== observation.tick) {
      throw Error('视觉帧缺失或与结构化观测的 tick 不一致');
    }
    const started = performance.now();
    if (profile === 'full-v1') {
      const moving = observation.player.movement?.some(Boolean);
      full(visual_frame, {action_id: moving ? 'move' : 'stop'});
      ctx.drawImage(fullSurface, 0, 0);
    } else simpleScene(ctx, visual_frame, observation, profile === 'schematic-v1', near ? nearWorldScale : overviewWorldScale, trail);
    if (!near) drawHud(ctx, visual_frame, observation, trail ? 'structured-v1' : profile);
    const render_ms = performance.now() - started;
    const encodingStarted = performance.now();
    const encode = (mime, quality) => new Promise(resolve => surface.toBlob(resolve, mime, quality));
    let blob = await encode('image/png');
    let quality;
    if (blob?.size > MAX_VISUAL_IMAGE_BYTES) {
      for (quality of [.88, .76, .64]) {
        signal?.throwIfAborted();
        blob = await encode('image/jpeg', quality);
        if (blob?.type === 'image/jpeg' && blob.size <= MAX_VISUAL_IMAGE_BYTES) break;
      }
    }
    signal?.throwIfAborted();
    if (!blob || blob.type !== (quality === undefined ? 'image/png' : 'image/jpeg') || blob.size > MAX_VISUAL_IMAGE_BYTES) {
      throw Error('视觉图像编码失败或超过 96 KiB');
    }
    const data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    signal?.throwIfAborted();
    return {image: {profile, tick: observation.tick, mime_type: blob.type, data_url},
      render_ms, encode_ms: performance.now() - encodingStarted, ...(quality === undefined ? {} : {jpeg_quality: quality})};
  };
}
