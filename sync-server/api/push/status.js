// GET ?endpoint=... or POST { endpoint } -> { subscribed, deviceId }
// What lib/push.js syncPushSubscription asks on boot and in Settings: does the
// server still hold this browser's subscription, and under which device id.
// deviceId answers null when the stored row has none.
import { send, body, pushHandler, requireUid } from './_lib.js'

export default pushHandler(async (req, res) => {
  const ctx = await requireUid(req, res)
  if (!ctx) return
  const endpoint = req.query?.endpoint || (await body(req)).endpoint
  if (typeof endpoint !== 'string' || !endpoint) return send(res, 400, { error: 'An endpoint is required' })
  const snap = await ctx.db.collection('pushSubs')
    .where('uid', '==', ctx.uid).where('endpoint', '==', endpoint).limit(1).get()
  if (snap.empty) return send(res, 200, { subscribed: false, deviceId: null })
  return send(res, 200, { subscribed: true, deviceId: snap.docs[0].data().deviceId ?? null })
}, ['GET', 'POST'])
