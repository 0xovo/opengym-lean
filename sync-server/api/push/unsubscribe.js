// POST { endpoint } or { deviceId } -> { ok: true }
// Drops the caller's stored subscription: by endpoint (what the page sends
// when it unsubscribes the browser), else by device id.
import { send, body, pushHandler, requireUid, subDocId } from './_lib.js'

export default pushHandler(async (req, res) => {
  const ctx = await requireUid(req, res)
  if (!ctx) return
  const { endpoint, deviceId } = await body(req)
  const col = ctx.db.collection('pushSubs')
  if (typeof endpoint === 'string' && endpoint) {
    const snap = await col.where('uid', '==', ctx.uid).where('endpoint', '==', endpoint).get()
    await Promise.all(snap.docs.map(d => d.ref.delete()))
  } else if (deviceId) {
    await col.doc(subDocId(ctx.uid, deviceId, '')).delete()
  }
  return send(res, 200, { ok: true })
})
