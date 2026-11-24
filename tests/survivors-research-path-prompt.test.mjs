import assert from 'node:assert/strict';
import test from 'node:test';
import {pathPromptInput} from '../scripts/survivors-research/path-prompt-protocol.mjs';
import {wholePathInput} from '../scripts/survivors-research/whole-path-protocol.mjs';

test('the path-prompt arm adds only a dynamically rendered text block to the exact old request', () => {
  const observation = {schema: 'survivors-observation-v1', profile: 'state-detail-v1', tick: 6, terminal: false,
    player: {gem_pickup_radius: 0.81, movement_distance: {unobstructed_100_ms: 0.43}}};
  const strategy = 'Collect reachable gems.';
  const old = pathPromptInput(observation, strategy, 'old');
  assert.equal(JSON.stringify(old), JSON.stringify(wholePathInput(observation, strategy, 'whole-path')));
  const next = pathPromptInput(observation, strategy, 'new');
  const [message] = next.input;
  const extra = message.content.at(-1);
  assert.deepEqual({...next, input: [{...message, content: message.content.slice(0, -1)}]}, old);
  assert.equal(extra.type, 'input_text');
  assert.match(extra.text, /100 ms step is 0\.43 world units.*pickup radius is 0\.81 world units/);
  assert.equal(next.questions[0].choices.length, 64);
  assert.throws(() => pathPromptInput({...observation, player: {}}, strategy, 'new'), /observed 100 ms/);
});
