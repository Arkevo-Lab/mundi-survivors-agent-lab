import {drawSprite} from '../../../public/games/survivors-lab-0.61.0/src/sprites.mjs';
import {enemyAnimationState, playerAnimationState} from '../../../public/games/survivors-lab-0.61.0/src/animation.mjs';
import {sceneMaterial, tileMaterialVariant} from '../../../public/games/survivors-lab-0.61.0/src/scene-material.mjs';
import {whipBounds} from '../../../public/games/survivors-lab-0.61.0/src/combat.mjs';
import {VIEW} from '../../../public/games/survivors-lab-0.61.0/src/stage.mjs';

const TAU = Math.PI * 2;
const tileSize = 96;
const foliage = ['#324b32', '#3a5133', '#4a5e3b', '#263b2c'];

export function createResearchPainter(canvas, {scale = 1, fixedMotion = false} = {}) {
  const {width, height} = VIEW;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', {alpha: false});
  ctx.scale(canvas.width / width, canvas.height / height);
  ctx.imageSmoothingEnabled = false;
  const reducedMotion = fixedMotion ? {matches: false} : matchMedia('(prefers-reduced-motion: reduce)');
  const shade = ctx.createRadialGradient(width / 2, height / 2, 120, width / 2, height / 2, width * .69);
  shade.addColorStop(0, '#00000000');
  shade.addColorStop(1, '#080e09ad');
  const groundTiles = foliage.map((color, variant) => {
    const tile = document.createElement('canvas');
    tile.width = tile.height = tileSize;
    const draw = tile.getContext('2d');
    for (let i = 0; i < 72; i++) {
      const n = Math.imul(i + 19 * variant + 1, 0x9e3779b9) >>> 0;
      draw.fillStyle = i % 3 === 0 ? color : '#15271d5b';
      draw.fillRect(n % 92, (n >>> 12) % 93, i % 7 === 0 ? 5 : 2, i % 5 === 0 ? 3 : 1);
    }
    return tile;
  });
  function circle(x, y, radius, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
  }
  return function paint(frame, movement, cameraOffsetY = 0) {
    if (!frame?.player) return;
    const player = frame.player;
    const scene = sceneMaterial(frame, reducedMotion.matches);
    const originX = player.x * VIEW.scale - width / 2;
    const originY = (player.y + cameraOffsetY) * VIEW.scale - height / 2;
    const x = value => value * VIEW.scale - originX;
    const y = value => value * VIEW.scale - originY;
    const visible = item => x(item.x) > -45 && x(item.x) < width + 45 && y(item.y) > -45 && y(item.y) < height + 45;
    ctx.fillStyle = scene.base;
    ctx.fillRect(0, 0, width, height);
    for (let ty = Math.floor(originY / tileSize); ty * tileSize < originY + height; ty++) {
      for (let tx = Math.floor(originX / tileSize); tx * tileSize < originX + width; tx++) {
        const left = Math.floor(tx * tileSize - originX);
        const top = Math.floor(ty * tileSize - originY);
        const variant = tileMaterialVariant(tx, ty, scene.layer);
        if (tx % 13 === 0 || ty % 17 === 0) {
          ctx.fillStyle = '#666044';
          ctx.fillRect(left, top, tx % 13 === 0 ? 28 : tileSize, ty % 17 === 0 ? 28 : tileSize);
        }
        ctx.drawImage(groundTiles[variant], left, top);
      }
    }
    for (const item of frame.breakables ?? []) {
      if (!visible(item)) continue;
      ctx.fillStyle = '#3a2618';
      ctx.fillRect(x(item.x) - 4, y(item.y) - 3, 8, 15);
      ctx.fillStyle = '#e8ad5f';
      ctx.fillRect(x(item.x) - 4, y(item.y) - 10, 8, 8);
      ctx.fillStyle = '#fff0a2';
      ctx.fillRect(x(item.x) - 2, y(item.y) - 13, 4, 6);
    }
    for (const gem of frame.gems ?? []) {
      if (!visible(gem)) continue;
      ctx.save();
      ctx.translate(x(gem.x), y(gem.y));
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = gem.value > 4 ? '#e06b55' : gem.value > 1 ? '#8dd263' : '#56b5e8';
      ctx.fillRect(-3.5, -3.5, 7, 7);
      ctx.fillStyle = '#dceeff';
      ctx.fillRect(-3.5, -3.5, 3, 2);
      ctx.restore();
    }
    for (const item of frame.pickups ?? []) {
      if (visible(item)) circle(x(item.x), y(item.y), 5, '#e7b96b');
    }
    for (const chest of frame.chests ?? []) {
      if (!visible(chest)) continue;
      ctx.fillStyle = '#7f4d29';
      ctx.fillRect(x(chest.x) - 10, y(chest.y) - 8, 20, 14);
      ctx.strokeStyle = '#f6cf6f';
      ctx.strokeRect(x(chest.x) - 9, y(chest.y) - 7, 18, 12);
    }
    for (const heart of frame.soulHearts ?? []) {
      if (visible(heart)) circle(x(heart.x), y(heart.y), 5, '#e89fd2');
    }
    for (const zone of [...(frame.santaWaterZones ?? []), ...(frame.birdZones ?? []),
      ...(frame.lightningStrikes ?? []), ...(frame.carnageExplosions ?? []), ...(frame.garlicAreas ?? [])]) {
      if (Number.isFinite(zone.radius) && zone.radius > 0) circle(x(zone.x), y(zone.y), zone.radius * VIEW.scale, '#62c6f24a');
    }
    for (const projectile of [...(frame.projectiles ?? []), ...(frame.bibleOrbs ?? []), ...(frame.birdRays ?? [])]) {
      if (visible(projectile)) circle(x(projectile.x), y(projectile.y), 4, '#fff3b1');
    }
    for (const strike of frame.whipStrikes ?? []) {
      const bounds = whipBounds(strike, frame.tick);
      if (!bounds) continue;
      ctx.save();
      ctx.globalAlpha = bounds.alpha * .77;
      ctx.strokeStyle = '#ffdba7';
      ctx.lineWidth = 3;
      const left = x(bounds.left), right = x(bounds.right);
      const top = y(bounds.top), bottom = y(bounds.bottom);
      ctx.beginPath();
      ctx.ellipse((left + right) / 2, (top + bottom) / 2, (right - left) / 2, (bottom - top) / 4, 0, Math.PI * .04, Math.PI * 1.16);
      ctx.stroke();
      ctx.restore();
    }
    for (const enemy of frame.enemies ?? []) {
      if (!visible(enemy)) continue;
      const facing = enemy.x > player.x ? -1 : 1;
      const moving = frame.tick >= enemy.frozenUntil;
      drawSprite(ctx, enemy.sprite ?? enemy.kind, x(enemy.x), y(enemy.y) + 12, {
        scale: enemy.boss ? 1.8 : 1, tick: frame.tick + enemy.id * 7, variant: enemy.kind, moving, facing,
        flash: frame.tick < enemy.hitUntil, reducedMotion: reducedMotion.matches,
        animation: enemyAnimationState(frame, enemy, {moving, facing, reducedMotion: reducedMotion.matches})
      });
    }
    const moving = Boolean(movement?.action_id && movement.action_id !== 'stop');
    const playerY = height / 2 - cameraOffsetY * VIEW.scale;
    drawSprite(ctx, frame.character, width / 2, playerY + 15, {
      scale: 1.25, tick: frame.tick, moving, facing: player.facing, reducedMotion: reducedMotion.matches,
      animation: playerAnimationState(frame, {moving, reducedMotion: reducedMotion.matches})
    });
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
    if (Number.isFinite(player.hp) && player.maxHp > 0) {
      ctx.fillStyle = '#18201b';
      ctx.fillRect(width / 2 - 25, playerY + 23, 50, 5);
      ctx.fillStyle = '#d46f65';
      ctx.fillRect(width / 2 - 25, playerY + 23, 50 * Math.max(0, player.hp / player.maxHp), 5);
    }
  };
}

export function createResearchRenderer(canvas) {
  const paint = createResearchPainter(canvas);
  let pending, raf = 0;
  return (frame, movement, cameraOffsetY) => {
    pending = [frame, movement, cameraOffsetY];
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(...pending); });
  };
}
