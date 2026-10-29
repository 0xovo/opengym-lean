// POST { deviceId } -> { ok: true }
// Cancels a booked rest end (pause, skip, the timer finishing on screen): the
// job goes away and its QStash message is deleted best effort. A message
// that still lands finds no job, or a job whose stamp has moved on, and
// /api/push/send stays silent.
import { send, body, pushHandler, requireUid, jobDocId, validDeviceId, qstashDelete } from '../_lib.js'

export default pushHandler(async (req, res) => {
  const ctx = await requireUid(req, res)
  if (!ctx) return
  const { deviceId } = await body(req)
  if (!validDeviceId(deviceId)) return send(res, 400, { error: 'A device id is required' })
  const ref = ctx.db.collection('restJobs').doc(jobDocId(ctx.uid, deviceId))
  const snap = await ref.get()
  if (snap.exists) {
    await qstashDelete(snap.data().messageId)
    await ref.delete()
  }
  return send(res, 200, { ok: true })
})
