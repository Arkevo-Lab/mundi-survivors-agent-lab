import {RESEARCH_SLOT_TICKS, RESEARCH_SLOT_WAIT_ID, TICK_HZ} from '../../shared/survivors-research-contract.js';
import {MAX_VISUAL_IMAGE_BYTES, TRAJECTORY_PROFILE, VISUAL_HEIGHT, VISUAL_WIDTH} from './models/visual-input.js';

const CENTER = [120, 141];

function dot(ctx, [x, y], radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fill();
}

function pathLine(ctx, a, b, color) {
  const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.lineTo(...b);
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 6) {
    for (const offset of [-.55, .55]) {
      ctx.moveTo(...b);
      ctx.lineTo(b[0] - 6 * Math.cos(theta + offset), b[1] - 6 * Math.sin(theta + offset));
    }
  }
  ctx.stroke();
}

export function drawTrajectory(ctx, receipts, target, offset) {
  const width = VISUAL_WIDTH;
  const height = VISUAL_HEIGHT;
  ctx.fillStyle = '#08121e';
  ctx.fillRect(0, 0, width, height);
  ctx.font = 'bold 16px monospace';
  ctx.fillStyle = '#f1f8ff';
  ctx.fillText('EXECUTED MOVEMENT', 16, 24);
  ctx.font = '11px monospace';
  ctx.fillText('World units  +x right  +y down', 16, 43);
  ctx.fillText('Older → newer', 247, 43);

  ctx.save();
  ctx.beginPath();
  ctx.rect(12, 53, 218, 191);
  ctx.clip();
  ctx.strokeStyle = '#23394f';
  ctx.lineWidth = 1;
  for (let x = CENTER[0] % 32; x < 230; x += 32) {
    ctx.beginPath(); ctx.moveTo(x, 53); ctx.lineTo(x, 244); ctx.stroke();
  }
  for (let y = CENTER[1] % 32; y < 244; y += 32) {
    ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(230, y); ctx.stroke();
  }

  const points = [[-(offset?.dx ?? 0), -(offset?.dy ?? 0)]];
  for (const {dx, dy} of [...receipts].reverse()) {
    const [x, y] = points.at(-1);
    points.push([x - dx, y - dy]);
  }
  points.reverse();
  const extent = Math.max(1, ...points.flat().map(Math.abs), Math.abs(target?.dx ?? 0), Math.abs(target?.dy ?? 0));
  const scale = Math.min(64, 77 / extent);
  const toPixels = ([x, y]) => [CENTER[0] + x * scale, CENTER[1] + y * scale];
  let point = toPixels(points[0]);
  dot(ctx, point, 4, '#a9b9ce');
  for (const [index, receipt] of receipts.entries()) {
    const next = toPixels(points[index + 1]);
    const color = receipt.action_id === RESEARCH_SLOT_WAIT_ID ? '#ffbe5b' : '#64e4ff';
    pathLine(ctx, point, next, color);
    dot(ctx, next, receipt.action_id === RESEARCH_SLOT_WAIT_ID ? 5 : 2.5, color);
    if (receipt.action_id === RESEARCH_SLOT_WAIT_ID) {
      ctx.fillStyle = color;
      ctx.fillText('W' + (index + 1), next[0] + 6, next[1] - 6);
    }
    point = next;
  }
  if (target) {
    const targetPoint = toPixels([target.dx, target.dy]);
    dot(ctx, targetPoint, 6, '#d5ff79');
  }
  if (receipts.length && offset && (offset.dx !== 0 || offset.dy !== 0)) {
    ctx.strokeStyle = '#a9b9ce';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(...point);
    ctx.lineTo(...CENTER);
    ctx.stroke();
    ctx.setLineDash([]);
    dot(ctx, point, 3.5, '#a9b9ce');
  }
  ctx.strokeStyle = '#f1f8ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(...CENTER, 7, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#a9b9ce';
  ctx.fillText('Dashed: from last close to now', 15, 259);
  const rulerUnits = [0.5, 1, 2, 4, 8].find(value => value * scale >= 24) ?? 8;
  pathLine(ctx, [20, 225], [20 + rulerUnits * scale, 225], '#f1f8ff');
  ctx.fillStyle = '#f1f8ff';
  ctx.fillText(rulerUnits.toFixed(2) + ' u', 20, 217);
  if (target) {
    ctx.fillStyle = '#d5ff79';
    ctx.fillText('Gem now: ' + target.dx.toFixed(3) + ', ' + target.dy.toFixed(3) + ' u', 245, 244);
    ctx.fillStyle = '#f1f8ff';
  }
  ctx.fillText('Slot      ms      signed dx / dy', 245, 64);
  if (!receipts.length) ctx.fillText('No executed slots yet', 245, 90);
  const signed = value => (value >= 0 ? '+' : '') + value.toFixed(3);
  for (const [index, receipt] of receipts.entries()) {
    const direction = receipt.action_id === RESEARCH_SLOT_WAIT_ID ? 'wait' : receipt.action_id.split(':')[1];
    const duration = (receipt.executed_ticks * 1000 / TICK_HZ).toFixed(receipt.executed_ticks === RESEARCH_SLOT_TICKS ? 0 : 1);
    ctx.fillStyle = direction === 'wait' ? '#ffbe5b' : '#64e4ff';
    ctx.fillText(String(index + 1) + ' ' + direction, 245, 85 + index * 24);
    ctx.fillStyle = '#f1f8ff';
    ctx.fillText(duration.padStart(4) + '    ' + signed(receipt.dx) + ' ' + signed(receipt.dy), 333, 85 + index * 24);
  }
}

export function createTrajectoryCapture() {
  const canvas = document.createElement('canvas');
  canvas.width = VISUAL_WIDTH;
  canvas.height = VISUAL_HEIGHT;
  const ctx = canvas.getContext('2d', {alpha: false});
  return async ({observation, signal}) => {
    signal?.throwIfAborted();
    const started = performance.now();
    const target = observation.loot?.find(item => item.kind === 'experience' && !item.being_collected &&
      Number.isFinite(item.dx) && Number.isFinite(item.dy));
    drawTrajectory(ctx, observation.player?.movement_receipts ?? [], target, observation.player?.movement_receipt_offset);
    const render_ms = performance.now() - started;
    const encoding = performance.now();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (blob?.type !== 'image/png' || blob.size > MAX_VISUAL_IMAGE_BYTES) {
      throw Error('轨迹 PNG 编码失败或超过 96 KiB');
    }
    const data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    signal?.throwIfAborted();
    return {image: {profile: TRAJECTORY_PROFILE, tick: observation.tick, mime_type: 'image/png', data_url},
      render_ms, encode_ms: performance.now() - encoding};
  };
}
