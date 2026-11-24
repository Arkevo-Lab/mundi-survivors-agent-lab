import {isLocalMicroProjectionSchema} from './models/local-micro.js';
import {LOCAL_MICRO_PROFILE, MAX_VISUAL_IMAGE_BYTES, VISUAL_HEIGHT, VISUAL_WIDTH} from './models/visual-input.js';

const centerX = VISUAL_WIDTH / 2;
const centerY = VISUAL_HEIGHT / 2;

function diamond(ctx, x, y, size, color) {
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawThreat(ctx, threat, scale) {
  const x = centerX + threat.dx * scale;
  const y = centerY + threat.dy * scale;
  ctx.fillStyle = threat.type === 'enemy' ? '#df8b91' : '#dfaa80';
  if (threat.shape === 'rectangle') {
    const halfWidth = Math.max(2, threat.half_width * scale);
    const halfHeight = Math.max(2, threat.half_height * scale);
    ctx.fillRect(x - halfWidth, y - halfHeight, halfWidth * 2, halfHeight * 2);
  } else if (threat.shape === 'circle') {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, threat.radius * scale), 0, 2 * Math.PI);
    ctx.fill();
  } else {
    // Unknown extent keeps a visible center marker without depicting a collision radius.
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
}

function drawPlayer(ctx, {facing, movement}) {
  diamond(ctx, centerX, centerY, 8, '#e9f7f5');
  if (movement?.some(Boolean)) {
    const [x, y] = movement;
    ctx.strokeStyle = '#f3fbfa';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX + x * 10, centerY + y * 10);
    ctx.lineTo(centerX + x * 24, centerY + y * 24);
    ctx.stroke();
  }
  if (facing !== -1 && facing !== 1) return;
  ctx.beginPath();
  ctx.moveTo(centerX - facing * 4, centerY - 22);
  ctx.lineTo(centerX + facing * 3, centerY - 16);
  ctx.lineTo(centerX - facing * 4, centerY - 10);
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111c26';
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#ffcd72';
  ctx.stroke();
}

export function drawLocalMicro(ctx, projection) {
  const scale = projection.viewport.scale_px_per_unit;
  ctx.fillStyle = '#111c26';
  ctx.fillRect(0, 0, VISUAL_WIDTH, VISUAL_HEIGHT);
  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, projection.viewport.local_radius * scale, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = '#65bdff';
  ctx.lineWidth = 1;
  for (const weapon of projection.weapons??[]) {
    for (const {dx,dy,bounds} of weapon.combat?.active_strikes??[]) {
      if (!bounds) continue;
      const width = bounds.half_width * scale;
      const height = bounds.half_height * scale;
      ctx.strokeRect(centerX + dx*scale - width, centerY + dy*scale - height, width*2, height*2);
    }
  }
  for (const threat of projection.threats) drawThreat(ctx, threat, scale);
  for (const {dx, dy} of projection.local_gems) {
    diamond(ctx, centerX + dx * scale, centerY + dy * scale, 4, '#69dca9');
  }
  ctx.restore();
  drawPlayer(ctx, projection.player);
}

export function createLocalMicroCapture() {
  const canvas = document.createElement('canvas');
  canvas.width = VISUAL_WIDTH;
  canvas.height = VISUAL_HEIGHT;
  const ctx = canvas.getContext('2d', {alpha: false});
  async function encode(surface, tick) {
    const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
    if (!blob || blob.type !== 'image/png' || blob.size > MAX_VISUAL_IMAGE_BYTES) throw Error('局部图像编码失败或超过大小上限');
    const data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return {profile: LOCAL_MICRO_PROFILE, tick, mime_type: 'image/png', data_url};
  }
  return async function prepareLocalMicroImage({projection, signal}) {
    signal?.throwIfAborted();
    const u=projection?.viewport;
    if (!ctx || !isLocalMicroProjectionSchema(projection?.schema) || !Number.isSafeInteger(projection.tick) ||
        projection.tick < 0 || !Number.isFinite(u?.scale_px_per_unit) || u.scale_px_per_unit <= 0 ||
        !Number.isFinite(u.local_radius) || u.local_radius <= 0) {
      throw Error('局部图像缺少有效的同帧观测');
    }
    const renderStart = performance.now();
    drawLocalMicro(ctx, projection);
    const render_ms = performance.now() - renderStart;
    const encodeStart = performance.now();
    const image = await encode(canvas,projection.tick);
    signal?.throwIfAborted();
    return {image,render_ms,encode_ms:performance.now()-encodeStart};
  };
}
