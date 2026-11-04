/* Adapted state layer: upstream read ./data/state-<uid>.json + db.json from a
   local self-hosted server. This app has no ./data; its data is the Firestore
   users/{uid} split-doc tree (app/src/lib/firestore-model.js). This module is
   the same seam with a Firestore reader behind it: stateFromDocs is the pure
   assembly (meta doc + subcollections -> the state object S the app and the
   tools expect), createStateSource loads those docs per request, and
   _seedStateForTests keeps upstream's test seam name and purpose. */
import { joinDocs, keyForDocId } from '../../../app/src/lib/firestore-model.js'

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}

const FIELDS = [
  ['workouts', 'workouts'], ['routines', 'routines'], ['exercises', 'customEx'],
  ['bodyweight', 'bodyweight'], ['measurements', 'measurements'],
]

// Keys that are never legitimate app state fields in the meta doc. The app
// writes settings, week, dayPlan, exWeights, exNotes and sync stamps there
// (firestore-model.js splitState copies every non-list field of S); none of
// its writers ever stores one of these names. A stored meta carrying one is
// hostile or corrupt, and merging it with Object.assign would SET the
// assembled state's prototype instead of storing data, smuggling fields like
// active, queue and exNotes in through the prototype chain where the plain
// deletes below cannot reach them. They are dropped before any merge.
const DANGEROUS_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function cleanMeta(meta) {
  if (meta == null || typeof meta !== 'object') return {}
  const out = {}
  for (const k of Object.keys(meta)) {
    if (DANGEROUS_META_KEYS.has(k)) continue
    out[k] = meta[k]
  }
  return out
}

const isEntryObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

// Light shape normalization for stored docs whose internals are wrong-typed
// (a hand edit, a bad import, an older bug). Whole workouts and routines are
// never dropped for these faults, and well-formed data passes through
// untouched: a workout or routine with no fault below is returned as the
// same object, so valid shapes stay byte-identical.
//   - a workout whose entries is not an array gets entries: []
//   - non-object workout entries are dropped
//   - an entry whose sets is not an array gets sets: []
//   - non-object sets are dropped
//   - a routine whose ex is not an array gets ex: []
//   - non-object routine ex entries are dropped
function normalizeWorkout(w) {
  if (!isEntryObj(w)) return w
  if (!Array.isArray(w.entries)) return { ...w, entries: [] }
  let changed = false
  const entries = []
  for (const e of w.entries) {
    if (!isEntryObj(e)) { changed = true; continue }
    if (!Array.isArray(e.sets)) { entries.push({ ...e, sets: [] }); changed = true; continue }
    const badSet = e.sets.some(s => !isEntryObj(s))
    if (badSet) { entries.push({ ...e, sets: e.sets.filter(isEntryObj) }); changed = true; continue }
    entries.push(e)
  }
  return changed ? { ...w, entries } : w
}

function normalizeRoutine(r) {
  if (!isEntryObj(r)) return r
  if (!Array.isArray(r.ex)) return { ...r, ex: [] }
  if (r.ex.every(isEntryObj)) return r
  return { ...r, ex: r.ex.filter(isEntryObj) }
}

/** Pure assembly: { meta, lists: { coll: entry[] | Map } } -> S, or null when
 *  the account has no meta doc and every list is empty (upstream's no-state
 *  case: never synced from a device). _fbUpdatedAt and active never reach S.
 *  Lists are keyed by the Firestore doc id, exactly as the app's own reader
 *  keys them (firestore-sync.js readAll keys each Map by keyForDocId(doc
 *  id)), so every stored doc survives assembly: keying by a key derived from
 *  entry content instead collapsed stored entries that share the derived
 *  key (two id-less workouts on the same day and start, two weigh-ins on one
 *  date) into one. Callers that hand in plain arrays have no doc ids to key
 *  by, so each entry is keyed by its position, which preserves them all the
 *  same way. */
export function stateFromDocs({ meta, lists } = {}) {
  const hasMeta = meta != null && typeof meta === 'object'
  const listSize = v => (v instanceof Map ? v.size : Array.isArray(v) ? v.length : 0)
  const anyList = FIELDS.some(([coll]) => listSize(lists?.[coll]) > 0)
  if (!hasMeta && !anyList) return null
  const maps = {}
  for (const [coll] of FIELDS) {
    const raw = lists?.[coll]
    if (raw instanceof Map) maps[coll] = new Map(raw)
    else if (Array.isArray(raw)) maps[coll] = new Map(raw.map((e, i) => [String(i), e]))
    else maps[coll] = new Map()
  }
  const joined = joinDocs({ meta: hasMeta ? cleanMeta(meta) : {}, lists: maps })
  // Belt and braces: nothing dangerous reaches the merge even if a future
  // join path reintroduces it.
  for (const k of DANGEROUS_META_KEYS) delete joined[k]
  const S = Object.assign({}, defaultsShape(), joined)
  delete S._fbUpdatedAt
  delete S.active
  if (Array.isArray(S.workouts)) S.workouts = S.workouts.map(normalizeWorkout)
  if (Array.isArray(S.routines)) S.routines = S.routines.map(normalizeRoutine)
  return S
}

/** Firestore-backed source for one uid. getState() loads fresh per call:
 *  a serverless function has no long-lived process to cache in, and a fresh
 *  load is the hosted equivalent of upstream's watch-and-reread rule. */
export function createStateSource(db, uid) {
  return {
    async getState() {
      const userRef = db.collection('users').doc(uid)
      const colls = FIELDS.map(([coll]) => coll)
      const [metaSnap, ...snaps] = await Promise.all([
        userRef.get(),
        ...colls.map(c => userRef.collection(c).get()),
      ])
      const lists = {}
      snaps.forEach((snap, i) => {
        const m = new Map()
        snap.forEach(d => m.set(keyForDocId(d.id), d.data()))
        lists[colls[i]] = m
      })
      return stateFromDocs({ meta: metaSnap.exists ? (metaSnap.data() || {}) : null, lists })
    },
  }
}

/** Test seam, same name and purpose as upstream's: a source over a passed-in
 *  state, no Firestore involved. */
export function _seedStateForTests(state) {
  return { getState: async () => state }
}
