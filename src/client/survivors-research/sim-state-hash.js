// Stable JSON ordering across a structured clone and a re-imported archive.
// These digests compare simulation state. The export can separately sign files.
export function stateHash(value) {
  const json = JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca77);
  }
  return [a, b].map(hash => (hash >>> 0).toString(16).padStart(8, '0')).join('');
}
