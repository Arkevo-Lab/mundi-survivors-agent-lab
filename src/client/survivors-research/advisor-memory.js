import {CARDINAL_HEADINGS,CARDINAL_MEMORY_WITH_HEADING} from './models/action-cardinal.js';

const MAX_TARGETS = 128;
const MAX_ENEMIES = 128;
const MAX_CHOICES = 4;
const MAX_WINDOWS = 4;
const MAX_ENEMY_AGE = 120;
const MAX_UNPINNED_TARGET_AGE = 600;
const MAX_ADVICE_AGE = 120;
const MAX_ACTIONS_IN_SUMMARY = 8;
const MAX_OBSERVED_OFFSET_X = 16.01;
const MAX_OBSERVED_OFFSET_Y = 9.01;
const MAX_ENEMY_CHANGES = 16;
const HEADINGS = new Set(['none', 'up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left']);
const ACTIONS = new Set(['stop', ...['up', 'down', 'left', 'right'].map(direction => 'move:' + direction + ':hold:100')]);
const finite = Number.isFinite;
const validTick = tick => Number.isSafeInteger(tick) && tick >= 0;
const valueOrNull = value => finite(value) ? value : null;
const delta = (before, after) => before === null || after === null ? null : after - before;

function point(origin, item) {
  return item && validTick(item.id) && finite(item.dx) && finite(item.dy) &&
    Math.abs(item.dx) <= MAX_OBSERVED_OFFSET_X && Math.abs(item.dy) <= MAX_OBSERVED_OFFSET_Y
    ? {id: item.id, x: origin.x + item.dx, y: origin.y + item.dy} : null;
}

function prune(records, limit, pinned) {
  if (records.size <= limit) return;
  const ordered = [...records.values()].sort((a, b) =>
    b.last_seen_tick - a.last_seen_tick || a.id - b.id);
  const retained = new Set(ordered.filter(row => row.id !== pinned)
    .slice(0, limit - Number(records.has(pinned))).map(row => row.id));
  for (const id of records.keys()) {
    if (id !== pinned && !retained.has(id)) records.delete(id);
  }
}

function targetRow(target, tick) {
  if (!target) return null;
  const {first_seen_tick, ...row} = target;
  return withAge(row, tick);
}

function withAge(row, tick) {
  return Object.freeze({...row, age_ticks: tick - row.last_seen_tick});
}

function observedRange(target, player, tick) {
  return target?.last_seen_tick === tick && (target.status === 'visible' || target.status === 'attracted')
    ? Math.hypot(target.x - player.x, target.y - player.y) : null;
}

function cardinalWindow(window, start, end) {
  const {from_tick, to_tick, displacement, hp_delta, hits_delta, pickups_delta, actions, target, target_id, enemy_changes} = window;
  const rangeStart = observedRange(target.from, start, from_tick);
  const rangeEnd = observedRange(target.to, end, to_tick);
  return Object.freeze({from_tick, to_tick, displacement, hp_delta, hits_delta, pickups_delta,
    applied_action_count: actions.count,
    target: target_id === null ? null : Object.freeze({
      id: target_id, status_start: target.from?.status ?? null, status_end: target.to?.status ?? null,
      range_start: rangeStart, range_end: rangeEnd, range_delta: delta(rangeStart, rangeEnd),
    }),
    enemy_changes});
}

