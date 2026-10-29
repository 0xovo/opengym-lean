// Unit tests for the pure parts of api/push/_lib.js: the QStash delivery
// signature check and the push payload shape. Run with: node --test tests/
// (from the sync-server folder, after npm install). No QStash, Firebase or
// network access is involved: signatures are minted here with the same
// documented HS256 scheme QStash uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { verifyQstashSignature, restPushPayload } from '../api/push/_lib.js'

const CURRENT = 'current-signing-key-for-tests'
const NEXT = 'next-signing-key-for-tests'
const URL = 'https://your-app.vercel.app/api/push/send'
const BODY = JSON.stringify({ uid: 'user-1', deviceId: 'device-1_ab', endsAt: 1893456000000 })

const b64u = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')

function sign(key, claims = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64u({ alg: 'HS256', typ: 'JWT' })
  const payload = b64u({
    iss: 'Upstash',
    sub: URL,
    exp: now + 300,
    nbf: now - 10,
    body: createHash('sha256').update(BODY).digest('base64url'),
    ...claims,
  })
  const sig = createHmac('sha256', key).update(header + '.' + payload).digest('base64url')
  return header + '.' + payload + '.' + sig
}

const verify = over => verifyQstashSignature({ signature: sign(CURRENT), rawBody: BODY, url: URL, currentKey: CURRENT, nextKey: NEXT, ...over })

test('accepts a signature from the current key', () => {
  assert.equal(verify({}), true)
})

test('accepts a signature from the next key', () => {
  assert.equal(verify({ signature: sign(NEXT) }), true)
})

test('rejects a signature from an unknown key', () => {
  assert.equal(verify({ signature: sign('some-other-key') }), false)
})

test('rejects an expired token', () => {
  const now = Math.floor(Date.now() / 1000)
  assert.equal(verify({ signature: sign(CURRENT, { exp: now - 5 }) }), false)
})

test('rejects a token whose body claim does not match the body', () => {
  assert.equal(verify({ rawBody: BODY + ' ' }), false)
})

test('rejects a token issued for a different destination', () => {
  assert.equal(verify({ signature: sign(CURRENT, { sub: 'https://your-app.vercel.app/api/push/other' }) }), false)
})

test('rejects a token from a different issuer', () => {
  assert.equal(verify({ signature: sign(CURRENT, { iss: 'NotUpstash' }) }), false)
})

test('rejects a missing or malformed signature', () => {
  assert.equal(verify({ signature: undefined }), false)
  assert.equal(verify({ signature: 'not-a-jwt' }), false)
})

test('the rest payload is exactly what the service worker reads', () => {
  assert.deepEqual(restPushPayload(), { title: 'Rest over', body: 'Time for your next set.', tag: 'rest-timer' })
})
