import {buildResumeNode, canBuildResumeNode, NODE_SCHEMA, NODE_DURATION_TICKS, resumeNodeId, verifyResumeNode} from './resume-node.js';
import {restoreNodeModel} from './models/node-context.js';
import {createCardinalAdvisedModel, createCardinalModel, createDirectionalModel, createStrategicAdvisedModel, createLocalMicroStrategicModel} from './models/directional.js';
import {CARDINAL_ADVISOR_MODE} from './models/action-cardinal.js';
import {createAdvisorMemory} from './advisor-memory.js';
import {createStrategyMemory} from './models/strategy-memory.js';
import {STRATEGY_MODEL, STRATEGY_REASONING_EFFORT} from './models/strategy-config.js';
import {ADVISOR_REFRESH_TICKS, ADVISOR_HORIZON_TICKS, ADVISOR_TTL_TICKS,
  ADVISOR_TIMEOUT_MS} from './models/action-advisor.js';
import {PLAYER_BASE_SPEED} from '../../../public/games/survivors-lab-0.61.0/src/balance.mjs';
import {enhanceSelects} from '../select-dropdown.js';
import {downloadLocalVideo, finalizeVideo, recordLocalVideo} from '../local-video.js';
import {createHumanControl} from './human-control.js';
import {RECOMMENDED_PLAYTEST} from './playtest-preset.js';
import {createResearchModel, getResearchModelStatus} from './models/index.js';
import {NACE_MODEL,NACE_PROVIDER} from './models/nace-decisions.js';
import {createCardinalAdvisor,DECISIONS_MODEL} from './models/decisions.js';
import {WHOLE_PATH_STAGGERED_MODE, WHOLE_PATH_EIGHT_DIRECTION_MODE, WHOLE_PATH_MODE, isWholePathMode} from './models/action-whole-path.js';
import {createIteratedWholePathModel} from './models/iterated-whole-path.js';
import {connectSimulation, expectResponse} from './worker-client.js';
import {openEvidence, hashJSON} from './evidence.js';
import {createArchive, readReplay, resultMetrics, summarizeRuns} from './report.js';
import {prepareResponseSample, sampleResponses, SAMPLES_PER_CONDITION, summarizeResponseSamples} from './response-sample.js';
import {calibrateLink, freezeLinkCalibration} from './models/compensation.js';
import {INFORMATION_PRESETS, INFORMATION_FIELD_LABELS, customInformation, describeInformation} from './information-presets.js';
import {importLinkReports} from './link-calibration-import.js';
import {TIMING_ROWS} from './timing-report.js';
import {createResearchRenderer} from './render.js';
import {createPacedNaceAdmission,providerClockMode,PROVIDER_PROCESSING_CAP_MS} from './provider-clock.js';
import {engineHash, now, runExperiment} from './experiment.js';
import {createVisualCapture} from './visual-render.js';
import {exampleFrame, exampleObservation} from './visual-example.js';
import {STRUCTURED_NEAR_PROFILE, TRAJECTORY_PROFILE, VISUAL_PROFILES} from './models/visual-input.js';
import {BAT_CRYSTAL_BANDS} from '../../../public/games/survivors-lab-research-v1/src/bat-crystal-bands.mjs';
import {RESEARCH_ENGINE, RESEARCH_FINE_HOLD_DURATIONS_MS, RESEARCH_INFORMATION_FIELDS,
  RESEARCH_SLOTS_PROFILE, RESEARCH_SLOTS_COUNT, RESEARCH_SLOT_MS, RESEARCH_SLOT_TICKS, RESEARCH_SLOT_WAIT_ID,
  RESEARCH_SEQUENCE_PROFILE, RESEARCH_COVERAGE_SEQUENCE_PROFILE, RESEARCH_SEQUENCE_MAX_SEGMENTS, RESEARCH_SEQUENCE_MAX_TICKS,
  RESEARCH_CLOSED_PLAN_FEEDBACK, RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK, RESEARCH_EXECUTED_PLAN_FEEDBACK,
  RESEARCH_PRESSURE, RESEARCH_SCHEMA, TICK_HZ, researchCandidates} from '../../shared/survivors-research-contract.js';

const pageQuery = new URLSearchParams(location.search);
const engineering = ['1', 'engineering'].includes(pageQuery.get('verify'));
const bandsSelected = !engineering && pageQuery.get('scenario') === BAT_CRYSTAL_BANDS.id;
const bandsLabel = '蝙蝠与水晶横带';
const bandsOpeningCameraY = 2.6;
const comparisonRuns = new Map();
const terminalModelErrors = new Set(['provider_quota', 'provider_auth', 'provider_model_unavailable', 'provider_visual_rejected',
  'provider_rate_limit', 'connection_unavailable', 'sign_in_required']);
const customStorageKey = 'mundi-survivors-information-v1';
const PLAYTEST_SECONDS = 60;
const PLAYTEST_SEED = 11;
const defaultNaceAdmission=createPacedNaceAdmission();
const HUMAN_INFORMATION = INFORMATION_PRESETS.find(preset => preset.id === 'medium');
const WHOLE_PATH_INFORMATION = INFORMATION_PRESETS.find(preset => preset.id === 'medium-high');
const wholePathLabels = {
  [WHOLE_PATH_EIGHT_DIRECTION_MODE]: '64 路径 · 8 方向 × 2 段',
  [WHOLE_PATH_STAGGERED_MODE]: '64 路径 · 50 / 50 / 200 ms',
};
const wholePathLabel = protocol => wholePathLabels[protocol] ?? '64 路径 · 300 ms';
const wholePathDescriptions = {
  [WHOLE_PATH_EIGHT_DIRECTION_MODE]: '每条依次执行两段 150 ms 的移动，共 300 ms。每段可选上下左右或四个斜向，直行和斜行的速度相同。',
  [WHOLE_PATH_STAGGERED_MODE]: '每条依次执行三段上下左右移动，前两段各 50 ms，第三段 200 ms，完整路径共 300 ms。',
};
const isLuna = kind => (remoteStatus(kind)?.kind ?? kind) === 'openai-decisions';
const supportsSlots = kind => isLuna(kind) || ['mock', 'fixed', 'random', 'rule', 'none', 'human'].includes(kind);
const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = value; };
const show = (id, yes) => { byId(id).hidden = !yes; };
const modelControl = () => byId('model');
const disabled = (id, yes) => { byId(id).disabled = yes; };
const fmt = (value, places = 1) => Number.isFinite(value) ? value.toFixed(places) : '—';
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const render = createResearchRenderer(byId('game'));
const storeReady = openEvidence();
const MAX_ARCHIVE_BYTES = 140 * 1024 * 1024;
const MAX_EXPORT_EVIDENCE = 100 * 1024 * 1024;
const VISUAL_INTERVAL_MS = 250;
const MAX_VISUAL_SECONDS = 120;
const isRemote = kind => kind === 'generation' || kind === 'openai-decisions' || localModels.has(kind);
const remoteStatus = kind => localKeyMode ? localModels.get(kind) : kind === 'generation' ? modelStatus : kind === 'openai-decisions' ? modelStatus?.decisions : null;
const modelLabel = model => ({'gpt-6.1-terra': 'GPT‑6.1 Terra', 'gpt-5.4-mini': 'GPT‑5.4 mini', 'gpt-6-luna': 'GPT‑6 Luna', [NACE_MODEL]: 'Nace Drex Max v1.1'}[model] ?? model);
const modelModes = {generation: 'Chat 模式', 'openai-decisions': '决策模式'};
const remoteName = kind => kind === 'generation' ? 'Chat Completions' : 'Decisions';
const PRIOR_ENGINE_HASHES = new Set([
  'cba7affe03ba787b49fbe4452f11edfa7b22bf29f76523268952ccd225821cf4',
  '92258f35822d5cd1f8c5bae2794722c54897cd59360cde6ffe0f3e8837fb5476',
  'ebae49d1087b30a5efad52941fd5f6d5a2b10956b94cbff1a980d39d8a5134e8',
  'db27187fa72bd18267e22e3f045991802f9a1d10707957a7d7c5715675da3204',
  '1b211afc4de6146aeb9e189836f134a5b2da77efbd4d361a986ec8d73dcc932f',
  '9f668c6cb06da7290832dab75ad93272ce1f4a8422afdf9f87f1eda673391793',
  '4919f524a14857cba28a3cc5bf72c82f8ee672a9506b353180acd986a2e23fcf',
  '7d3be7b824a68e5981a7a279ebbc2ac8726e0e3347675d8d0a5e97daf44a4f26',
  '9b10f85f106cfbd3caeb788b536dbc8c3654e5d8a656aff39adb38410a42fefd',
  'dbbdb00cb7c98b28eac954454f46623c7d1d931cb5d739020b0a0e627e84085d',
  '6eed03584f8348e18d636711870b496402487b0527104c35e2d32d542d003d3b',
  '905f7bad81e30c0c5cd73ad737938bea602cd8a72302471d7e9ac20211e74b58',
  '1ac9fd0ed0bc9dc7e27635b805e0397507ab6fbc279b7fdc1876015137bf7fcf',
  '87a2a633847881d805dfc9426a8783dc0e12bb8855c8d36bc9f3a23e8a9e457b',
  '9c1b5bbd84646de720dd4c50af2e9a348960260b63ebee7057bc850a61547882',
  '138f228730fbd1062c0af2cda475c5b4af494d692b28b21a0168b502498f533c',
  'c2cd171fcb918731cb2c7dbba39de75d034d65fe328d3c1d3ae31f507b083075',
  '2a16b444f69cb65f1846f31d61de27dd646740e69792838c5a5e196f8d714ef5',
  '7356f30655d038478454536acc297000e32e9b8cd50c7ed2762edea3774543be',
  '67e1b9bd1bb3caab5750ec650bec1788435e0091286817455dbe6327b5c11bae',
  'd0fc8c9bda7649a27b60e365bf4c339cc01476e304670ade4495b8d47f5978bb',
  '42b958d74e7d655a708171277f84cb8a30f21534a578ef8095b9abcc43ed093d',
  'e51b8bc27d1c706c668c16faab4cb5dafdfabbd0f9998f0b37f67aa10c81b034',
  '489da11fff935831f4d93ed24bfe4be0d204f256faf2a7b08b82a2028da5ddbc',
  '7f8bf2dae2a8b2a12645f6cf48181c9c0f06ed8732f974ad45ec5a85841ae2e9',
]);
const runtime = {
  kind: 'browser-worker', visibility_requirement: 'foreground', debug_renderer: true,
  platform: navigator.userAgentData?.platform ?? navigator.platform,
  browser: navigator.userAgent,
  logical_cpus: navigator.hardwareConcurrency ?? null,
  device_memory_gb_rounded: navigator.deviceMemory ?? null,
  gpu: null, vram_gb: null, shared_model_gpu: null,
  node_version: null, launch_command: null
};

let activity = null;
let live = null;
let experiment = null;
let selection = [];
let selectedReplay;
let replaySources = [];
let modelStatus;
let localKeyMode = false;
let localApiKey;
let localKeyConfigured = false;
let localNaceConfigured = false;
const localModels = new Map();
let probeController;
let probing = false;
let modelConnectionErrors = {};
let responseSample;
let latestHumanRun;
let latestHumanVideo;
const linkReports = new Map();
const clockMode = (ms, calibrated = ms > 0, provider = false, providerCap = null) => provider
  ? '供应商处理时间' + (Number.isFinite(providerCap) ? ' · 上限 ' + fmt(providerCap, 0) + ' ms' : '')
  : calibrated ? '实验模拟 · ' + fmt(ms, 1) + ' ms' : '实时';
const pair = (raw, adjusted, places = 1) => fmt(raw, places) + ' / ' + fmt(adjusted, places);

async function automaticCalibration() {
  try {
    const response = await fetch('/survivors-research-calibration.json', {cache: 'no-store', signal: AbortSignal.timeout(1500)});
    if (!response.ok) return null;
    return freezeLinkCalibration(await response.json());
  } catch {
    return null;
  }
}

