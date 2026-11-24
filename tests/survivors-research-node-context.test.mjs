import assert from 'node:assert/strict';
import test from 'node:test';
import {createResumeContext,restoreNodeModel} from '../src/client/survivors-research/models/node-context.js';

function sample(tick, x=0, gems=0) {
  return {observation:{run_id:'source',observation_id:'obs-'+tick,tick,sampled_at_ms:tick*17,
    player:{hp:120},loot:[{id:5,kind:'experience',dx:3-x,dy:1,value:1}],
    enemies:[],coverage:{loot:{visible:1,sent:1,truncated:false}}},
    frame:{tick,sampled_at_ms:tick*17,player:{x,y:0},gemsCollected:gems},hitsTaken:0};
}
const guidance={decision_id:'g1',observation_tick:0,accepted_tick:10,guidance:{target_id:5,heading:'right'}};
const inputs={source_run_id:'source',source_mode:'advisory-cardinal-v2',base_tick:20,
  context_samples:[sample(0),sample(10,1),sample(20,2)],
  accepted_guidance:[guidance],applied_actions:[{decision_id:'a',applied_tick:11,action_id:'move:right:hold:100'}]};

test('node memory round-trips independently and excludes future samples and guidance',()=>{
  const context=createResumeContext({...inputs,context_samples:[...inputs.context_samples,sample(40,9)],
    accepted_guidance:[guidance,{...guidance,decision_id:'future',accepted_tick:40}]});
  const clean=createResumeContext(inputs);
  assert.deepEqual(context,clean);
  const a=restoreNodeModel({context,nodeTick:20,branchRunId:'branch-a',targetMode:'advisory-cardinal-v2'});
  const b=restoreNodeModel({context,nodeTick:20,branchRunId:'branch-b',targetMode:'advisory-cardinal-v2'});
  assert.equal(a.advisorRestore.active.guidance.target_id,5);
  assert.equal(a.advisorRestore.nextTick,20);
  assert.equal(a.memory.cardinalSnapshot().run_id,'branch-a');
  assert.equal(a.memory.cardinalSnapshot().targets[0].dx,1);
  const refreshed=sample(20,2);
  refreshed.observation.run_id='branch-a';
  assert.equal(a.memory.observe(refreshed.observation,refreshed.frame,0,true),true);
  assert.equal(a.memory.cardinalSnapshot().ongoing.applied_action_count,1);
  assert.equal(b.memory.cardinalSnapshot().run_id,'branch-b');
  const next=createResumeContext({source_run_id:'branch-a',source_mode:'advisory-cardinal-v2',base_tick:30,
    initial_context:context,context_samples:[sample(30,2.5,1)]});
  assert.equal(next.memory_state.current.tick,30);
  assert.equal(next.memory_state.ongoing.metadata.target_id,5);
});

test('expired and diagonal legacy advice never maps silently into cardinal directions',()=>{
  const source=createResumeContext({...inputs,source_mode:'advisory-direction-v1',
    accepted_guidance:[{...guidance,guidance:{target_id:5,heading:'up-right'}}]});
  const result=restoreNodeModel({context:source,nodeTick:20,branchRunId:'b',targetMode:'advisory-cardinal-v2'});
  assert.equal(result.advisorRestore.active,null);
  assert.equal(result.memory.cardinalSnapshot().active_target_id,5);
  assert.ok(result.contextReport.missing.includes('incompatible_or_expired_guidance'));
});

test('same-tick ACK belongs to preceding guidance window',()=>{
  const context=createResumeContext({...inputs,base_tick:20,
    accepted_guidance:[guidance,{decision_id:'g2',observation_tick:10,accepted_tick:20,
      guidance:{target_id:5,heading:'left'}}],
    applied_actions:[{decision_id:'boundary',applied_tick:20,action_id:'move:right:hold:100'}]});
  const restored=restoreNodeModel({context,nodeTick:20,branchRunId:'b',targetMode:'advisory-cardinal-v2'});
  assert.equal(restored.memory.cardinalSnapshot().history[0].applied_action_count,1);
  assert.equal(restored.memory.cardinalSnapshot().ongoing.applied_action_count,0);
});

test('nested branch reobserves its base tick while excluding parent boundary events',()=>{
  const parent=createResumeContext(inputs);
  const initial=sample(20,2,4);
  initial.observation.loot=[{id:8,kind:'experience',dx:1,dy:2,value:1}];
  const child=createResumeContext({source_run_id:'child',source_mode:'advisory-cardinal-v2',base_tick:30,
    initial_context:parent,context_samples:[initial,sample(30,2.5,4)],accepted_guidance:[guidance],
    applied_actions:[{decision_id:'ignored',applied_tick:20,action_id:'move:up:hold:100'}]});
  assert.ok(child.memory_state.targets.some(([id])=>id===8));
  assert.equal(child.memory_state.ongoing.metadata.guidance_id,'g1');
  assert.equal(child.memory_state.actions.length,1);
});

test('hydrate rejects future observations, history and guidance',()=>{
  const original=createResumeContext(inputs);
  for (const mutate of [
    state=>{state.memory_state.current.tick=21;},
    state=>{state.memory_state.targets[0][1].last_seen_tick=21;},
    state=>{state.active_guidance.acceptedTick=21;},
    state=>{state.memory_state.ongoing.metadata.accepted_tick=21;},
    state=>{state.memory_state.actions[0].applied_tick=21;},
  ]) {
    const bad=structuredClone(original);
    mutate(bad);
    assert.throws(()=>restoreNodeModel({context:bad,nodeTick:20,branchRunId:'b',targetMode:'advisory-cardinal-v2'}));
  }
});
