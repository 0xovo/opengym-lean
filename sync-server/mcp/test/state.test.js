// Tests for the adapted state layer (src/state.js): the Firestore split docs
// become the state object S the tools expect, with the same no-state rule
// upstream's file layer had (nothing synced yet is null, not an empty profile).
import { describe, test, expect } from 'vitest'
import { stateFromDocs, _seedStateForTests } from '../src/state.js'
import { TOOLS } from '../src/tools.js'
import { pinnedNoteFor, exNoteFor } from '../../../app/src/lib/history.js'

const handlerOf = Object.fromEntries(TOOLS.map(t => [t.name, t.handler]))

describe('stateFromDocs', () => {
  test('no meta doc and no entries is null (never synced)', () => {
    expect(stateFromDocs({ meta: null, lists: {} })).toBeNull()
    expect(stateFromDocs({ meta: null, lists: { workouts: [], routines: [], exercises: [], bodyweight: [], measurements: [] } })).toBeNull()
  })

  test('assembles meta plus lists, exercises under their state name customEx', () => {
    const S = stateFromDocs({
      meta: { unit: 'lb', targetW: 80 },
      lists: {
        workouts: [{ id: 'w-1', d: '2026-11-01', entries: [] }],
        routines: [{ id: 'r-1', name: 'Day', ex: [] }],
        exercises: [{ id: 'ex-1', n: 'Mine', custom: true }],
        bodyweight: [{ d: '2026-11-01', w: 151 }],
        measurements: [{ d: '2026-11-01', waist: 100 }],
      },
    })
    expect(S.unit).toBe('lb')
    expect(S.targetW).toBe(80)
    expect(S.workouts.map(w => w.id)).toEqual(['w-1'])
    expect(S.routines.map(r => r.id)).toEqual(['r-1'])
    expect(S.customEx.map(e => e.id)).toEqual(['ex-1'])
    expect(S.bodyweight).toEqual([{ d: '2026-11-01', w: 151 }])
    expect(S.measurements.length).toBe(1)
  })

  test('app defaults are merged under stored state', () => {
    const S = stateFromDocs({ meta: { unit: 'lb' }, lists: {} })
    expect(S.unit).toBe('lb')
    expect(S.restSec).toBe(90)
    expect(S.week).toEqual({})
    expect(S.bodyweight).toEqual([])
  })

  test('the running workout and the sync stamp never reach S', () => {
    const S = stateFromDocs({ meta: { active: { id: 'run-1' }, _fbUpdatedAt: 123, unit: 'kg' }, lists: {} })
    expect('active' in S).toBe(false)
    expect('_fbUpdatedAt' in S).toBe(false)
  })

  test('entries alone (no meta doc) still make a state', () => {
    const S = stateFromDocs({ meta: null, lists: { bodyweight: [{ d: '2026-11-01', w: 90 }] } })
    expect(S.bodyweight.length).toBe(1)
  })
})

describe('stateFromDocs: every stored doc survives assembly (attack round 2, find 1)', () => {
  test('two id-less workouts on the same day and start both present', () => {
    const S = stateFromDocs({
      meta: { unit: 'kg' },
      lists: {
        workouts: [
          { d: '2026-07-24', start: 100, name: 'Morning', entries: [] },
          { d: '2026-07-24', start: 100, name: 'Evening', entries: [] },
        ],
      },
    })
    expect(S.workouts.map(w => w.name)).toEqual(['Morning', 'Evening'])
    expect(handlerOf.list_workouts(S, {}).matching_count).toBe(2)
  })

  test('duplicate bodyweight dates both present in the assembled list', () => {
    const S = stateFromDocs({
      meta: { unit: 'kg' },
      lists: { bodyweight: [{ d: '2026-07-27', w: 78 }, { d: '2026-07-27', w: 99 }] },
    })
    expect(S.bodyweight).toEqual([{ d: '2026-07-27', w: 78 }, { d: '2026-07-27', w: 99 }])
  })

  test('duplicate routine and exercise ids in separate docs both present', () => {
    const S = stateFromDocs({
      meta: { unit: 'kg' },
      lists: {
        routines: [{ id: 'r-1', name: 'First', ex: [] }, { id: 'r-1', name: 'Second', ex: [] }],
        exercises: [{ id: 'cx', n: 'FirstEx' }, { id: 'cx', n: 'SecondEx' }],
      },
    })
    expect(S.routines.map(r => r.name)).toEqual(['First', 'Second'])
    expect(S.customEx.map(e => e.n)).toEqual(['FirstEx', 'SecondEx'])
  })

  test('doc-id keyed maps (the Firestore reader shape) keep the #2 split doc', () => {
    const S = stateFromDocs({
      meta: { unit: 'kg' },
      lists: {
        workouts: new Map([
          ['2026-07-24|100', { d: '2026-07-24', start: 100, name: 'Morning', entries: [] }],
          ['2026-07-24|100#2', { d: '2026-07-24', start: 100, name: 'Evening', entries: [] }],
        ]),
      },
    })
    expect(S.workouts.map(w => w.name)).toEqual(['Morning', 'Evening'])
  })
})

