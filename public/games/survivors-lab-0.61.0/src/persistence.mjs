// Local candidate persistence. Checksums detect corruption, not hostile save editing.
export const MAX_SAVE_BYTES = 8_000_000;
export const MAX_SETTLEMENTS = 2048;
export const PROFILE_KEY = 'mundi:survivors:0.61.0:profile.v1';
export const CHARACTER_COSTS = Object.freeze({antonio: 0, imelda: 11, pasqualina: 110, gennaro: 550});
export const CHARACTER_IDS = ['antonio', 'imelda', 'pasqualina', 'gennaro', 'arca', 'porta', 'exdash', 'mortaccio'];
export const clone = value => JSON.parse(JSON.stringify(value));
export function requireValue(ok, reason) { if (!ok) throw new Error(reason); }
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= min && value <= max; }
export function validateJSON(value, depth = 0) {
  requireValue(depth <= 24, 'save too deep');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { requireValue(Number.isFinite(value), 'non-finite number'); return; }
  if (typeof value === 'string') { requireValue(value.length <= 8_000_000, 'string too long'); return; }
  requireValue(value && typeof value === 'object', 'invalid JSON value');
  requireValue(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype, 'invalid object');
  requireValue(Object.keys(value).length <= 20000, 'save collection too large');
  for (const [key, child] of Object.entries(value)) {
    requireValue(!['__proto__', 'prototype', 'constructor'].includes(key), 'unsafe key');
    validateJSON(child, depth + 1);
  }
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function checksum(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  let hi = 0xcbf29ce4, lo = 0x84222325;
  for (const byte of bytes) {
    const low = (lo ^ byte) >>> 0;
    const carry = Math.floor(low * 0x1b3 / 0x100000000);
    const nextHi = (Math.imul(hi, 0x1b3) + Math.imul(low, 0x100) + carry) >>> 0;
    lo = Math.imul(low, 0x1b3) >>> 0;
    hi = nextHi;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}
export function pack(kind, payload, version = 1) {
  validateJSON(payload);
  const body = {kind, version, payload};
  const bodyText=JSON.stringify(body);
  requireValue(new TextEncoder().encode(bodyText).length+30 <= MAX_SAVE_BYTES,'save byte budget exceeded');
  const text = JSON.stringify({...body, checksum: checksum(body)});
  requireValue(new TextEncoder().encode(text).length <= MAX_SAVE_BYTES, 'save byte budget exceeded');
  return text;
}
export function unpack(text, kind, version = 1) {
  requireValue(typeof text === 'string' && text.length <= MAX_SAVE_BYTES && new TextEncoder().encode(text).length <= MAX_SAVE_BYTES, 'invalid save size');
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error('invalid JSON'); }
  validateJSON(envelope);
  requireValue(envelope?.kind === kind, 'missing dependency: save kind');
  requireValue(envelope.version === version, 'unsupported version');
  requireValue(envelope.checksum === checksum({kind, version, payload: envelope.payload}), 'checksum mismatch');
  return envelope.payload;
}
export function memoryStorage() {
  const entries = new Map();
  return {getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value)};
}
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string') && new Set(value).size === value.length;
function validateProfile(data) {
  validateJSON(data);
  requireValue(integer(data?.revision) && integer(data.bank) && strings(data.unlocks) && data.unlocks.includes('antonio') && data.unlocks.every(id => CHARACTER_IDS.includes(id)), 'invalid profile');
  requireValue(strings(data.discovered) && data.receipts && !Array.isArray(data.receipts) && typeof data.receipts === 'object', 'invalid receipts');
  requireValue(Object.keys(data.receipts).length <= MAX_SETTLEMENTS, 'settlement capacity reached; export required');
  for (const [id, receipt] of Object.entries(data.receipts)) requireValue(id.length > 0 && typeof receipt === 'string' && /^[0-9a-f]{16}$/.test(receipt), 'invalid receipt digest');
  requireValue(data.checkpoint === null || typeof data.checkpoint === 'string', 'invalid checkpoint');
}
// Persistent browser writers must all use this named origin-wide Web Lock.
// Without Web Locks we expose no writable persistent fallback.
export function browserStorageAdapter(storage, locks = globalThis.navigator?.locks) {
  // Access can itself throw in restricted contexts; let the session catch it.
  const target=()=>storage??globalThis.localStorage;
  return {getItem: key => target().getItem(key), setItem: (key,value) => target().setItem(key,value),
    capability: locks?.request ? 'web-locks' : 'read-only-no-locks',
    exclusive: (action, {signal} = {}) => {
      requireValue(locks?.request, 'cross-context locking unavailable');
      return locks.request(PROFILE_KEY, {mode:'exclusive',...(signal?{signal}:{})}, action);
    }};
}
const freshProfile = () => ({revision:0,bank:0,unlocks:['antonio'],discovered:[],receipts:{},checkpoint:null});
export function createProfileStore(storage = memoryStorage(), validateCheckpoint = () => {}) {
  requireValue(typeof storage.getItem === 'function' && typeof storage.setItem === 'function', 'missing dependency: storage');
  function read() {
    const raw = storage.getItem(PROFILE_KEY);
    let data = freshProfile(), error = null, validProfile=false, legacy=null;
    try {
      if (raw !== null) data = unpack(raw, 'survivors-profile');
      else {
        const gold = storage.getItem('mundi:survivors:0.61.0:legacy.gold'), characters = storage.getItem('mundi:survivors:0.61.0:legacy.characters');
        legacy={gold,characters};
        let unlocks;
        try { unlocks = characters === null ? [] : JSON.parse(characters); } catch { throw new Error('invalid legacy unlocks'); }
        requireValue(strings(unlocks) && unlocks.every(id => CHARACTER_IDS.includes(id)), 'invalid legacy unlocks');
        requireValue(gold === null || (gold.trim() !== '' && integer(Number(gold))), 'invalid legacy bank');
        data.bank = Number(gold ?? 0); data.unlocks = [...new Set(['antonio',...unlocks])].sort();
      }
      validateProfile(data);validProfile=true;
      if (data.checkpoint !== null) validateCheckpoint(data.checkpoint);
    } catch (caught) { error = caught.message;if(!validProfile)data=freshProfile(); }
    return {raw,data,error,legacy};
  }
  let current = read(), expectedCheckpoint = current.data?.checkpoint ?? null;
  let expectedRaw = current.raw;
  const exclusive = (action,options) => storage.exclusive ? storage.exclusive(action,options) : action();
  const live = signal => requireValue(!signal?.aborted,'storage request cancelled');
  function backup(raw) {
    if (raw === null) return null;
    const key = PROFILE_KEY + '.recovery.' + checksum(raw);
    const existing = storage.getItem(key);
    requireValue(existing === null || existing === raw, 'recovery backup collision');
    if (existing === null) storage.setItem(key,raw);
    return key;
  }
  function backupLegacy(legacy) {
    const raw=JSON.stringify(legacy),key=PROFILE_KEY+'.recovery.legacy.'+checksum(raw);
    const existing=storage.getItem(key);
    requireValue(existing===null || existing===raw,'legacy recovery backup collision');
    if(existing===null)storage.setItem(key,raw);
    return key;
  }
  function transact(change, {checkpointWrite = false,signal} = {}) {
    return exclusive(() => {
      live(signal);
      const latest = read();
      if(latest.error){current=latest;throw Error('corrupt profile/checkpoint: explicit replacement required');}
      // Single-context adapters retain conservative stale detection. Web Locks
      // rebase account mutations inside the lock, while checkpoint writes use CAS.
      if (!storage.exclusive) requireValue(latest.raw === expectedRaw, 'stale profile: reconcile required');
      if (checkpointWrite) requireValue(latest.data.checkpoint === expectedCheckpoint, 'checkpoint conflict: reconcile required');
      const next = clone(latest.data), result = change(next);
      next.revision++;
      validateProfile(next);
      if (next.checkpoint !== null) validateCheckpoint(next.checkpoint);
      // Preserve the exact 0.54 profile before a 0.55 checkpoint replaces it.
      // Older engine pages can still read the backed-up historical run.
      if (checkpointWrite && latest.data.checkpoint && next.checkpoint &&
          unpack(latest.data.checkpoint,'survivors-run').engine === 'survivors-lab-0.54.0' &&
          unpack(next.checkpoint,'survivors-run').engine === 'survivors-lab-0.55.0') backup(latest.raw);
      const encoded = pack('survivors-profile',next);
      live(signal);
      storage.setItem(PROFILE_KEY,encoded);
      current = {raw:encoded,data:next,error:null}; expectedRaw = encoded;
      if (checkpointWrite || latest.data.checkpoint === expectedCheckpoint) expectedCheckpoint = next.checkpoint;
      return result;
    },{signal});
  }
  return Object.freeze({
    snapshot: () => { requireValue(!current.error || current.data?.bank !== undefined,'corrupt profile'); return clone(current.data); },
    checkpoint: () => current.data?.checkpoint ?? null,
    recovery: () => current.error ? {reason:current.error,raw:current.raw,legacy:current.raw===null?clone(current.legacy):null,checkpoint:current.data?.checkpoint ?? null,token:checksum({raw:current.raw,legacy:current.legacy})} : null,
    refresh({signal}={}) { return exclusive(()=>{live(signal);current=read();expectedRaw=current.raw;return {profile:clone(current.data),recovery:this.recovery(),checkpointConflict:current.data?.checkpoint!==expectedCheckpoint};},{signal}); },
    replaceCorrupt(token,{signal}={}) {
      return exclusive(() => {
        live(signal);
        const latest=read();requireValue(latest.error && token===checksum({raw:latest.raw,legacy:latest.legacy}),'recovery decision is stale');
        const backupKey=latest.raw===null?backupLegacy(latest.legacy):backup(latest.raw);
        let next;
        try { validateProfile(latest.data); next=clone(latest.data); next.checkpoint=null; }
        catch { next=freshProfile(); }
        next.revision++; const encoded=pack('survivors-profile',next);
        live(signal);
        storage.setItem(PROFILE_KEY,encoded);
        current={raw:encoded,data:next,error:null};expectedRaw=encoded;expectedCheckpoint=null;
        return {backupKey};
      },{signal});
    },
    reconcileCheckpoint(token, localCheckpoint,{signal}={}) {
      return exclusive(() => {
        live(signal);
        const latest=read();requireValue(!latest.error,'corrupt checkpoint');
        requireValue(token===checksum(latest.data.checkpoint),'checkpoint decision is stale');
        const backupKey=backup(latest.raw);
        const localKey=backup(localCheckpoint);
        current=latest;expectedRaw=latest.raw;expectedCheckpoint=latest.data.checkpoint;
        return {backupKey,localKey};
      },{signal});
    },
    importSession(id, incoming,{signal}={}) {
      validateProfile(incoming);
      return transact(next=>{
        const hash=checksum(incoming),key=`session:${id}`;
        if(Object.hasOwn(next.receipts,key)){requireValue(next.receipts[key]===hash,'session transfer conflict');return {duplicate:true};}
        for(const [receiptId,digest] of Object.entries(incoming.receipts)) {
          requireValue(!Object.hasOwn(next.receipts,receiptId),'session receipt already imported');next.receipts[receiptId]=digest;
        }
        next.bank+=incoming.bank;next.unlocks=[...new Set([...next.unlocks,...incoming.unlocks])].sort();
        next.discovered=[...new Set([...next.discovered,...incoming.discovered])].sort();next.receipts[key]=hash;
        if(next.checkpoint!==null)backup(storage.getItem(PROFILE_KEY));
        next.checkpoint=incoming.checkpoint;return {duplicate:false};
      },{checkpointWrite:true,signal});
    },
    saveCheckpoint: (checkpoint,{signal}={}) => transact(next => { next.checkpoint=checkpoint; },{checkpointWrite:true,signal}),
    unlock(id,{signal}={}) {
      requireValue(CHARACTER_IDS.includes(id),'unknown character');
      return transact(next => {
        if (next.unlocks.includes(id) || CHARACTER_COSTS[id]===undefined) return true;
        if (next.bank < CHARACTER_COSTS[id]) return false;
        next.bank-=CHARACTER_COSTS[id];next.unlocks.push(id);next.unlocks.sort();return true;
      },{signal});
    },
    settle(id,receipt,checkpoint,{signal}={}) {
      requireValue(integer(receipt.gold) && strings(receipt.discovered),'invalid settlement');
      return transact(next => {
        const hash=checksum(receipt);
        if (Object.hasOwn(next.receipts,id)) {
          requireValue(next.receipts[id]===hash,'receipt conflict');
          return {duplicate:true,bank:next.bank,...(next.checkpoint!==expectedCheckpoint?{checkpointConflict:true}:{})};
        }
        requireValue(Object.keys(next.receipts).length < MAX_SETTLEMENTS,'settlement capacity reached; export required');
        next.bank+=receipt.gold;next.discovered=[...new Set([...next.discovered,...receipt.discovered])].sort();next.receipts[id]=hash;
        // Concurrent runs may both settle; neither is allowed to silently replace
        // the other tab's checkpoint. The local run stays available for reconcile.
        const checkpointConflict=next.checkpoint!==expectedCheckpoint;
        if (!checkpointConflict) next.checkpoint=checkpoint;
        return {duplicate:false,bank:next.bank,...(checkpointConflict?{checkpointConflict:true}:{})};
      },{signal});
    }
  });
}