async function measureLink(signal) {
  try {
    const timeout = AbortSignal.timeout(7500);
    const response = await fetch('/api/survivors-research/measure-link', {method: 'POST', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    return response.ok ? freezeLinkCalibration(await response.json()) : null;
  } catch {
    return null;
  }
}

function readCustomInformation() {
  try {
    return customInformation(JSON.parse(localStorage.getItem(customStorageKey) ?? '{}'));
  } catch {
    return null;
  }
}

let savedInformation = readCustomInformation();
let previousInformation;
let explicitPlaytestAction;
const canUseWholePath = () => !engineering && localKeyMode && localKeyConfigured && !localApiKey && isLuna(modelControl().value);
function selectedWholePath() {
  const protocol = byId('playtest-action-profile').value;
  return canUseWholePath() && isWholePathMode(protocol) ? protocol : undefined;
}

function updateWholePathControls() {
  const action = byId('playtest-action-profile');
  const available = canUseWholePath();
  for (const option of action.options) {
    if (isWholePathMode(option.value)) option.disabled = !available;
  }
  if (available) action.value = explicitPlaytestAction ?? WHOLE_PATH_MODE;
  if (!available && isWholePathMode(action.value)) action.value = RESEARCH_SLOTS_PROFILE;
  const selected = Boolean(selectedWholePath());
  const information = byId('information-level');
  if (selected && previousInformation === undefined) {
    previousInformation = information.value;
    information.value = WHOLE_PATH_INFORMATION.id;
  } else if (!selected && previousInformation !== undefined) {
    information.value = previousInformation;
    previousInformation = undefined;
  }
  information.disabled = selected;
  show('custom-information', !selected);
}

function selectedInformation() {
  if (selectedWholePath()) return WHOLE_PATH_INFORMATION;
  const id = byId('information-level').value;
  return id === 'custom' ? savedInformation : INFORMATION_PRESETS.find(preset => preset.id === id);
}
function updateInformationDescription() {
  const information = selectedInformation();
  const feedback = selectedFeedback();
  const description = information && describeInformation(information);
  const noImageDescription = information && describeInformation({...information, visual: 'none-v1'});
  text('information-description', selectedNearView()
    ? '发送同一份中高档详细数据，并附放大的近场结构图。图中不显示状态栏、累计水晶数或波次。'
    : description ? feedback === 'trajectory'
    ? noImageDescription.replace('无图，模型只读结构化数据。', '附最近动作的轨迹图。') : description : '');
  showFeedbackControls();
}
function selectedNearView() {
  return selectedWholePath() === WHOLE_PATH_MODE && byId('playtest-strategy').value === 'initial' &&
    byId('playtest-near-view').checked;
}
function selectedDirectional() {
  return selectedWholePath() === WHOLE_PATH_MODE && byId('playtest-strategy').value === 'direction';
}
function selectedAdvisoryCondition() {
  if (selectedWholePath() !== WHOLE_PATH_MODE) return;
  const strategy = byId('playtest-strategy').value;
  if (['latest-local-micro', 'strategy-on'].includes(strategy) &&
      modelControl().value === 'openai-decisions:gpt-6-luna') return strategy;
  if (strategy === 'advisor-on' || strategy === 'micro-control') return strategy;
}
function selectedPathMicroModel() {
  if (selectedAdvisoryCondition() !== 'latest-local-micro') return undefined;
  const model = byId('playtest-micro-model').value;
  if (model === DECISIONS_MODEL || (localNaceConfigured && model === NACE_MODEL)) return model;
}
function selectedRecommendation() {
  return selectedWholePath() === RECOMMENDED_PLAYTEST.movementProtocol && byId('playtest-strategy').value === 'recommended'
    ? RECOMMENDED_PLAYTEST : undefined;
}
function playtestActionProfile() {
  return isLuna(modelControl().value) && byId('playtest-action-profile').value === RESEARCH_SLOTS_PROFILE
    ? RESEARCH_SLOTS_PROFILE : RESEARCH_SEQUENCE_PROFILE;
}
function selectedFeedback() {
  const fields = selectedInformation()?.fields;
  return !engineering && playtestActionProfile() === RESEARCH_SLOTS_PROFILE &&
    (!fields || fields.includes('movement')) ? byId('movement-feedback').value : 'none';
}
function showFeedbackControls() {
  const slots = !engineering && playtestActionProfile() === RESEARCH_SLOTS_PROFILE;
  const fields = selectedInformation()?.fields;
  const allowed = !fields || fields.includes('movement');
  show('movement-feedback-row', slots);
  disabled('movement-feedback', !allowed);
  const descriptions = {
    none: '按当前信息档发送数据和画面。',
    receipts: '在当前信息档基础上，发送最近实际执行槽的方向、时长和位移。',
    trajectory: '同时发送文字记录和一张轨迹图。图上使用当前观察可见的水晶位置。',
  };
  text('movement-feedback-hint', allowed ? descriptions[selectedFeedback()] : '当前信息档隐藏移动数据，动作反馈关闭。');
}
function showMovementScale(speed) {
  const slotMs = RESEARCH_SLOT_MS;
  const distance = speed * RESEARCH_SLOT_TICKS / TICK_HZ;
  text('movement-scale', '地图标尺 · 移速 ' + fmt(speed, 2) + ' 单位/秒，' + slotMs +
    ' ms 直走约 ' + fmt(distance, 3) + ' 单位，斜走每轴约 ' + fmt(distance / Math.SQRT2, 3) + ' 单位。');
}
function showPlaytestRules() {
  updateWholePathControls();
  show('playtest-action-row', !engineering && isLuna(modelControl().value));
  const protocol = selectedWholePath();
  const recommended = selectedRecommendation();
  const originalProtocol = protocol === WHOLE_PATH_MODE;
  show('playtest-strategy-row', originalProtocol);
  disabled('playtest-strategy', !originalProtocol);
  const strategies = byId('playtest-strategy');
  for (const value of ['latest-local-micro', 'strategy-on']) {
    strategies.querySelector('option[value="' + value + '"]').disabled = !originalProtocol ||
      modelControl().value !== 'openai-decisions:gpt-6-luna';
  }
  const initial = originalProtocol && byId('playtest-strategy').value === 'initial';
  show('playtest-near-view-row', initial);
  disabled('playtest-near-view', !initial);
  const slots = playtestActionProfile() === RESEARCH_SLOTS_PROFILE;
  show('movement-scale', slots);
  updateInformationDescription();
  const advisoryCondition = selectedAdvisoryCondition();
  const pathMicroModel = selectedPathMicroModel();
  show('playtest-model-row',pathMicroModel!==NACE_MODEL);
  const microModel = byId('playtest-micro-model');
  microModel.querySelector('option[value="' + NACE_MODEL + '"]').disabled = !localNaceConfigured;
  show('playtest-micro-model-row', advisoryCondition === 'latest-local-micro');
  show('playtest-provider-clock-hint', pathMicroModel === NACE_MODEL);
  disabled('playtest-micro-model', advisoryCondition !== 'latest-local-micro' || Boolean(activity));
  const directional = selectedDirectional();
  const opening = '安东尼奥 · ' + (bandsSelected ? bandsLabel : '密集开局');
  const originalOption = byId('playtest-action-profile').querySelector('option[value="' + WHOLE_PATH_MODE + '"]');
  const actionLabel = pathMicroModel ? '微操层单问 · 65 项' : advisoryCondition ? '微操层单问 · 100 ms'
    : directional ? '微操层三问 · 100 ms' : '64 路径 · 300 ms';
  if (originalOption.textContent !== actionLabel) originalOption.textContent = actionLabel;
  if (['latest-local-micro', 'strategy-on'].includes(advisoryCondition)) {
    const timing = pathMicroModel === NACE_MODEL
      ? '前两步各 100 ms，第三步最长 400 ms。新动作生效时会替换未完成的动作，计划走完就停下。'
      : '三步各 100 ms。';
    const perception = pathMicroModel
      ? '微操层由 ' + modelLabel(pathMicroModel) + ' 看局部简图，从 64 条三步路径和停止中选一项。' + timing
      : advisoryCondition === 'latest-local-micro' ? '微操层看局部威胁与一步内能进入拾取范围的水晶，由 Luna 执行最长 100 ms 的动作。'
      : '微操层看全景结构图，由 Luna 执行最长 100 ms 的动作。';
    const direction=pathMicroModel===NACE_MODEL?modelLabel(NACE_MODEL):'Luna';
    const upgrade=pathMicroModel===NACE_MODEL?'升级时由 Drex 从当前可选项中选择。':'';
    const strategyModel = modelLabel(STRATEGY_MODEL) + (STRATEGY_REASONING_EFFORT === 'high' ? '（高推理）' : '');
    const combat = pathMicroModel === NACE_MODEL
      ? '两层还会读取当前朝向与鞭击范围、伤害和冷却。微操会参考方向层采用的战略阶段与转换条件。' : '';
    text('playtest-rules', opening + ' · 60 秒。战略层用 ' + strategyModel + '，每 10 模拟秒生成打法。方向层由 '+direction+' 选择目标与方向。两层都看中高信息和全景结构图。' + combat + perception + upgrade);
    return;
  }
  if (advisoryCondition === 'advisor-on') {
    text('playtest-rules', opening + ' · 60 秒 · 中高信息。方向层从上下左右选方向，根据实际位移、目标距离、拾取和受击调整。微操层每次执行一个最多 100 ms 的动作。');
    return;
  }
  if (advisoryCondition === 'micro-control') {
    text('playtest-rules', opening + ' · 60 秒 · 中高信息。微操层根据当前画面和观测执行动作，每步最多 100 ms。');
    return;
  }
  if (directional) {
    text('playtest-rules', opening + ' · 60 秒 · 中高信息。每次判断威胁方向、水晶方向，再选择上、下、左、右或停。移动最多 100 ms，从下一帧生效。下次请求带上刚才的判断、实际移动方向和受击次数。');
    return;
  }
  if (protocol) {
    const steps = wholePathDescriptions[protocol] ?? '每条依次执行三个 100 ms 的上下左右移动，共 300 ms。';
    text('playtest-rules', opening + ' · 每局最多 ' + PLAYTEST_SECONDS + ' 秒 · 中高信息。' +
      'Luna 从完整的 64 条路径中选一条，' + steps +
      '新路径会替换尚未完成的动作。另有一道独立目标题，答案只记录，升级单独决定。' +
      (recommended ? '推荐方案使用总览结构图，并提供最近 4 个已结束移动计划的实际位移、执行时长和生命值变化。' : ''));
    return;
  }
  if (slots) {
    const slotMs = RESEARCH_SLOT_MS;
    text('playtest-rules', '每局最多 ' + PLAYTEST_SECONDS + ' 秒，目标是活下来并多捡经验水晶。' +
      'Luna 一次请求选 ' + RESEARCH_SLOTS_COUNT + ' 个 ' + slotMs + ' ms 时间槽（共 ' + (slotMs * RESEARCH_SLOTS_COUNT) +
      ' ms），每槽可选八个方向或等待。等待时游戏照常推进；新有效计划在下一帧替换余量，计划用完就停下。升级单独决定。' +
      '各信息档使用同一套动作和战斗设置。');
    showMovementScale(PLAYER_BASE_SPEED);
    return;
  }
  const candidates = researchCandidates(RESEARCH_SEQUENCE_PROFILE);
  const directions = candidates.filter(({id}) => id.endsWith(':ticks:1')).length;
  const duration = RESEARCH_SEQUENCE_MAX_TICKS * 1000 / TICK_HZ;
  text('playtest-rules', '每局最多 ' + PLAYTEST_SECONDS + ' 秒，目标是活下来并多捡经验水晶。' +
    '模型一轮可安排 1–' + RESEARCH_SEQUENCE_MAX_SEGMENTS + ' 步，允许重复。基础动作 ' + candidates.length + ' 个：' +
    directions + ' 个方向各有单帧微步（约 ' + fmt(1000 / TICK_HZ, 1) + ' ms）和 ' + RESEARCH_FINE_HOLD_DURATIONS_MS.join('、') +
    ' ms 的短步，也可单独停下或选择升级。移动计划最多执行 ' + duration + ' ms，超出会截断。' +
    '新决策可替换还没走完的计划，走完就停下。各档只改变模型看到的信息，动作和战斗设置相同。');
}
function showInformationChoices(selected) {
  const menu = byId('information-level');
  menu.replaceChildren(...INFORMATION_PRESETS.map(preset => new Option(preset.label, preset.id)));
  if (savedInformation) menu.add(new Option(savedInformation.label, 'custom'));
  menu.value = selected;
  updateInformationDescription();
}
function setupInformationControls() {
  showInformationChoices('medium');
  byId('information-level').addEventListener('change', updateInformationDescription);
  showPlaytestRules();
  const initial = savedInformation ?? {observation: 'state-detail-v1', visual: 'none-v1', fields: RESEARCH_INFORMATION_FIELDS};
  byId('custom-observation').value = initial.observation;
  byId('custom-visual').value = initial.visual;
  byId('custom-name').value = savedInformation?.label ?? '';
  for (const field of RESEARCH_INFORMATION_FIELDS) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = field;
    checkbox.checked = initial.fields.includes(field);
    label.append(checkbox, INFORMATION_FIELD_LABELS[field]);
    byId('custom-fields').append(label);
  }
  byId('save-information').addEventListener('click', () => {
    const config = customInformation({
      observation: byId('custom-observation').value, visual: byId('custom-visual').value,
      fields: Array.from(byId('custom-fields').querySelectorAll(':checked'), checkbox => checkbox.value),
      name: byId('custom-name').value.trim() || '我的配置',
    });
    if (!config) return;
    try {
      localStorage.setItem(customStorageKey, JSON.stringify({...config, name: config.label}));
    } catch {
      text('custom-status', '浏览器无法保存配置，请检查本地存储。');
      return;
    }
    savedInformation = config;
    showInformationChoices('custom');
    byId('custom-information').open = false;
  });
}

function currentCalibration() {
  const current = linkReports.get(byId('link-current').value);
  const target = linkReports.get(byId('link-target').value);
  if (!current || !target) throw Error('请选择当前与目标线路');
  return calibrateLink(current, target, {allowProxy: byId('link-allow-proxy').checked});
}
function showCalibration() {
  try {
    const calibration = currentCalibration();
    text('link-status', '预算 ' + fmt(calibration.budget_ms, 1) + ' ms · ' +
      (calibration.comparison === 'matched-probe-estimate' ? '同端点热连接探针' : '替代基线估算') +
      ' · 到期 ' + new Date(calibration.expires_at_ms).toLocaleTimeString() +
      ' · 当前 ' + fmt(calibration.current.stats.p50_ms) + ' ms（n=' + calibration.current.stats.n +
      '），目标 ' + fmt(calibration.target.stats.p50_ms) + ' ms（n=' + calibration.target.stats.n + '）');
  } catch (error) {
    text('link-status', error.message);
  }
}

async function loadCalibrationFiles(event) {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (!files.length) return;
  try {
    const reports = [];
    for (const file of files) {
      if (file.size > 256 * 1024) throw Error('线路采样报告过大');
      reports.push(...importLinkReports(JSON.parse(await file.text())));
    }
    for (const report of reports) {
      const id = JSON.stringify([report.line_id, report.endpoint, report.collector, report.measured_at]);
      if (linkReports.has(id)) continue;
      linkReports.set(id, report);
      const label = [report.line_id, report.endpoint, report.measured_at].join(' · ');
      for (const select of ['link-current', 'link-target']) byId(select).add(new Option(label, id));
    }
    showCalibration();
  } catch (error) {
    text('link-status', error.message);
  }
}
let playing = false;
let replayWorker;
let replayTask;
let replaySequence = 0;
let verifiedNodeFrame = null;
let selectedNode = null;
const knownNodes = new Map();

function status(message, state = 'ready') {
  document.body.dataset.state = state;
  text('phase', message);
}
function evidenceStatus(message) { text('evidence-status', message); }
function canSampleResponses() {
  return !probing && modelStatus?.available && modelStatus.generation_profile === 'openai-chat-completions-v1' &&
    modelStatus.decisions?.available;
}
function refreshControls() {
  const busy = Boolean(activity);
  const engineeringSlots = engineering && byId('action-profile').value === RESEARCH_SLOTS_PROFILE;
  const supportsSelectedProfile = !engineeringSlots || supportsSlots(modelControl().value);
  const canReplay = Boolean(selectedReplay);
  disabled('configuration', busy);
  disabled('simple-configuration', busy);
  disabled('batch-seeds', busy);
  disabled('start-human', busy);
  disabled('download-human-video', busy || !latestHumanVideo || latestHumanVideo.runId !== latestHumanRun?.run_id);
  disabled('download-human-replay', busy || !latestHumanRun);
  show('human-downloads', Boolean(latestHumanRun || latestHumanVideo));
  disabled('start', busy || !supportsSelectedProfile || (!engineering && (probing || localKeyMode && !localModels.has(modelControl().value))));
  disabled('research-key', busy || probing);
  disabled('load-key-models', busy || probing);
  if (!engineering) {
    const kind = modelControl().value || 'generation';
    const setup = modelSetupAction(kind);
    text('start', localKeyMode ? '开始测试' : probing ? '检查模型连接…' : setup ?? (remoteStatus(kind)?.available ? '开始测试' : '重新检查连接'));
  }
  disabled('batch', busy);
  disabled('batch-selected', busy || !supportsSelectedProfile);
  disabled('benchmark-visual', busy);
  disabled('sample-responses', busy || engineeringSlots || !canSampleResponses());
  disabled('probe', busy);
  disabled('sample-adjusted', busy);
  disabled('export-sample', busy || !responseSample?.groups?.some(group => group.attempts.length));
  disabled('compare-models', busy || engineeringSlots || !modelStatus?.available || !modelStatus?.decisions?.available);
  disabled('compare-visual', busy || modelControl().value === 'none' || !supportsSelectedProfile);
  disabled('visual-profile', modelControl().value === 'none');
  const canStop = Boolean(experiment || playing || activity);
  show('stop', canStop);
  disabled('stop', !canStop);
  disabled('history', busy);
  disabled('import', busy);
  disabled('export', busy || !selection.length);
  disabled('replay', busy || !canReplay);
  disabled('replay-play', busy || !canReplay);
  disabled('replay-range', busy);
  disabled('replay-source', busy);
  disabled('saved-node', busy);
  disabled('save-node', busy || !verifiedNodeFrame || Boolean(selectedNode));
  disabled('export-node', busy || !selectedNode);
  disabled('start-node', busy || probing || engineering || !(selectedNode || verifiedNodeFrame) ||
    !remoteStatus(modelControl().value)?.available);
}
function changeActivity(value) {
  activity = value;
  refreshControls();
}
function setPayload(id, value) {
  const node = byId(id);
  node.payload = value;
  if (node.parentElement.open) node.textContent = pretty(value ?? '—');
}
for (const id of ['input', 'output', 'snapshot', 'decision-timing']) {
  const node = byId(id);
  node.parentElement.addEventListener('toggle', () => {
    if (node.parentElement.open && Object.hasOwn(node, 'payload')) node.textContent = pretty(node.payload ?? '—');
  });
}

function resetDisplay() {
  live = {decisions: 0, failures: 0, startedAt: null, snapshot: null, movement: null, pausedMs: 0, control: null};
  for (const id of ['tick', 'clock', 'hp', 'hits-taken', 'score', 'gems-collected', 'rate', 'failures', 'movement',
    'decision-ticks', 'latency', 'age', 'clock-pause', 'decisions', 'action-plan', 'plan-progress', 'plan-executed', 'plan-note', 'advisor-status', 'strategy-status',
    'strategy-stage', 'strategy-policy', 'strategy-transition', 'strategy-signals']) text(id, '—');
  for (const id of ['offer-row', 'reward-row', 'replay-range-row', 'plan-row', 'plan-error', 'control-diagnostics', 'advisor-diagnostics', 'strategy-diagnostics',
    'strategy-stage', 'strategy-policy', 'strategy-transition', 'strategy-signals']) show(id, false);
  for (const id of ['input', 'output', 'snapshot', 'decision-timing']) setPayload(id, '等待首次数据');
  text('report', '等待对局完成');
  text('input-dispatch', '等待首次决策');
  show('decision-answer', false);
  show('visual-evidence', false);
  byId('visual-image').removeAttribute('src');
  delete byId('visual-image').dataset.tick;
  text('quality', '有效决策帧率待校准');
  text('scene-title', '研究画面');
  show('stage-overlay', false);
}

const directionLabels = {
  up: '上', 'up-right': '右上', right: '右', 'down-right': '右下',
  down: '下', 'down-left': '左下', left: '左', 'up-left': '左上',
};
function describeAction(id) {
  if (id === 'stop') return '停下';
  if (id === RESEARCH_SLOT_WAIT_ID) return '等待 ' + RESEARCH_SLOT_MS + ' ms';
  const [type, direction, unit, amount] = id.split(':');
  if (type === 'choose') return '升级 ' + unit;
  if (type !== 'move' || !directionLabels[direction]) return id;
  const length = unit === 'ticks' ? amount + ' 帧' : amount + (unit === 'hold' ? ' ms' : ' 单位');
  return '向' + directionLabels[direction] + '移动 ' + length;
}
function showPlan(actionIds) {
  if (!Array.isArray(actionIds) || !actionIds.length) return;
  show('plan-row', true);
  text('action-plan', actionIds.map(describeAction).join(' → '));
}

function executedSlotsText(plan, executedTicks) {
  if (plan.action_ids?.length !== RESEARCH_SLOTS_COUNT) return '';
  const segments = plan.action_ids.flatMap((id, index) => {
    const ticks = Math.min(RESEARCH_SLOT_TICKS, executedTicks - index * RESEARCH_SLOT_TICKS);
    if (ticks <= 0) return [];
    const action = id === RESEARCH_SLOT_WAIT_ID ? '等待' : '向' + directionLabels[id.split(':')[1]];
    return [action + ' ' + fmt(ticks * 1000 / TICK_HZ, ticks === RESEARCH_SLOT_TICKS ? 0 : 1) + ' ms'];
  });
  return segments.length ? segments.join(' → ') : '0 ms';
}

function showPlanProgress(movement, tick) {
  const plan = movement?.plan;
  if (!plan) {
    text('plan-progress', movement?.action_id === 'stop' ? '静止' : '');
    return;
  }
  showPlan(plan.action_ids);
  const slots = plan.action_ids.length === RESEARCH_SLOTS_COUNT;
  text('plan-progress', '第 ' + (plan.index + 1) + ' / ' + plan.scheduled_segments +
    (slots ? ' 槽 · ' : ' 步 · ') + describeAction(movement.action_id));
  if (slots) text('plan-executed', '实际执行 ' + executedSlotsText(plan, Math.max(0, tick - plan.started_tick + 1)));
}

function showFrame(frame, movement, elapsedMs = null, effectiveMs = elapsedMs, cameraOffsetY = 0) {
  if (!frame) return;
  render(frame, movement, cameraOffsetY);
  text('tick', frame.tick);
  text('clock', pair(elapsedMs === null ? null : elapsedMs / 1000, effectiveMs === null ? null : effectiveMs / 1000, 2) +
    ' / ' + fmt(frame.tick / TICK_HZ, 2) + ' s');
  text('hp', fmt(frame.player?.hp, 0) + ' / ' + fmt(frame.player?.maxHp, 0));
  text('hits-taken', frame.hits_taken ?? '—');
  text('gems-collected', frame.player?.gemsCollected ?? '—');
  text('score', frame.player?.level ?? '—');
  const remaining = movement?.remaining_distance != null ? fmt(movement.remaining_distance, 2) + ' 单位'
    : movement?.remaining_ticks != null ? fmt(movement.remaining_ticks * 1000 / TICK_HZ, 0) + ' ms' : '';
  text('movement', movement?.action_id ? [movement.action_id, remaining].filter(Boolean).join(' · ') : '静止');
  showPlanProgress(movement, frame.tick);
  if (Number.isFinite(frame.player?.speed)) showMovementScale(frame.player.speed);
  const offer = frame.pendingUpgrade;
  show('offer-row', Boolean(offer?.length));
  if (offer?.length) text('offer', offer.map(option => option.name ?? option.label ?? option.id ?? option.kind).join(' / '));
  const treasure = frame.lastTreasure;
  show('reward-row', Boolean(treasure));
  if (treasure) text('reward', (treasure.rewards ?? []).map(reward => reward.name ?? reward.label ?? reward.kind).filter(Boolean).join(' / ') || '自动结算');
  setPayload('snapshot', frame);
}

function updateControlDiagnostics() {
  const control = live?.control;
  if (!control) return;
  const {movement} = live;
  const active = movement?.action_id;
  let state;
  if (control.finished) state = '对局已结束';
  else if (active === RESEARCH_SLOT_WAIT_ID) state = '模型计划在等待槽，游戏仍推进';
  else if (active?.startsWith('move:')) state = '正在' + describeAction(active);
  else if (control.failure) state = '静止 · 上次模型动作未生效';
  else if (!live.decisions) state = '静止 · 尚无生效动作';
  else if (control.latestChoice === 'stop') state = '模型选择停下';
  else if (control.latestChoice?.startsWith('choose:')) state = '已选择升级，等待移动计划';
  else state = '移动计划已走完，角色静止';
  if (control.requestedAt !== null && !control.finished) {
    state += ' · 等模型返回 ' + fmt(Math.max(0, now() - control.requestedAt) / 1000, 1) + ' 秒';
  }
  text('control-status', control.label + ' · ' + state);
  text('control-counts', live.decisions + ' 次生效 · ' + live.failures + ' 次失败' +
    (control.distance == null ? '' : ' · 实际移动 ' + fmt(control.distance, 2) + ' 地图单位'));
}

function updateAdvisorDiagnostics() {
  if (!live.advisor) return;
  const {guidance, finished} = live.advisor;
  const tick = Math.max(live.snapshot?.tick ?? 0, guidance?.accepted_tick ?? 0);
  const active = guidance && guidance.expires_tick > tick;
  const upgrade = Boolean(live.snapshot?.pendingUpgrade?.length);
  const target = active && (guidance.target == null ? '无指定目标' : '水晶目标 #' + guidance.target.id +
    (guidance.target.status === 'unknown' ? '（最后可见位置）' : ''));
  const heading = active && (directionLabels[guidance.heading] ?? '无方向偏好');
  text('advisor-status', finished ? '对局已结束' : upgrade ? '升级选择中'
    : !guidance && !live.advisor.received ? '等待首次指导' : !active ? '暂无有效指导'
    : [target, heading, '观测于 ' + fmt((tick - guidance.source_tick) / TICK_HZ, 1) + ' 秒前'].join(' · '));
}

function updateStrategyDiagnostics() {
  const {strategy} = live;
  if (!strategy) return;
  const {active, pending, status, finished} = strategy;
  const latest = active?.strategy;
  const published = latest && '上份发布于 ' + fmt(active.accepted_tick / TICK_HZ, 2) + ' 模拟秒';
  const tick = Math.max(live.snapshot?.tick ?? 0, active?.accepted_tick ?? 0);
  const age = latest && '依据 ' + fmt((tick - active.source_tick) / TICK_HZ, 1) + ' 秒前的观察';
  const state = finished ? '对局已结束' : pending ? '正在生成打法'
    : status && status !== 'accepted' ? '本轮生成未完成' : latest ? '打法生效中' : '等待首次生成';
  const statusText = [state, published, age, '每 10 模拟秒刷新'].filter(Boolean).join(' · ');
  if (byId('strategy-status').textContent !== statusText) text('strategy-status', statusText);
  for (const [id, value] of [
    ['strategy-stage', latest && '阶段：' + latest.phase],
    ['strategy-policy', latest?.approach],
    ['strategy-transition', latest && '转换条件：' + latest.transition],
    ['strategy-signals', latest && '有效迹象：' + latest.success_signal + ' · 需调整迹象：' + latest.failure_signal],
  ]) {
    if (byId(id).textContent !== (value ?? '')) text(id, value ?? '');
    show(id, Boolean(value));
  }
}

function onRunEvent(event) {
  if (event.type === 'research:snapshot') {
    live.startedAt ??= event.startedAt;
    live.snapshot = event.snapshot;
    live.movement = event.movement;
    const elapsed = event.clock?.elapsed_ms ?? (live.startedAt == null ? null : Math.max(0, now() - live.startedAt));
    const effective = event.clock?.effective_elapsed_ms ?? (elapsed == null ? null : Math.max(0, elapsed - live.pausedMs));
    showFrame(live.snapshot, live.movement, elapsed, effective,
      live.bands && live.snapshot?.tick === 0 ? bandsOpeningCameraY : 0);
    updateControlDiagnostics();
    updateAdvisorDiagnostics();
    updateStrategyDiagnostics();
    const gameRate = effective > 0 ? live.decisions * 1000 / effective : null;
    text('rate', engineering ? pair(elapsed > 0 ? live.decisions * 1000 / elapsed : null, gameRate, 2) + ' Hz'
      : fmt(gameRate, 2));
  } else if ((event.type === 'advisor:published' || event.type === 'advisor:availability') && live.advisor) {
    live.advisor.guidance = event.hint;
    live.advisor.received = true;
    updateAdvisorDiagnostics();
  } else if (event.type === 'strategy:requested' && live.strategy) {
    live.strategy.pending = true;
    updateStrategyDiagnostics();
  } else if ((event.type === 'strategy:published' || event.type === 'strategy:restored') && live.strategy) {
    live.strategy.active = event.type === 'strategy:restored' ? event.strategy : event;
    updateStrategyDiagnostics();
  } else if (event.type === 'strategy:attempt' && live.strategy) {
    live.strategy.pending = false;
    live.strategy.status = event.status;
    updateStrategyDiagnostics();
  } else if (event.type === 'run_ended') {
    if (live.advisor) live.advisor.finished = true;
    if (live.strategy) live.strategy.finished = true;
    updateAdvisorDiagnostics();
    updateStrategyDiagnostics();
  } else if (event.type === 'latency_compensation_ended') {
    live.pausedMs = event.latency_compensated_ms;
    live.lastPauseMs = event.paused_ms;
    text('clock-pause', pair(event.paused_ms, live.pausedMs) + ' ms');
  } else if (event.type === 'action_applied' && Array.isArray(event.action_ids)) {
    showPlan(event.action_ids);
    text('plan-note', '');
    text('plan-executed', '');
    text('plan-progress', '已生效 · 第 ' + event.applied_tick + ' 帧');
  } else if (event.type === 'movement_plan_truncated') {
    const truncation = '超出移动预算 · ' + event.requested_ticks + ' 帧截至 ' + event.scheduled_ticks + ' 帧。';
    text('plan-note', [byId('plan-note').textContent, truncation].filter(Boolean).join(' '));
  } else if (event.type === 'movement_plan_ended') {
    const interrupted = ['replaced', 'stopped'].includes(event.reason);
    const executed = executedSlotsText(event, event.executed_ticks);
    if (executed && !interrupted) text('plan-executed', '实际执行 ' + executed);
    if (event.reason === 'run-ended' && event.action_ids?.length === RESEARCH_SLOTS_COUNT &&
        event.executed_ticks < event.scheduled_ticks) {
      text('plan-note', '对局结束 · 本轮只执行 ' + event.executed_ticks + ' / ' + event.scheduled_ticks + ' 帧。');
    }
    if (!interrupted) return;
    const note = byId('plan-note').textContent;
    const interruption = '上一轮计划在第 ' + event.tick + ' 帧被打断（已执行 ' + event.executed_ticks +
      ' / ' + event.scheduled_ticks + ' 帧）。';
    text('plan-note', [note, interruption, executed && '上一轮实际执行 ' + executed].filter(Boolean).join(' '));
  } else if (event.type === 'model:request') {
    if (live.control) {
      live.control.requestedAt = event.at_ms;
      updateControlDiagnostics();
    }
  } else if (event.type === 'model:attempt') {
    if (live.control) {
      live.control.requestedAt = null;
      if (event.status === 'applied') {
        live.control.latestChoice = event.action_id;
        live.control.failure = false;
      } else if (event.status !== 'cancelled') {
        live.control.failure = true;
      }
    }
    if (!engineering && terminalModelErrors.has(event.error?.code)) {
      live.modelError ??= event.error.message;
      void experiment?.stop();
    }
    const {ack, observation_tick: observed, applied_tick: applied} = event;
    if (event.status === 'applied') {
      showPlan(ack?.action_ids ?? event.action_ids);
      show('plan-error', false);
    } else if (event.error && event.status !== 'cancelled') {
      text('plan-error', '本轮未生效 · ' + event.error.message + '（' + event.error.code + '）');
      show('plan-error', true);
    }
    if (event.status === 'applied') live.decisions++;
    else if (event.status !== 'cancelled') live.failures++;
    text('decision-ticks', observed + ' / ' + (applied ?? '—'));
    const raw = event.request_latency?.raw_request_ms ?? (event.request_started_at_ms == null || event.request_finished_at_ms == null
      ? null : event.request_finished_at_ms - event.request_started_at_ms);
    text('latency', pair(raw, event.request_latency?.estimated_adjusted_request_ms ?? raw) + ' ms');
    text('age', pair(ack?.observation_age_ms, ack?.adjusted_observation_age_ms ?? ack?.observation_age_ms) + ' ms');
    text('decisions', live.decisions);
    text('failures', live.failures);
    updateControlDiagnostics();
    setPayload('input', event.input);
    setPayload('decision-timing', event.decision_timing);
    const metadata = event.backend_metadata;
    const answer = metadata?.decision_answers ?? metadata?.decision_answer;
    show('decision-answer', Boolean(answer));
    if (answer) text('decision-answer-body', pretty(answer));
    text('input-dispatch', event.input == null ? '本轮无可记录输入'
      : metadata?.simulated ? '本地模拟输入'
      : metadata?.upstream_dispatched === true ? '供应商已回应 · 对应请求'
      : metadata?.upstream_dispatched === false ? '本轮未发至供应商'
      : '已准备输入 · 供应商接收状态未知');
    if (event.visual && (event.image || event.status !== 'cancelled')) {
      const {profile, tick, mime_type, byte_length, render_ms, encode_ms, jpeg_quality} = event.visual;
      const node = byId('visual-image');
      if (event.image) {
        node.src = event.image.data_url;
        node.dataset.tick = tick;
        node.dataset.profile = profile;
      } else {
        node.removeAttribute('src');
        delete node.dataset.tick;
      }
      show('visual-image', Boolean(event.image));
      show('visual-evidence', true);
      text('visual-meta', [profile, 'tick ' + tick, mime_type, byte_length == null ? null : byte_length + ' B',
        jpeg_quality == null ? null : 'JPEG ' + jpeg_quality,
        '渲染 ' + fmt(render_ms) + ' ms', '编码 ' + fmt(encode_ms) + ' ms'].filter(Boolean).join(' · '));
      text('visual-transfer', event.status === 'visual_error' ? '图像采集失败 · 本轮未推理'
        : metadata?.simulated ? '本地模拟输入 · 决策与像素无关'
        : metadata?.upstream_dispatched === true ? '对应供应商请求已返回'
        : '发送状态见模型输入记录');
    }
    if (event.raw_response != null || event.status !== 'cancelled') setPayload('output', event.raw_response ?? event.error);
  } else if (event.type === 'environment_invalid') {
    text('quality', '本局环境异常 · ' + event.reason);
  } else if (event.type === 'fault') {
    evidenceStatus('研究记录异常 · ' + event.message);
    text('quality', '本局证据不完整');
  }
}

function getConfig(seed) {
  return {
    seed,
    character: byId('character').value,
    max_ticks: byId('duration').valueAsNumber * TICK_HZ,
    observation_profile: byId('observation-profile').value,
    action_profile: byId('action-profile').value,
    max_observation_age_ms: null
  };
}
function getModel(kind, config, benchmark, movementProtocol, recommended) {
  if (isWholePathMode(movementProtocol)) {
    if (!recommended && !canUseWholePath()) throw Error('64 路径模式需要本机已保存的 Luna 连接。');
    return createIteratedWholePathModel(undefined, recommended?.pathQuestionGuidance, undefined, undefined,
      recommended?.config.movement_feedback, movementProtocol);
  }
  if (benchmark) {
    const action_id = config.action_profile === 'distance-v1' ? 'move:right:distance:1'
      : config.action_profile === RESEARCH_SLOTS_PROFILE ? 'move:right:hold:50' : 'move:right:hold:200';
    return createResearchModel({kind: 'mock', delay_ms: 0, action_id, seed: config.seed, failure: 'none'});
  }
  if (kind === 'none') return null;
  if (isRemote(kind)) {
    const selected = remoteStatus(kind);
    if (!selected?.available) throw Error(remoteName(kind) + ' 尚未配置可用的自有 API Key');
    return createResearchModel({kind: (selected.kind ?? kind) === 'openai-decisions' ? 'openai-decisions' : 'generative',
      model: selected.model, generation_profile: selected.generation_profile, timeout_ms: 30000,
      ...(localKeyMode && {apiKey: localApiKey, localConnection: !localApiKey && localKeyConfigured})});
  }
  if (kind === 'mock') {
    const failure = byId('failure').value;
    const delay = Number(byId('delay').value);
    const action_id = config.action_profile === 'distance-v1' ? 'move:right:distance:1'
      : config.action_profile === RESEARCH_SLOTS_PROFILE ? 'move:right:hold:50' : 'move:right:hold:200';
    return createResearchModel({kind, delay_ms: delay, action_id, seed: config.seed,
      failure, timeout_ms: failure === 'timeout' ? Math.max(500, delay + 500) : 30000});
  }
  return createResearchModel({kind, seed: config.seed});
}

function modelSetupAction(kind) {
  if (modelConnectionErrors[kind] === 'sign_in_required') return '登录后测试';
  const status = remoteStatus(kind)?.status;
  if (status === 'key_required' || status === 'coding_plan_unsupported') return '连接模型后测试';
  return null;
}

function modelConnectionMessage(kind) {
  if (probing) return '正在检查连接…';
  const connection = remoteStatus(kind);
  if (connection?.available) return '已配置，可开始测试';
  if (modelConnectionErrors[kind] === 'sign_in_required') return '请先登录本地 Mundi';
  switch (connection?.status) {
    case 'key_required': return '请在模型设置中保存 API Key';
    case 'coding_plan_unsupported': return '请在模型设置中切换至自有 API Key';
    case 'official_openai_required': return '当前预览未启用此模型';
    default: return '连接状态暂不可用，请刷新';
  }
}

function showModelConnection() {
  if (localKeyMode) return;
  const menu = modelControl();
  const options = [...menu.options].filter(option => isRemote(option.value));
  for (const option of options) {
    const kind = option.value;
    const connection = remoteStatus(kind);
    option.textContent = modelLabel(connection?.model ?? (kind === 'generation' ? 'gpt-5.4-mini' : 'gpt-6-luna')) +
      ' · ' + modelModes[kind];
    option.dataset.dropdownDescription = modelConnectionMessage(kind);
    option.disabled = engineering && (probing || !connection?.available);
  }
  const selected = isRemote(menu.value) ? menu.value
    : options.find(option => remoteStatus(option.value)?.available)?.value ?? 'generation';
  const connection = remoteStatus(selected);
  const needsSetup = modelSetupAction(selected) !== null;
  show('connection-panel', engineering || probing || !connection?.available);
  show('connect-model', engineering || (!probing && needsSetup));
  text('connection', modelConnectionMessage(selected));
}

async function loadLocalModels({useConfigured = false} = {}) {
  const input = byId('research-key');
  const menu = modelControl();
  const previousModel = menu.value;
  const key = useConfigured ? '' : input.value.trim();
  if (!key && !useConfigured) { input.focus(); return; }
  localApiKey = undefined;
  localModels.clear();
  menu.replaceChildren(new Option('请先读取模型列表', ''));
  probing = true;
  refreshControls();
  text('local-key-status', '正在读取 OpenAI 模型列表…');
  try {
    const response = await fetch('/api/survivors-research/local-key', {
      method: 'POST', mode: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000),
      headers: key ? {'X-Mundi-Research-Key': key} : {},
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error?.message ?? '无法读取模型列表。');
    for (const info of data.models) {
      if (!modelModes[info.kind]) continue;
      const id = info.kind + ':' + info.model;
      localModels.set(id, {...info, available: true});
      const option = new Option(modelLabel(info.model) + ' · ' + modelModes[info.kind], id);
      option.dataset.dropdownDescription = info.kind === 'openai-decisions'
        ? '列表可见 · 决策接口权限待实测' : '列表可见 · Chat 接口权限待实测';
      menu.add(option);
    }
    if (!localModels.size) throw Error('这个 Key 的模型列表里没有当前研究页可测试的模型。');
    const preferred = 'openai-decisions:gpt-6-luna';
    localApiKey = key || undefined;
    if (localModels.has(previousModel)) menu.value = previousModel;
    else if (localModels.has(preferred)) {
      menu.value = preferred;
      if (!engineering) {
        if (explicitPlaytestAction === undefined && !canUseWholePath()) {
          byId('playtest-action-profile').value = RESEARCH_SLOTS_PROFILE;
        }
        byId('movement-feedback').value = 'receipts';
        byId('movement-feedback').dispatchEvent(new Event('change', {bubbles: true}));
        if (!canUseWholePath() && byId('information-level').value === 'medium') byId('information-level').value = 'medium-high';
        byId('information-level').dispatchEvent(new Event('change', {bubbles: true}));
      }
    }
    menu.dispatchEvent(new Event('change', {bubbles: true}));
    if (useConfigured) show('research-key-label', false);
    input.value = '';
    text('local-key-status', '已读取 ' + localModels.size + ' 个候选模型。');
  } catch (error) {
    text('local-key-status', error.name === 'TimeoutError' ? '读取模型列表超时，请重试。' : error.message);
  } finally {
    probing = false;
    refreshControls();
  }
}

async function initializeModelConnection() {
  if (!engineering && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
    probing = true;
    refreshControls();
    try {
      const response = await fetch('/api/survivors-research/local-key', {cache: 'no-store', signal: AbortSignal.timeout(1500)});
      if (response.ok) {
        const settings = await response.json();
        localKeyMode = settings.enabled === true;
        localKeyConfigured = settings.configured === true;
        localNaceConfigured = settings.nace_model === NACE_MODEL;
        if (localNaceConfigured) byId('playtest-micro-model').value = NACE_MODEL;
      }
    } catch { /* ordinary account mode */ }
    probing = false;
    if (localKeyMode) {
      show('connection-panel', false);
      show('local-key-panel', true);
      const placeholder = new Option('请先读取模型列表', '', true, true);
      placeholder.disabled = true;
      modelControl().replaceChildren(placeholder);
      byId('load-key-models').addEventListener('click', () => void loadLocalModels({useConfigured: localKeyConfigured && !byId('research-key').value.trim()}));
      byId('research-key').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!activity && !probing) void loadLocalModels();
        }
      });
      refreshControls();
      if (localKeyConfigured) await loadLocalModels({useConfigured: true});
      return;
    }
  }
  await probe();
}

