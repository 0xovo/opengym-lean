// Tool-layer tests for the adapted tools (src/tools.js). Upstream's suite
// seeded from upstream's demo state; these tests seed a small hand-built
// state instead and pin the same behaviours: shapes, missing-entry errors,
// same-day ambiguity, future rows, custom-exercise resolution, and the
// no-state sentinel.
import { describe, test, expect } from 'vitest'
import { TOOLS, parseToolArgs, toolInputSchema } from '../src/tools.js'
import { exOr } from '../../../app/src/lib/exercises.js'

const byName = Object.fromEntries(TOOLS.map(t => [t.name, t.handler]))
const call = (S, name, params = {}) => byName[name](S, params)

function freshState() {
  return {
    unit: 'kg', restSec: 90, lang: 'en', targetW: 77,
    week: { 1: ['r-push'] }, dayPlan: {}, exWeights: {},
    routines: [
      { id: 'r-push', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }, { id: '0739', sets: 3, reps: 12, weight: 100 }] },
      { id: 'r-leg', name: 'Leg Day', ex: [{ id: '0739', sets: 4, reps: 10, weight: 120 }] },
    ],
    workouts: [
      { id: 'w-1', d: '2026-07-24', start: 1784900000000, name: 'Leg Day', routineId: 'r-leg', entries: [{ id: '0739', sets: [{ w: 152.5, r: 12, done: true }] }] },
    ],
    bodyweight: [{ d: '2026-07-20', w: 79 }, { d: '2026-07-27', w: 78.3 }],
    customEx: [{ id: 'cx-sled', n: 'Sled drag', bp: 'upper legs' }],
  }
}

describe('list_routines and get_routine', () => {
  test('lists routines with counts', () => {
    const r = call(freshState(), 'list_routines')
    expect(r.unit).toBe('kg')
    expect(r.routines.map(x => x.name).sort()).toEqual(['Leg Day', 'Push Day'])
    expect(r.routines.find(x => x.id === 'r-push').exercise_count).toBe(2)
  })

  test('get_routine returns the full exercise list by routine_id and by id alias', () => {
    const S = freshState()
    const a = call(S, 'get_routine', { routine_id: 'r-push' })
    expect(a.name).toBe('Push Day')
    expect(a.exercises.length).toBe(2)
    expect(a.exercises[0].summary).toMatch(/\d+\s*×\s*\d+/)
    expect(call(S, 'get_routine', { id: 'r-push' }).id).toBe('r-push')
  })

  test('get_routine throws ENOENT on a bogus id', () => {
    expect(() => call(freshState(), 'get_routine', { routine_id: 'bogus' })).toThrow(/no routine with id/)
  })

  test('get_routine with neither routine_id nor id is an error', () => {
    expect(() => call(freshState(), 'get_routine', {})).toThrow(/needs a routine_id/)
  })

  test('custom exercises resolve from state, not the catalogue', () => {
    const S = freshState()
    S.routines[0].ex.push({ id: 'cx-sled', sets: 3, reps: 20 })
    const r = call(S, 'get_routine', { routine_id: 'r-push' })
    expect(r.exercises.at(-1)).toMatchObject({ id: 'cx-sled', name: 'Sled drag', body_part: 'upper legs' })
  })
})

describe('list_workouts and get_workout', () => {
  test('summarises the newest workout with volume and sets', () => {
    const r = call(freshState(), 'list_workouts')
    expect(r.total_count).toBe(1)
    expect(r.workouts[0]).toMatchObject({ id: 'w-1', date: '2026-07-24', volume: 1830, sets_done: 1 })
  })

  test('future-dated workouts are not listed as recent', () => {
    const S = freshState()
    S.workouts.push({ id: 'w-future', d: '2999-01-01', entries: [] })
    const r = call(S, 'list_workouts')
    expect(r.workouts.map(w => w.id)).toEqual(['w-1'])
    expect(r.matching_count).toBe(1)
  })

  test('get_workout by id returns the set breakdown', () => {
    const r = call(freshState(), 'get_workout', { workout_id: 'w-1' })
    expect(r.date).toBe('2026-07-24')
    expect(r.entries[0].sets[0]).toMatchObject({ w: 152.5, r: 12 })
  })

  test('two workouts on one date answer ambiguous, not a guess', () => {
    const S = freshState()
    S.workouts.push({ id: 'w-2', d: '2026-07-24', entries: [] })
    const r = call(S, 'get_workout', { date: '2026-07-24' })
    expect(r.ambiguous).toBe(true)
    expect(r.workouts.map(w => w.id).sort()).toEqual(['w-1', 'w-2'])
  })

  test('get_workout with neither id nor date is an error', () => {
    expect(() => call(freshState(), 'get_workout', {})).toThrow(/needs either/)
  })
})

