// This independent lab deliberately has no MUNDI account store or credential fallback.
export async function resolveModelKey(_env, _owner, fail) {
  fail(401, 'This lab requires an explicitly supplied local API key.');
}