async function probe() {
  probeController?.abort();
  const controller = new AbortController();
  probeController = controller;
  probing = true;
  showModelConnection();
  refreshControls();

  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
  const [chat, choice] = await Promise.allSettled([
    getResearchModelStatus({signal}),
    getResearchModelStatus({kind: 'openai-decisions', signal}),
  ]);
  if (controller.signal.aborted) return;
  modelConnectionErrors = {generation: chat.reason?.code, 'openai-decisions': choice.reason?.code};
  const found = {...(chat.value ?? {}), decisions: choice.value};
  if (modelStatus?.model !== found.model || modelStatus?.decisions?.model !== found.decisions?.model) {
    byId('vision-confirm').checked = false;
  }
  modelStatus = found;
  probing = false;
  const menu = modelControl();
  if (!engineering && !menu.value) {
    const ready = Object.keys(modelModes).find(kind => remoteStatus(kind)?.available);
    if (ready) menu.value = ready;
  } else if (engineering && isRemote(menu.value) && !remoteStatus(menu.value)?.available) {
    menu.value = 'mock';
  }
  updateVisualControls();
}

function updateVisualControls() {
  showModelConnection();
  const kind = modelControl().value;
  const visual = byId('visual-profile').value !== 'none-v1';
  if (kind === 'none') byId('visual-profile').value = 'none-v1';
  show('mock-config', kind === 'mock');
  show('vision-confirm-row', isRemote(kind) || Boolean(modelStatus?.available && modelStatus?.decisions?.available));
  text('visual-config-hint', visual && kind !== 'none'
    ? '480 × 270 · 单图 96 KiB · 至少间隔 250 ms · 最长 120 秒'
    : '各档均发送所选 JSON 和动作候选。四档对照至少间隔 250 ms，每档最多 120 秒。');
  refreshControls();
}

