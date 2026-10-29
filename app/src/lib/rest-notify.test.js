// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://gym.test/" }
import { describe, it, expect, beforeEach } from 'vitest'
import {
  REST_NOTIFY_KEY, armRestAlertState, cancelRestAlertState, finishRestAlertState,
  restNotifyEnabled, setRestNotifyEnabled,
} from './rest-notify.js'

// The pure alert state behind the local rest notifications used when there is
// no server session:
// a rest arms one alert at its end, extensions move it, a skip cancels it, and
// the end is announced at most once however many ticks observe it.
describe('rest alert state', () => {
  it('arms on start at the rest end', () => {
    expect(armRestAlertState(null, 5000)).toEqual({ endsAt: 5000, alerted: false })
  })

  it('reschedules on extend: a moved end starts clean', () => {
    const armed = armRestAlertState(null, 5000)
    expect(armRestAlertState(armed, 20000)).toEqual({ endsAt: 20000, alerted: false })
  })

  it('re-arming the same end keeps the announced flag', () => {
    const done = finishRestAlertState(armRestAlertState(null, 5000), {}).state
    expect(armRestAlertState(done, 5000)).toEqual({ endsAt: 5000, alerted: true })
  })

  it('cancels on skip: nothing pending, nothing fires', () => {
    const cancelled = cancelRestAlertState(armRestAlertState(null, 5000))
    expect(cancelled).toBe(null)
    expect(finishRestAlertState(cancelled, { away: true, canNotify: true })).toEqual({ state: null, notify: false, tone: false })
  })

  it('an end watched live on screen announces with neither banner nor extra tone', () => {
    const out = finishRestAlertState(armRestAlertState(null, 5000), { away: false, hidden: false, canNotify: true })
    expect(out).toEqual({ state: { endsAt: 5000, alerted: true }, notify: false, tone: false })
  })

  it('an end while the page is hidden notifies when the user opted in', () => {
    const out = finishRestAlertState(armRestAlertState(null, 5000), { away: false, hidden: true, canNotify: true })
    expect(out.notify).toBe(true)
    expect(out.tone).toBe(false)
  })

  it('catch-up fires once: notification and tone when back, then never again', () => {
    const first = finishRestAlertState(armRestAlertState(null, 5000), { away: true, hidden: false, canNotify: true })
    expect(first.notify).toBe(true)
    expect(first.tone).toBe(true)
    const second = finishRestAlertState(first.state, { away: true, hidden: false, canNotify: true })
    expect(second).toEqual({ state: first.state, notify: false, tone: false })
  })

  it('catch-up tone still fires when notifications are off, banner does not', () => {
    const out = finishRestAlertState(armRestAlertState(null, 5000), { away: true, canNotify: false })
    expect(out.notify).toBe(false)
    expect(out.tone).toBe(true)
  })

  it('no state, no fire', () => {
    expect(finishRestAlertState(null, { away: true, canNotify: true }).notify).toBe(false)
  })
})

describe('rest notify switch storage', () => {
  beforeEach(() => localStorage.removeItem(REST_NOTIFY_KEY))

  it('is off until the user turns it on, and the choice sticks', () => {
    expect(restNotifyEnabled()).toBe(false)
    setRestNotifyEnabled(true)
    expect(localStorage.getItem(REST_NOTIFY_KEY)).toBe('1')
    expect(restNotifyEnabled()).toBe(true)
    setRestNotifyEnabled(false)
    expect(restNotifyEnabled()).toBe(false)
  })
})
