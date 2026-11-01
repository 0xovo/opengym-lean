// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))

import { DEF, useStore, restoredStateFor, dropRemovedFields } from './useStore.js'
import { joinDocs, splitState } from '../lib/firestore-model.js'
import { mergeStates } from '../lib/sync-merge.js'

const clone = value => JSON.parse(JSON.stringify(value))

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

afterEach(() => {
  localStorage.clear()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

// The gym check-in feature is gone, and with it its three state fields: gymCards,
// lastGymCardId, checkIn. A profile saved by an older build still carries them — in this
// device's storage, in a pulled account copy, in a Firestore meta doc, in an imported
// backup. These pin the removal contract: the fields load as absent everywhere a foreign
// state becomes the live one, real data alongside them survives, and no sync path can
// resurrect them.
const OLD_FIELDS = ['gymCards', 'lastGymCardId', 'checkIn']
const oldState = () => Object.assign(clone(DEF), {
  unit: 'lb',
  gymCards: [{ id: 'c1', label: 'FitZone', value: 'ABC123', fmt: 'qrcode' }],
  lastGymCardId: 'c1',
  checkIn: false,
})
const expectGone = S => { for (const k of OLD_FIELDS) expect(S, k).not.toHaveProperty(k) }

describe('removed gym-card fields', () => {
  it('are absent from a fresh profile', () => {
    expectGone(useStore.getState().S)
    expectGone(DEF)
  })

  it('dropRemovedFields strips exactly the three keys', () => {
    const s = oldState()
    dropRemovedFields(s)
    expectGone(s)
    expect(s.unit).toBe('lb')
    expect(dropRemovedFields(null)).toBe(null)
  })

  it('a restored account copy carrying them loads without them', () => {
    const next = restoredStateFor(clone(DEF), oldState())
    expectGone(next)
    expect(next.unit).toBe('lb')
  })

  it('replacing the state with an old backup drops them, in memory and on disk', () => {
    useStore.getState().replaceState(oldState(), false)
    expectGone(useStore.getState().S)
    expect(useStore.getState().S.unit).toBe('lb')
    const saved = JSON.parse(localStorage.getItem('gym_state_v1'))
    expectGone(saved)
  })

  it('a Firestore meta doc carrying them joins without them', () => {
    const { meta, lists } = splitState(oldState())
    // splitState files the card list as its own doc and keeps the scalars in meta; both
    // halves of an old cloud copy are covered by the join.
    const S = joinDocs({ meta, lists })
    expectGone(S)
    expect(S.unit).toBe('lb')
  })

  it('a pull-merge against an old cloud copy does not resurrect them', () => {
    const local = clone(DEF)
    const remote = restoredStateFor(local, oldState())
    const merged = mergeStates(local, remote, { prefer: 'a' })
    expectGone(merged)
  })
})