describe('get_bodyweight', () => {
  test('latest weigh-in carries its delta against the goal', () => {
    const r = call(freshState(), 'get_bodyweight')
    expect(r.goal).toBe(77)
    expect(r.count).toBe(2)
    expect(r.latest).toEqual({ date: '2026-07-27', weight: 78.3, delta_vs_goal: 1.3 })
  })
})

describe('estimate_1rm', () => {
  test('best estimate for the leg press matches the Epley reading', () => {
    const r = call(freshState(), 'estimate_1rm', { exercise_id: '0739' })
    expect(r.best).toMatchObject({ w: 152.5, r: 12, est: 213.5 })
  })

  test('an unknown exercise says so instead of claiming no records', () => {
    const r = call(freshState(), 'estimate_1rm', { exercise_id: 'nope-999' })
    expect(r.best).toBeNull()
    expect(r.exercise.unknown).toBe(true)
    expect(r.no_estimate_reason).toMatch(/No exercise with id/)
  })

  test('no exercise id returns a PR table', () => {
    const r = call(freshState(), 'estimate_1rm', {})
    expect(r.pr_table.length).toBe(1)
    expect(r.pr_table[0]).toMatchObject({ exId: '0739', est: 213.5 })
  })
})

describe('muscle_balance, get_week_plan, preview_session', () => {
  test('muscle_balance reports worked and neglected muscles', () => {
    const r = call(freshState(), 'muscle_balance', { period: 'all' })
    expect(r.workouts_in_period).toBe(1)
    expect(r.worked.length).toBeGreaterThan(0)
    expect(Array.isArray(r.neglected)).toBe(true)
  })

  test('get_week_plan covers seven weekdays', () => {
    const r = call(freshState(), 'get_week_plan')
    expect(r.weekdays.length).toBe(7)
    expect(r.days.length).toBe(7)
  })

  test('preview_session opens the routine with its exercises', () => {
    const r = call(freshState(), 'preview_session', { routine_id: 'r-push' })
    expect(r.routine_name).toBe('Push Day')
    expect(r.exercises.length).toBe(2)
    expect(r.exercises[0]).toHaveProperty('opening_sets')
  })
})

describe('no state and argument validation', () => {
  test('a null state answers the no-state sentinel, not a crash', () => {
    const r = call(null, 'list_routines')
    expect(r.error).toMatch(/no synced state yet/)
  })

  test('the zod boundary refuses a date the calendar does not have', () => {
    expect(() => parseToolArgs(TOOLS.find(t => t.name === 'get_bodyweight'), { from: '2026-02-30' })).toThrow(/not a date the calendar has/)
    expect(parseToolArgs(TOOLS.find(t => t.name === 'get_bodyweight'), { from: '2024-02-29' })).toEqual({ from: '2024-02-29' })
  })

  test('the zod boundary refuses an out-of-range limit', () => {
    expect(() => parseToolArgs(TOOLS.find(t => t.name === 'list_workouts'), { limit: 500 })).toThrow()
  })
})

