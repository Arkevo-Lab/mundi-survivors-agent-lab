// Public weapon capability; this does not prescribe a route or an action.
export const WHIP_KNOWLEDGE = [
  'When equipped, the whip attacks automatically on its cooldown in a short-range horizontal area with vertical thickness.',
  'The first strike uses the player’s left or right facing when emitted. In a multi-strike cycle, additional strikes alternate relative to the facing at each strike’s own emission, which may change between strikes.',
  'Moving left or right changes that facing; moving vertically or stopping retains it. Turning alone does not immediately fire the whip, and moving down does not make it attack downward.',
  'Enemies above or below must be within the horizontal attack area to be hit; relative positioning, timing, range and damage affect whether a hit or defeat occurs.',
].join(' ');
