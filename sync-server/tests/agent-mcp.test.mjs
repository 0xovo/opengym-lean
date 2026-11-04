// Tests for the agent connector (api/_agent.js): the MCP endpoint at action
// "mcp" and the token management at action "agent-tokens". Run with:
// node --test tests/agent-mcp.test.mjs  (from sync-server/, after npm install)
//
// The handler and the token cores are driven against the in-memory fake in
// _fake-firestore.mjs, pinning the safety contract:
//   - no token and a bad token are rejected; a read token cannot write, a
//     write token cannot delete;
//   - a token only ever reaches its own uid's tree, even though another
//     user's tree sits in the same fake;
//   - create-read-update-delete round-trips for exercises, routines,
//     workouts and bodyweight land in the split docs the app syncs, stamped
//     source "agent", with tombstones on deletes and an agentLog audit entry
//     after every write and delete;
//   - malformed payloads are rejected without partial writes;
//   - token management refuses an invalid Firebase ID token (the dispatcher
//     proof is bearerUid's, pinned in _lib.js usage; here the cores pin that
//     listing never leaks a raw token or hash, and a user cannot revoke
//     another user's token).
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMcpHandler, agentTokensAction, createAgentToken, hashToken, _clearRateWindows,
  agentConnectorEnabled,
} from '../api/_agent.js'
import { fakeDb, fakeRes } from './_fake-firestore.mjs'
import { bearerUid } from '../api/passkey/_lib.js'

const UID = 'uid-owner'
const OTHER = 'uid-other'
const NOW = 1762000000000

function seedDb() {
  return fakeDb({
    [`users/${UID}`]: { unit: 'kg', body: 'male', targetW: 80, lang: 'en' },
    [`users/${UID}/exercises/ex-1`]: { id: 'ex-1', n: 'Owner Press', bp: 'chest', custom: true, _ts: 10 },
    [`users/${UID}/routines/r-1`]: { id: 'r-1', name: 'Owner Day', ex: [{ id: 'ex-1', sets: 2, reps: 8, weight: 40 }], _ts: 10 },
    [`users/${UID}/workouts/w-1`]: { id: 'w-1', d: '2026-11-01', start: 100, entries: [{ id: 'ex-1', sets: [{ w: 40, r: 8 }] }], _ts: 10 },
    [`users/${UID}/bodyweight/2026-11-01`]: { d: '2026-11-01', w: 151, t: 10 },
    [`users/${OTHER}`]: { unit: 'lb' },
    [`users/${OTHER}/exercises/ex-9`]: { id: 'ex-9', n: 'Other Secret Lift', custom: true, _ts: 10 },
    [`users/${OTHER}/workouts/w-9`]: { id: 'w-9', d: '2026-11-02', start: 200, entries: [], _ts: 10 },
  })
}

async function mint(db, uid, scopes, name = 'Test agent') {
  const { payload } = await createAgentToken({
    uid, db, reqBody: { name, scopes }, now: NOW,
    makeToken: () => `raw-token-for-${uid}-${scopes.join('-')}-${Math.random()}`,
    makeId: () => `id-${uid}-${scopes.join('-')}-${Math.random()}`,
  })
  return payload.token
}

function mcpFor(db, overrides = {}) {
  return createMcpHandler({ adminFn: () => ({ db }), now: () => NOW, ...overrides })
}

async function rpc(handler, token, method, params, id = 1) {
  const res = fakeRes()
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  await handler({ method: 'POST', headers, body: { jsonrpc: '2.0', id, method, params } }, res)
  return res
}
const call = (handler, token, name, args) => rpc(handler, token, 'tools/call', { name, arguments: args })
const toolJson = res => JSON.parse(res.body.result.content[0].text)

beforeEach(() => _clearRateWindows())

describe('MCP auth and scopes', () => {
  it('rejects a request with no token', async () => {
    const res = await rpc(mcpFor(seedDb()), null, 'initialize', {})
    assert.equal(res.statusCode, 401)
    assert.equal(res.body.error.code, -32001)
  })

  it('rejects a bad token', async () => {
    const res = await rpc(mcpFor(seedDb()), 'gym_agent_nope', 'tools/list', {})
    assert.equal(res.statusCode, 401)
  })

  it('initialize and tools/list answer with a valid token, listing all 25 tools', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db)
    const init = await rpc(h, token, 'initialize', { protocolVersion: '2025-03-26' })
    assert.equal(init.statusCode, 200)
    assert.equal(init.body.result.serverInfo.name, 'opengym')
    const list = await rpc(h, token, 'tools/list', {})
    assert.equal(list.body.result.tools.length, 25)
    const names = list.body.result.tools.map(t => t.name)
    for (const n of ['list_routines', 'get_routine', 'preview_session', 'get_week_plan', 'list_workouts', 'get_workout', 'get_bodyweight', 'estimate_1rm', 'muscle_balance']) assert.ok(names.includes(n), `upstream tool ${n} listed`)
    const ping = await rpc(h, token, 'ping', {})
    assert.deepEqual(ping.body.result, {})
  })

  it('a read token cannot call a write tool', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const res = await call(mcpFor(db), token, 'create_exercise', { n: 'Nope' })
    assert.equal(res.body.error.code, -32003)
    assert.match(res.body.error.message, /write/)
    assert.equal(db._store.has(`users/${UID}/exercises/ag-`), false)
  })

  it('a write token cannot call a delete tool', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write'])
    const res = await call(mcpFor(db), token, 'delete_exercise', { id: 'ex-1' })
    assert.equal(res.body.error.code, -32003)
    assert.ok(db._store.has(`users/${UID}/exercises/ex-1`))
  })

  it('rate limit kicks in per token', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db, { rateLimit: { max: 2, windowMs: 60000 } })
    assert.equal((await rpc(h, token, 'ping', {})).statusCode, 200)
    assert.equal((await rpc(h, token, 'ping', {})).statusCode, 200)
    assert.equal((await rpc(h, token, 'ping', {})).statusCode, 429)
  })
})

