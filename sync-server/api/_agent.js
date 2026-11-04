// Agent connector: a remote MCP endpoint plus the token management behind the
// Settings "Agent connections" card. Both ride the existing passkey [action]
// function (actions "mcp" and "agent-tokens") because the Hobby plan caps a
// deployment at 12 Serverless Functions and server/api already sits at 12;
// underscore files are not functions, so the cores live here, exactly like
// _health-export.js and _methods.js.
//
// Auth, two different doors for two different callers:
//   - /api/mcp: a per-user agent token, sent as Bearer. Only the token's
//     SHA-256 hash is stored, in the top-level agentTokens collection
//     (agentTokens/{tokenHash} -> { id, uid, name, scopes, createdAt,
//     lastUsedAt }), which lives OUTSIDE the synced users/{uid} tree and is
//     Admin-SDK-only (firestore.rules denies clients everything outside their
//     own users tree). The raw token is shown once, at creation.
//   - agent-tokens management: the account owner's Firebase ID token, verified
//     server-side by bearerUid in _lib.js, the same proof _methods.js uses.
//     The uid comes from the verified token, never from the body, so one
//     account can only ever list, create or revoke its own tokens.
//
// Data: every tool operates on users/{uid} EXACTLY as the app defines it
// (app/src/lib/firestore-model.js): the meta doc plus one doc per entry in the
// workouts / routines / exercises / bodyweight subcollections, doc ids
// encodeURIComponent(key). Writes mirror what the client's sync layer would
// have written for the same change, so a phone picks agent changes up as
// ordinary sync:
//   - entries carry _ts = edit time (weigh-ins carry t, their own stamp), the
//     stamp lib/sync-merge.js holds versions against; without it a stale
//     device copy would win the merge back over the agent's edit;
//   - entries carry source: 'agent' (the split schema has no source field of
//     its own; this is the one added field, and merge treats unknown fields as
//     ordinary entry data);
//   - deletes also stamp the meta doc's `deleted` tombstone map
//     (deleted.<field>.<key> = now), the record that stops another device's
//     surviving copy from resurrecting the entry; creates and updates stamp
//     the matching add-back (-now) when a tombstone exists;
//   - the meta doc's _fbUpdatedAt is bumped on tombstone writes only, the way
//     a client push bumps it.
// The in-progress workout is never touched: nothing here reads or writes the
// `active` field of the meta doc as a session, and the activeBackup
// subcollection is never read or written at all.
//
// Audit: every write and delete appends one doc to users/{uid}/agentLog
// ({ token, tokenId, tool, coll, targetId, at }), and token creation and
// revocation append one too (create_token / revoke_token, coll agentTokens).
// token is the token name and tokenId its client-visible UUID id (never the
// hash), so two tokens sharing a name stay distinguishable in the log. That
// subcollection is safe there:
// lib/firestore-sync.js attaches to a FIXED list of subcollections (the five
// split lists plus activeBackup) and never enumerates subcollections
// dynamically, and its pushes only diff the split lists, so agentLog docs are
// neither merged into device state nor deleted by a device push.
//
// Protocol: MCP over Streamable HTTP, hand-rolled JSON-RPC (initialize, ping,
// tools/list, tools/call). No SDK dependency. Per-token best-effort rate
// limit: an in-memory window per token hash (per function instance, which is
// all v1 needs).
//
// Adaptation: the nine read tools are upstream
// openGym's own MCP tools, adapted in ../mcp/src/tools.js (their handlers,
// descriptions and zod schemas; the state seam is ../mcp/src/state.js, which
// assembles the state object from this tree's Firestore split docs). The
// remaining tools (profile, stats, export, custom exercises, and every
// write and delete) have no upstream counterpart and are this app's Phase 2
// additions, as are the token store, audit log and kill switch below.
//
// Kill switch: AGENT_CONNECTOR_ENABLED is a HARD off switch, server-side
// only. Unset (the default) or any value other than an
// explicit off means enabled; "false", "0", "off", "no" or "disabled"
// (any case) turn the whole connector off: both actions refuse cleanly
// before any token lookup or Firestore write, and the Settings card is
// deliberately unaffected (it stays visible; revoking tokens is the normal
// off, this flag is the emergency one).
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { admin, body, send, usernameOfUid } from './passkey/_lib.js'
import { TOOLS as UPSTREAM_TOOLS, parseToolArgs, toolInputSchema } from '../mcp/src/tools.js'
import { createStateSource } from '../mcp/src/state.js'

export const AGENT_SCOPES = ['read', 'write', 'delete']

const OFF_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])
/** The kill switch, read per request like the health export reads its env:
 *  enabled unless AGENT_CONNECTOR_ENABLED is an explicit off value. */
export function agentConnectorEnabled(env = process.env) {
  const v = String(env?.AGENT_CONNECTOR_ENABLED ?? '').trim().toLowerCase()
  return !OFF_VALUES.has(v)
}
export const DISABLED_ERROR = 'Agent connector is disabled on this server (AGENT_CONNECTOR_ENABLED is off)'
const DAY_MS = 24 * 60 * 60 * 1000
const MCP_PROTOCOL = '2025-03-26'

// ---------------------------------------------------------------------------
// Small shared helpers (mirrors of the client-side firestore-model.js rules)

