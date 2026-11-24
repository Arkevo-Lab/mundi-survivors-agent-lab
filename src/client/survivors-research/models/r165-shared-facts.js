import { sharedFacts as sharedFactsV1 } from './r162-shared-facts.js';

export const R165_FACTS_VERSION='survivors-shared-facts-v2';
const PURSUIT = 'The observed enemy velocity is a world-space measurement from the most recent simulation tick, not a guaranteed future vector. Ordinary pursuing enemies recompute their direction toward the player’s current position each tick as the player moves; special cases such as frozen, recoil or fixed-direction enemies can behave differently. Stopping does not by itself stop approaching pursuers or evade them.';
export function sharedFacts(role) {
  const pickup = role === 'strategy' || role === 'direction' ? ' An attracted crystal follows the player, who can continue moving; XP and pickup counts can be credited later. A zero pickup delta in a short window alone does not prove that attraction failed.' : '';
  return `${sharedFactsV1(role)} ${PURSUIT}${pickup}`;
}
