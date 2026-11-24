import assert from 'node:assert/strict';
import test from 'node:test';
import {hashJSON} from '../src/client/survivors-research/evidence.js';
import {createArchive, readReplay, summarizeRuns} from '../src/client/survivors-research/report.js';
import {buildResumeNode, canBuildResumeNode, resumeNodeId, verifyResumeNode} from '../src/client/survivors-research/resume-node.js';

const config = {seed: 42, max_ticks: 3600, action_profile: 'hold-sequence-v1'};
const source = {run_id: 'source', manifest: {config, engine_sha256: 'engine-hash', initial_state_sha256: 'initial',
  model: {kind:'openai-decisions', movement_question_mode:'direction-v1'}},
  initial_state: {checkpoint:'initial'}, actions: [], result: {tick: 120, reason:'stopped', state_hash:'terminal'}};
const observed = (tick, observationId = 'obs-' + tick) => ({type:'observation_sampled', tick,
  observation_id:observationId, sampled_at_ms:1000 + tick, terminal:false});

test('node cache identity binds evidence, terminal choices, context, and exact frame', async () => {
  const evidence = [observed(90), observed(100)];
  const id = await resumeNodeId(source, 100, evidence);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.notEqual(id, await resumeNodeId(source, 101, evidence));
  assert.notEqual(id, await resumeNodeId(source, 100, [...evidence, {type:'advisor:published', accepted_tick:90}]));
  assert.notEqual(id, await resumeNodeId({...source, resume_node:{integrity:'parent'}}, 100, evidence));
  assert.equal(canBuildResumeNode(source, 120), true);
  for (const reason of ['death','reaper','time-limit']) {
    assert.equal(canBuildResumeNode({...source, result:{...source.result, reason}}, 120), false);
  }
  assert.equal(canBuildResumeNode({...source, result:{...source.result, reason:'segment-limit'}}, 120), true);
  assert.equal(canBuildResumeNode({...source, manifest:{...source.manifest, branch:{base_tick:100}}}, 99), false);
});

test('node uses only cutoff receipts and branch archive preserves self-sufficient starting state', async () => {
  const samples = [observed(90), observed(121), observed(100)];
  const snapshot = {tick:100, player:{hp:92,gemsCollected:7}, hits_taken:3};
  const sim = {source_run_id:'source', base_tick:100, node_hash:'physical-hash', config};
  const node = await buildResumeNode({run:source,tick:100,events:samples,worker:{
    async request(type,id,body) {
      assert.equal(type, 'research:build_node');
      assert.equal(id, 'source');
      assert.deepEqual(body.observations.map(row => row.tick), [90,100]);
      return {consistent:true,base_tick:100,node_state:sim,snapshot,context_samples:[]};
    },
  }});
  assert.equal(await verifyResumeNode(node), node);
  await assert.rejects(verifyResumeNode({...node, facts:{...node.facts, gems_collected:900}}), /节点/);

  const initial_state = {node_state:sim,limit_tick:700};
  const branch = {schema:'survivors-research-branch-v1',node_id:node.node_id,node_sha256:node.integrity,
    source:node.source,base_tick:100,limit_tick:700,start_facts:node.facts,strategy:'最新版四向寻晶',
    start_semantics:'fresh-requests-at-node',prefix_model_requests:0};
  const run = {run_id:'branch', manifest:{...source.manifest, run_id:'branch',
    initial_state_sha256:await hashJSON(initial_state), branch}, resume_node:node, initial_state,
    result:{tick:101,base_tick:100,limit_tick:700,hp:88,hits_taken:4,gems_collected:9,reason:'stopped'},
    actions:[], evidence_complete:true};
  const events = [observed(100)];
  const archive = await createArchive([{run,events,positions:[[0,0],[1,0]]}]);
  const [loaded] = await readReplay(archive,{includeEvidence:true});
  assert.deepEqual(loaded.resume_node,node);
  assert.deepEqual(loaded.events,events);
  assert.equal(loaded.payloads.files,archive.files);
  assert.equal(JSON.parse(archive.files['movement.jsonl']).tick,101);
  const [summary] = summarizeRuns([loaded]).rows;
  assert.equal(summary.segment_crystals,2);
  assert.equal(summary.segment_hits,1);
  assert.equal(summary.segment_hp_delta,-4);
  assert.equal(summary.comparison_eligible,false);
  delete archive.files['resume-node.json'];
  await assert.rejects(readReplay(archive), /节点/);
});