export const docIdFor = key => encodeURIComponent(String(key))
export const hashToken = token => createHash('sha256').update(String(token)).digest('hex')

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = v => typeof v === 'number' && Number.isFinite(v)
// Real calendar dates only: Date.parse rolls a nonexistent date forward
// (2026-02-31 becomes March), so parse the components and round-trip them.
const isDateStr = v => {
  if (typeof v !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const dt = new Date(0)
  dt.setUTCFullYear(y, mo - 1, d)
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

class ToolError extends Error {}
const bad = msg => { throw new ToolError(msg) }

// The only error text an infrastructure failure may put on the wire. Real
// firebase-admin and Firestore messages can carry project ids, credential
// paths and account uids, so they go to the server log (console.error) and
// never into a response body.
const INTERNAL_ERROR = 'Internal server error'

// Dual-name parameters (log_bodyweight's d/date and w/weight,
// delete_bodyweight's d/date; get_routine's routine_id/id follows the same
// rule in server/mcp/src/tools.js): if both names are present, non-empty
// and disagree, that is a clean tool error naming the conflict, never a
// silent pick. An empty string or an absent name yields to the other;
// equal values are fine. Returns undefined when neither name carries a
// value, leaving the caller's own required-field check to answer.
function pickDual(a, k1, k2, label) {
  const has = v => v !== undefined && v !== null && v !== ''
  const v1 = a?.[k1], v2 = a?.[k2]
  if (has(v1) && has(v2)) {
    if (v1 !== v2) bad(`${label}: ${k1} and ${k2} disagree (${JSON.stringify(v1)} vs ${JSON.stringify(v2)}); pass only one of them, or make them agree`)
    return v1
  }
  if (has(v1)) return v1
  if (has(v2)) return v2
  return undefined
}

// ---------------------------------------------------------------------------
// Token store

async function findToken(db, rawToken) {
  if (!rawToken) return null
  const ref = db.collection('agentTokens').doc(hashToken(rawToken))
  const snap = await ref.get()
  if (!snap.exists) return null
  return { ref, hash: ref.id, ...snap.data() }
}

function bearerOf(req) {
  const h = req.headers?.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

// Best-effort per-token rate limit: a sliding in-memory window.
const rateWindows = new Map()
export function rateOk(hash, now, { max = 120, windowMs = 60 * 1000 } = {}) {
  const arr = (rateWindows.get(hash) || []).filter(t => now - t < windowMs)
  if (arr.length >= max) { rateWindows.set(hash, arr); return false }
  arr.push(now)
  rateWindows.set(hash, arr)
  return true
}
export const _clearRateWindows = () => { rateWindows.clear(); failedAuthWindows.clear() }

// Best-effort failed-auth throttle (F7): unauthenticated requests are not
// covered by the per-token limit above, and each guessed token costs a
// Firestore read, so failed token lookups are counted per client IP in
// memory (per function instance, like the rate windows). After
// FAILED_AUTH_MAX failures inside the rate window, that IP gets 429 for the
// rest of the window, before any further token lookup happens.
const FAILED_AUTH_MAX = 30
const failedAuthWindows = new Map()
function clientIpOf(req) {
  const xff = req.headers?.['x-forwarded-for']
  const first = typeof xff === 'string' ? xff.split(',')[0].trim() : ''
  return first || 'unknown'
}
function failedAuthCount(ip, now, windowMs) {
  const arr = (failedAuthWindows.get(ip) || []).filter(t => now - t < windowMs)
  failedAuthWindows.set(ip, arr)
  return arr.length
}
function noteFailedAuth(ip, now, windowMs) {
  failedAuthCount(ip, now, windowMs)
  failedAuthWindows.get(ip).push(now)
}

// ---------------------------------------------------------------------------
// Token management cores (the agent-tokens action). Each takes the caller's
// proven uid and returns { status, payload }, like the _methods.js cores.

const publicToken = d => ({
  id: d.id, name: d.name, scopes: Array.isArray(d.scopes) ? d.scopes : [],
  createdAt: d.createdAt || null, lastUsedAt: d.lastUsedAt || null,
})

export async function listAgentTokens({ uid, db }) {
  const snap = await db.collection('agentTokens').where('uid', '==', uid).get()
  const tokens = snap.docs.map(d => publicToken(d.data())).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  return { status: 200, payload: { tokens } }
}

export async function createAgentToken({ uid, db, reqBody, now = Date.now(), makeToken, makeId }) {
  const name = typeof reqBody?.name === 'string' ? reqBody.name.trim() : ''
  if (!name || name.length > 60) return { status: 400, payload: { error: 'Give the token a name (up to 60 characters)' } }
  const scopes = Array.isArray(reqBody?.scopes) ? [...new Set(reqBody.scopes.filter(s => AGENT_SCOPES.includes(s)))] : []
  if (!scopes.length || scopes.length !== (Array.isArray(reqBody?.scopes) ? new Set(reqBody.scopes).size : 0)) {
    return { status: 400, payload: { error: 'Pick at least one scope: read, write or delete' } }
  }
  const raw = (makeToken || (() => 'gym_agent_' + randomBytes(32).toString('base64url')))()
  const rec = { id: (makeId || randomUUID)(), uid, name, scopes, createdAt: now, lastUsedAt: null }
  await db.collection('agentTokens').doc(hashToken(raw)).set(rec)
  await auditTokenOp(db, uid, { tokenName: name, tokenId: rec.id, tool: 'create_token', at: now })
  // The raw token is returned exactly here, exactly once; only its hash is kept.
  return { status: 200, payload: { token: raw, ...publicToken(rec) } }
}

/** One agentLog audit doc for a token management op, in the same
 *  users/{uid}/agentLog the tool writes use. tokenId and targetId are the
 *  client-visible UUID id from the token record, never the stored hash. */
async function auditTokenOp(db, uid, { tokenName, tokenId, tool, at }) {
  await db.collection('users').doc(uid).collection('agentLog').doc(randomUUID())
    .set({ token: tokenName, tokenId, tool, coll: 'agentTokens', targetId: tokenId, at })
}

export async function revokeAgentToken({ uid, db, reqBody, now = Date.now() }) {
  const id = typeof reqBody?.id === 'string' ? reqBody.id : ''
  if (!id) return { status: 400, payload: { error: 'Missing token id' } }
  const snap = await db.collection('agentTokens').where('uid', '==', uid).get()
  const doc = snap.docs.find(d => d.data()?.id === id)
  if (!doc) return { status: 404, payload: { error: 'Token not found' } }
  await db.collection('agentTokens').doc(doc.id).delete()
  await auditTokenOp(db, uid, { tokenName: doc.data()?.name, tokenId: id, tool: 'revoke_token', at: now })
  return { status: 200, payload: { ok: true } }
}

export async function agentTokensAction({ uid, db, reqBody, now, makeToken, makeId, enabled }) {
  // Kill switch first: a refused call touches no token record and no Firestore doc.
  const on = enabled !== undefined ? enabled : agentConnectorEnabled()
  if (!on) return { status: 403, payload: { error: DISABLED_ERROR } }
  const op = reqBody?.op
  if (op === 'list') return listAgentTokens({ uid, db })
  if (op === 'create') return createAgentToken({ uid, db, reqBody, now, makeToken, makeId })
  if (op === 'revoke') return revokeAgentToken({ uid, db, reqBody, now })
  return { status: 400, payload: { error: 'Unknown op' } }
}

// ---------------------------------------------------------------------------
// Reading and writing the users/{uid} split docs

const userRefOf = (db, uid) => db.collection('users').doc(uid)
const collRefOf = (db, uid, coll) => userRefOf(db, uid).collection(coll)

async function listColl(db, uid, coll) {
  const snap = await collRefOf(db, uid, coll).get()
  const out = []
  snap.forEach(d => out.push(d.data()))
  return out
}

async function getEntry(db, uid, coll, key) {
  const snap = await collRefOf(db, uid, coll).doc(docIdFor(key)).get()
  return snap.exists ? snap.data() : null
}

// The meta doc's tombstone map, updated inside the same transaction as the
// entry write/delete it belongs to: field is the STATE field name (workouts,
// routines, customEx, bodyweight), key the entry key sync-merge names it by,
// stamp positive for a removal, negative for an add-back.
function stampTombstone(tx, userRef, meta, field, key, stamp) {
  const deleted = isObj(meta?.deleted) ? { ...meta.deleted } : {}
  const fm = isObj(deleted[field]) ? { ...deleted[field] } : {}
  fm[String(key)] = stamp
  deleted[field] = fm
  if (meta) tx.update(userRef, { deleted, _fbUpdatedAt: FieldValue.serverTimestamp() })
  else tx.set(userRef, { deleted, _fbUpdatedAt: FieldValue.serverTimestamp() })
}

/** Write one entry (create or replace), its add-back tombstone when a removal
 *  was on record, and the audit doc, in one transaction. For a create
 *  (createError set), existence is re-checked INSIDE the transaction: the
 *  caller's earlier getEntry check sits outside it, so two concurrent
 *  creates with one id could both pass it and the second would silently
 *  clobber the first. Updates pass no createError and keep overwriting. */
// Creates for one entry are serialized inside this function instance: the
// check and the write in one create cannot interleave with another create
// of the same entry, so a loser always re-reads inside its transaction
// after the winner has landed. Across instances the transaction re-check
// is the guard (Firestore retries a contended transaction, and the retry
// sees the winner's doc).
const createChains = new Map()
function runCreateSerialized(lockKey, fn) {
  const prev = createChains.get(lockKey) || Promise.resolve()
  const next = prev.then(fn, fn)
  const stored = next.catch(() => {})
  createChains.set(lockKey, stored)
  stored.then(() => { if (createChains.get(lockKey) === stored) createChains.delete(lockKey) })
  return next
}

async function putEntry(db, uid, opts) {
  if (!opts.createError) return writeEntry(db, uid, opts)
  return runCreateSerialized(`${uid}/${opts.coll}/${opts.key}`, () => writeEntry(db, uid, opts))
}

async function writeEntry(db, uid, { coll, field, key, entry, tokenName, tokenId, tool, now, createError }) {
  const userRef = userRefOf(db, uid)
  const entryRef = collRefOf(db, uid, coll).doc(docIdFor(key))
  const auditRef = collRefOf(db, uid, 'agentLog').doc(randomUUID())
  await db.runTransaction(async tx => {
    const metaSnap = await tx.get(userRef)
    const meta = metaSnap.exists ? metaSnap.data() : null
    if (createError) {
      const existing = await tx.get(entryRef)
      if (existing.exists) bad(createError)
    }
    tx.set(entryRef, entry)
    const tomb = isObj(meta?.deleted) ? meta.deleted[field]?.[String(key)] : undefined
    if (typeof tomb === 'number' && tomb > 0) stampTombstone(tx, userRef, meta, field, key, -now)
    tx.set(auditRef, { token: tokenName, tokenId, tool, coll, targetId: String(key), at: now })
  })
}

/** Delete one entry, stamp its tombstone, and append the audit doc, atomically. */
async function removeEntry(db, uid, { coll, field, key, tokenName, tokenId, tool, now }) {
  const userRef = userRefOf(db, uid)
  const entryRef = collRefOf(db, uid, coll).doc(docIdFor(key))
  const auditRef = collRefOf(db, uid, 'agentLog').doc(randomUUID())
  await db.runTransaction(async tx => {
    const metaSnap = await tx.get(userRef)
    const meta = metaSnap.exists ? metaSnap.data() : null
    tx.delete(entryRef)
    stampTombstone(tx, userRef, meta, field, key, now)
    tx.set(auditRef, { token: tokenName, tokenId, tool, coll, targetId: String(key), at: now })
  })
}

// ---------------------------------------------------------------------------
// Validation. Shapes mirror the app's: sets are { w, r } numbers, routine
// entries are exercise configs ({ id, sets, reps, weight, ... }), a workout is
// { d, start, entries: [{ id, sets }] }, a weigh-in is { d, w }.

// Sane upper bounds (F6): the app itself caps nothing a user types, but an
// uncapped set weight times reps can push get_stats volume to Infinity,
// which then serializes as null. Caps mirror log_bodyweight (1000) and the
// CSV importer's MAX_KG (2000); reps get a generous 10000 ceiling.
const MAX_WEIGHT = 2000
const MAX_REPS = 10000
const MAX_BODYWEIGHT = 1000

const optNum = (v, label, { min = 0, max } = {}) => {
  if (v === undefined || v === null) return undefined
  if (!isNum(v) || v < min) bad(`${label} must be a number${min ? ` of at least ${min}` : ''}`)
  if (max !== undefined && v > max) bad(`${label} must be a number of at most ${max}`)
  return v
}
const reqStr = (v, label, max = 500) => {
  if (typeof v !== 'string' || !v.trim()) bad(`${label} is required`)
  if (v.length > max) bad(`${label} is too long`)
  return v
}
const optStr = (v, label, max = 2000) => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > max) bad(`${label} must be a string`)
  return v
}
const optStrList = (v, label) => {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) bad(`${label} must be a list of strings`)
  return v
}

