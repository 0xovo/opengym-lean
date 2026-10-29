// GET or POST -> { key }
// The VAPID public key the browser subscribes against. It is not a secret
// (every subscribed browser holds it), but it is only handed to a signed-in
// caller, same as upstream. The matching private key is a Vercel env var too,
// used only by /api/push/send when QStash calls it at a rest's end.
import { send, pushHandler, requireUid } from './_lib.js'

export default pushHandler(async (req, res) => {
  if (!await requireUid(req, res)) return
  const key = process.env.VAPID_PUBLIC_KEY
  if (!key) return send(res, 500, { error: 'VAPID_PUBLIC_KEY env var is not set on the Vercel project' })
  return send(res, 200, { key })
}, ['GET', 'POST'])