describe('dual-name rule for get_routine (attack round 2, find 6)', () => {
  const getRoutineTool = TOOLS.find(t => t.name === 'get_routine')
  const viaBoundary = args => byName.get_routine(freshState(), parseToolArgs(getRoutineTool, args))

  test('both names supplied and agreeing works', () => {
    expect(viaBoundary({ routine_id: 'r-push', id: 'r-push' }).id).toBe('r-push')
  })

  test('both names supplied and disagreeing is a clean conflict error', () => {
    expect(() => viaBoundary({ routine_id: 'r-push', id: 'r-leg' })).toThrow(/conflicting routine_id .* and id/)
    expect(() => viaBoundary({ routine_id: 'r-leg', id: 'r-push' })).toThrow(/conflicting/)
  })

  test('an empty string on the unused name no longer fails the call', () => {
    expect(viaBoundary({ routine_id: '', id: 'r-push' }).id).toBe('r-push')
    expect(viaBoundary({ routine_id: 'r-push', id: '' }).id).toBe('r-push')
  })

  test('both names empty is still the needs-a-routine_id error, not a validation failure', () => {
    expect(() => viaBoundary({ routine_id: '', id: '' })).toThrow(/needs a routine_id/)
    expect(() => viaBoundary({})).toThrow(/needs a routine_id/)
  })
})

describe('reserved custom exercise ids never reach the shared index (attack round 2, find 3)', () => {
  test('a __proto__ custom exercise cannot poison EXIDX through preview_session', () => {
    const S = freshState()
    S.customEx = [JSON.parse('{"id":"__proto__","n":"Ghost Lift","bp":"chest","eq":"barbell","sm":["chest"] }')]
    S.routines[0].ex = [{ id: '__proto__', sets: 3, reps: 8, weight: 60 }]
    const p = call(S, 'preview_session', { routine_id: 'r-push' })
    expect(p.routine_name).toBe('Push Day')
    // No ghost values under unrelated keys, and the catalogue is intact.
    expect(exOr('n').missing).toBe(true)
    expect(exOr('bp').missing).toBe(true)
    expect(exOr('0025').n).toBe('barbell bench press')
    // A second, clean profile previewed in the same process is unaffected.
    const p2 = call(freshState(), 'preview_session', { routine_id: 'r-push' })
    expect(p2.exercises[0].name).toBe('barbell bench press')
    expect(exOr('n').missing).toBe(true)
  })

  test('dot and dunder custom ids are likewise kept out of the index', () => {
    for (const badId of ['.', '..', '__x__']) {
      const S = freshState()
      S.customEx = [{ id: badId, n: 'Ghost', bp: 'chest' }]
      S.routines[0].ex = [{ id: badId, sets: 1, reps: 1 }]
      expect(() => call(S, 'preview_session', { routine_id: 'r-push' })).not.toThrow()
      expect(exOr('n').missing).toBe(true)
    }
  })
})

describe('advertised schemas say what validation does (attack round 2, find 7)', () => {
  test('descriptions survive ZodOptional and ZodEffects wrappers', () => {
    const lw = toolInputSchema(TOOLS.find(t => t.name === 'list_workouts'))
    expect(lw.properties.from.description).toMatch(/Inclusive start date/)
    expect(lw.properties.limit.description).toMatch(/Max items/)
    const est = toolInputSchema(TOOLS.find(t => t.name === 'estimate_1rm'))
    expect(est.properties.formula.description).toMatch(/Formula to use/)
    expect(est.properties.exercise_id.description).toMatch(/exercise id/)
    const prev = toolInputSchema(TOOLS.find(t => t.name === 'preview_session'))
    expect(prev.properties.routine_id.description).toMatch(/Routine to preview/)
  })

  test('date fields keep the pattern and now say real calendar dates', () => {
    const bw = toolInputSchema(TOOLS.find(t => t.name === 'get_bodyweight'))
    for (const k of ['from', 'to']) {
      expect(bw.properties[k].pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$')
      expect(bw.properties[k].format).toBe('date')
      expect(bw.properties[k].description).toMatch(/real calendar date/)
    }
    const lw = toolInputSchema(TOOLS.find(t => t.name === 'list_workouts'))
    expect(lw.properties.from.description).toMatch(/Inclusive start date/)
    expect(lw.properties.from.description).toMatch(/real calendar date/)
  })
})