function cleanSets(sets, label = 'sets') {
  if (!Array.isArray(sets)) bad(`${label} must be a list of sets`)
  if (sets.length > 100) bad(`${label} has too many sets`)
  return sets.map((s, i) => {
    if (!isObj(s)) bad(`${label}[${i}] must be an object with w and r`)
    const out = {}
    for (const k of ['w', 'r']) {
      const cap = k === 'w' ? MAX_WEIGHT : MAX_REPS
      if (s[k] === null || s[k] === undefined) out[k] = null
      else if (isNum(s[k]) && s[k] >= 0 && s[k] <= cap) out[k] = s[k]
      else bad(`${label}[${i}].${k} must be a number or null of at most ${cap}`)
    }
    if (typeof s.done === 'boolean') out.done = s.done
    const extra = optNum(s.sec, `${label}[${i}].sec`); if (extra !== undefined) out.sec = extra
    return out
  })
}

function cleanExercise(input, { partial = false } = {}) {
  if (!isObj(input)) bad('exercise must be an object')
  const out = {}
  if (!partial || input.n !== undefined) out.n = reqStr(input.n, 'exercise name', 200)
  for (const k of ['bp', 'eq', 'tg', 'cat']) { const v = optStr(input[k], k, 100); if (v !== undefined) out[k] = v }
  const desc = optStr(input.desc, 'desc', 5000); if (desc !== undefined) out.desc = desc
  for (const k of ['sm', 'muscleGroups', 'primaries', 'secondaries']) { const v = optStrList(input[k], k); if (v !== undefined) out[k] = v }
  return out
}