describe('cross-user isolation', () => {
  it('a token for uid A reads only uid A data', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db)
    const ex = toolJson(await call(h, token, 'list_exercises', {}))
    assert.deepEqual(ex.exercises.map(e => e.id), ['ex-1'])
    const all = toolJson(await call(h, token, 'export_all', {}))
    assert.ok(!JSON.stringify(all).includes('Other Secret Lift'))
    assert.ok(!JSON.stringify(all).includes('w-9'))
    const missing = await call(h, token, 'get_exercise', { id: 'ex-9' })
    assert.equal(missing.body.result.isError, true)
  })

  it('a token for uid A cannot write into uid B tree', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    await call(h, token, 'create_exercise', { id: 'ex-new', n: 'Mine' })
    assert.ok(db._store.has(`users/${UID}/exercises/ex-new`))
    assert.equal(db._store.has(`users/${OTHER}/exercises/ex-new`), false)
    const del = await call(h, token, 'delete_exercise', { id: 'ex-9' })
    assert.equal(del.body.result.isError, true)
    assert.ok(db._store.has(`users/${OTHER}/exercises/ex-9`))
  })
})

describe('round-trips in the split-doc schema', () => {
  it('exercise create, read, update, delete with audit and tombstone', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const created = toolJson(await call(h, token, 'create_exercise', { exercise: { id: 'ag-ex', n: 'Agent Curl', bp: 'upper arms', eq: 'dumbbell' } }))
    assert.equal(created.exercise.source, 'agent')
    assert.equal(created.exercise._ts, NOW)
    assert.equal(created.exercise.custom, true)
    assert.deepEqual(db._store.get(`users/${UID}/exercises/ag-ex`).n, 'Agent Curl')
    const got = toolJson(await call(h, token, 'get_exercise', { id: 'ag-ex' }))
    assert.equal(got.exercise.n, 'Agent Curl')
    const upd = toolJson(await call(h, token, 'update_exercise', { id: 'ag-ex', patch: { n: 'Agent Curl Plus' } }))
    assert.equal(upd.exercise.n, 'Agent Curl Plus')
    assert.equal(upd.exercise.bp, 'upper arms')
    const del = toolJson(await call(h, token, 'delete_exercise', { id: 'ag-ex' }))
    assert.equal(del.deleted, 'ag-ex')
    assert.equal(db._store.has(`users/${UID}/exercises/ag-ex`), false)
    assert.equal(db._store.get(`users/${UID}`).deleted.customEx['ag-ex'], NOW)
    const logs = [...db._store.entries()].filter(([k]) => k.startsWith(`users/${UID}/agentLog/`)).map(([, v]) => v)
    // The mint at the top also audits its own creation (create_token, F4).
    assert.deepEqual(logs.map(l => l.tool), ['create_token', 'create_exercise', 'update_exercise', 'delete_exercise'])
    assert.ok(logs.every(l => l.token === 'Test agent' && l.at === NOW))
  })

  it('routine round-trip', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const created = toolJson(await call(h, token, 'create_routine', { routine: { id: 'ag-r', name: 'Agent Day', ex: [{ id: 'ex-1', sets: 3, reps: 10, weight: 20 }] } }))
    assert.equal(created.routine.source, 'agent')
    const gotR = toolJson(await call(h, token, 'get_routine', { id: 'ag-r' }))
    assert.equal(gotR.name, 'Agent Day')
    assert.deepEqual({ id: gotR.exercises[0].id, sets: gotR.exercises[0].sets, reps: gotR.exercises[0].reps, weight: gotR.exercises[0].weight }, { id: 'ex-1', sets: 3, reps: 10, weight: 20 })
    const upd = toolJson(await call(h, token, 'update_routine', { id: 'ag-r', patch: { name: 'Agent Day 2' } }))
    assert.equal(upd.routine.name, 'Agent Day 2')
    assert.equal(upd.routine.ex.length, 1)
    await call(h, token, 'delete_routine', { id: 'ag-r' })
    assert.equal(db._store.has(`users/${UID}/routines/ag-r`), false)
    assert.equal(db._store.get(`users/${UID}`).deleted.routines['ag-r'], NOW)
  })

  it('workout round-trip', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const logged = toolJson(await call(h, token, 'log_workout', { workout: { id: 'ag-w', d: '2026-11-03', routineId: 'r-1', entries: [{ id: 'ex-1', sets: [{ w: 50, r: 6 }, { w: 50, r: 5 }] }] } }))
    assert.equal(logged.workout.source, 'agent')
    assert.equal(logged.workout.start, Date.parse('2026-11-03'))
    const list = toolJson(await call(h, token, 'list_workouts', {}))
    assert.equal(list.workouts[0].id, 'ag-w')
    const upd = toolJson(await call(h, token, 'update_workout', { id: 'ag-w', patch: { note: 'felt strong' } }))
    assert.equal(upd.workout.note, 'felt strong')
    await call(h, token, 'delete_workout', { id: 'ag-w' })
    assert.equal(db._store.has(`users/${UID}/workouts/ag-w`), false)
    assert.equal(db._store.get(`users/${UID}`).deleted.workouts['ag-w'], NOW)
  })

  it('bodyweight round-trip', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const logged = toolJson(await call(h, token, 'log_bodyweight', { d: '2026-11-04', w: 150.5 }))
    assert.deepEqual(logged.bodyweight, { d: '2026-11-04', w: 150.5, t: NOW, source: 'agent' })
    const list = toolJson(await call(h, token, 'get_bodyweight', {}))
    assert.deepEqual(list.entries.map(b => b.date), ['2026-11-01', '2026-11-04'])
    assert.equal(list.latest.weight, 150.5)
    await call(h, token, 'delete_bodyweight', { d: '2026-11-04' })
    assert.equal(db._store.has(`users/${UID}/bodyweight/2026-11-04`), false)
    assert.equal(db._store.get(`users/${UID}`).deleted.bodyweight['2026-11-04'], NOW)
  })

  it('profile, stats and export read the owner tree', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db)
    const profile = toolJson(await call(h, token, 'get_profile', {}))
    assert.equal(profile.profile.unit, 'kg')
    assert.deepEqual(profile.counts, { workouts: 1, routines: 1, customExercises: 1, weighIns: 1 })
    const stats = toolJson(await call(h, token, 'get_stats', {}))
    assert.equal(stats.totalWorkouts, 1)
    assert.equal(stats.lastWorkoutDate, '2026-11-01')
    assert.equal(stats.totalVolume, 320)
    assert.deepEqual(stats.latestBodyweight, { date: '2026-11-01', kg: 151 })
    const all = toolJson(await call(h, token, 'export_all', {}))
    assert.equal(all.profile.targetW, 80)
    assert.equal('active' in all.profile, false)
    assert.equal('_fbUpdatedAt' in all.profile, false)
  })

  it('never touches active or activeBackup', async () => {
    const db = seedDb()
    db._store.set(`users/${UID}/activeBackup/dev1`, { active: { id: 'run-1' }, deviceId: 'dev1' })
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    await call(h, token, 'log_workout', { workout: { id: 'ag-w2', d: '2026-11-03', entries: [] } })
    await call(h, token, 'delete_workout', { id: 'w-1' })
    assert.deepEqual(db._store.get(`users/${UID}/activeBackup/dev1`), { active: { id: 'run-1' }, deviceId: 'dev1' })
    assert.equal(db._store.get(`users/${UID}`).active, undefined)
  })
})

