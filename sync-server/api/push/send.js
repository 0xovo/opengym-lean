// POST { uid, deviceId, endsAt } -> { ok: true, sent }
// The call QStash makes at a rest's end, and the only function here not
// called by the app. The Upstash-Signature header is its credential, checked
// against the signing keys before anything else happens.
//
// The endsAt in the body is the booking stamp: the push goes out only when
// the stored job still carries that exact end. A cancelled job is gone and a
// re-booked one has moved on, so a QStash message whose delete was missed
// lands here and stays silent. The job is deleted before the send: a rest
// alert is a moment, and a duplicate or a retried stale one is worse than a
// missed one.
import webpush from 'web-push'
import { admin, send, jobDocId, subDocId, restPushPayload, verifyQstashSignature, SEND_URL, ORIGIN } from './_lib.js'

// The exact bytes QStash signed. The runtime may have parsed a JSON body
// already, in which case the stream is empty and the object is re-stringified;
// the publish side builds that JSON itself, in a fixed key order, so the
// round trip reproduces the signed bytes.
async function rawBodyOf(req) {
  if (typeof req.body === 'string' && req.body) return req.body
  const chunks = []
  try { for await (const c of req) chunks.push(c) } catch { /* already consumed */ }
  if (chunks.length) return Buffer.concat(chunks).toString('utf8')
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body)
  return ''
}

export default async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  try {
    const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY
    const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY
    if (!currentKey && !nextKey) {
      return send(res, 500, { error: 'QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY env vars are not set on the Vercel project' })
    }
    const raw = await rawBodyOf(req)
    const ok = verifyQstashSignature({
      signature: req.headers?.['upstash-signature'],
      rawBody: raw,
      url: SEND_URL,
      currentKey, nextKey,
    })
    if (!ok) return send(res, 401, { error: 'Invalid Upstash-Signature' })
    let data = {}
    try { data = JSON.parse(raw) } catch { /* an unparseable body simply matches no job */ }
    const { uid, deviceId, endsAt } = data
    if (!uid || !deviceId) return send(res, 200, { ok: true, sent: false, reason: 'no-target' })

    const { db } = admin()
    const jobRef = db.collection('restJobs').doc(jobDocId(uid, deviceId))
    const job = await jobRef.get()
    if (!job.exists) return send(res, 200, { ok: true, sent: false, reason: 'no-job' })
    if (job.data().endsAt !== endsAt) return send(res, 200, { ok: true, sent: false, reason: 'stale' })
    await jobRef.delete()

    let subSnap = await db.collection('pushSubs')
      .where('uid', '==', uid).where('deviceId', '==', deviceId).limit(1).get()
    if (subSnap.empty) {
      const byId = await db.collection('pushSubs').doc(subDocId(uid, deviceId, '')).get()
      if (byId.exists) subSnap = { empty: false, docs: [byId] }
    }
    if (subSnap.empty) return send(res, 200, { ok: true, sent: false, reason: 'no-subscription' })
    const subDoc = subSnap.docs[0]

    const pub = process.env.VAPID_PUBLIC_KEY
    const priv = process.env.VAPID_PRIVATE_KEY
    if (!pub || !priv) return send(res, 500, { error: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars are not set on the Vercel project' })
    // The VAPID subject is a contact for the push services: the deployer's
    // own VAPID_SUBJECT (a mailto: address) when set, else the app origin.
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || ORIGIN, pub, priv)
    try {
      await webpush.sendNotification(subDoc.data().subscription, JSON.stringify(restPushPayload()))
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await subDoc.ref.delete()
        return send(res, 200, { ok: true, sent: false, reason: 'subscription-gone' })
      }
      console.error('Web Push send failed', e)
      return send(res, 200, { ok: true, sent: false, reason: 'push-failed' })
    }
    return send(res, 200, { ok: true, sent: true })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) return send(res, 500, { error: e.message || 'Server error' })
  }
}
