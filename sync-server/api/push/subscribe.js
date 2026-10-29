// POST { subscription, deviceId } -> { ok: true }
// Stores this browser's push subscription under the caller's uid and the
// browser's device id, so the sender can find exactly one subscription for a
// booked rest: the phone that started it, not every device on the account.
import { send, body, pushHandler, requireUid, subDocId, validDeviceId } from './_lib.js'

export default pushHandler(async (req, res) => {
  const ctx = await requireUid(req, res)
  if (!ctx) return
  const { subscription, deviceId } = await body(req)
  if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://')
    || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return send(res, 400, { error: 'A push subscription with an https endpoint and keys is required' })
  }
  await ctx.db.collection('pushSubs').doc(subDocId(ctx.uid, deviceId, subscription.endpoint)).set({
    uid: ctx.uid,
    deviceId: validDeviceId(deviceId) ? deviceId : null,
    endpoint: subscription.endpoint,
    subscription,
    updatedAt: Date.now(),
  })
  return send(res, 200, { ok: true })
})
