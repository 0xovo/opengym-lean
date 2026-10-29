// POST { seconds, deviceId } -> { ok: true, endsAt, scheduled }
// Books the end of a rest: one job per account and device in restJobs,
// overwritten by every re-book (extend, resume), plus a delayed QStash
// message that will call /api/push/send at the end. A re-book deletes the
// previous message first; if a delete is ever missed, the endsAt stamp the
// message carries no longer matches the job, and send stays silent.
// Until the deployer sets QSTASH_TOKEN the job is still written and the
// answer is still ok with scheduled: false; the local alert layer covers
// the rest either way.
import { send, body, pushHandler, requireUid, jobDocId, validDeviceId, qstashPublish, qstashDelete, qstashConfigured } from './_lib.js'

const MAX_SECONDS = 3600

export default pushHandler(async (req, res) => {
  const ctx = await requireUid(req, res)
  if (!ctx) return
  const { seconds, deviceId } = await body(req)
  if (!validDeviceId(deviceId)) return send(res, 400, { error: 'A device id is required' })
  const sec = Number(seconds)
  if (!Number.isFinite(sec) || sec <= 0) return send(res, 400, { error: 'Seconds must be a positive number' })
  const delay = Math.min(MAX_SECONDS, Math.max(1, Math.round(sec)))
  const endsAt = Date.now() + delay * 1000
  const ref = ctx.db.collection('restJobs').doc(jobDocId(ctx.uid, deviceId))
  const prev = await ref.get()
  if (prev.exists && prev.data().messageId) await qstashDelete(prev.data().messageId)
  const messageId = await qstashPublish(delay, { uid: ctx.uid, deviceId, endsAt })
  await ref.set({ uid: ctx.uid, deviceId, endsAt, bookedAt: Date.now(), messageId })
  return send(res, 200, { ok: true, endsAt, scheduled: qstashConfigured() && !!messageId })
})