function cleanNumList(v, label, { max } = {}) {
  if (!Array.isArray(v)) bad(`${label} must be a list of numbers`)
  if (v.length > 100) bad(`${label} has too many entries`)
  return v.map((x, i) => {
    const n = optNum(x, `${label}[${i}]`, { max })
    if (n === undefined) bad(`${label}[${i}] must be a number`)
    return n
  })
}

function cleanPyramid(v, label) {
  if (!Array.isArray(v)) bad(`${label} must be a list`)
  if (v.length > 10) bad(`${label} has too many sets`)
  return v.map((x, i) => {
    if (x === 'max') return x
    const n = optNum(x, `${label}[${i}]`, { max: MAX_REPS })
    if (n === undefined) bad(`${label}[${i}] must be a number or "max"`)
    return n
  })
}

function cleanIntensifier(x, label) {
  if (!isObj(x)) bad(`${label} must be an object`)
  if (x.type !== 'dropset' && x.type !== 'restpause') bad(`${label}.type must be dropset or restpause`)
  const out = { type: x.type }
  for (const k of ['count', 'pct', 'totalReps', 'restSec']) {
    const v = optNum(x[k], `${label}.${k}`, k === 'totalReps' ? { max: MAX_REPS } : {})
    if (v !== undefined) out[k] = v
  }
  return out
}

