#!/usr/bin/env node
/* Does the adapted package's import graph still load under plain node?
   Ported from upstream's check for the same reason: vitest resolves modules
   Vite-style, so a Vite-only import in a shared lib module can leave every
   test green and still kill the hosted function at cold start. Run by bare
   node on purpose. */
const LIB = new URL('../../../app/src/lib/', import.meta.url)
const MODULES = [
  'i18n-core.js', 'format.js', 'exercises.js', 'exercises-data.js',
  'history.js', 'muscles.js', 'onerm.js', 'progression.js', 'queue.js'
]
let failed = 0
for (const m of MODULES) {
  try { await import(new URL(m, LIB)); console.log(`  ok    ${m}`) }
  catch (e) { failed++; console.error(`  FAIL  ${m} - ${e.message}`) }
}
for (const entry of ['../src/state.js', '../src/tools.js', '../src/labels.js']) {
  try { await import(new URL(entry, import.meta.url)); console.log(`  ok    mcp/${entry.replace('../', '')}`) }
  catch (e) { failed++; console.error(`  FAIL  mcp/${entry.replace('../', '')} - ${e.message}`) }
}
if (failed) { console.error(`\n${failed} module(s) do not load under plain node.`); process.exit(1) }
console.log('\nthe whole adapted MCP import graph loads under plain node.')