describe('validation', () => {
  it('malformed payloads are rejected and write nothing', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const before = db._store.size
    for (const [name, args] of [
      ['create_exercise', { exercise: { bp: 'chest' } }],
      ['create_exercise', { exercise: { n: 'X', sm: 'not-a-list' } }],
      ['create_routine', { routine: { name: 'X', ex: [{ sets: 3 }] } }],
      ['create_routine', { routine: { name: 'X', ex: [{ id: 'ex-1', sets: 'three' }] } }],
      ['log_workout', { workout: { d: 'not-a-date', entries: [] } }],
      ['log_workout', { workout: { d: '2026-11-03', entries: [{ id: 'ex-1', sets: [{ w: 'heavy', r: 5 }] }] } }],
      ['log_bodyweight', { d: '2026-11-03', w: -3 }],
      ['log_bodyweight', { d: '2026-13-40', w: 80 }],
    ]) {
      const res = await call(h, token, name, args)
      assert.equal(res.body.result.isError, true, `${name} should fail`)
      assert.ok(res.body.result.content[0].text.length > 0)
    }
    const logs = [...db._store.keys()].filter(k => k.includes('agentLog'))
    // Only the setup mint's own create_token audit exists; the malformed
    // calls above added no audit entries and no other writes.
    assert.equal(logs.length, 1)
    assert.equal(db._store.size, before)
  })

  it('updating or deleting a missing entry is an error, not a write', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    assert.equal((await call(h, token, 'update_exercise', { id: 'nope', patch: { n: 'X' } })).body.result.isError, true)
    assert.equal((await call(h, token, 'delete_routine', { id: 'nope' })).body.result.isError, true)
    assert.equal((await call(h, token, 'delete_bodyweight', { d: '2026-01-01' })).body.result.isError, true)
  })
})