// Strict whitelist, like the other cleaners: a routine entry is the config
// the app's exercise config sheet writes for one slot (sheets.jsx ExConfig
// save, lib/plan-share.js cleanEx, lib/routines.js, lib/superset-meta.js).
// Anything else the caller sends (extra keys, _ts, source, active, dunder
// keys, unbounded strings) is dropped silently, the way create_exercise
// strips junk, instead of being stored verbatim.
function cleanRoutineEx(ex) {
  if (!Array.isArray(ex)) bad('routine ex must be a list of exercise entries')
  if (ex.length > 100) bad('routine has too many exercises')
  return ex.map((e, i) => {
    if (!isObj(e)) bad(`routine ex[${i}] must be an object`)
    const label = `routine ex[${i}]`
    const out = { id: reqStr(e.id, `${label}.id`, 200) }
    for (const k of ['sets', 'reps', 'weight', 'restSec', 'warmupRestSec', 'warmupSets',
      'repsMin', 'repsMax', 'setsMax', 'inc', 'deloadFactor', 'min', 'sec', 'speed', 'sgRest']) {
      // An unlogged slot in the app's own seed carries weight null, not 0.
      if (k === 'weight' && e.weight === null) { out.weight = null; continue }
      const max = k === 'weight' ? MAX_WEIGHT : (k === 'reps' || k === 'repsMin' || k === 'repsMax') ? MAX_REPS : undefined
      const v = optNum(e[k], `${label}.${k}`, { max }); if (v !== undefined) out[k] = v
    }
    for (const [k, max] of [['mode', 20], ['prog', 50], ['dbLoad', 20], ['sg', 100], ['sgName', 100]]) {
      const v = optStr(e[k], `${label}.${k}`, max); if (v !== undefined) out[k] = v
    }
    const note = optStr(e.note, `${label}.note`); if (note !== undefined) out.note = note
    for (const k of ['bodyweight', 'side', 'backoff', 'lastToFailure', 'assisted']) {
      if (typeof e[k] === 'boolean') out[k] = e[k]
    }
    if (e.pyramid !== undefined) out.pyramid = cleanPyramid(e.pyramid, `${label}.pyramid`)
    if (e.pyramidRest !== undefined) out.pyramidRest = cleanNumList(e.pyramidRest, `${label}.pyramidRest`)
    if (e.pyramidWeight !== undefined) out.pyramidWeight = cleanNumList(e.pyramidWeight, `${label}.pyramidWeight`, { max: MAX_WEIGHT })
    if (e.intensifier !== undefined) out.intensifier = cleanIntensifier(e.intensifier, `${label}.intensifier`)
    return out
  })
}

function cleanRoutine(input, { partial = false } = {}) {
  if (!isObj(input)) bad('routine must be an object')
  const out = {}
  if (!partial || input.name !== undefined) out.name = reqStr(input.name, 'routine name', 200)
  if (input.ex !== undefined) out.ex = cleanRoutineEx(input.ex)
  else if (!partial) bad('routine ex is required')
  const emoji = optStr(input.emoji, 'emoji', 50); if (emoji !== undefined) out.emoji = emoji
  const prog = optStr(input.prog, 'prog', 50); if (prog !== undefined) out.prog = prog
  const note = optStr(input.note, 'note'); if (note !== undefined) out.note = note
  return out
}

function cleanWorkoutEntries(entries) {
  if (!Array.isArray(entries)) bad('workout entries must be a list')
  if (entries.length > 100) bad('workout has too many exercises')
  return entries.map((e, i) => {
    if (!isObj(e)) bad(`workout entries[${i}] must be an object`)
    reqStr(e.id, `workout entries[${i}].id`, 200)
    const out = { id: e.id, sets: cleanSets(e.sets, `workout entries[${i}].sets`) }
    const topW = e.topW === null ? null : optNum(e.topW, `workout entries[${i}].topW`, { max: MAX_WEIGHT }); if (topW !== undefined) out.topW = topW
    const note = optStr(e.note, `workout entries[${i}].note`); if (note !== undefined) out.note = note
    return out
  })
}

function cleanWorkout(input, { partial = false } = {}) {
  if (!isObj(input)) bad('workout must be an object')
  const out = {}
  if (!partial || input.d !== undefined) {
    if (!isDateStr(input.d)) bad('workout d must be a date string like 2026-11-04')
    out.d = input.d
  }
  if (input.entries !== undefined) out.entries = cleanWorkoutEntries(input.entries)
  else if (!partial) bad('workout entries is required')
  for (const k of ['start', 'end']) { const v = optNum(input[k], `workout ${k}`); if (v !== undefined) out[k] = v }
  for (const k of ['name', 'note', 'routineId']) { const v = optStr(input[k], `workout ${k}`, 500); if (v !== undefined) out[k] = v }
  const bw = optNum(input.bw, 'workout bw', { max: MAX_BODYWEIGHT }); if (bw !== undefined) out.bw = bw
  return out
}

// ---------------------------------------------------------------------------
// Tools

const workoutKey = w => (w?.id != null ? String(w.id) : `${w?.d}|${w?.start}`)

async function readAll(db, uid) {
  const userRef = userRefOf(db, uid)
  const [metaSnap, workouts, routines, exercises, bodyweight, measurements] = await Promise.all([
    userRef.get(),
    listColl(db, uid, 'workouts'), listColl(db, uid, 'routines'),
    listColl(db, uid, 'exercises'), listColl(db, uid, 'bodyweight'), listColl(db, uid, 'measurements'),
  ])
  return { meta: metaSnap.exists ? (metaSnap.data() || {}) : {}, workouts, routines, exercises, bodyweight, measurements }
}

