import assert from 'node:assert/strict';
import test from 'node:test';
import {withoutWeaponState} from '../src/client/survivors-research/models/action-observation.js';
import {projectLocalMicro,DREX_WEAPON_MICRO_PROJECTION_SCHEMA} from '../src/client/survivors-research/models/local-micro.js';
import {drawLocalMicro} from '../src/client/survivors-research/micro-visual-render.js';

const enemy = (id,dx,hp) => ({id,dx,dy:0,hp,radius:0.25,velocity:[0,0]});
const bounds = {shape:'rectangle',half_width:0.5,half_height:0.4};
const strike = (id,dx) => ({id,index:0,direction:1,dx,dy:0,bounds,
  remaining_ticks:3,damage:10,max_bounds:bounds,already_hit_enemy_ids:[1,2]});
const snapshot = {
  tick:42,
  player:{speed:3.2,movement:[0,0],equipment:[{id:'whip',level:2},{id:'wand',level:1}],
    weapon_state:[{id:'whip',combat:{pending_strikes:[{index:1,in_ticks:5}],
      active_strikes:[strike(8,3.5),strike(9,4)],cooldown_remaining_ticks:60}},
    {id:'wand',combat:null}]},
  enemies:[enemy(1,2,12),enemy(2,4,4),enemy(3,1,undefined)],
};
const local = observation => projectLocalMicro({observation,weaponAware:true,targetHandoff:true,facing:-1});

test('weapon-aware local projection preserves the old radius and only carries local enemy identities',()=>{
  const projection = local(snapshot);
  assert.equal(projection.schema,DREX_WEAPON_MICRO_PROJECTION_SCHEMA);
  assert.equal(projection.viewport.local_radius,3.2);
  assert.equal(projection.player.facing,-1);
  assert.deepEqual(projection.threats.map(({id,hp})=>[id,hp]),[[1,12],[3,null]]);
  const [whip,wand] = projection.weapons;
  assert.deepEqual(wand,{id:'wand',level:1,combat:null});
  assert.equal(whip.level,2);
  assert.deepEqual(whip.combat.pending_strikes,[{index:1,in_ticks:5}]);
  const {max_bounds,...localStrike} = strike(8,3.5);
  assert.deepEqual(whip.combat.active_strikes,[{...localStrike,already_hit_enemy_ids:[1]}]);
  const cast = structuredClone(snapshot);
  cast.player.weapon_state[0].combat.active_strikes[0].bounds = null;
  assert.equal(local(cast).weapons[0].combat.active_strikes[0].bounds,null);
  delete cast.player.weapon_state[0].combat.active_strikes[0].max_bounds;
  assert.equal(local(cast).weapons[0].combat.active_strikes[0].id,8);
  assert.deepEqual(snapshot.player.weapon_state[0].combat.active_strikes[0].already_hit_enemy_ids,[1,2]);
  const otherRoles = withoutWeaponState(snapshot);
  assert.deepEqual(otherRoles.player.equipment,snapshot.player.equipment);
  assert.ok(!Object.hasOwn(otherRoles.player,'weapon_state'));
  assert.equal(withoutWeaponState(otherRoles),otherRoles);
  assert.equal(local(otherRoles).weapons,null);
  assert.deepEqual(local({...snapshot,player:{...snapshot.player,weapon_state:[]}}).weapons,[]);
  assert.ok(!Object.hasOwn(projectLocalMicro({observation:snapshot,targetHandoff:true}),'weapons'));
});

test('canvas draws only measured active rectangles inside the existing clip',()=>{
  const calls = [];
  const ctx = new Proxy({}, {get(target,key) {
    return key in target ? target[key] : (...args) => calls.push([key,...args]);
  }});
  const projection = local(snapshot);
  projection.weapons[0].combat.active_strikes.push({dx:0,dy:0,bounds:null});
  drawLocalMicro(ctx,projection);
  assert.equal(calls.filter(row=>row[0]==='strokeRect').length,1);
  assert.ok(calls.findIndex(row=>row[0]==='clip') < calls.findIndex(row=>row[0]==='strokeRect'));
  assert.ok(calls.findIndex(row=>row[0]==='strokeRect') < calls.findIndex(row=>row[0]==='restore'));
});
