// @vitest-environment happy-dom
// This fork's demo opens empty: the seed is a clean slate, not a fabricated history. These
// tests pin that contract: every user-data list empty, every map empty, nothing active,
// and the state shaped exactly like the store defaults it overlays, so a first-time
// visitor gets the same starting point as a fresh install.
import { describe, it, expect } from 'vitest'
import { buildDemoState } from './demoSeed.js'
import { DEMO_SEEDED } from './demo.js'
import { DEF } from '../store/useStore.js'

const clone = o => JSON.parse(JSON.stringify(o))

const LIST_KEYS = [
  'routines', 'workouts', 'bodyweight', 'measurements', 'customMeasurements',
  'customEx', 'favEx', 'equipProfiles'
]
const MAP_KEYS = ['week', 'dayPlan', 'dayNotes', 'exWeights', 'exNotes']
const NULL_KEYS = ['active', 'queue', 'rotation', 'activeEquipId', 'targetW', 'effort']

describe('demo seed: the empty starting state', () => {
  it('carries no user data at all', () => {
    const S = buildDemoState()
    for (const k of LIST_KEYS) expect(S[k], k).toEqual([])
    for (const k of MAP_KEYS) expect(S[k], k).toEqual({})
    for (const k of NULL_KEYS) expect(S[k], k).toBeNull()
  })

  it('overlaid on the store defaults, reproduces a fresh install exactly', () => {
    const S = Object.assign(clone(DEF), buildDemoState())
    expect(S).toEqual(clone(DEF))
  })

  it('is fresh objects on every call, so one profile cannot leak into the next', () => {
    const a = buildDemoState()
    a.workouts.push({ id: 'x' })
    a.week[1] = 'y'
    const b = buildDemoState()
    expect(b.workouts).toEqual([])
    expect(b.week).toEqual({})
    expect(a).not.toBe(b)
  })

  it('seeds under the v2 key, so browsers holding the old fabricated profile reset', () => {
    expect(DEMO_SEEDED).toBe('gym_demo_seeded_v2')
  })
})
