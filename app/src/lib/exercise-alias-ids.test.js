/* The id of a drawing that is no exercise of its own (the female figure of a male exercise,
   EXALIAS) looks up the exercise it draws, and a plan file or an import may carry one.
   On the way in it becomes the exercise's own id, so the app goes on storing exercise ids only;
   ids already in state are never rewritten. */
import { afterEach, describe, expect, it } from 'vitest'
import { EXALIAS } from './exercises-data.js'
import { EXIDX, canonicalExId } from './exercises.js'
import { mergePlan, parsePlan } from './plan-share.js'
import { HEVY_ID_MAP, parseHevyWorkouts } from './import-hevy.js'

const [ALIAS, TO] = Object.entries(EXALIAS).find(([id, to]) => EXIDX[to] && !Object.keys(EXIDX).includes(id))
const state = () => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {}, dayPlan: {}, week: {},
  routines: [{ id: 'r1', name: 'Old', ex: [{ id: ALIAS, sets: 3, reps: 10, mode: 'reps' }, { id: '0001', sets: 3, reps: 10, mode: 'reps' }] }],
})
const plan = ex => JSON.stringify({ opengym_plan: 1, unit: 'kg', routines: [{ id: 'p1', name: 'Shared', ex }], customEx: [] })

describe('canonicalExId', () => {
  it('turns a drawing id into its exercise and leaves everything else alone', () => {
    expect(EXIDX[ALIAS]).toBe(EXIDX[TO])
    expect(canonicalExId(ALIAS)).toBe(TO)
    expect(canonicalExId(TO)).toBe(TO)
    expect(canonicalExId('k3x9custom')).toBe('k3x9custom')
    expect(canonicalExId(undefined)).toBe(undefined)
    expect(canonicalExId('constructor')).toBe('constructor')
  })
})

describe('a drawing id on its way in', () => {
  it('a plan file: parsed and merged as the exercise, the routines already there untouched', () => {
    const s = state()
    const bundle = parsePlan(plan([{ id: ALIAS, sets: 3, reps: 8, mode: 'reps' }]))
    expect(bundle.routines[0].ex[0].id).toBe(TO)
    mergePlan(s, { ...bundle, routines: [{ ...bundle.routines[0], ex: [{ id: ALIAS, sets: 3 }] }] })
    expect(s.routines[1].ex[0].id).toBe(TO)
    expect(s.routines[0].ex[0].id).toBe(ALIAS)
  })

  it('a plan file whose own custom exercise happens to carry such an id keeps it as a custom one', () => {
    const raw = JSON.stringify({ opengym_plan: 1, unit: 'kg', routines: [{ id: 'p1', name: 'Shared', ex: [{ id: ALIAS, sets: 3 }] }], customEx: [{ id: ALIAS, n: 'my thing', bp: 'chest' }] })
    const bundle = parsePlan(raw)
    expect(bundle.routines[0].ex[0].id).toBe(ALIAS)
    const s = state()
    mergePlan(s, bundle)
    const added = s.routines[1].ex[0].id
    expect(s.customEx.map(c => c.id)).toEqual([added])
  })

  describe('an import', () => {
    afterEach(() => { delete HEVY_ID_MAP.TESTALIAS })
    it('a Hevy template pinned to a drawing id lands on the exercise', () => {
      HEVY_ID_MAP.TESTALIAS = ALIAS
      const parsed = parseHevyWorkouts([{
        id: 'w', title: 'W', start_time: '2026-09-01T10:00:00+00:00', end_time: '2026-09-01T11:00:00+00:00',
        exercises: [{ title: 'x', exercise_template_id: 'TESTALIAS', sets: [{ type: 'normal', weight_kg: 40, reps: 8 }] }],
      }], [])
      expect(parsed.workouts[0].entries[0].id).toBe(TO)
    })
  })
})