async function showVisualExamples() {
  const capture = createVisualCapture();
  for (const profile of VISUAL_PROFILES.filter(profile => profile !== 'none-v1')) {
    const {image} = await capture({visual_frame: exampleFrame, observation: exampleObservation, profile});
    byId('visual-' + profile).src = image.data_url;
  }
}

async function loadEntry(store, run) {
  const events = await store.events(run.run_id);
  const actions = run.actions ?? events.filter(event => event.type === 'action_applied');
  return {run: {...run, actions, metrics: run.metrics ?? resultMetrics(run.result, events, actions, run.manifest.advisor, run.manifest.strategy, run.manifest.visual?.role_profiles)}, events};
}
async function refreshHistory() {
  const store = await storeReady;
  const recent = await store.list();
  const select = byId('history');
  const value = select.value;
  select.replaceChildren(new Option('选择历史对局', ''));
  for (const run of recent) {
    const when = new Date(run.created_at).toLocaleString();
    const label = [when, run.model, run.visual_profile, '种子 ' + run.seed, run.reason ?? '中断'].join(' · ');
    select.add(new Option(label, run.run_id));
  }
  if (Array.from(select.options).some(option => option.value === value)) select.value = value;
  if (!engineering && comparisonRuns.size < 12) {
    let historyWorker;
    try {
      for (const item of recent.slice(0, 24)) {
        if (comparisonRuns.size >= 12) break;
        if (comparisonRuns.has(item.run_id)) continue;
        const saved = await store.run(item.run_id);
        if (!saved?.manifest?.information || saved.manifest.branch || !saved.result) continue;
        comparisonRuns.set(saved.run_id, saved);
        if (saved.result.gems_collected != null || !Array.isArray(saved.actions)) continue;
        try {
          await verifyRun(saved);
          historyWorker ??= connectSimulation();
          const replayed = await replayFrame(saved, undefined, historyWorker);
          if (replayed.consistent) saved.result.gems_collected = replayed.result.gems_collected;
        } catch {
          // The historical row can still be shown if its replay cannot be verified.
        }
      }
    } finally {
      historyWorker?.close();
    }
    showComparison();
  }
}

