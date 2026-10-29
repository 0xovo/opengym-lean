// Preflight for the Option 2 build: fail fast with a plain message naming every
// missing env var, instead of shipping a broken deploy. vercel.json runs this first
// in its buildCommand. Where each value comes from: ../SETUP-SYNC.md, Part 1.
const REQUIRED = [
  ['FIREBASE_SERVICE_ACCOUNT', 'the service account JSON from your Firebase project, pasted as one value'],
  ['VITE_FB_API_KEY', 'apiKey from the firebaseConfig block of your web app'],
  ['VITE_FB_PROJECT_ID', 'projectId from the firebaseConfig block of your web app'],
  ['VITE_FB_APP_ID', 'appId from the firebaseConfig block of your web app'],
]
// Optional: the build works without these, but the named feature stays off.
// The rest timer push (locked phone) needs the whole set: the VAPID pair for
// /api/push/send, and the QStash token plus signing keys for the scheduling.
// See SETUP-SYNC.md, the QStash section.
const OPTIONAL = [
  ['VAPID_PUBLIC_KEY', 'rest timer push alerts (locked phone) stay off'],
  ['VAPID_PRIVATE_KEY', 'rest timer push alerts (locked phone) stay off'],
  ['QSTASH_TOKEN', 'rest timer pushes are booked but never scheduled'],
  ['QSTASH_CURRENT_SIGNING_KEY', '/api/push/send cannot verify QStash calls'],
  ['QSTASH_NEXT_SIGNING_KEY', '/api/push/send cannot verify QStash calls'],
]
for (const [name, hint] of OPTIONAL) {
  if (!String(process.env[name] || '').trim()) console.warn(`check-env: optional ${name} is not set: ${hint}.`)
}
const missing = REQUIRED.filter(([name]) => !String(process.env[name] || '').trim())
if (missing.length) {
  console.error('Cannot build the sync version: these environment variables are missing in the Vercel project:')
  for (const [name, hint] of missing) console.error(`  ${name}: ${hint}`)
  console.error('Add them under Project, Settings, Environment Variables (Production), then redeploy. Full guide: SETUP-SYNC.md.')
  process.exit(1)
}
console.log('check-env: all required environment variables are set.')
