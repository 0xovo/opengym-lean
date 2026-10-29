// Rest-over notifications for running with no push server (local mode, and
// the bring your own sync mode this fork adds).
//
// Upstream's web rest alert is Web Push: the page books the end with the server
// (store/useUI.js pushRestTimer) and the server sends a push when the rest runs
// out. With no server session there is nobody to book with, so that path can
// never fire. What a web app can do on its own is covered by this
// module: show a system notification through the service worker registration
// when a rest ends while the app is open or still alive, and catch up the
// moment the app comes back if the end passed while it was away.
//
// The honest limit, iOS especially: a web app cannot fire at an exact time
// while the system has it fully suspended. That case needs a server sending a
// push, which is a separate piece and is not promised anywhere in the UI.
//
// The decision logic is pure (arm / finish / cancel over a small state) so it
// is unit tested without a browser. The platform calls sit under it and every
// one of them is wrapped: a missing API must never break the timer itself.

export const REST_NOTIFY_KEY = 'gym_rest_notify'
export const REST_NOTIFY_TAG = 'rest-timer'

// The Settings switch is the one place these are turned on (same discipline as
// upstream's push switch): the choice is the user's, kept on this device.
export function restNotifyEnabled() {
  try { return localStorage.getItem(REST_NOTIFY_KEY) === '1' } catch { return false }
}
export function setRestNotifyEnabled(v) {
  try { localStorage.setItem(REST_NOTIFY_KEY, v ? '1' : '0') } catch { /* private mode: the switch just does not stick */ }
}

// ---- the pure alert state: one rest, armed at its end, announced at most once
// Arm at a rest's end. Re-arming with the same end (a resume recomputing it)
// keeps the announced flag; a moved end is a new schedule and starts clean.
export const armRestAlertState = (state, endsAt) =>
  state && state.endsAt === endsAt ? state : { endsAt, alerted: false }

// Skip, dismiss, pause, a rest replacing this one: nothing is pending anymore.
export const cancelRestAlertState = () => null

// The rest reached its end; decide what announces it, exactly once.
//   notify: a system notification, when the user opted in, permission is
//     granted, and the end was not watched live on screen (away the whole
//     time, or the page hidden at the end). On screen the tone is the alert.
//   tone: the end tone again on return, when the end passed while away and
//     nothing could announce it at the time.
export function finishRestAlertState(state, { away = false, hidden = false, canNotify = false } = {}) {
  if (!state || state.alerted) return { state, notify: false, tone: false }
  return {
    state: { ...state, alerted: true },
    notify: !!(canNotify && (away || hidden)),
    tone: !!away,
  }
}

// ---- platform: the notification itself, through the service worker
// Same tag the server's push uses, so a banner from either path replaces the
// other instead of stacking.
export async function showRestDoneNotification(title) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.()
    const opts = { tag: REST_NOTIFY_TAG, icon: 'icon-512.png' }
    if (reg?.showNotification) { await reg.showNotification(title, opts); return true }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') { new Notification(title, opts); return true }
  } catch { /* notification APIs vary by browser and policy; stay quiet */ }
  return false
}

export async function closeRestDoneNotification() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.()
    const list = await reg?.getNotifications?.({ tag: REST_NOTIFY_TAG })
    list?.forEach(n => n.close())
  } catch { /* nothing to close, or no API to close it with */ }
}

// ---- platform: keep the screen on for the length of a rest
// A sentinel of this module's own, on purpose: lib/wakelock.js holds the
// workout-wide lock, and releasing that one at a rest's end would drop the
// screen lock for the rest of the workout. Two requests can be held at once;
// the screen stays on while any of them lives, and this one is let go at the
// rest's end, pause or skip. The browser drops it on its own when the page
// hides, so wanting it is kept as intent and re-acquired on return, the same
// shape lib/wakelock.js uses.
let wlSentinel = null
let wlWanted = false
let wlPending = false

const wlSupported = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator

async function wlAcquire() {
  if (!wlWanted || wlSentinel || wlPending || !wlSupported()) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  wlPending = true
  try {
    const s = await navigator.wakeLock.request('screen')
    if (!wlWanted) { s.release().catch(() => {}); return }
    wlSentinel = s
    s.addEventListener('release', () => { if (wlSentinel === s) wlSentinel = null })
  } catch { wlSentinel = null } finally { wlPending = false }
}

const wlOnVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') wlAcquire() }

export function restWakeLockOn() {
  if (wlWanted) return
  wlWanted = true
  try { document.addEventListener('visibilitychange', wlOnVisible) } catch { /* no document: nothing to hold */ }
  wlAcquire()
}

export function restWakeLockOff() {
  wlWanted = false
  try { document.removeEventListener('visibilitychange', wlOnVisible) } catch { /* as above */ }
  const s = wlSentinel
  wlSentinel = null
  if (s) s.release().catch(() => {})
}
