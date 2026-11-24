import {RESEARCH_SLOTS_COUNT, RESEARCH_SLOT_WAIT_ID} from '../../shared/survivors-research-contract.js';

const directions = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};

export function createHumanControl({onUpgrade}) {
  const held = new Set();
  const listeners = new AbortController();
  let upgrade;
  function handleKey(event) {
    if (event.type === 'keydown' && (event.metaKey || event.ctrlKey || event.altKey ||
      event.target?.closest?.('input, textarea, select, [contenteditable]'))) return;
    const direction = directions[event.code];
    if (direction) {
      event.preventDefault();
      if (event.type === 'keyup') held.delete(event.code);
      else if (!event.repeat && !upgrade) held.add(event.code);
    }
    if (event.type === 'keydown' && !event.repeat && /^[1-9]$/.test(event.key) && upgrade?.choose) {
      event.preventDefault();
      upgrade.choose(Number(event.key) - 1);
    }
  }
  function clearUpgrade() {
    if (!upgrade) return;
    upgrade = undefined;
    held.clear();
    onUpgrade(null);
  }
  function waitForUpgrade(offer, candidates, signal) {
    const options = offer.options.flatMap(option => {
      const actionId = `choose:${offer.offer_id}:${option.option_id}`;
      return candidates.some(candidate => candidate.id === actionId) ? [{...option, actionId}] : [];
    });
    if (!options.length) throw Error('升级选项已失效');
    held.clear();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearUpgrade();
        reject(signal.reason);
      };
      const choose = index => {
        if (upgrade?.choose !== choose || !options[index]) return;
        signal.removeEventListener('abort', cancel);
        upgrade = {options, selected: index, actionId: options[index].actionId};
        onUpgrade(upgrade);
        resolve(upgrade.actionId);
      };
      upgrade = {options, choose};
      signal.addEventListener('abort', cancel, {once: true});
      if (signal.aborted) cancel();
      else onUpgrade(upgrade);
    });
  }
  return {
    start() {
      const options = {signal: listeners.signal};
      window.addEventListener('keydown', handleKey, options);
      window.addEventListener('keyup', handleKey, options);
      window.addEventListener('blur', () => held.clear(), options);
    },
    handleAttempt(event) {
      if (!upgrade?.actionId || event.action_id !== upgrade.actionId) return false;
      clearUpgrade();
      return event.status !== 'applied' && event.status !== 'cancelled';
    },
    close() {
      listeners.abort();
      held.clear();
      clearUpgrade();
    },
    model: {
      config: {kind: 'human', model: '玩家'},
      async decide({observation, candidates, signal}) {
        if (observation.upgrade_offer) {
          const id = await waitForUpgrade(observation.upgrade_offer, candidates, signal);
          return {action_id: id, action_ids: [id]};
        }
        const pressed = new Set([...held].map(code => directions[code]));
        const vertical = pressed.has('up') === pressed.has('down') ? '' : pressed.has('up') ? 'up' : 'down';
        const horizontal = pressed.has('left') === pressed.has('right') ? '' : pressed.has('left') ? 'left' : 'right';
        const heading = [vertical, horizontal].filter(Boolean).join('-');
        const id = heading ? `move:${heading}:hold:50` : RESEARCH_SLOT_WAIT_ID;
        return {action_id: id, action_ids: Array(RESEARCH_SLOTS_COUNT).fill(id)};
      },
    },
  };
}