export const TOOLS = [
  { name: 'get_profile', scope: 'read', description: 'Profile summary: unit, settings highlights and counts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_stats', scope: 'read', description: 'Stats summary: workout counts, volume, latest weigh-in.', inputSchema: { type: 'object', properties: {} } },
  { name: 'export_all', scope: 'read', description: 'Everything: profile meta, workouts, routines, custom exercises, bodyweight, measurements.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_exercises', scope: 'read', description: 'List the custom exercises.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_exercise', scope: 'read', description: 'One custom exercise by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'create_exercise', scope: 'write', description: 'Create a custom exercise. Takes { exercise: { n, bp?, eq?, tg?, desc?, sm? } } or the fields directly.', inputSchema: { type: 'object', properties: { exercise: { type: 'object' } } } },
  { name: 'update_exercise', scope: 'write', description: 'Patch a custom exercise by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, patch: { type: 'object' } }, required: ['id', 'patch'] } },
  { name: 'delete_exercise', scope: 'delete', description: 'Delete a custom exercise by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'create_routine', scope: 'write', description: 'Create a routine: { routine: { name, ex: [{ id, sets, reps, weight }] } } or the fields directly.', inputSchema: { type: 'object', properties: { routine: { type: 'object' } } } },
  { name: 'update_routine', scope: 'write', description: 'Patch a routine by id (name and/or ex).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, patch: { type: 'object' } }, required: ['id', 'patch'] } },
  { name: 'delete_routine', scope: 'delete', description: 'Delete a routine by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'log_workout', scope: 'write', description: 'Log a finished workout: { workout: { d, entries: [{ id, sets: [{ w, r }] }], name?, routineId?, note? } } or the fields directly.', inputSchema: { type: 'object', properties: { workout: { type: 'object' } } } },
  { name: 'update_workout', scope: 'write', description: 'Patch a logged workout by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, patch: { type: 'object' } }, required: ['id', 'patch'] } },
  { name: 'delete_workout', scope: 'delete', description: 'Delete a logged workout by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'log_bodyweight', scope: 'write', description: 'Log a weigh-in: { d: "2026-11-04", w: 151 } (date/weight also accepted).', inputSchema: { type: 'object', properties: { d: { type: 'string' }, w: { type: 'number' } }, required: ['d', 'w'] } },
  { name: 'delete_bodyweight', scope: 'delete', description: 'Delete the weigh-in on a date: { d } (or date).', inputSchema: { type: 'object', properties: { d: { type: 'string' } }, required: ['d'] } },
]
// The adapted upstream read tools join the registry with the read scope and
// JSON Schemas derived from their zod shapes (../mcp/src/tools.js).
for (const t of UPSTREAM_TOOLS) {
  TOOLS.push({ name: t.name, scope: 'read', description: t.description, inputSchema: toolInputSchema(t), upstream: t })
}
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]))

const newId = prefix => prefix + randomBytes(6).toString('hex')

// Caller-supplied ids on the create paths get the same validation the
// get/update/delete paths apply through reqStr (a non-empty string of at
// most 200 chars), plus the ids Firestore itself forbids as document ids:
// exactly "." or "..", and the reserved __.*__ pattern. Without this a
// create could mint an entry no other tool can address again, or one that
// 500s against real Firestore. A missing or blank id still means the
// caller wants a generated one, as before.
const cleanCreateId = v => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') bad('id must be a string')
  const id = v.trim()
  if (!id) return null
  if (id.length > 200) bad('id is too long')
  if (id === '.' || id === '..' || /^__.*__$/.test(id)) bad('id is not a valid document id')
  return id
}

async function callTool(db, uid, tokenRec, name, args, now) {
  const a = isObj(args) ? args : {}
  const upstream = UPSTREAM_TOOLS.find(t => t.name === name)
  if (upstream) {
    let parsed
    try { parsed = parseToolArgs(upstream, a) } catch (e) { bad(e.message) }
    // The state load is infrastructure, not tool logic: its failures are NOT
    // converted to ToolError here. They propagate to the host's guarded 500
    // path, which logs the real error and answers the generic body, so a
    // Firestore message (project ids, credential paths) never reaches the
    // client dressed as a tool error. Only the handler's own errors, whose
    // messages are written for the caller, become ToolErrors below.
    const S = await createStateSource(db, uid).getState()
    try { return upstream.handler(S, parsed) } catch (e) { bad(e.message) }
  }
  switch (name) {
    case 'get_profile': {
      const { meta, workouts, routines, exercises, bodyweight } = await readAll(db, uid)
      const nameRec = await usernameOfUid(db, uid).catch(() => null)
      const profile = {}
      for (const k of ['unit', 'body', 'targetW', 'lang', 'theme', 'weekStart', 'week']) if (meta[k] !== undefined) profile[k] = meta[k]
      return {
        username: nameRec?.username || null, profile,
        counts: { workouts: workouts.length, routines: routines.length, customExercises: exercises.length, weighIns: bodyweight.length },
      }
    }
    case 'get_stats': {
      const { workouts, bodyweight } = await readAll(db, uid)
      const sorted = workouts.slice().sort((x, y) => String(y.d).localeCompare(String(x.d)) || ((y.start || 0) - (x.start || 0)))
      const cutoff = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10)
      let totalSets = 0, totalVolume = 0
      for (const w of workouts) for (const e of (Array.isArray(w.entries) ? w.entries : [])) {
        for (const s of (Array.isArray(e?.sets) ? e.sets : [])) { totalSets++; if (isNum(s?.w) && isNum(s?.r)) { const v = s.w * s.r; if (Number.isFinite(v)) totalVolume += v } }
      }
      const bw = bodyweight.filter(e => typeof e?.d === 'string' && isNum(e?.w)).sort((x, y) => x.d.localeCompare(y.d))
      return {
        totalWorkouts: workouts.length,
        sessionsLast30Days: sorted.filter(w => typeof w.d === 'string' && w.d >= cutoff).length,
        lastWorkoutDate: sorted.length ? (sorted[0].d ?? null) : null,
        totalSets, totalVolume,
        latestBodyweight: bw.length ? { date: bw[bw.length - 1].d, kg: bw[bw.length - 1].w } : null,
        weighIns: bw.length,
      }
    }
    case 'export_all': {
      const { meta, workouts, routines, exercises, bodyweight, measurements } = await readAll(db, uid)
      const profile = { ...meta }
      delete profile._fbUpdatedAt; delete profile.deleted; delete profile.edited; delete profile.undone; delete profile.active
      return { profile, workouts, routines, customEx: exercises, bodyweight, measurements }
    }
    case 'list_exercises': return { exercises: await listColl(db, uid, 'exercises') }
    case 'get_exercise': {
      const id = reqStr(a.id, 'id', 200)
      const e = await getEntry(db, uid, 'exercises', id)
      if (!e) bad(`No custom exercise with id ${id}`)
      return { exercise: e }
    }
    case 'create_exercise': {
      const input = isObj(a.exercise) ? a.exercise : a
      const fields = cleanExercise(input)
      const id = cleanCreateId(input.id) || newId('ag-')
      if (await getEntry(db, uid, 'exercises', id)) bad(`A custom exercise with id ${id} already exists`)
      const entry = { ...fields, id, custom: true, source: 'agent', _ts: now }
      await putEntry(db, uid, { coll: 'exercises', field: 'customEx', key: id, entry, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now, createError: `A custom exercise with id ${id} already exists` })
      return { exercise: entry }
    }
    case 'update_exercise': {
      const id = reqStr(a.id, 'id', 200)
      const existing = await getEntry(db, uid, 'exercises', id)
      if (!existing) bad(`No custom exercise with id ${id}`)
      const entry = { ...existing, ...cleanExercise(a.patch, { partial: true }), id, source: 'agent', _ts: now }
      await putEntry(db, uid, { coll: 'exercises', field: 'customEx', key: id, entry, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { exercise: entry }
    }
    case 'delete_exercise': {
      const id = reqStr(a.id, 'id', 200)
      if (!(await getEntry(db, uid, 'exercises', id))) bad(`No custom exercise with id ${id}`)
      await removeEntry(db, uid, { coll: 'exercises', field: 'customEx', key: id, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { deleted: id }
    }
    case 'create_routine': {
      const input = isObj(a.routine) ? a.routine : a
      const fields = cleanRoutine(input)
      const id = cleanCreateId(input.id) || newId('ag-')
      if (await getEntry(db, uid, 'routines', id)) bad(`A routine with id ${id} already exists`)
      const entry = { ...fields, id, source: 'agent', _ts: now }
      await putEntry(db, uid, { coll: 'routines', field: 'routines', key: id, entry, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now, createError: `A routine with id ${id} already exists` })
      return { routine: entry }
    }
    case 'update_routine': {
      const id = reqStr(a.id, 'id', 200)
      const existing = await getEntry(db, uid, 'routines', id)
      if (!existing) bad(`No routine with id ${id}`)
      const entry = { ...existing, ...cleanRoutine(a.patch, { partial: true }), id, source: 'agent', _ts: now }
      await putEntry(db, uid, { coll: 'routines', field: 'routines', key: id, entry, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { routine: entry }
    }
    case 'delete_routine': {
      const id = reqStr(a.id, 'id', 200)
      if (!(await getEntry(db, uid, 'routines', id))) bad(`No routine with id ${id}`)
      await removeEntry(db, uid, { coll: 'routines', field: 'routines', key: id, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { deleted: id }
    }
    case 'log_workout': {
      const input = isObj(a.workout) ? a.workout : a
      const fields = cleanWorkout(input)
      const id = cleanCreateId(input.id) || newId('ag-')
      if (await getEntry(db, uid, 'workouts', id)) bad(`A workout with id ${id} already exists`)
      const entry = { ...fields, id, start: fields.start ?? Date.parse(fields.d), source: 'agent', _ts: now }
      await putEntry(db, uid, { coll: 'workouts', field: 'workouts', key: workoutKey(entry), entry, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now, createError: `A workout with id ${id} already exists` })
      return { workout: entry }
    }
    case 'update_workout': {
      const id = reqStr(a.id, 'id', 200)
      const existing = await getEntry(db, uid, 'workouts', id)
      if (!existing) bad(`No workout with id ${id}`)
      const entry = { ...existing, ...cleanWorkout(a.patch, { partial: true }), id, source: 'agent', _ts: now }
      await putEntry(db, uid, { coll: 'workouts', field: 'workouts', key: workoutKey(entry), entry, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { workout: entry }
    }
    case 'delete_workout': {
      const id = reqStr(a.id, 'id', 200)
      const existing = await getEntry(db, uid, 'workouts', id)
      if (!existing) bad(`No workout with id ${id}`)
      await removeEntry(db, uid, { coll: 'workouts', field: 'workouts', key: workoutKey(existing), tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { deleted: id }
    }
    case 'log_bodyweight': {
      const d = pickDual(a, 'd', 'date', 'date')
      const w = pickDual(a, 'w', 'weight', 'weight')
      if (!isDateStr(d)) bad('d must be a date string like 2026-11-04')
      if (!isNum(w) || w <= 0 || w > 1000) bad('w must be a weight in kg over 0')
      const entry = { d, w, t: now, source: 'agent' }
      await putEntry(db, uid, { coll: 'bodyweight', field: 'bodyweight', key: d, entry, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { bodyweight: entry }
    }
    case 'delete_bodyweight': {
      const d = pickDual(a, 'd', 'date', 'date')
      if (!isDateStr(d)) bad('d must be a date string like 2026-11-04')
      if (!(await getEntry(db, uid, 'bodyweight', d))) bad(`No weigh-in on ${d}`)
      await removeEntry(db, uid, { coll: 'bodyweight', field: 'bodyweight', key: d, tokenName: tokenRec.name, tokenId: tokenRec.id, tool: name, now })
      return { deleted: d }
    }
    default: bad(`Unknown tool ${name}`)
  }
}

// ---------------------------------------------------------------------------
// The MCP handler (Streamable HTTP, JSON-RPC 2.0)

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

export function createMcpHandler(overrides = {}) {
  return async (req, res) => {
    const now = overrides.now ? overrides.now() : Date.now()
    const reply = (status, obj) => send(res, status, obj)
    if (req.method !== 'POST') return reply(405, rpcError(null, -32000, 'POST only'))
    let msg
    try { msg = await body(req) } catch { msg = null }
    if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return reply(400, rpcError(msg?.id, -32600, 'Invalid JSON-RPC request'))
    }
    const isNotification = msg.id === undefined
    // Kill switch before everything else: no admin init, no token lookup, no
    // Firestore write on a refused call. Notifications carry no result to
    // refuse into, so they keep the plain 202 and do nothing, as usual.
    const on = overrides.enabled !== undefined ? overrides.enabled : agentConnectorEnabled()
    if (!on) {
      if (isNotification) { res.status(202); return res.end ? res.end() : undefined }
      return reply(503, rpcError(msg.id, -32004, DISABLED_ERROR))
    }
    // Auth: every method needs a valid agent token (initialize included, so a
    // bad token fails at the handshake, not mid-session). The best-effort
    // failed-auth throttle runs first, so a throttled IP costs no token
    // lookup at all; without an x-forwarded-for header the caller lands in
    // one shared bucket, which keeps tests and local calls working.
    const authWindowMs = overrides.rateLimit?.windowMs || 60 * 1000
    const ip = clientIpOf(req)
    if (failedAuthCount(ip, now, authWindowMs) >= FAILED_AUTH_MAX) {
      if (isNotification) { res.status(202); return res.end ? res.end() : undefined }
      return reply(429, rpcError(msg.id, -32002, 'Too many failed auth attempts; slow down'))
    }
    let db
    // This runs before auth, so its error text would reach unauthenticated
    // callers: log the real error, answer the generic body.
    try { db = (overrides.adminFn || admin)().db } catch (e) { console.error(e); return reply(500, rpcError(msg.id, -32000, INTERNAL_ERROR)) }
    const rec = await findToken(db, bearerOf(req)).catch(() => null)
    if (!rec || !rec.uid) {
      noteFailedAuth(ip, now, authWindowMs)
      if (isNotification) { res.status(202); return res.end ? res.end() : undefined }
      return reply(401, rpcError(msg.id, -32001, 'Unauthorized: a valid agent token is required'))
    }
    if (!rateOk(rec.hash, now, overrides.rateLimit)) {
      if (isNotification) { res.status(202); return res.end ? res.end() : undefined }
      return reply(429, rpcError(msg.id, -32002, 'Rate limit for this token; slow down'))
    }
    // Best-effort last-used stamp; never blocks or fails the call.
    rec.ref.update({ lastUsedAt: now }).catch(() => {})

    if (isNotification) { res.status(202); return res.end ? res.end() : undefined }

    try {
      switch (msg.method) {
        case 'initialize':
          return reply(200, rpcResult(msg.id, {
            protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : MCP_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'opengym', version: '1.0.0' },
          }))
        case 'ping':
          return reply(200, rpcResult(msg.id, {}))
        case 'tools/list':
          return reply(200, rpcResult(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }))
        case 'tools/call': {
          const toolName = msg.params?.name
          const tool = TOOL_BY_NAME[toolName]
          if (!tool) return reply(200, rpcError(msg.id, -32602, `Unknown tool ${toolName}`))
          const scopes = Array.isArray(rec.scopes) ? rec.scopes : []
          if (!scopes.includes(tool.scope)) {
            return reply(200, rpcError(msg.id, -32003, `This token lacks the ${tool.scope} scope this tool needs`))
          }
          try {
            const out = await callTool(db, rec.uid, rec, toolName, msg.params?.arguments, now)
            return reply(200, rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false }))
          } catch (e) {
            if (e instanceof ToolError) {
              return reply(200, rpcResult(msg.id, { content: [{ type: 'text', text: e.message }], isError: true }))
            }
            throw e
          }
        }
        default:
          return reply(200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`))
      }
    } catch (e) {
      console.error(e)
      return reply(500, rpcError(msg.id, -32000, INTERNAL_ERROR))
    }
  }
}

export const mcpHandler = createMcpHandler()
