import { admin, body, send, handler, bearerUid } from './_lib.js'
import { listSignInMethods, linkOptions, linkVerify, removePasskey } from './_methods.js'
import { mcpHandler, agentTokensAction } from '../_agent.js'

// Single Vercel function for the four Sign-in methods endpoints:
//   POST /api/passkey/list         → the caller's methods (Settings reads state here)
//   POST /api/passkey/link-options → start the add-a-passkey link ceremony
//   POST /api/passkey/link-verify  → finish it (binds to the caller's existing uid)
//   POST /api/passkey/remove       → delete one of the caller's passkey credentials
//
// These were four separate files (list.js, link-options.js, link-verify.js,
// remove.js) until the Hobby plan's 12-function cap rejected the deployment at 15
// functions; folding them behind this dynamic route keeps every URL and payload
// identical at one function. Static sibling files (login-*, register-*) still win
// their own paths; only the four actions below land here. The cores live in
// _methods.js and take the uid from the verified ID token, as before: nothing in
// the body can name another account.
const ROUTES = {
  list: ({ uid, db, auth }) => listSignInMethods({ uid, db, auth }),
  'link-options': async ({ uid, req, db }) => linkOptions({ uid, reqBody: await body(req), db }),
  'link-verify': async ({ uid, req, db }) => linkVerify({ uid, reqBody: await body(req), db }),
  remove: async ({ uid, req, db, auth }) => removePasskey({ uid, reqBody: await body(req), db, auth }),
  // Agent connections (Settings card): list / create / revoke the caller's own
  // MCP agent tokens. Same door as the methods above (uid from the verified ID
  // token); the cores live in ../_agent.js. The body carries { op, ... }.
  'agent-tokens': async ({ uid, req, db }) => agentTokensAction({ uid, reqBody: await body(req), db }),
}

const methodsHandler = handler(async (req, res) => {
  const route = ROUTES[req.query?.action]
  if (!route) return send(res, 404, { error: 'Not found' })
  const { auth, db } = admin()
  const uid = await bearerUid(req, auth)
  if (!uid) return send(res, 401, { error: 'Sign in first' })
  const { status, payload } = await route({ uid, req, db, auth })
  return send(res, status, payload)
})

// /api/mcp arrives here through the vercel.json rewrite to /api/passkey/mcp:
// the agent connector (../_agent.js) is gated on its own per-user agent tokens,
// not on a Firebase ID token, so it bypasses the POST-only methods wrapper
// above; every other action, known or not, keeps the exact behavior it had
// (unknown actions still 404 inside).
export default async (req, res) => {
  if (req.query?.action === 'mcp') return mcpHandler(req, res)
  return methodsHandler(req, res)
}
