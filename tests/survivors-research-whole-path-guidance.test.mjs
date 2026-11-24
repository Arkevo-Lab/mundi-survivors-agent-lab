import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { createIteratedWholePathModel, wholePathStrategyDigest, WHOLE_PATH_FARM_STRATEGY,
  WHOLE_PATH_FARM_STRATEGY_SHA256, WHOLE_PATH_GUIDANCE_SCHEMA } from '../src/client/survivors-research/models/iterated-whole-path.js';
import { RESEARCH_SEQUENCE_PROFILE, researchCandidates } from '../src/shared/survivors-research-contract.js';

test('bounded whole-path guidance preserves the default and hashes the exact effective strategy', async t => {
  const guidance = 'Recheck accessible experience after opening safe space.';
  const candidate = { schema: WHOLE_PATH_GUIDANCE_SCHEMA, guidance };
  const expected = WHOLE_PATH_FARM_STRATEGY + guidance + '\n';
  assert.equal(await wholePathStrategyDigest(), WHOLE_PATH_FARM_STRATEGY_SHA256);
  assert.equal(await wholePathStrategyDigest(candidate), createHash('sha256').update(expected).digest('hex'));
  for (const invalid of [null, [], {}, { ...candidate, extra: true }, { ...candidate, schema: 'unknown' },
    ...['', ' spaces ', 'line\nbreak', 'line\u2028break', 'hidden\u202Etext', '\uD800', '界'.repeat(267)]
      .map(guidance => ({ ...candidate, guidance }))]) {
    assert.throws(() => createIteratedWholePathModel(invalid), TypeError);
    await assert.rejects(wholePathStrategyDigest(invalid), TypeError);
  }
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ error: { code: 'fixture' } }, { status: 409 });
  };
  const chunk = (name, data) => {
    const block = Buffer.concat([Buffer.from(name), data]);
    const bytes = Buffer.alloc(8 + block.length);
    bytes.writeUInt32BE(data.length);
    block.copy(bytes, 4);
    bytes.writeUInt32BE(crc32(block), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(480);
  header.writeUInt32BE(270, 4);
  header[8] = 8;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(481 * 270))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  const action_profile = RESEARCH_SEQUENCE_PROFILE;
  const observation = { schema: 'survivors-observation-v1', tick: 0, profile: 'state-detail-v1',
    terminal: false, player: { speed: 3.2 } };
  const args = { observation, action_profile, candidates: researchCandidates(action_profile),
    image: { profile: 'structured-v1', tick: 0, mime_type: 'image/png', data_url: 'data:image/png;base64,' + png } };
  for (const policy of [undefined, candidate]) {
    await assert.rejects(createIteratedWholePathModel(policy).decide(args), { code: 'fixture' });
  }
  assert.equal(bodies[0].training_strategy, WHOLE_PATH_FARM_STRATEGY);
  assert.deepEqual(bodies[1], { ...bodies[0], training_strategy: expected });
});
