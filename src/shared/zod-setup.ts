// IMPORTANT: this module must NOT import from 'zod'. It sets Zod's global config object BEFORE
// Zod core initializes, so `jitless` is guaranteed to be in place first. Zod core reads this exact
// global (`globalThis.__zod_globalConfig`) and preserves any value that already exists.
//
// Why jitless: strict CSPs block `new Function` — YouTube pages enable Trusted Types and the
// extension's own pages use `script-src 'self'`. Zod v4's JIT probe calls `new Function` inside a
// try/catch, but the browser still reports the blocked call as a securitypolicyviolation and logs
// it as an extension error. jitless makes Zod skip the probe entirely; validation still works.
const store = globalThis as typeof globalThis & {
  __zod_globalConfig?: { jitless?: boolean };
};
store.__zod_globalConfig ??= {};
store.__zod_globalConfig.jitless = true;
