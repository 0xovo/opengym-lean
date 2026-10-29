// Shared plumbing for the /api/push/* Vercel functions (optional, sync mode only).
//
// Why these exist: the local rest alert (app/src/lib/rest-notify.js) can only
// fire while the app is alive. A rest that ends with the phone locked needs a
// real Web Push, booked ahead of time and delivered by something that can
// wake up on schedule. That scheduler is Upstash QStash (free tier): the
// rest-timer function books the end here and publishes a delayed QStash
// message for it; QStash calls /api/push/send at the end, and send does the
// actual Web Push. Nothing here runs unless the deployer sets the QStash and
// VAPID env vars (SETUP-SYNC.md, the QStash section); without them the local
// alert layer is the whole story, exactly as before.
//
// Auth: the client-facing functions take the caller's Firebase ID token (the
// passkey ceremony's session) and derive the uid from it via the passkey
// folder's bearerUid; a uid in a body is never trusted there. /api/push/send
// is the exception: QStash calls it, and its Upstash-Signature header,
// verified below, is the credential.
//
// Data (Firestore, Admin SDK only, same as the passkey collections):
//   pushSubs/{uid}_{deviceId}   { uid, deviceId, endpoint, subscription, updatedAt }
//   restJobs/{uid}_{deviceId}   { uid, deviceId, endsAt, bookedAt, messageId }
// A deviceId that does not match the client's shape keys the subscription by
// a hash of its endpoint instead, so a hand-set or stale id can never collide
// with another browser's row.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { admin, body, send, bearerUid, ORIGIN } from '../passkey/_lib.js'

export { admin, body, send, ORIGIN }

const DEVICE_ID_RULE = /^[A-Za-z0-9_-]{8,64}$/
export const validDeviceId = id => typeof id === 'string' && DEVICE_ID_RULE.test(id)

export const subDocId = (uid, deviceId, endpoint) =>
  uid + '_' + (validDeviceId(deviceId) ? deviceId : createHash('sha256').update(String(endpoint || '')).digest('hex').slice(0, 32))

export const jobDocId = (uid, deviceId) => uid + '_' + (validDeviceId(deviceId) ? deviceId : 'unknown')

/** Like the passkey folder's handler, with the allowed methods as a parameter. */
export function pushHandler(fn, methods = ['POST']) {
  return async (req, res) => {
    if (!methods.includes(req.method)) return send(res, 405, { error: methods.join(' or ') + ' only' })
    try { await fn(req, res) }
    catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: e.message || 'Server error' }) }
  }
}

/** Admin handles plus the caller's uid; answers 401 and returns null without one. */
export async function requireUid(req, res) {
  const { auth, db } = admin()
  const uid = await bearerUid(req, auth)
  if (!uid) { send(res, 401, { error: 'Sign in first' }); return null }
  return { auth, db, uid }
}

// ---- QStash: publishing, deleting, and delivery verification

const QSTASH_BASE = 'https://qstash.upstash.io/v2'
export const SEND_URL = ORIGIN + '/api/push/send'
export const qstashConfigured = () => !!process.env.QSTASH_TOKEN

/** Publishes a delayed message to /api/push/send. Returns the message id, or
 *  null when QStash is not configured yet or the publish failed; booking a
 *  rest must succeed either way, the local alert layer covers the rest. */
export async function qstashPublish(delaySeconds, payload) {
  if (!qstashConfigured()) return null
  try {
    const r = await fetch(QSTASH_BASE + '/publish/' + SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.QSTASH_TOKEN,
        'Content-Type': 'application/json',
        'Upstash-Delay': Math.max(1, Math.round(delaySeconds)) + 's',
      },
      body: JSON.stringify(payload),
    })
    if (!r.ok) { console.error('QStash publish failed', r.status); return null }
    const data = await r.json().catch(() => ({}))
    return data.messageId || null
  } catch (e) { console.error('QStash publish failed', e); return null }
}

/** Best-effort delete of a scheduled message (re-book, cancel). The stamp
 *  check in /api/push/send makes a missed delete harmless. */
export async function qstashDelete(messageId) {
  if (!qstashConfigured() || !messageId) return
  try { await fetch(QSTASH_BASE + '/messages/' + encodeURIComponent(messageId), { method: 'DELETE', headers: { Authorization: 'Bearer ' + process.env.QSTASH_TOKEN } }) }
  catch { /* best effort by design */ }
}

/** The push payload, shaped exactly what public/sw.js's push handler reads
 *  (title, body, tag) and mirroring upstream's rest copy, minus its emoji. */
export const restPushPayload = () => ({ title: 'Rest over', body: 'Time for your next set.', tag: 'rest-timer' })

const b64uDecode = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** Verifies an Upstash-Signature header the documented way: the header is an
 *  HS256 JWT signed with the current or next signing key; its claims must
 *  carry issuer Upstash, an expiry in the future, and a body claim holding
 *  the base64url SHA-256 of the exact request body bytes. Pure, so it is
 *  unit tested without QStash. Returns true only when everything matches. */
export function verifyQstashSignature({ signature, rawBody, url, currentKey, nextKey }) {
  if (!signature || typeof rawBody !== 'string') return false
  const parts = String(signature).split('.')
  if (parts.length !== 3) return false
  let claims
  try { claims = JSON.parse(b64uDecode(parts[1]).toString('utf8')) } catch { return false }
  if (claims.iss !== 'Upstash') return false
  if (url && claims.sub !== url) return false
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < now) return false
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return false
  const expectedBody = createHash('sha256').update(rawBody).digest('base64url')
  if (claims.body !== expectedBody) return false
  const signed = parts[0] + '.' + parts[1]
  const given = b64uDecode(parts[2])
  for (const key of [currentKey, nextKey]) {
    if (!key) continue
    const mac = createHmac('sha256', key).update(signed).digest()
    if (mac.length === given.length && timingSafeEqual(mac, given)) return true
  }
  return false
}