describe('adapted upstream read tools (server/mcp)', () => {
  it('reads the owner tree through the Firestore state layer', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db)
    const routines = toolJson(await call(h, token, 'list_routines', {}))
    assert.deepEqual(routines.routines.map(r => r.id), ['r-1'])
    assert.equal(routines.routines[0].exercise_count, 1)
    const one = toolJson(await call(h, token, 'get_routine', { routine_id: 'r-1' }))
    assert.equal(one.name, 'Owner Day')
    assert.equal(one.exercises[0].id, 'ex-1')
    const bw = toolJson(await call(h, token, 'get_bodyweight', {}))
    assert.deepEqual(bw.entries, [{ date: '2026-11-01', weight: 151, delta_vs_goal: 71 }])
    const est = toolJson(await call(h, token, 'estimate_1rm', { exercise_id: 'ex-1' }))
    // The seeded set carries no done flag, so upstream's rule applies: no
    // completed sets, no estimate (and the exercise itself is not unknown).
    assert.equal(est.best, null)
    assert.match(est.no_estimate_reason, /No completed sets/)
    const bal = toolJson(await call(h, token, 'muscle_balance', { period: 'all' }))
    assert.equal(bal.workouts_in_period, 1)
    const week = toolJson(await call(h, token, 'get_week_plan', {}))
    assert.equal(week.weekdays.length, 7)
    const prev = toolJson(await call(h, token, 'preview_session', { routine_id: 'r-1' }))
    assert.equal(prev.routine_name, 'Owner Day')
    assert.equal(prev.exercises.length, 1)
    const wo = toolJson(await call(h, token, 'get_workout', { workout_id: 'w-1' }))
    assert.equal(wo.date, '2026-11-01')
    assert.equal(wo.entries[0].sets[0].w, 40)
  })

  it('a missing routine is a tool error, and a fake calendar date is refused at the zod boundary', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db)
    assert.equal((await call(h, token, 'get_routine', { routine_id: 'nope' })).body.result.isError, true)
    const badDate = await call(h, token, 'get_bodyweight', { from: '2026-02-30' })
    assert.equal(badDate.body.result.isError, true)
    assert.match(badDate.body.result.content[0].text, /not a date the calendar has/)
    const leap = await call(h, token, 'get_bodyweight', { from: '2024-02-29' })
    assert.equal(leap.body.result.isError, false)
  })

  it('an account with nothing synced answers the no-state sentinel', async () => {
    const db = fakeDb({ 'passkeyUsers/testuser': { uid: 'uid-empty', userHandle: 'h-e' } })
    const { payload } = await createAgentToken({ uid: 'uid-empty', db, reqBody: { name: 'E', scopes: ['read'] }, now: NOW, makeToken: () => 'raw-empty', makeId: () => 'tok-empty' })
    const h = mcpFor(db)
    const res = await call(h, payload.token, 'list_routines', {})
    assert.equal(res.body.result.isError, false)
    assert.match(toolJson(res).error, /no synced state yet/)
  })
})

describe('kill switch (AGENT_CONNECTOR_ENABLED)', () => {
  it('parses sensibly: unset is enabled, explicit off values are off', () => {
    assert.equal(agentConnectorEnabled({}), true)
    assert.equal(agentConnectorEnabled({ AGENT_CONNECTOR_ENABLED: '' }), true)
    assert.equal(agentConnectorEnabled({ AGENT_CONNECTOR_ENABLED: 'true' }), true)
    assert.equal(agentConnectorEnabled({ AGENT_CONNECTOR_ENABLED: '1' }), true)
    for (const v of ['false', '0', 'off', 'no', 'disabled', 'FALSE', ' Off ']) {
      assert.equal(agentConnectorEnabled({ AGENT_CONNECTOR_ENABLED: v }), false, v)
    }
  })

  it('flag off: MCP initialize and tools/call are refused, token creation is refused, nothing is looked up or written', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const before = db._store.size
    const off = mcpFor(db, { enabled: false })
    const init = await rpc(off, token, 'initialize', { protocolVersion: '2025-03-26' })
    assert.equal(init.statusCode, 503)
    assert.equal(init.body.error.code, -32004)
    assert.match(init.body.error.message, /disabled/)
    const callRes = await call(off, token, 'create_exercise', { n: 'Nope' })
    assert.equal(callRes.statusCode, 503)
    assert.equal(callRes.body.error.code, -32004)
    // Even a bad token gets the disabled answer, not an auth answer: the flag
    // is checked before any token lookup happens.
    const badToken = await rpc(off, 'gym_agent_nope', 'tools/list', {})
    assert.equal(badToken.statusCode, 503)
    const create = await agentTokensAction({ uid: UID, db, reqBody: { op: 'create', name: 'X', scopes: ['read'] }, enabled: false })
    assert.equal(create.status, 403)
    assert.match(create.payload.error, /disabled/)
    assert.equal(db._store.size, before) // no write of any kind landed
  })
})

