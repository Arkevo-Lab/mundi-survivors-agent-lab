// Local treasure adapter: selected installed data defines base coin ranges and
// prize types; random generator, fixed prizes and other modifiers remain open.
export const TREASURE_TIER_CANDIDATES = Object.freeze({
  1: Object.freeze({rarity: 'common', rewards: 1, goldMin: 100, goldMax: 199}),
  2: Object.freeze({rarity: 'rare', rewards: 3, goldMin: 300, goldMax: 599}),
  3: Object.freeze({rarity: 'legendary', rewards: 5, goldMin: 500, goldMax: 999})
});

export function treasureTierCandidate(tier) {
  if (!TREASURE_TIER_CANDIDATES[tier]) throw new Error('invalid treasure tier');
  return TREASURE_TIER_CANDIDATES[tier];
}

// 058 maps the installed no-modifier base coin draw to its seeded RNG.
export function treasureGold(tier, random) {
  const profile=treasureTierCandidate(tier);
  return profile.goldMin + Math.floor(random() * (profile.goldMax - profile.goldMin + 1));
}

export function settleTreasure({tier, random, evolutions, upgrades, existingWeapons, existingAny, prizeTypes, choose, apply}) {
  const profile = treasureTierCandidate(tier);
  const rewards = [];
  for (let index = 0; index < profile.rewards; index++) {
    // Rebuild after each applied reward: repeated items can gain another level,
    // but no item can be awarded beyond its cap. Preserve the prototype's
    // evolution-first preference, without exposing a choice to the player.
    const eligibleEvolutions = evolutions();
    let pool;
    if (prizeTypes) {
      const type = prizeTypes[index];
      pool = type === 'EVOLUTION' && eligibleEvolutions.length ? eligibleEvolutions
        : type === 'EVOLUTION' || type === 'EXISTING_WEAPON' ? existingWeapons()
          : existingAny();
    } else pool = eligibleEvolutions.length ? eligibleEvolutions : upgrades();
    const reward = pool.length ? (choose ? choose(pool) : pool[Math.floor(random() * pool.length)])
      : {id: 'bonus-coin', label: '金币袋 · 获得 25 金币'};
    const awarded = {...reward};
    apply(awarded);
    rewards.push(awarded);
  }
  return rewards;
}
