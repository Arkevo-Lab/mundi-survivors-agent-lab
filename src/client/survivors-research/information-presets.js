import {RESEARCH_INFORMATION_FIELDS, RESEARCH_OBSERVATIONS} from '../../shared/survivors-research-contract.js';
import {VISUAL_PROFILES} from './models/visual-input.js';

export const INFORMATION_PRESETS = Object.freeze([
  ['low', '低', 'state-compact-v1', 'none-v1', ['health', 'enemies']],
  ['medium-low', '中低', 'state-compact-v1', 'none-v1'],
  ['medium', '中等', 'state-detail-v1', 'none-v1'],
  ['medium-high', '中高', 'state-detail-v1', 'structured-v1'],
  ['high', '高', 'state-detail-v1', 'schematic-v1'],
  ['very-high', '特别高', 'state-detail-v1', 'full-v1'],
  ['complete', '完全信息', 'state-full-v1', 'full-v1'],
].map(([id, label, observation, visual, fields]) =>
  Object.freeze({id, label, observation, visual, fields: fields ? Object.freeze(fields) : null})));

export function customInformation(value) {
  const {observation, visual, fields, name} = value ?? {};
  if (!RESEARCH_OBSERVATIONS.includes(observation) || !VISUAL_PROFILES.includes(visual) ||
      !Array.isArray(fields) || fields.some(field => !RESEARCH_INFORMATION_FIELDS.includes(field))) return null;
  const label = typeof name === 'string' ? name.trim().slice(0, 32) : '';
  return {id: 'custom', label, observation, visual,
    fields: RESEARCH_INFORMATION_FIELDS.filter(field => fields.includes(field))};
}

export const INFORMATION_FIELD_LABELS = Object.freeze({
  health: '生命值', progress: '等级与经验', movement: '移动状态', equipment: '装备',
  enemies: '附近敌人', hazards: '攻击范围与效果', loot: '地面资源（含经验水晶）', score: '水晶拾取数与波次',
});

const observationDescriptions = {
  'state-compact-v1': '精简数据，便于掌握附近目标的大致位置。',
  'state-detail-v1': '详细数据，位置更精确。',
  'state-full-v1': '提供视野内的全量数据，保留更精确的位置。',
};
const visualDescriptions = {
  'none-v1': '无图，模型只读结构化数据。',
  'structured-v1': '附结构图，用几何符号标出场景中的对象。',
  'schematic-v1': '附示意图，用简化轮廓区分场景中的对象。',
  'full-v1': '附近原版画面，包含游戏精灵和重绘的状态栏。',
};

export function describeInformation({observation, visual, fields}) {
  const scoreVisible = fields ? fields.includes('score') : observation === 'state-full-v1';
  const visible = fields ?? RESEARCH_INFORMATION_FIELDS.filter(field => field !== 'score' || scoreVisible);
  const hidden = RESEARCH_INFORMATION_FIELDS.filter(field => !visible.includes(field));
  const lines = [visualDescriptions[visual]];
  if (visible.length) {
    lines.push('数据包括' + visible.map(field => INFORMATION_FIELD_LABELS[field]).join('、') + '。');
    if (visible.includes('enemies') || visible.includes('loot') || visible.includes('hazards')) {
      lines.push(observationDescriptions[observation]);
      if (observation !== 'state-compact-v1' && visible.includes('enemies')) lines.push('敌人数据还包括血量和速度。');
      if (observation === 'state-full-v1' && visible.includes('loot')) lines.push('地面资源还包括可破坏物。');
    }
  } else {
    lines.push('仅提供基础帧信息。');
  }
  if (fields && hidden.length) {
    lines.push('已隐藏' + hidden.map(field => INFORMATION_FIELD_LABELS[field]).join('、') + '。');
  } else if (!scoreVisible) {
    lines.push(visual === 'none-v1' ? '看不到累计水晶拾取数和波次。' : '画面还显示累计水晶拾取数与波次。');
  }
  if (!visible.includes('loot')) lines.push('模型看不到地上的经验水晶。');
  return lines.join('');
}