describe('stateFromDocs: prototype-safe assembly (attack round 2, find 2)', () => {
  const lists = () => ({
    workouts: [{ id: 'w-1', d: '2026-07-24', start: 1, entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true }], note: 'real pinned', notePin: true }] }],
    routines: [{ id: 'r-1', name: 'One', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }],
    exercises: [], bodyweight: [], measurements: [],
  })

  test('a __proto__ key in meta cannot smuggle active, queue or exNotes in', () => {
    const meta = JSON.parse('{"unit":"kg","__proto__":{"pollutedGlobal":"YES","_fbUpdatedAt":424242,"active":{"editingWorkoutId":"w-1"},"queue":{"ids":["r-1"],"since":0,"label":"GHOST-QUEUE"},"exNotes":{"0025":"GHOST-NOTE"}}}')
    const S = stateFromDocs({ meta, lists: lists() })
    expect(Object.getPrototypeOf(S)).toBe(Object.prototype)
    expect('active' in S).toBe(false)
    expect(S._fbUpdatedAt).toBeUndefined()
    expect(S.queue).toBeUndefined()
    expect({}.pollutedGlobal).toBeUndefined()
    expect(Object.prototype.pollutedGlobal).toBeUndefined()
    // No ghost coach week from the smuggled queue, and note lookups behave
    // exactly as they do on the clean control state below.
    expect(handlerOf.get_week_plan(S, {}).coach_week).toBeNull()
    expect(exNoteFor(S, '0025')).toBeNull()
    expect(pinnedNoteFor(S, '0025')).toEqual({ note: 'real pinned', d: '2026-07-24' })
    const clean = stateFromDocs({ meta: { unit: 'kg' }, lists: lists() })
    expect(pinnedNoteFor(clean, '0025')).toEqual(pinnedNoteFor(S, '0025'))
  })

  test('constructor and prototype keys in meta are dropped, not stored', () => {
    const meta = JSON.parse('{"unit":"kg","constructor":{"prototype":{"polluted2":"YES"}},"prototype":{"polluted3":"YES"}}')
    const S = stateFromDocs({ meta, lists: lists() })
    expect(Object.hasOwn(S, 'constructor')).toBe(false)
    expect(Object.hasOwn(S, 'prototype')).toBe(false)
    expect({}.polluted2).toBeUndefined()
    expect({}.polluted3).toBeUndefined()
    expect(S.unit).toBe('kg')
  })
})

describe('stateFromDocs: wrong-typed internals are normalized (attack round 2, find 4)', () => {
  const baseLists = () => ({
    workouts: [{ id: 'w-1', d: '2026-07-24', start: 1, entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true }] }] }],
    routines: [{ id: 'r-1', name: 'One', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }],
    exercises: [], bodyweight: [{ d: '2026-07-27', w: 78 }], measurements: [],
  })
  const ALL_CALLS = [
    ['list_routines', {}], ['get_routine', { routine_id: 'r-1' }], ['preview_session', { routine_id: 'r-1' }],
    ['get_week_plan', {}], ['list_workouts', {}], ['get_workout', { workout_id: 'w-1' }],
    ['get_bodyweight', {}], ['estimate_1rm', {}], ['muscle_balance', { period: 'all' }],
  ]
  const poisons = {
    'workout entries is a string': l => { l.workouts[0].entries = 'nope' },
    'workout entries is a number': l => { l.workouts[0].entries = 42 },
    'workout entries holds null': l => { l.workouts[0].entries = [null] },
    'workout entry sets is a string': l => { l.workouts[0].entries = [{ id: '0025', sets: 'nope' }] },
    'workout entry sets holds null': l => { l.workouts[0].entries = [{ id: '0025', sets: [null] }] },
    'routine ex is a string': l => { l.routines[0].ex = 'nope' },
    'routine ex holds null': l => { l.routines[0].ex = [null] },
  }
  for (const [label, poison] of Object.entries(poisons)) {
    test(`every read tool still answers when ${label}`, () => {
      const lists = baseLists()
      poison(lists)
      const S = stateFromDocs({ meta: { unit: 'kg', targetW: 77 }, lists })
      for (const [name, args] of ALL_CALLS) {
        expect(() => handlerOf[name](S, args), name).not.toThrow()
      }
    })
  }

  test('the faults are repaired in place, the workout and routine themselves kept', () => {
    const lists = baseLists()
    lists.workouts[0].entries = [{ id: '0025', sets: [null, { w: 60, r: 8, done: true }] }, null, { id: '0739', sets: 'nope' }]
    lists.routines[0].ex = [null, { id: '0025', sets: 3, reps: 8, weight: 60 }]
    const S = stateFromDocs({ meta: { unit: 'kg' }, lists })
    expect(S.workouts).toHaveLength(1)
    expect(S.workouts[0].entries).toEqual([
      { id: '0025', sets: [{ w: 60, r: 8, done: true }] },
      { id: '0739', sets: [] },
    ])
    expect(S.routines).toHaveLength(1)
    expect(S.routines[0].ex).toEqual([{ id: '0025', sets: 3, reps: 8, weight: 60 }])
    const lists2 = baseLists()
    lists2.workouts[0].entries = 'nope'
    lists2.routines[0].ex = 'nope'
    const S2 = stateFromDocs({ meta: { unit: 'kg' }, lists: lists2 })
    expect(S2.workouts[0].entries).toEqual([])
    expect(S2.routines[0].ex).toEqual([])
  })

  test('well-formed data passes through byte-identical', () => {
    const lists = baseLists()
    const S = stateFromDocs({ meta: { unit: 'kg', targetW: 77 }, lists })
    expect(S.workouts).toEqual(lists.workouts)
    expect(S.routines).toEqual(lists.routines)
    expect(JSON.stringify(S.workouts)).toBe(JSON.stringify(lists.workouts))
    expect(JSON.stringify(S.routines)).toBe(JSON.stringify(lists.routines))
  })
})

describe('_seedStateForTests', () => {
  test('yields the seeded state, like upstream', async () => {
    const S = { unit: 'kg', routines: [] }
    expect(await _seedStateForTests(S).getState()).toBe(S)
  })
})