describe('agent token management auth door', () => {
  // The agent-tokens action rides the [action].js methods dispatcher, which
  // answers 401 unless bearerUid proves a Firebase ID token. Pin that proof:
  // an invalid token (the fake auth rejects it) and a missing header both
  // yield no uid, so the dispatcher never reaches the cores.
  it('bearerUid refuses an invalid Firebase ID token and a missing header', async () => {
    const auth = { async verifyIdToken(t) { if (t === 'good-token') return { uid: UID }; throw new Error('bad token') } }
    assert.equal(await bearerUid({ headers: { authorization: 'Bearer good-token' } }, auth), UID)
    assert.equal(await bearerUid({ headers: { authorization: 'Bearer forged' } }, auth), null)
    assert.equal(await bearerUid({ headers: {} }, auth), null)
  })
})

describe('agent token management cores', () => {
  it('create stores only the hash and returns the raw token once', async () => {
    const db = seedDb()
    const { status, payload } = await createAgentToken({
      uid: UID, db, reqBody: { name: 'Laptop', scopes: ['read', 'write'] }, now: NOW,
      makeToken: () => 'raw-secret-token', makeId: () => 'tok-1',
    })
    assert.equal(status, 200)
    assert.equal(payload.token, 'raw-secret-token')
    const stored = [...db._store.entries()].filter(([k]) => k.startsWith('agentTokens/'))
    assert.equal(stored.length, 1)
    assert.equal(stored[0][0], `agentTokens/${hashToken('raw-secret-token')}`)
    assert.ok(!JSON.stringify(stored[0][1]).includes('raw-secret-token'))
    assert.equal(stored[0][1].uid, UID)
  })

  it('list returns name, scopes and stamps, never the raw token or its hash', async () => {
    const db = seedDb()
    await mint(db, UID, ['read'], 'Laptop')
    await mint(db, OTHER, ['read'], 'Someone else')
    const { payload } = await agentTokensAction({ uid: UID, db, reqBody: { op: 'list' } })
    assert.equal(payload.tokens.length, 1)
    assert.equal(payload.tokens[0].name, 'Laptop')
    assert.deepEqual(payload.tokens[0].scopes, ['read'])
    const text = JSON.stringify(payload)
    assert.ok(!text.includes('raw-token'))
    assert.ok(!text.includes(hashToken(payload.tokens[0].id)))
    for (const tk of payload.tokens) assert.ok(!('token' in tk))
  })

  it('create validates name and scopes', async () => {
    const db = seedDb()
    assert.equal((await agentTokensAction({ uid: UID, db, reqBody: { op: 'create', name: '', scopes: ['read'] } })).status, 400)
    assert.equal((await agentTokensAction({ uid: UID, db, reqBody: { op: 'create', name: 'X', scopes: [] } })).status, 400)
    assert.equal((await agentTokensAction({ uid: UID, db, reqBody: { op: 'create', name: 'X', scopes: ['fly'] } })).status, 400)
  })

  it('a user cannot revoke another user token', async () => {
    const db = seedDb()
    const other = await createAgentToken({
      uid: OTHER, db, reqBody: { name: 'Theirs', scopes: ['read'] }, now: NOW,
      makeToken: () => 'their-raw', makeId: () => 'tok-theirs',
    })
    const attempt = await agentTokensAction({ uid: UID, db, reqBody: { op: 'revoke', id: other.payload.id } })
    assert.equal(attempt.status, 404)
    assert.ok(db._store.has(`agentTokens/${hashToken('their-raw')}`))
    const own = await agentTokensAction({ uid: OTHER, db, reqBody: { op: 'revoke', id: 'tok-theirs' } })
    assert.equal(own.status, 200)
    assert.equal(db._store.has(`agentTokens/${hashToken('their-raw')}`), false)
  })

  it('a revoked token stops working on the MCP endpoint', async () => {
    const db = seedDb()
    const created = await createAgentToken({
      uid: UID, db, reqBody: { name: 'Temp', scopes: ['read'] }, now: NOW,
      makeToken: () => 'temp-raw', makeId: () => 'tok-temp',
    })
    const h = mcpFor(db)
    assert.equal((await rpc(h, 'temp-raw', 'ping', {})).statusCode, 200)
    await agentTokensAction({ uid: UID, db, reqBody: { op: 'revoke', id: created.payload.id } })
    assert.equal((await rpc(h, 'temp-raw', 'ping', {})).statusCode, 401)
  })
})