function setReplaySources(runs) {
  replaySources = runs.filter(run => run.result?.state_hash);
  selectedReplay = replaySources.at(-1);
  const select = byId('replay-source');
  select.replaceChildren(...replaySources.map(run => new Option(
    run.manifest.model.kind + ' · ' + clockMode(run.manifest.link_compensation?.configured_ms,
      run.manifest.link_compensation?.mode === 'estimated-link-compensation',
      run.manifest.link_compensation?.mode === providerClockMode, run.manifest.link_compensation?.provider_processing_cap_ms) + ' · ' + (run.manifest.visual?.profile ?? 'none-v1') + ' · 种子 ' + run.manifest.config.seed + ' · ' + run.result.tick + ' 帧',
    run.run_id)));
  select.value = selectedReplay?.run_id ?? '';
  show('replay-source-row', replaySources.length > 1);
  show('replay-range-row', false);
  selectNode(null);
  showBranch(selectedReplay);
  refreshControls();
}

function showComparison(run) {
  if (run?.manifest?.information && !run.manifest.branch && run.result) comparisonRuns.set(run.run_id, run);
  const body = byId('simple-results-body');
  body.replaceChildren();
  const sorted = [...comparisonRuns.values()].sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
  for (const entry of sorted.slice(12)) comparisonRuns.delete(entry.run_id);
  const displayed = sorted.slice(0, 12);
  const clockGroups = new Set(displayed.map(({manifest}) =>
    manifest.link_compensation?.adaptive ? 'adaptive' : manifest.link_compensation?.configured_ms ?? 0));
  show('comparison-clock-note', clockGroups.size > 1);
  show('comparison-pressure-note', new Set(displayed.map(entry => entry.manifest.config.pressure_profile ?? 'standard')).size > 1);
  show('comparison-actions-note', new Set(displayed.map(({manifest}) => manifest.model.movement_protocol ?? manifest.config.action_profile)).size > 1);
  show('comparison-feedback-note', new Set(displayed.map(entry => entry.manifest.config.movement_feedback ?? 'none')).size > 1);
  for (const entry of displayed) {
    const {result, manifest, metrics} = entry;
    const row = document.createElement('tr');
    const died = ['death', 'reaper'].includes(result.reason);
    const outcome = died ? '阵亡' : result.reason === 'time-limit' ? '存活到时限'
      : result.reason === 'stopped' ? '手动结束' : '中断';
    const comparable = result.environment_valid && entry.evidence_complete &&
      (died || result.reason === 'time-limit') && metrics?.decisions > 0;
    const providerTiming = manifest.link_compensation?.mode === providerClockMode;
    const providerCap = manifest.link_compensation?.provider_processing_cap_ms;
    row.title = providerTiming ? Number.isFinite(providerCap)
      ? '每笔请求最多计入 ' + fmt(providerCap, 0) + ' ms 的供应商处理时间，其余等待暂停'
      : '按模型报告处理时间推进，其余等待暂停'
      : manifest.link_compensation?.adaptive ? '自动测量与更新线路补偿'
      : manifest.link_compensation?.mode === 'estimated-link-compensation'
      ? '使用有效的实测线路补偿' : '无有效线路校准，按原始时钟记录';
    const feedback = {receipts: '位移文字', trajectory: '位移文字和轨迹图'}[manifest.config.movement_feedback];
    if (feedback) row.title += ' · ' + feedback;
    const human = manifest.model.kind === 'human';
    const protocol = manifest.model.movement_protocol;
    const mode = manifest.advisor?.condition === 'latest-local-micro' ? '局部微操' : manifest.strategy ? '三层对照' : manifest.advisor?.condition === 'advisor-on' ? '两层对照'
      : isWholePathMode(protocol) ? wholePathLabel(protocol) : modelModes[manifest.model.kind === 'openai-decisions' ? 'openai-decisions' : 'generation'];
    const values = [human ? '玩家' : modelLabel(manifest.model.model) + ' · ' + mode,
      human ? '实景' : [manifest.information.label, feedback].filter(Boolean).join(' · '), result.gems_collected, result.hits_taken,
      fmt(result.tick / TICK_HZ) + ' 秒', outcome + (comparable ? '' : ' · 不可比较'),
      result.tick, human ? '—' : fmt(metrics?.game_clock_decision_hz, 2)];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value ?? '—';
      row.append(cell);
    }
    if (!human && metrics?.decisions != null) {
      const timingLabel = providerTiming ? ' · 实际墙钟 ' + fmt(result.wall_elapsed_ms / 1000, 1) + ' 秒'
        : ' · 累计链路补偿 ' + fmt(result.latency_compensated_ms, 0) + ' ms';
      row.lastElementChild.title = metrics.decisions + ' 次生效 · 请求中位数 ' + fmt(metrics.request_ms?.p50, 0) + ' ms' + timingLabel;
    }
    body.append(row);
  }
  show('simple-results', comparisonRuns.size > 0);
}

function showSelection(entries) {
  selection = entries;
  const runs = entries.map(entry => entry.run);
  setReplaySources(runs);
  const summary = summarizeRuns(runs);
  text('report', pretty(summary));
  const hasResults = summary.rows.some(row => row.tick !== null);
  const rows = byId('visual-results-body');
  rows.replaceChildren();
  if (hasResults) {
    for (const row of summary.rows) {
      const tr = document.createElement('tr');
      const values = [[row.model_name, row.model_endpoint].filter(Boolean).join(' / ') || row.model, row.visual_profile, clockMode(row.latency_compensation_ms, row.link_compensation?.mode === 'estimated-link-compensation',
        row.link_compensation?.mode === providerClockMode, row.link_compensation?.provider_processing_cap_ms), row.seed, row.tick ?? '—', row.hp ?? '—',
        row.gems_collected ?? '—', row.decisions ?? '—', pair(row.raw_decision_hz, row.game_clock_decision_hz, 2), fmt(row.latency_compensated_ms), fmt(row.visual_image_bytes?.p50, 0),
        fmt(row.visual_render_ms?.p50), fmt(row.visual_encode_ms?.p50), pair(row.request_ms?.p50, row.estimated_adjusted_request_ms?.p50),
        pair(row.observation_age_ms?.p50, row.adjusted_observation_age_ms?.p50), row.visual_capture_errors ?? '—', row.valid ? '有效' : '无效'];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        tr.append(cell);
      }
      rows.append(tr);
    }
  }
  show('visual-results', hasResults);
  showTimingSummary(summary.rows);
}

function showTimingSummary(rows) {
  const measured = rows.filter(row => row.stage_timings);
  show('timing-summary', measured.length > 0);
  const container = byId('timing-table');
  container.replaceChildren();
  if (!measured.length) return;
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  function cell(row, value, heading = false) {
    const node = document.createElement(heading ? 'th' : 'td');
    node.textContent = value;
    row.append(node);
  }
  cell(header, '阶段', true);
  for (const entry of measured) cell(header,
    [entry.model_name, entry.model_endpoint, entry.visual_profile, clockMode(entry.latency_compensation_ms, entry.link_compensation?.mode === 'estimated-link-compensation',
      entry.link_compensation?.mode === providerClockMode, entry.link_compensation?.provider_processing_cap_ms), entry.seed].filter(value => value != null).join(' · '), true);
  const body = table.createTBody();
  for (const {id, label} of TIMING_ROWS) {
    const row = body.insertRow();
    cell(row, label);
    for (const entry of measured) {
      const data = entry.stage_timings[id];
      cell(row, data?.n ? [data.n, fmt(data.p50, 3), fmt(data.p95, 3), fmt(data.max, 3)].join(' / ') : '—');
    }
  }
  for (const [key, label] of [['waited_for_new_tick', '进入新帧等待'], ['snapshot_cache', '快照缓存命中'],
    ['observation_cache', 'JSON 缓存命中'], ['visual_cache', '视觉缓存命中']]) {
    const row = body.insertRow();
    cell(row, label + '（命中 / 样本）');
    for (const entry of measured) {
      const metric = entry.stage_counts?.[key];
      cell(row, metric?.n ? metric.count + ' / ' + metric.n : '—');
    }
  }
  container.append(table);
}