export function createAdvisorMemory() {
  let current = null;
  let anchor = null;
  let ongoing = null;
  let pinned = null;
  const targets = new Map();
  const enemies = new Map();
  const history = [];
  let actions = [];
  let lastActionTick = 0;
  let lastDecisionId = null;

  function observe(observation, visualFrame, hitsTaken = null, refreshSameTick = false) {
    const {run_id, tick, sampled_at_ms} = observation ?? {};
    const position = visualFrame?.player;
    if (typeof run_id !== 'string' || !run_id || !validTick(tick) ||
        !finite(sampled_at_ms) || visualFrame?.tick !== tick || visualFrame.sampled_at_ms !== sampled_at_ms ||
        !finite(position?.x) || !finite(position?.y) || observation.terminal ||
        (current && (run_id !== current.run_id || tick < current.tick || tick === current.tick && !refreshSameTick))) return false;

    anchor ??= {x: position.x, y: position.y};
    // The structured HUD shows the same sampled aggregate when public JSON omits score.
    const publicGems = observation.score?.gems_collected;
    const visibleGems = validTick(publicGems) ? publicGems : visualFrame.gemsCollected;
    const player = Object.freeze({x: position.x - anchor.x, y: position.y - anchor.y,
      hp: valueOrNull(observation.player?.hp), hits_taken: validTick(hitsTaken) ? hitsTaken : null,
      gems_collected: validTick(visibleGems) ? visibleGems : null});
    current = {run_id, tick, player};
    const seenTargets = new Set();
    for (const item of Array.isArray(observation.loot) ? observation.loot : []) {
      if (item?.kind !== 'experience') continue;
      const located = point(player, item);
      if (!located) continue;
      seenTargets.add(item.id);
      targets.set(item.id, {...located, value: valueOrNull(item.value),
        status: item.being_collected ? 'attracted' : 'visible', last_seen_tick: tick,
        first_seen_tick: targets.get(item.id)?.first_seen_tick ?? tick});
    }
    const covered = observation.coverage?.loot;
    const allLootListed = Array.isArray(observation.loot) && covered?.truncated === false &&
      covered.sent === observation.loot.length && covered.visible === covered.sent;
    for (const [id, old] of targets) {
      if (seenTargets.has(id)) continue;
      // A confirmed absence or attraction remains evidence until reobserved.
      if (old.status === 'attracted' || old.status === 'reobserved-absent') continue;
      // Leave margin for rounded public offsets.
      const inside = Math.abs(player.x - old.x) < 15.99 && Math.abs(player.y - old.y) < 8.99;
      targets.set(id, {...old, status: allLootListed && inside ? 'reobserved-absent' : 'unknown'});
    }
    prune(targets, MAX_TARGETS, pinned);
    for (const [id, enemy] of enemies) {
      if (tick - enemy.last_seen_tick > MAX_ENEMY_AGE) enemies.delete(id);
    }
    for (const item of Array.isArray(observation.enemies) ? observation.enemies : []) {
      const located = point(player, item);
      if (!located || !finite(item.radius) || item.radius < 0) continue;
      const old = enemies.get(item.id);
      const previous = old?.last_seen_tick === tick ? old.previous : old ? Object.freeze({x: old.x, y: old.y, tick: old.last_seen_tick}) : null;
      enemies.set(item.id, {...located, radius: item.radius, last_seen_tick: tick, previous});
    }
    prune(enemies, MAX_ENEMIES, null);
    return true;
  }

  function windowAt() {
    const {metadata, player: start, target, enemies: startEnemies} = ongoing;
    const {player, tick} = current;
    const executed = actions.filter(action => action.applied_tick <= tick);
    const enemyChanges = [];
    for (const old of startEnemies) {
      const next = enemies.get(old.id);
      if (next?.last_seen_tick !== tick) continue;
      enemyChanges.push(Object.freeze({id: old.id, dx: next.x - old.x, dy: next.y - old.y}));
    }
    const liveTarget = targets.get(metadata.target_id);
    return Object.freeze({...metadata, from_tick: metadata.accepted_tick, to_tick: tick,
      displacement: Object.freeze({dx: player.x - start.x, dy: player.y - start.y}),
      hp_delta: delta(start.hp, player.hp), hits_delta: delta(start.hits_taken, player.hits_taken),
      pickups_delta: delta(start.gems_collected, player.gems_collected),
      actions: Object.freeze({count: executed.length, last: Object.freeze(executed.slice(-MAX_ACTIONS_IN_SUMMARY))}),
      target: Object.freeze({from: target, to: targetRow(liveTarget, tick)}),
      enemy_changes: Object.freeze(enemyChanges)});
  }

  function selectedTargets({tick, player}) {
    const active = targets.get(pinned);
    const choices = [...targets.values()].filter(row => row.id !== pinned &&
      (row.status === 'visible' || row.status === 'unknown' && tick - row.last_seen_tick <= MAX_UNPINNED_TARGET_AGE));
    const distance = row => (row.x - player.x) ** 2 + (row.y - player.y) ** 2;
    choices.sort((a, b) => distance(a) - distance(b) || a.id - b.id);
    if (active) choices.unshift(active);
    return choices.slice(0, MAX_CHOICES).map(row => targetRow(row, tick));
  }

  function snapshot() {
    if (!current) return null;
    const {tick} = current;
    const observedEnemies = [...enemies.values()].sort((a, b) =>
      b.last_seen_tick - a.last_seen_tick || a.id - b.id);
    return Object.freeze({...current,
      targets: Object.freeze(selectedTargets(current)),
      enemies: Object.freeze(observedEnemies.map(row => withAge(row, tick))),
      history: Object.freeze(history.map(row => row.legacy)), ongoing: ongoing && windowAt()});
  }

  function cardinalSnapshot({includeHeading=false}={}) {
    if (!current) return null;
    const {run_id, tick, player} = current;
    const {x, y, ...publicPlayer} = player;
    const relativeTargets = selectedTargets(current).map(({x: targetX, y: targetY, ...target}) =>
      Object.freeze({...target, dx: targetX - x, dy: targetY - y}));
    const withHeading=(cardinal,heading)=>includeHeading?Object.freeze({...cardinal,
      heading:CARDINAL_HEADINGS.includes(heading)?heading:null}):cardinal;
    return Object.freeze({
      schema: includeHeading?CARDINAL_MEMORY_WITH_HEADING:'survivors-cardinal-memory-v2', coordinate_frame: 'current-player-relative', run_id, tick,
      player: Object.freeze(publicPlayer), active_target_id: pinned, targets: Object.freeze(relativeTargets),
      history: Object.freeze(history.map(row=>withHeading(row.cardinal,row.legacy?.heading))),
      ongoing: ongoing && withHeading(cardinalWindow(windowAt(),ongoing.player,player),ongoing.metadata.heading),
    });
  }

  function accept({guidance_id, source_tick, target_id, heading} = {}) {
    if (!current || typeof guidance_id !== 'string' || !guidance_id || !validTick(source_tick) ||
        source_tick > current.tick || current.tick - source_tick >= MAX_ADVICE_AGE ||
        (ongoing && (source_tick <= ongoing.metadata.source_tick || guidance_id === ongoing.metadata.guidance_id)) ||
        !HEADINGS.has(heading)) return false;
    if (target_id !== null) {
      const target = targets.get(target_id);
      if (!target || target.first_seen_tick > source_tick ||
          (target.status !== 'visible' && target.status !== 'unknown')) return false;
    }
    if (ongoing) {
      const closed = windowAt();
      history.push({legacy: closed, cardinal: cardinalWindow(closed, ongoing.player, current.player)});
      if (history.length > MAX_WINDOWS) history.shift();
    }
    actions = actions.filter(action => action.applied_tick > current.tick);
    pinned = target_id;
    const startEnemies = [];
    for (const enemy of enemies.values()) {
      if (enemy.last_seen_tick !== current.tick) continue;
      startEnemies.push(enemy);
      if (startEnemies.length >= MAX_ENEMY_CHANGES) break;
    }
    ongoing = {
      metadata: {guidance_id, source_tick, accepted_tick: current.tick, target_id, heading},
      player: current.player, target: targetRow(targets.get(pinned), current.tick), enemies: startEnemies,
    };
    return true;
  }

  function recordAction({decision_id, applied_tick, action_id} = {}) {
    if (!ongoing || typeof decision_id !== 'string' || !decision_id || decision_id === lastDecisionId ||
        !validTick(applied_tick) || applied_tick <= lastActionTick || applied_tick <= ongoing.metadata.accepted_tick ||
        !ACTIONS.has(action_id)) return false;
    actions.push(Object.freeze({decision_id, applied_tick, action_id}));
    lastActionTick = applied_tick;
    lastDecisionId = decision_id;
    return true;
  }

  function reset() {
    current = null;
    anchor = null;
    ongoing = null;
    pinned = null;
    targets.clear();
    enemies.clear();
    history.length = 0;
    actions = [];
    lastActionTick = 0;
    lastDecisionId = null;
  }

  function exportState() {
    return structuredClone({schema:'survivors-advisor-memory-state-v1', current, anchor, ongoing, pinned,
      targets:[...targets.entries()], enemies:[...enemies.entries()], history, actions, lastActionTick, lastDecisionId});
  }

  function importState(state, runId) {
    if (!state || state.schema !== 'survivors-advisor-memory-state-v1' || typeof runId !== 'string' || !runId ||
        !Array.isArray(state.targets) || state.targets.length > MAX_TARGETS ||
        !Array.isArray(state.enemies) || state.enemies.length > MAX_ENEMIES ||
        !Array.isArray(state.history) || state.history.length > MAX_WINDOWS || !Array.isArray(state.actions) ||
        state.current && (!validTick(state.current.tick) || !finite(state.current.player?.x) ||
          !finite(state.current.player?.y))) throw new TypeError('Invalid advisor memory checkpoint');
    reset();
    const copy = structuredClone(state);
    current = copy.current && {...copy.current, run_id:runId};
    anchor = copy.anchor;
    ongoing = copy.ongoing;
    pinned = copy.pinned;
    for (const [id, target] of copy.targets) targets.set(id, target);
    for (const [id, enemy] of copy.enemies) enemies.set(id, enemy);
    history.push(...copy.history);
    actions = copy.actions;
    lastActionTick = copy.lastActionTick;
    lastDecisionId = copy.lastDecisionId;
  }

  return {observe, snapshot, cardinalSnapshot, accept, recordAction, reset, exportState, importState};
}