describe('attack round 2 fixes', () => {
  it('R2-5: a failing state load answers a generic 500 and leaks no internal error text', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const MARKER = 'MARKER-PROJECT-SECRET /srv/firebase/key.json uid-owner'
    const prox = new Proxy(db, {
      get(t, k) {
        if (k === 'collection') return (name) => { if (name === 'users') throw new Error(MARKER); return t.collection(name) }
        return t[k]
      },
    })
    const h = mcpFor(prox)
    for (const tool of ['list_routines', 'get_profile']) {
      const res = await call(h, token, tool, {})
      assert.equal(res.statusCode, 500, tool)
      assert.equal(res.body.error.message, 'Internal server error', tool)
      assert.ok(!JSON.stringify(res.body).includes('MARKER-PROJECT-SECRET'), tool)
      assert.ok(!JSON.stringify(res.body).includes('key.json'), tool)
    }
  })

  it('R2-5: an admin init failure with no token likewise leaks nothing', async () => {
    const MARKER = 'MARKER-INIT-SECRET service-account.json'
    const h = createMcpHandler({ adminFn: () => { throw new Error(MARKER) }, now: () => NOW })
    const res = await rpc(h, null, 'tools/list', {})
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.error.message, 'Internal server error')
    assert.ok(!JSON.stringify(res.body).includes('MARKER-INIT-SECRET'))
  })

  it('R2-6: log_bodyweight dual names agree, conflict cleanly, and yield when empty', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    // Both supplied and agreeing: fine.
    const agree = await call(h, token, 'log_bodyweight', { d: '2026-11-05', date: '2026-11-05', w: 140, weight: 140 })
    assert.equal(agree.body.result.isError, false)
    assert.equal(db._store.get(`users/${UID}/bodyweight/2026-11-05`).w, 140)
    // Both supplied and disagreeing: a clean tool error naming the conflict, nothing written.
    const conflictD = await call(h, token, 'log_bodyweight', { d: '2026-11-06', date: '2026-11-07', w: 140 })
    assert.equal(conflictD.body.result.isError, true)
    assert.match(conflictD.body.result.content[0].text, /d and date disagree/)
    assert.equal(db._store.has(`users/${UID}/bodyweight/2026-11-06`), false)
    assert.equal(db._store.has(`users/${UID}/bodyweight/2026-11-07`), false)
    const conflictW = await call(h, token, 'log_bodyweight', { d: '2026-11-06', w: 140, weight: 141 })
    assert.equal(conflictW.body.result.isError, true)
    assert.match(conflictW.body.result.content[0].text, /w and weight disagree/)
    // An empty string on the unused name yields to the other.
    const emptyD = await call(h, token, 'log_bodyweight', { d: '', date: '2026-11-08', w: 139 })
    assert.equal(emptyD.body.result.isError, false)
    assert.equal(db._store.get(`users/${UID}/bodyweight/2026-11-08`).w, 139)
    const emptyW = await call(h, token, 'log_bodyweight', { d: '2026-11-09', w: '', weight: 138 })
    assert.equal(emptyW.body.result.isError, false)
    assert.equal(db._store.get(`users/${UID}/bodyweight/2026-11-09`).w, 138)
    const emptyDate = await call(h, token, 'log_bodyweight', { d: '2026-11-10', date: '', w: 137 })
    assert.equal(emptyDate.body.result.isError, false)
    // delete_bodyweight follows the same rule.
    const del = await call(h, token, 'delete_bodyweight', { d: '', date: '2026-11-08' })
    assert.equal(del.body.result.isError, false)
    assert.equal(db._store.has(`users/${UID}/bodyweight/2026-11-08`), false)
    const delConflict = await call(h, token, 'delete_bodyweight', { d: '2026-11-09', date: '2026-11-10' })
    assert.equal(delConflict.body.result.isError, true)
    assert.match(delConflict.body.result.content[0].text, /disagree/)
  })

  it('R2-6: get_routine dual names over the wire follow the same rule', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db)
    const agree = await call(h, token, 'get_routine', { routine_id: 'r-1', id: 'r-1' })
    assert.equal(agree.body.result.isError, false)
    const conflict = await call(h, token, 'get_routine', { routine_id: 'r-1', id: 'other' })
    assert.equal(conflict.body.result.isError, true)
    assert.match(conflict.body.result.content[0].text, /conflicting routine_id/)
    const emptyUnused = await call(h, token, 'get_routine', { routine_id: 'r-1', id: '' })
    assert.equal(emptyUnused.body.result.isError, false)
    assert.equal(toolJson(emptyUnused).id, 'r-1')
  })
})