async function startRuns(items, seeds, batchId, {providerAdmission,runtimeKind,durationTicks=NODE_DURATION_TICKS}={}) {
  if (activity) return;
  if (document.hidden) { evidenceStatus('请在研究页处于前台时启动'); return; }
  const job = {kind: batchId ? 'batch' : 'single', cancelled: false, setup: new AbortController()};
  changeActivity(job);
  const entries = [];
  let humanControl, recording;
  try {
    if (items.some(({config, kind}) => config.action_profile === RESEARCH_SLOTS_PROFILE && !supportsSlots(kind))) {
      throw Error('时间槽实验使用 Luna 决策模式。');
    }
    const humanRun = items[0]?.kind === 'human';
    const pathMicroRun = items.some(item => item.pathMicroModel);
    const measureLinkDuringRun = !humanRun && !pathMicroRun && !engineering && ['127.0.0.1', 'localhost'].includes(location.hostname);
    if (measureLinkDuringRun) status('正在测量网络', 'running');
    const linkCalibration = humanRun || pathMicroRun ? null : engineering
      ? byId('link-compensation').value === 'calibrated' && items.some(item => item.kind !== 'none') ? currentCalibration() : null
      : measureLinkDuringRun ? await measureLink(job.setup.signal) ?? await automaticCalibration() : await automaticCalibration();
    const store = await storeReady;
    if (items.some(({visualProfile, config, resumeNode}) => visualProfile !== 'none-v1' &&
      (resumeNode ? durationTicks : config.max_ticks) > MAX_VISUAL_SECONDS * TICK_HZ)) {
      throw Error('图像对局上限为 120 秒。请缩短时限或分开运行，以保留完整图像。');
    }
    if (items.some(({kind, visualProfile}) => isRemote(kind) && visualProfile !== 'none-v1') &&
        engineering && !byId('vision-confirm').checked) throw Error('请先确认所配置的自有模型支持视觉输入。');
    for (const [index, {kind, config, visualProfile, minimumObservationIntervalMs, benchmark, information,
      movementProtocol, recommended, directional, advisoryCondition, pathMicroModel, resumeNode, nodeLookup}] of items.entries()) {
      if (job.cancelled || document.hidden) break;
      const human = kind === 'human';
      const localMicro = advisoryCondition === 'latest-local-micro';
      const strategic = localMicro || advisoryCondition === 'strategy-on';
      const advising = strategic || advisoryCondition === 'advisor-on';
      const drexDirection=localMicro&&pathMicroModel===NACE_MODEL;
      const advisor = advisoryCondition && {...(drexDirection&&{provider:NACE_PROVIDER,model:NACE_MODEL}),mode: CARDINAL_ADVISOR_MODE, condition: advisoryCondition,
        refresh_ticks: ADVISOR_REFRESH_TICKS, horizon_ticks: ADVISOR_HORIZON_TICKS, ttl_ticks: ADVISOR_TTL_TICKS,
        timeout_ms: ADVISOR_TIMEOUT_MS, max_inflight: 1};
      function controller(restored) {
        if (strategic) {
          const createModel = localMicro ? createLocalMicroStrategicModel : createStrategicAdvisedModel;
          return createModel({memory: restored?.memory ?? createAdvisorMemory(),
            strategyMemory: restored?.strategyMemory ?? createStrategyMemory(),
            ...(localMicro && {pathMicroModel,actionProfile:config.action_profile}),
            ...(drexDirection && {advisor:createCardinalAdvisor(NACE_MODEL)}),
            ...(restored && {restore: restored.advisorRestore, strategyRestore: restored.strategyRestore})});
        }
        return advising ? createCardinalAdvisedModel({memory: restored?.memory ?? createAdvisorMemory(),
          ...(restored && {restore: restored.advisorRestore})})
          : advisoryCondition ? createCardinalModel()
            : directional ? createDirectionalModel(restored ? {legacyPrevious: restored.legacyPrevious} : undefined)
              : getModel(kind, config, benchmark, movementProtocol, recommended);
      }
      const model = human ? (humanControl = createHumanControl({onUpgrade: showHumanUpgrades})).model
        : resumeNode ? null : controller();
      const createBranchModel = resumeNode && (branchRunId => {
        const targetMode = advising ? CARDINAL_ADVISOR_MODE : directional && !advisoryCondition ? 'advisory-direction-v1' : null;
        const restored = restoreNodeModel({context: resumeNode.context, nodeTick: resumeNode.source.tick,
          branchRunId, targetMode, enableStrategy: strategic});
        return {model: controller(restored), contextReport: restored.contextReport};
      });
      resetDisplay();
      live.bands = config.scenario === BAT_CRYSTAL_BANDS.id;
      if (live.bands) text('scene-title', bandsLabel);
      if (strategic) {
        live.strategy = {active: null, pending: false, status: null, finished: false};
        show('strategy-diagnostics', true);
        updateStrategyDiagnostics();
      }
      if (advising) {
        live.advisor = {guidance: null, received: false, finished: false};
        show('advisor-diagnostics', true);
        updateAdvisorDiagnostics();
      }
      if (human) {
        humanControl.start();
        byId('game').focus({preventScroll: true});
        const recordingStatus = message => {
          text('human-recording-status', message);
          show('human-recording-status', true);
        };
        try {
          recording = recordLocalVideo(byId('game'), {onError: error => recordingStatus(error.message)});
          recordingStatus('正在录制游戏画面…');
        } catch (error) { recordingStatus(error.message + '。仍会保存动作记录。'); }
      }
      if ((model || resumeNode) && !human) {
        const profile = pathMicroModel
          ? '局部感知 · 65 项 · ' + (config.action_profile === RESEARCH_COVERAGE_SEQUENCE_PROFILE ? '100/100/400 ms' : '100/100/100 ms')
          : localMicro ? '局部感知 · 100 ms' : advisoryCondition ? '单问 · 100 ms'
          : isWholePathMode(movementProtocol) ? wholePathLabel(movementProtocol)
          : config.action_profile === RESEARCH_SLOTS_PROFILE ? '500 ms 时间槽'
          : config.action_profile === RESEARCH_SEQUENCE_PROFILE ? '组合移动'
          : config.action_profile === RESEARCH_COVERAGE_SEQUENCE_PROFILE ? '组合移动 · 600 毫秒' : config.action_profile;
        live.control = {label: [modelLabel(model?.config.model ?? pathMicroModel ?? (resumeNode ? DECISIONS_MODEL : model.config.kind)), profile].join(' · '),
          requestedAt: null, finished: false};
        show('control-diagnostics', true);
        updateControlDiagnostics();
      }
      evidenceStatus('正在记录此局。');
      const runCalibration = model || resumeNode ? linkCalibration : undefined;
      const providerProcessing = pathMicroModel === NACE_MODEL;
      const mode = clockMode(runCalibration?.budget_ms, Boolean(runCalibration), providerProcessing, PROVIDER_PROCESSING_CAP_MS);
      status(human ? '玩家对局中' : engineering ? (batchId ? '批次 ' + (index + 1) + ' / ' + items.length : '运行中') + ' · ' + mode : '测试中', 'running');
      experiment = runExperiment({config, model, createBranchModel, resumeNode, nodeLookup, store, seedSet: seeds, batchId,
        runtime:{...runtime,...(runtimeKind&&{kind:runtimeKind}),...(drexDirection&&{direction_provider:'nace'})}, onUpdate(event) {
        onRunEvent(event);
        if (event.type === 'research:snapshot') recording?.mark(event.snapshot.tick);
        if (!human) return;
        if (event.type === 'upgrade_pause_started' || event.type === 'upgrade_pause_ended' && event.reason === 'selected') {
          try { recording?.pause(event.type === 'upgrade_pause_started'); }
          catch { text('human-recording-status', '无法切换录像暂停状态。动作记录继续保存。'); }
        }
        if (event.type === 'model:attempt' && humanControl.handleAttempt(event)) {
          void experiment?.stop('interrupted');
        }
      },
        visualProfile, information, minimumObservationIntervalMs, benchmark, advisor, providerProcessing, durationTicks, providerAdmission:providerAdmission??(drexDirection?defaultNaceAdmission:undefined), linkCalibration: runCalibration,
        linkCalibrationFrozenAtMs: runCalibration?.calibrated_at_ms, measureLink: measureLinkDuringRun ? measureLink : undefined});
      refreshControls();
      const run = await experiment.done;
      experiment = null;
      entries.push({run});
      if (!engineering) showComparison(run);
      showSelection(entries);
      if (resumeNode) selectNode(resumeNode, {preview: false});
      showBranch(run);
      const result = run.result;
      if (human && result) {
        latestHumanRun = run;
        if (recording) {
          try {
            const captured = await recording.finish(result.tick);
            if (!captured?.blob.size) throw Error('录像没有可下载的画面');
            const video = await finalizeVideo(captured);
            latestHumanVideo = {...video, runId: run.run_id};
            try {
              await store.saveHumanVideo(latestHumanVideo);
              text('human-recording-status', '录像已保存，可下载。');
            } catch { text('human-recording-status', '录像可下载，本地存储写入失败。'); }
          } catch (error) { text('human-recording-status', error.message + '。动作记录仍可下载。'); }
        }
      }
      if (result) {
        if (live.control) {
          live.control.finished = true;
          live.control.distance = result.distance;
          updateControlDiagnostics();
        }
        showFrame(live.snapshot, live.movement, result.elapsed_ms, result.effective_elapsed_ms ?? result.elapsed_ms);
        text('rate', engineering ? pair(run.metrics?.raw_decision_hz, run.metrics?.game_clock_decision_hz, 2) + ' Hz'
          : fmt(run.metrics?.game_clock_decision_hz, 2));
        text('clock-pause', pair(live.lastPauseMs ?? 0, result.latency_compensated_ms ?? 0) + ' ms');
        text('decisions', run.metrics?.decisions ?? '—');
      }
      if (!run.evidence_complete) {
        evidenceStatus('证据不完整 · ' + (run.evidence_fault ?? '运行中断'));
        break;
      }
      evidenceStatus(live.modelError || (result?.environment_valid ? '已保存，可导出或回放。'
        : '已保存 · 环境异常 ' + (result?.environment_reasons ?? []).join(', ')));
    }
    const last = entries.at(-1)?.run;
    status(live?.modelError ? '模型调用失败' : job.cancelled ? '已停止' : !last ? '已中断'
      : batchId && entries.length === items.length ? '批次完成'
      : last.result?.reason === 'stopped' ? '已停止' : last.result?.reason === 'segment-limit' ? '完成短段测试' : last.result?.reason === 'time-limit' ? '达到时限'
      : last.result?.reason === 'death' ? '角色阵亡' : '运行结束', 'finished');
    await refreshHistory();
  } catch (error) {
    status('运行失败', 'failed');
    evidenceStatus(error.message);
  } finally {
    humanControl?.close();
    if (recording) void recording.cancel().catch(() => {});
    experiment = null;
    changeActivity(null);
  }
  return entries;
}

function showHumanUpgrades(upgrade) {
  const container = byId('human-upgrades');
  const list = byId('human-upgrade-options');
  if (!upgrade) {
    if (container.contains(document.activeElement)) byId('game').focus({preventScroll: true});
    container.hidden = true;
    list.replaceChildren();
    return;
  }
  const {options, choose, selected} = upgrade;
  if (!choose) {
    text('human-upgrade-status', '正在应用 ' + options[selected].name + '…');
    for (const button of list.querySelectorAll('button')) button.disabled = true;
    container.focus({preventScroll: true});
    return;
  }
  text('human-upgrade-status', '点击选项或按对应数字键。');
  list.replaceChildren(...options.map(({name, description}, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    const label = document.createElement('strong');
    label.textContent = `${index + 1}. ${name}`;
    const detail = document.createElement('span');
    detail.className = 'hint';
    detail.textContent = description;
    button.append(label, detail);
    button.addEventListener('click', () => choose(index));
    return button;
  }));
  container.hidden = false;
  list.firstElementChild?.focus({preventScroll: true});
}

function showSampleSummary(report) {
  const range = metric => metric.n ? fmt(metric.p50) + ' ms [' + fmt(metric.min) + '–' + fmt(metric.max) + ']' : '—';
  text('sample-summary', report.groups.map(group => {
    const summary = group.summary ?? summarizeResponseSamples(group.attempts);
    return [group.model + ' · ' + group.endpoint + ' · ' + (group.visual_profile === 'none-v1' ? '无图' : '结构图'),
      '合法动作 ' + summary.legal_actions + '/' + summary.n + ' · 完整等待 ' + range(summary.total_ms),
      ...(summary.adjusted_total_ms ? ['校准折算 ' + range(summary.adjusted_total_ms)] : []),
      '同源 HTTP ' + range(summary.browser_http_ms) + ' · 供应商往返 ' + range(summary.upstream_ms)].join('\n');
  }).join('\n\n'));
}

async function startResponseSample() {
  if (activity || !canSampleResponses() || document.hidden || !byId('experiment').reportValidity()) return;
  show('response-sample', true);
  if (!byId('vision-confirm').checked) {
    text('sample-status', '请先勾选图片支持确认。');
    return;
  }
  let linkCalibration;
  if (byId('sample-adjusted').checked) {
    try { linkCalibration = currentCalibration(); }
    catch (error) { text('sample-status', error.message); return; }
  }
  const controller = new AbortController();
  const report = {schema: 'mundi-survivors-response-sample-v1', sample_id: crypto.randomUUID(),
    started_at: new Date().toISOString(), engine_sha256: engineHash, target_per_condition: SAMPLES_PER_CONDITION,
    status: 'preparing', groups: [], ...(linkCalibration && {link_calibration: linkCalibration,
      link_latency_estimate_ms: linkCalibration.budget_ms})};
  responseSample = report;
  changeActivity({kind: 'response-sample', controller});
  text('sample-status', '正在准备第 0 帧观测与结构图…');
  text('sample-summary', '');
  try {
    const config = getConfig(byId('seed').valueAsNumber);
    const endpoints = [
      {model: getModel('generation', config), endpoint: '/v1/chat/completions'},
      {model: getModel('openai-decisions', config), endpoint: '/v1/decisions'},
    ];
    const prepared = await prepareResponseSample(config, controller.signal);
    Object.assign(report, {setup: prepared.setup, observation: prepared.observation, candidates: prepared.candidates,
      observation_sha256: await hashJSON(prepared.observation), candidates_sha256: await hashJSON(prepared.candidates),
      image_sha256: await hashJSON(prepared.image), status: 'sampling'});
    text('sample-status', '正在串行探测四种配置…');
    await sampleResponses({prepared, endpoints, report, signal: controller.signal, onUpdate() {
      const count = report.groups.reduce((total, group) => total + group.attempts.length, 0);
      text('sample-status', '已尝试 ' + count + ' / ' + (report.groups.length * SAMPLES_PER_CONDITION) + ' 次');
      showSampleSummary(report);
    }});
    report.status = controller.signal.aborted ? 'cancelled' : report.stopped_on ? 'failed' : 'complete';
    text('sample-status', report.status === 'complete'
      ? '采样完成 · 结构图准备 ' + fmt(report.setup.image_prepare_ms) + ' ms · 每档小样本，显示合法响应中位数与范围。'
      : report.status === 'cancelled' ? '已停止采样' : '已停止采样 · ' + report.stopped_on.message);
  } catch (error) {
    report.status = controller.signal.aborted ? 'cancelled' : 'failed';
    if (!controller.signal.aborted) report.setup_error = error.message;
    text('sample-status', controller.signal.aborted ? '已停止采样' : '采样准备失败 · ' + error.message);
  } finally {
    report.finished_at = new Date().toISOString();
    changeActivity(null);
  }
}