describe('attack-pass fixes (F1-F7)', () => {
  const agentLogs = db => [...db._store.entries()]
    .filter(([k]) => k.startsWith(`users/${UID}/agentLog/`)).map(([, v]) => v)

  it('F1: routine entries are whitelisted on create and update; junk is stripped, app fields survive', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const junk = JSON.parse('{"id":"ex-1","sets":3,"reps":10,"weight":20,"warmupSets":2,"restSec":90,'
      + '"note":"pause on the chest","sg":"g1","prog":"double","mode":"reps","evil":"' + 'x'.repeat(5000)
      + '","_ts":1,"_f":2,"source":"spoof","active":{"id":"run-1"},"__proto__":{"polluted":true}}')
    const created = await call(h, token, 'create_routine', {
      routine: { id: 'ag-r1', name: 'Clean Day', ex: [junk, { id: 'ex-9', sets: 1, reps: 5, weight: null }] },
    })
    assert.equal(created.body.result.isError, false)
    const stored = db._store.get(`users/${UID}/routines/ag-r1`)
    assert.deepEqual(stored.ex[0], {
      id: 'ex-1', sets: 3, reps: 10, weight: 20, warmupSets: 2, restSec: 90,
      note: 'pause on the chest', sg: 'g1', prog: 'double', mode: 'reps',
    })
    assert.deepEqual(stored.ex[1], { id: 'ex-9', sets: 1, reps: 5, weight: null })
    assert.equal({}.polluted, undefined)
    const upd = await call(h, token, 'update_routine', {
      id: 'ag-r1',
      patch: { ex: [{ id: 'ex-1', sets: 4, reps: 8, weight: 25, hacker: 'y', _ts: 9, nested: { deep: [1, 2, 3] } }] },
    })
    assert.equal(upd.body.result.isError, false)
    assert.deepEqual(db._store.get(`users/${UID}/routines/ag-r1`).ex[0], { id: 'ex-1', sets: 4, reps: 8, weight: 25 })
  })

  it('F2: nonexistent calendar dates are rejected; a real leap day passes', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    for (const d of ['2026-02-31', '2026-02-29', '2026-04-31']) {
      assert.equal((await call(h, token, 'log_bodyweight', { d, w: 100 })).body.result.isError, true, `bodyweight ${d}`)
      assert.equal((await call(h, token, 'log_workout', { workout: { id: `w-${d}`, d, entries: [] } })).body.result.isError, true, `workout ${d}`)
      assert.equal(db._store.has(`users/${UID}/bodyweight/${d}`), false)
    }
    const bw = await call(h, token, 'log_bodyweight', { d: '2024-02-29', w: 100 })
    assert.equal(bw.body.result.isError, false)
    assert.ok(db._store.has(`users/${UID}/bodyweight/2024-02-29`))
    const wo = await call(h, token, 'log_workout', { workout: { id: 'w-leap', d: '2024-02-29', entries: [] } })
    assert.equal(wo.body.result.isError, false)
  })

  it('F3: create-path ids get the read-path validation plus the Firestore-forbidden ids', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const longId = 'x'.repeat(250)
    const attempts = [
      ['create_exercise', { exercise: { id: longId, n: 'Long' } }],
      ['create_exercise', { exercise: { id: '..', n: 'Dots' } }],
      ['create_exercise', { exercise: { id: '__proto__', n: 'Dunder' } }],
      ['create_routine', { routine: { id: '..', name: 'Dots', ex: [] } }],
      ['create_routine', { routine: { id: longId, name: 'Long', ex: [] } }],
      ['log_workout', { workout: { id: '..', d: '2026-11-03', entries: [] } }],
      ['log_workout', { workout: { id: '__x__', d: '2026-11-03', entries: [] } }],
    ]
    for (const [name, args] of attempts) {
      const res = await call(h, token, name, args)
      assert.equal(res.statusCode, 200, name)
      assert.equal(res.body.result.isError, true, `${name} should reject the id as a clean tool error`)
      assert.ok(res.body.result.content[0].text.length > 0)
    }
    assert.equal(db._store.has(`users/${UID}/exercises/${longId}`), false)
    assert.equal(db._store.has(`users/${UID}/routines/..`), false)
    const ok = await call(h, token, 'create_exercise', { exercise: { id: 'fine-id', n: 'Fine' } })
    assert.equal(ok.body.result.isError, false)
  })

  it('F4: audit entries carry the token id, and token create and revoke each append one', async () => {
    const db = seedDb()
    const created = await agentTokensAction({
      uid: UID, db, reqBody: { op: 'create', name: 'Audited', scopes: ['read', 'write'] },
      now: NOW, makeToken: () => 'raw-audited', makeId: () => 'tok-audited',
    })
    assert.equal(created.status, 200)
    let logs = agentLogs(db).filter(l => l.tokenId === 'tok-audited')
    assert.equal(logs.length, 1)
    assert.deepEqual(
      { token: logs[0].token, tool: logs[0].tool, coll: logs[0].coll, targetId: logs[0].targetId, at: logs[0].at },
      { token: 'Audited', tool: 'create_token', coll: 'agentTokens', targetId: 'tok-audited', at: NOW },
    )
    const h = mcpFor(db)
    await call(h, 'raw-audited', 'create_exercise', { exercise: { id: 'ax-1', n: 'Audited Curl' } })
    logs = agentLogs(db).filter(l => l.tool === 'create_exercise')
    assert.equal(logs.length, 1)
    assert.equal(logs[0].tokenId, 'tok-audited')
    assert.equal(logs[0].token, 'Audited')
    const revoked = await agentTokensAction({ uid: UID, db, reqBody: { op: 'revoke', id: 'tok-audited' }, now: NOW })
    assert.equal(revoked.status, 200)
    logs = agentLogs(db).filter(l => l.tokenId === 'tok-audited')
    assert.deepEqual(logs.map(l => l.tool), ['create_token', 'create_exercise', 'revoke_token'])
    assert.equal(logs[2].coll, 'agentTokens')
    assert.equal(logs[2].targetId, 'tok-audited')
  })

  it('F5: a second create with an existing id fails and does not overwrite, even concurrently', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const first = await call(h, token, 'create_exercise', { exercise: { id: 'dup', n: 'First' } })
    assert.equal(first.body.result.isError, false)
    const second = await call(h, token, 'create_exercise', { exercise: { id: 'dup', n: 'Second' } })
    assert.equal(second.body.result.isError, true)
    assert.match(second.body.result.content[0].text, /already exists/)
    assert.equal(db._store.get(`users/${UID}/exercises/dup`).n, 'First')
    // Concurrent creates race past the outside-the-transaction pre-check, so
    // the in-transaction re-check is what lets exactly one of them land.
    const [r1, r2] = await Promise.all([
      call(h, token, 'create_exercise', { exercise: { id: 'race', n: 'Race A' } }),
      call(h, token, 'create_exercise', { exercise: { id: 'race', n: 'Race B' } }),
    ])
    const outcomes = [r1, r2].map(r => r.body.result.isError)
    assert.deepEqual(outcomes.sort(), [false, true])
    const winner = r1.body.result.isError ? 'Race B' : 'Race A'
    assert.equal(db._store.get(`users/${UID}/exercises/race`).n, winner)
    // Updates keep their overwrite semantics.
    const upd = await call(h, token, 'update_exercise', { id: 'dup', patch: { n: 'Updated' } })
    assert.equal(upd.body.result.isError, false)
    assert.equal(db._store.get(`users/${UID}/exercises/dup`).n, 'Updated')
  })

  it('F6: above-cap set weight, reps and workout bodyweight are rejected; stats volume stays finite', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read', 'write', 'delete'])
    const h = mcpFor(db)
    const badOnes = [
      ['log_workout', { workout: { id: 'w-bigw', d: '2026-11-03', entries: [{ id: 'ex-1', sets: [{ w: 2001, r: 5 }] }] } }],
      ['log_workout', { workout: { id: 'w-bigr', d: '2026-11-03', entries: [{ id: 'ex-1', sets: [{ w: 50, r: 10001 }] }] } }],
      ['log_workout', { workout: { id: 'w-bigbw', d: '2026-11-03', entries: [], bw: 1001 } }],
      ['create_routine', { routine: { id: 'r-big', name: 'Big', ex: [{ id: 'ex-1', sets: 3, reps: 10, weight: 5000 }] } }],
    ]
    for (const [name, args] of badOnes) {
      assert.equal((await call(h, token, name, args)).body.result.isError, true, name)
    }
    assert.equal(db._store.has(`users/${UID}/workouts/w-bigw`), false)
    const atCap = await call(h, token, 'log_workout', {
      workout: { id: 'w-cap', d: '2026-11-03', entries: [{ id: 'ex-1', sets: [{ w: 2000, r: 10 }] }], bw: 1000 },
    })
    assert.equal(atCap.body.result.isError, false)
    const stats = toolJson(await call(h, token, 'get_stats', {}))
    assert.ok(Number.isFinite(stats.totalVolume))
    assert.equal(stats.totalVolume, 320 + 2000 * 10)
  })

  it('F7: failed auth from one IP is throttled after 30; a valid token from another IP still works', async () => {
    const db = seedDb()
    const token = await mint(db, UID, ['read'])
    const h = mcpFor(db)
    const rpcIp = async (tok, ip) => {
      const res = fakeRes()
      const headers = { 'x-forwarded-for': ip }
      if (tok) headers.authorization = `Bearer ${tok}`
      await h({ method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'ping', params: {} } }, res)
      return res
    }
    const statuses = []
    for (let i = 0; i < 31; i++) statuses.push((await rpcIp('gym_agent_wrong', '1.2.3.4')).statusCode)
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(401))
    assert.equal(statuses[30], 429)
    const other = await rpcIp(token, '5.6.7.8')
    assert.equal(other.statusCode, 200)
    const noHeader = await rpc(h, token, 'ping', {})
    assert.equal(noHeader.statusCode, 200)
  })
})