function exportResponseSample() {
  if (!responseSample || activity) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(responseSample, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'survivors-response-sample-' + responseSample.sample_id + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportSelection(entriesToExport = selection) {
  if (!entriesToExport.length || activity) return;
  changeActivity({kind: 'export'});
  evidenceStatus('正在整理实验包…');
  try {
    const store = await storeReady;
    let bytes = 0;
    const entries = [];
    for (const entry of entriesToExport) {
      bytes += entry.run.evidence_bytes ?? 0;
      if (bytes > MAX_EXPORT_EVIDENCE) throw Error('批次实验包过大，请从历史记录逐局导出');
      const loaded = entry.events ? entry : await loadEntry(store, entry.run);
      const recordedEngine = loaded.run.manifest.engine_sha256;
      const supportsReplay = !engineHash || recordedEngine === engineHash || PRIOR_ENGINE_HASHES.has(recordedEngine);
      if (supportsReplay && loaded.run.evidence_complete && loaded.run.result?.state_hash) {
        let worker;
        try {
          await verifyRun(loaded.run);
          worker = connectSimulation();
          const {positions, consistent} = await replayFrame(loaded.run, undefined, worker, true);
          if (!consistent) throw Error('对局回放不一致，无法验证位移');
          entries.push({...loaded, positions});
        } finally { worker?.close(); }
      } else entries.push(loaded);
    }
    const archive = await createArchive(entries);
    const blob = new Blob([JSON.stringify(archive)], {type: 'application/json'});
    if (blob.size > MAX_ARCHIVE_BYTES) throw Error('批次实验包超过导入上限，请从历史记录逐局导出');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'survivors-research-' + (entriesToExport.length > 1 ? 'batch-' : '') + archive.run_ids[0] + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    evidenceStatus('实验包已生成。');
  } catch (error) { evidenceStatus(error.message); }
  finally { changeActivity(null); }
}

function nodeSummary(tick, facts) {
  return '原局 ' + fmt(tick / TICK_HZ, 2) + ' 秒 · 生命 ' + facts.hp + ' · 水晶 ' + facts.gems_collected;
}

function selectNode(node, {preview = true} = {}) {
  selectedNode = node;
  verifiedNodeFrame = null;
  byId('saved-node').value = node?.node_id ?? '';
  if (node) {
    const actionDuration = node.source.config.action_profile === RESEARCH_COVERAGE_SEQUENCE_PROFILE ? ' · 100/100/400 ms'
      : node.source.config.action_profile === RESEARCH_SEQUENCE_PROFILE ? ' · 300 ms 动作档' : '';
    text('node-summary', nodeSummary(node.source.tick, node.facts) + ' · ' + node.source.strategy + actionDuration);
    show('replay-range-row', false);
    if (preview) showFrame(node.snapshot, null);
  }
  show('node-summary', Boolean(node));
  refreshControls();
}

function setVerifiedNodeFrame(run, snapshot) {
  selectNode(null);
  if (!canBuildResumeNode(run, snapshot.tick)) return;
  verifiedNodeFrame = {run, tick: snapshot.tick};
  text('node-summary', nodeSummary(snapshot.tick, {hp: snapshot.player.hp, gems_collected: snapshot.player.gemsCollected}));
  show('node-summary', true);
  refreshControls();
}

async function refreshNodes() {
  const nodes = await (await storeReady).nodes();
  const menu = byId('saved-node');
  knownNodes.clear();
  menu.replaceChildren(new Option('选择测试节点', ''));
  for (const node of nodes) {
    knownNodes.set(node.node_id, node);
    menu.add(new Option(nodeSummary(node.source.tick, node.facts) + ' · ' + node.source.strategy, node.node_id));
  }
  menu.value = selectedNode?.node_id ?? '';
}

function showBranch(run) {
  const branch = run?.manifest.branch;
  const result = run?.result;
  show('branch-summary', Boolean(branch && result));
  if (!branch || !result) return;
  const signed = value => (value > 0 ? '+' : '') + value;
  const start = branch.start_facts;
  const state = result.reason === 'death' ? '阵亡' : result.reason === 'stopped' ? '已停止'
    : ['segment-limit', 'time-limit'].includes(result.reason) ? '达到续测时限' : '已结束';
  const variant = branch.source.strategy === branch.strategy ? branch.strategy
    : '策略变体 · ' + branch.source.strategy + ' → ' + branch.strategy;
  text('branch-summary', fmt((result.tick - branch.base_tick) / TICK_HZ, 2) + ' 秒续测 · ' + state +
    ' · 水晶 ' + signed(result.gems_collected - start.gems_collected) + ' · 受击 ' +
    signed(result.hits_taken - start.hits_taken) + ' · 生命 ' + signed(result.hp - start.hp) + ' · ' + variant +
    (run.metrics?.strategy ? ' · 战略层请求 ' + run.metrics.strategy.requests : ''));
}

async function saveOrStartNode(start) {
  if (activity || !(selectedNode || verifiedNodeFrame) || start && byId('start-node').disabled) return;
  const source = verifiedNodeFrame;
  let node = selectedNode;
  let reused = Boolean(node);
  const lookupStarted = performance.now();
  changeActivity({kind: 'node'});
  try {
    const store = await storeReady;
    if (!node) {
      const {run, tick} = source;
      await verifyRun(run);
      const events = run.events ?? await store.events(run.run_id);
      const nodeId = await resumeNodeId(run, tick, events);
      node = await store.node(nodeId);
      reused = Boolean(node);
      if (!node) {
        evidenceStatus('正在离线重建测试节点…');
        const worker = connectSimulation();
        try { node = await buildResumeNode({run, tick, events, worker, nodeId}); }
        finally { worker.close(); }
        await store.saveNode(node);
        await refreshNodes();
      }
    }
    await verifyResumeNode(node);
    selectNode(node);
    const context = node.context;
    evidenceStatus(context.history_from_tick == null ? '测试节点已就绪，原档无可恢复的公开观察历史。'
      : '测试节点已就绪，已恢复 ' + fmt(context.history_from_tick / TICK_HZ, 2) + ' 到 ' +
        fmt(context.history_to_tick / TICK_HZ, 2) + ' 秒的公开观察。');
  } catch (error) {
    node = null;
    evidenceStatus(error.message);
  } finally { changeActivity(null); }
  if (node && start) await startSavedResearchNode(node,{nodeLookup:{reused,elapsed_ms:performance.now()-lookupStarted}});
}

export {openEvidence};

export async function startSavedResearchNode(node,{nodeLookup,providerAdmission,runtimeKind,durationTicks}={}){
  await verifyResumeNode(node);
  const kind = modelControl().value;
  if (!remoteStatus(kind)?.available) return;
  const item = ordinaryRunItem(kind, node.source.config.seed);
  const nodeProfile = node.source.config.action_profile;
  const previousDrexProfile = nodeProfile === RESEARCH_SEQUENCE_PROFILE && item?.pathMicroModel === NACE_MODEL;
  if (!item || (item.config.action_profile !== nodeProfile && !previousDrexProfile)) {
    evidenceStatus('所选策略和节点使用的动作档位不同。请选用匹配的动作档位后续测。');
    return;
  }
  const config = node.source.config;
  if (config.pause_for_upgrade) {
    evidenceStatus('这个节点使用玩家升级暂停规则。当前模型续测需要可自动推进的升级规则。');
    return;
  }
  const fields = config.observation_fields;
  const incompatibleDirectionalFeedback = [RESEARCH_EXECUTED_PLAN_FEEDBACK, RESEARCH_CLOSED_PLAN_FEEDBACK,
    RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK].includes(config.movement_feedback);
  if (item.directional && (config.observation_profile !== 'state-detail-v1' || fields && !fields.includes('movement') ||
      incompatibleDirectionalFeedback) || item.recommended && config.movement_feedback !== item.config.movement_feedback) {
    evidenceStatus('所选策略需要与节点相同的观察配置。请选择与来源相容的策略。');
    return;
  }
  const entries=await startRuns([{...item,resumeNode:node,nodeLookup,config}],[config.seed],null,{providerAdmission,runtimeKind,durationTicks});
  return entries?.[0]?.run;
}

function downloadNode(node) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(node)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'survivors-node-' + node.node_id.slice(0, 12) + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function verifyRun(run) {
  if (run.manifest.engine !== RESEARCH_ENGINE || run.manifest.schema !== RESEARCH_SCHEMA) throw Error('实验包引擎或协议版本不兼容');
  const priorEngine = PRIOR_ENGINE_HASHES.has(run.manifest.engine_sha256);
  if (engineHash && run.manifest.engine_sha256 !== engineHash && !priorEngine) throw Error('实验包模拟引擎哈希与当前构建不同');
  if (await hashJSON(run.initial_state) !== run.manifest.initial_state_sha256) throw Error('初始状态哈希与清单不一致');
}
async function replayFrame(run, tick, worker = (replayWorker ??= connectSimulation()), includePositions = false) {
  const {manifest, initial_state, actions, result} = run;
  return worker.request('research:replay', run.run_id, {config: manifest.config, initial_state, actions, result, tick, include_positions: includePositions}, {timeout: 30000})
    .then(expectResponse);
}
function showReplay(frame, movement) {
  show('stage-overlay', false);
  text('scene-title', '回放画面');
  show('plan-error', false);
  show('control-diagnostics', false);
  show('advisor-diagnostics', false);
  show('strategy-diagnostics', false);
  text('plan-note', '');
  text('plan-executed', '');
  const applied = selectedReplay.actions.findLast(action => action.applied_tick <= frame.tick && Array.isArray(action.action_ids));
  show('plan-row', Boolean(applied));
  if (applied) {
    showPlan(applied.action_ids);
    if (applied.plan_end?.tick <= frame.tick) {
      const executed = executedSlotsText(applied.plan_end, applied.plan_end.executed_ticks);
      if (executed) text('plan-executed', '实际执行 ' + executed);
    }
  }
  showFrame(frame, movement);
  const range = byId('replay-range');
  range.min = selectedReplay.manifest.branch?.base_tick ?? 0;
  range.max = selectedReplay.result.tick;
  range.value = frame.tick;
  show('replay-range-row', true);
}
async function replay({play = false, tick} = {}) {
  if (!selectedReplay || activity) return;
  const run = selectedReplay;
  changeActivity({kind: 'replay'});
  status('验证回放', 'replaying');
  evidenceStatus('正在用实际应用帧重放…');
  try {
    await verifyRun(run);
    const verified = await replayFrame(run, tick);
    if (!verified.consistent) throw Error('回放不一致 · 首个核查差异帧 ' + verified.first_divergent_tick);
    showReplay(verified.snapshot, verified.movement);
    showBranch(run);
    setVerifiedNodeFrame(run, verified.snapshot);
    if (play) {
      playing = true;
      refreshControls();
      const startAt = performance.now();
      for (let current = run.manifest.branch?.base_tick ?? 0; playing && current < run.result.tick;) {
        const frame = await replayFrame(run, current);
        showReplay(frame.snapshot, frame.movement);
        setVerifiedNodeFrame(run, frame.snapshot);
        await new Promise(resolve => setTimeout(resolve, 180));
        current = Math.max(current + 1, Math.min(run.result.tick, (run.manifest.branch?.base_tick ?? 0) + Math.floor((performance.now() - startAt) * TICK_HZ / 1000)));
      }
      if (playing) {
        showReplay(verified.snapshot, verified.movement);
        setVerifiedNodeFrame(run, verified.snapshot);
      }
    }
    status('回放一致', 'replayed');
    evidenceStatus((tick === undefined ? '终局' : '已核查前缀') + '哈希一致 · ' + verified.result.state_hash);
  } catch (error) {
    status('回放失败', 'failed');
    evidenceStatus(error.message);
  } finally {
    playing = false;
    replayWorker?.close();
    replayWorker = null;
    changeActivity(null);
  }
}

function makeRunItem(kind, seed, visualProfile = byId('visual-profile').value, comparison = false) {
  if (kind === 'none') visualProfile = 'none-v1';
  return {kind, config: getConfig(seed), visualProfile,
    minimumObservationIntervalMs: comparison || visualProfile !== 'none-v1' ? VISUAL_INTERVAL_MS : 0};
}

function usePlaytestScenario(config) {
  if (!bandsSelected) return config;
  const {pressure_profile, ...options} = config;
  return {...options,scenario:BAT_CRYSTAL_BANDS.id,seed:BAT_CRYSTAL_BANDS.seed,character:BAT_CRYSTAL_BANDS.character};
}

async function previewBandsOpening() {
  const worker = connectSimulation();
  try {
    const config = usePlaytestScenario(RECOMMENDED_PLAYTEST.config);
    const opening = expectResponse(await worker.request('research:create', crypto.randomUUID(), {config}));
    if (opening.snapshot?.tick !== 0 || opening.config.scenario !== BAT_CRYSTAL_BANDS.id) {
      throw Error('固定开局预览与场景不一致');
    }
    if (activity || live?.snapshot || selectedNode) return;
    text('scene-title', bandsLabel + ' · 开局预览');
    show('stage-overlay', false);
    showFrame(opening.snapshot, null, null, null, bandsOpeningCameraY);
  } finally { worker.close(); }
}

function ordinaryRunItem(kind, seed) {
  const advisoryCondition = selectedAdvisoryCondition();
  if (selectedDirectional() || advisoryCondition) {
    const {movement_feedback, ...config} = RECOMMENDED_PLAYTEST.config;
    const pathMicroModel = selectedPathMicroModel();
    return {kind, config: {...config, seed,
      ...(pathMicroModel === NACE_MODEL && {action_profile: RESEARCH_COVERAGE_SEQUENCE_PROFILE})},
      information: RECOMMENDED_PLAYTEST.information,
      visualProfile: RECOMMENDED_PLAYTEST.visualProfile, minimumObservationIntervalMs: 0, directional: true,
      advisoryCondition, pathMicroModel};
  }
  const recommended = selectedRecommendation();
  if (recommended) {
    const {config, information, visualProfile, movementProtocol, minimumObservationIntervalMs, benchmark} = recommended;
    return {kind, config: {...config, seed}, information, visualProfile, movementProtocol,
      minimumObservationIntervalMs, recommended, benchmark};
  }
  const information = selectedInformation();
  if (!information) return null;
  const feedback = selectedFeedback();
  const config = {seed, character: 'antonio', max_ticks: PLAYTEST_SECONDS * TICK_HZ, action_profile: playtestActionProfile(),
    ...(feedback !== 'none' && {movement_feedback: feedback}),
    observation_profile: information.observation, pressure_profile: RESEARCH_PRESSURE,
    ...(information.fields && {observation_fields: information.fields})};
  const visualProfile = selectedNearView() ? STRUCTURED_NEAR_PROFILE
    : feedback === 'trajectory' ? TRAJECTORY_PROFILE : information.visual;
  return {kind, config, visualProfile, information, movementProtocol: selectedWholePath(), minimumObservationIntervalMs: 0};
}

byId('experiment').addEventListener('submit', event => {
  event.preventDefault();
  if (engineering) {
    const seed = byId('seed').valueAsNumber;
    void startRuns([makeRunItem(modelControl().value, seed)], [seed], null);
    return;
  }
  const kind = modelControl().value || 'generation';
  if (probing || activity) return;
  if (!remoteStatus(kind)?.available) {
    if (localKeyMode) return;
    if (modelSetupAction(kind)) byId('connect-model').click();
    else void probe();
    return;
  }
  const item = ordinaryRunItem(kind, PLAYTEST_SEED);
  if (item) {
    const config = usePlaytestScenario(item.config);
    void startRuns([{...item,config}], [config.seed], null);
  }
});
function startBatch(kinds) {
  if (!byId('experiment').reportValidity()) return;
  const values = byId('batch-seeds').value.split(/[\s,，]+/).filter(Boolean);
  const seeds = values.map(Number);
  if (seeds.length < 1 || seeds.length > 5 || new Set(seeds).size !== seeds.length ||
      values.some((value, index) => !/^\d+$/.test(value) || seeds[index] > 0xffffffff)) {
    evidenceStatus('请输入 1 至 5 个不同的无符号整数种子。');
    return;
  }
  const items = kinds.flatMap(kind => seeds.map(seed => makeRunItem(kind, seed)));
  void startRuns(items, seeds, crypto.randomUUID());
}
byId('start-human').addEventListener('click', () => {
  const seed = PLAYTEST_SEED;
  const config = usePlaytestScenario({seed, character: 'antonio', max_ticks: PLAYTEST_SECONDS * TICK_HZ,
    action_profile: RESEARCH_SLOTS_PROFILE, observation_profile: HUMAN_INFORMATION.observation, pressure_profile: RESEARCH_PRESSURE});
  void startRuns([{kind: 'human', config, visualProfile: 'none-v1', information: HUMAN_INFORMATION}], [config.seed], null);
});
byId('download-human-video').addEventListener('click', () => {
  if (latestHumanVideo && latestHumanVideo.runId === latestHumanRun?.run_id) downloadLocalVideo(latestHumanVideo, 'survivors-' + latestHumanVideo.runId);
});
byId('download-human-replay').addEventListener('click', () => {
  if (latestHumanRun) void exportSelection([{run: latestHumanRun}]);
});
byId('playtest-action-profile').addEventListener('change', () => {
  explicitPlaytestAction = byId('playtest-action-profile').value;
  showPlaytestRules();
});
byId('playtest-strategy').addEventListener('change', showPlaytestRules);
byId('playtest-micro-model').addEventListener('change', showPlaytestRules);
byId('playtest-near-view').addEventListener('change', updateInformationDescription);
byId('movement-feedback').addEventListener('change', updateInformationDescription);
byId('action-profile').addEventListener('change', refreshControls);
byId('batch').addEventListener('click', () => startBatch(['fixed', 'random', 'rule']));
byId('batch-selected').addEventListener('click', () => startBatch([modelControl().value]));
byId('compare-visual').addEventListener('click', () => {
  if (!byId('experiment').reportValidity()) return;
  const seed = byId('seed').valueAsNumber;
  const kind = modelControl().value;
  if (kind === 'none') return;
  void startRuns(VISUAL_PROFILES.map(profile => makeRunItem(kind, seed, profile, true)), [seed], crypto.randomUUID());
});
byId('sample-responses').addEventListener('click', () => void startResponseSample());
byId('export-sample').addEventListener('click', exportResponseSample);
byId('compare-models').addEventListener('click', () => {
  if (!byId('experiment').reportValidity() || !modelStatus?.available || !modelStatus?.decisions?.available) return;
  const seed = byId('seed').valueAsNumber;
  const profile = byId('visual-profile').value;
  void startRuns(['generation', 'openai-decisions'].map(kind => makeRunItem(kind, seed, profile, true)), [seed], crypto.randomUUID());
});
byId('benchmark-visual').addEventListener('click', () => {
  if (!byId('experiment').reportValidity()) return;
  const seed = byId('seed').valueAsNumber;
  const items = VISUAL_PROFILES.map(profile => ({
    ...makeRunItem('mock', seed, profile, true), benchmark: 'data-generation-v1'
  }));
  void startRuns(items, [seed], crypto.randomUUID());
});
byId('stop').addEventListener('click', () => {
  if (activity) {
    activity.cancelled = true;
    activity.setup?.abort();
  }
  if (activity?.kind === 'response-sample') activity.controller.abort();
  if (playing) playing = false;
  if (experiment) {
    status('正在结束并保存…', 'stopping');
    void experiment.stop();
  }
});
if (engineering) {
  byId('model').id = 'simple-model';
  byId('engineering-model').id = 'model';
}
modelControl().addEventListener('change', updateVisualControls);
byId('link-report-file').addEventListener('change', event => void loadCalibrationFiles(event));
for (const id of ['link-current', 'link-target', 'link-allow-proxy']) byId(id).addEventListener('change', showCalibration);
byId('link-compensation').addEventListener('change', () => {
  if (byId('link-compensation').value === 'calibrated') byId('link-calibration').open = true;
  showCalibration();
});
byId('visual-profile').addEventListener('change', updateVisualControls);
byId('probe').addEventListener('click', () => void probe());
byId('export').addEventListener('click', () => void exportSelection());
byId('history').addEventListener('change', async event => {
  const id = event.target.value;
  if (!id || activity) return;
  changeActivity({kind: 'load'});
  try {
    const store = await storeReady;
    const run = await store.run(id);
    if (!run) throw Error('本地对局未找到');
    showSelection([await loadEntry(store, run)]);
    showBranch(run);
    evidenceStatus(run.evidence_complete ? '已读取本地实验。' : '本地实验中断，已读取可恢复证据。');
  } catch (error) { evidenceStatus(error.message); }
  finally { changeActivity(null); }
});
byId('import').addEventListener('click', () => byId('import-file').click());
byId('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || activity) return;
  changeActivity({kind: 'import'});
  status('读取实验包', 'importing');
  let valid = false;
  try {
    if (file.size > MAX_ARCHIVE_BYTES) throw Error('实验包超过导入上限');
    const data = JSON.parse(await file.text());
    if (data?.schema === NODE_SCHEMA) {
      const node = await verifyResumeNode(data);
      await (await storeReady).saveNode(node);
      await refreshNodes();
      selectNode(node);
      status('已导入测试节点', 'replayed');
      evidenceStatus('测试节点可直接续测。');
      return;
    }
    const imported = await readReplay(data, {includeEvidence: true});
    const run = [...imported].reverse().find(item => item.result?.state_hash);
    if (!run) throw Error('实验包没有完整终局可回放');
    await verifyRun(run);
    selection = [];
    showSelection(imported.map(item => ({run: item})));
    showBranch(run);
    selection = [];
    refreshControls();
    valid = true;
  } catch (error) {
    status('导入失败', 'failed');
    evidenceStatus(error.message);
  } finally { changeActivity(null); }
  if (valid) void replay();
});
byId('replay-source').addEventListener('change', event => {
  selectedReplay = replaySources.find(run => run.run_id === event.target.value);
  show('replay-range-row', false);
  selectNode(null);
  showBranch(selectedReplay);
});
byId('saved-node').addEventListener('change', event => selectNode(knownNodes.get(event.target.value) ?? null));
byId('save-node').addEventListener('click', () => void saveOrStartNode(false));
byId('start-node').addEventListener('click', () => void saveOrStartNode(true));
byId('export-node').addEventListener('click', () => { if (selectedNode && !activity) downloadNode(selectedNode); });
byId('replay').addEventListener('click', () => void replay());
byId('replay-play').addEventListener('click', () => void replay({play: true}));
byId('replay-range').addEventListener('change', () => {
  selectNode(null);
  const sequence = ++replaySequence;
  clearTimeout(replayTask);
  replayTask = setTimeout(() => {
    if (sequence === replaySequence) void replay({tick: byId('replay-range').valueAsNumber});
  }, 100);
});
window.addEventListener('focus', () => {
  if (!localKeyMode && !engineering && !activity && !probing && !remoteStatus(modelControl().value)?.available) void probe();
});
document.addEventListener('visibilitychange', () => {
  text('visibility', document.hidden ? '页面隐藏' : '页面前台');
  experiment?.lifecycle(document.visibilityState);
  if (document.hidden && activity?.kind === 'batch') activity.cancelled = true;
  if (document.hidden && activity?.kind === 'response-sample') activity.controller.abort();
});
for (const state of ['freeze', 'resume']) document.addEventListener(state, () => experiment?.lifecycle(state));
window.addEventListener('pagehide', () => {
  experiment?.lifecycle('pagehide');
  if (activity?.kind === 'response-sample') activity.controller.abort();
});
show('simple-configuration', !engineering);
show('resume-node-controls', !engineering);
show('engineering-controls', engineering);
show('visual-panel', engineering);
document.body.dataset.view = engineering ? 'engineering' : 'simple';
for (const id of ['live-clock', 'live-failures', 'live-movement']) show(id, engineering);
if (!engineering) text('live-rate-label', '决策 / 秒');
show('run-cost', !engineering);
show('human-play', !engineering);
byId(bandsSelected ? 'bands-scenario' : 'ordinary-scenario').setAttribute('aria-current', 'page');
if (bandsSelected) {
  show('scenario-description', true);
  text('scenario-description', '固定开局。角色在上方，中间横带有 ' + BAT_CRYSTAL_BANDS.enemyPositions.length +
    ' 只蝙蝠，下方横带有 ' + BAT_CRYSTAL_BANDS.gemPositions.length + ' 颗经验水晶，两侧留空。开局后不再刷新敌人。');
  void previewBandsOpening().catch(error => text('stage-overlay', '固定开局预览加载失败 · ' + error.message));
}
byId('inspection-details').open = engineering;
setupInformationControls();
byId('playtest-strategy').querySelector('option[value="recommended"]').textContent = '历史方案（第 ' + RECOMMENDED_PLAYTEST.round + ' 轮）';
modelControl().addEventListener('change', showPlaytestRules);
enhanceSelects();
byId('information-level-dropdown').setAttribute('aria-describedby', 'information-description');
byId('playtest-strategy-dropdown').setAttribute('aria-describedby', 'playtest-rules');
void initializeModelConnection();
if (!engineering) void storeReady.then(async store => {
  const [video, recent] = await Promise.all([store.humanVideo(), store.list()]);
  const latest = recent.find(item => item.model === 'human' && item.reason);
  const run = latest ? await store.run(latest.run_id) : null;
  latestHumanVideo ??= video;
  latestHumanRun ??= run;
  refreshControls();
}).catch(() => {});
void refreshNodes().catch(error => evidenceStatus(error.message));
void refreshHistory().catch(error => evidenceStatus('研究存储不可用 · ' + error.message));
refreshControls();

if (engineering) void showVisualExamples().catch(error => text('visual-example-tick', '样例加载失败 · ' + error.message));
