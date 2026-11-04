import { useCallback, useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { dateLocale } from '../lib/i18n-core.js'
import { copyText } from '../lib/clipboard.js'
import { confirmSheet } from '../sheets.jsx'
import { useFb } from './FirebaseAccount.jsx'
import { Button, Check } from './ui.jsx'

// Settings → Agent connections (Firebase mode): create a named token for your
// own AI agent, pick its scopes (read / write / delete as separate grants),
// see when it was last used, revoke it any time. Mounted next to the Sign-in
// methods card and renders nothing signed out.
//
// Where the state comes from: agent tokens live in an Admin-SDK-only
// collection (only their hashes are stored), so the list is read from the
// project's own /api/passkey/agent-tokens (the server derives the account
// from the verified ID token, through fbAgentTokens in lib/firestore-sync.js).
// The raw token comes back exactly once, at creation, and is shown here once
// with the MCP address and a ready client config; it is never stored on this
// device. In a local-only build the card cannot exist (the data lives in the
// browser and no outside agent can reach it), so Settings shows
// AgentConnectionsNote there instead: one plain line saying so.

// "Added 3 Sep": the year only when it is not this one (same shape as SignInMethods.jsx).
const when = ts => {
  if (!ts) return ''
  const d = new Date(ts)
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}
  try { return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', ...year }) } catch { return '' }
}

const rowStyle = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }
const scopeLabel = s => (s === 'read' ? t('Read') : s === 'write' ? t('Write') : t('Delete'))
// Errors with a Firebase-style code carry raw SDK text, so show the generic
// message for those; server errors have no code and keep their own message.
const errText = e => (e?.code ? t('Something went wrong') : e?.message || t('Something went wrong'))
const mcpUrl = () => {
  try { return new URL('/api/mcp', window.location.origin).href } catch { return '/api/mcp' }
}
const clientConfig = (url, token) => JSON.stringify({
  mcpServers: { 'opengym': { url, headers: { Authorization: `Bearer ${token}` } } },
}, null, 2)

export function AgentConnectionsNote() {
  return (
    <div className="card" style={{ padding: 16, marginBottom: 22 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('Agent connections')}</div>
      <div className="muted small">{t('Agent connections need cloud sync. Turn on sync and sign in to connect an agent.')}</div>
    </div>
  )
}

export default function AgentConnections() {
  const toast = useUI(s => s.toast)
  const { mod, auth } = useFb()
  const [tokens, setTokens] = useState(null) // server list; the raw token is never in it
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState({ read: true, write: false, delete: false })
  const [created, setCreated] = useState(null) // { token, name } once, right after creation

  const load = useCallback(async () => {
    if (!mod || !auth.user) return
    try { const out = await mod.fbAgentTokens('list'); setTokens(out.tokens || []); setLoadErr('') }
    catch (e) { setLoadErr(e?.message || t('Something went wrong')) }
  }, [mod, auth.user])

  useEffect(() => { load() }, [load])

  if (!mod || !auth.user) return null

  const chosen = ['read', 'write', 'delete'].filter(s => scopes[s])
  const copy = async text => { if (await copyText(text)) toast(t('Copied')) }

  const create = async () => {
    setBusy(true)
    try {
      const out = await mod.fbAgentTokens('create', { name: name.trim(), scopes: chosen })
      setCreated({ token: out.token, name: out.name })
      setName('')
      setScopes({ read: true, write: false, delete: false })
      toast(t('Token created'))
      load()
    } catch (e) { toast(errText(e)) }
    finally { setBusy(false) }
  }

  const revoke = tk => confirmSheet({
    title: t('Revoke this token?'),
    message: t('The agent using this token will lose access right away.'),
    confirmText: t('Revoke'),
    onConfirm: async () => {
      setBusy(true)
      try { await mod.fbAgentTokens('revoke', { id: tk.id }); toast(t('Token revoked')); load() }
      catch (e) { toast(errText(e)) }
      finally { setBusy(false) }
    },
  })

  const tokenMeta = tk => [
    (tk.scopes || []).map(scopeLabel).join(', '),
    tk.createdAt && t('Added {0}', when(tk.createdAt)),
    tk.lastUsedAt ? t('Last used {0}', when(tk.lastUsedAt)) : t('Never used'),
  ].filter(Boolean).join(' · ')
  const url = mcpUrl()

  return (
    <div className="card" style={{ padding: 16, marginBottom: 22 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('Agent connections')}</div>
      <div className="muted small" style={{ marginBottom: 6 }}>
        {t('Connect your own AI agent to this app over MCP. It can read and change your plan, workouts and weigh-ins, but only as far as each token allows.')}
      </div>
      {!tokens && !loadErr && <div className="muted small">{t('Loading…')}</div>}
      {!tokens && loadErr && <>
        <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>{loadErr}</div>
        <Button disabled={busy} onClick={load}>{t('Try again')}</Button>
      </>}
      {tokens && <>
        {tokens.length === 0 && !created && <div className="muted small" style={{ padding: '6px 0' }}>{t('No tokens yet. Create one to connect an agent.')}</div>}
        {tokens.map(tk => (
          <div key={tk.id} style={rowStyle}>
            <div className="grow">
              <div>{tk.name}</div>
              <div className="muted small">{tokenMeta(tk)}</div>
            </div>
            <Button variant="ghost" disabled={busy} onClick={() => revoke(tk)}>{t('Revoke')}</Button>
          </div>
        ))}
        {created && <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 4 }}>
          <div className="small" style={{ marginBottom: 8 }}>{t('Copy this token now. It will not be shown again.')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
            <code style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>{created.token}</code>
            <Button size="sm" onClick={() => copy(created.token)}>{t('Copy')}</Button>
          </div>
          <div className="muted small">{t('MCP address')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <code style={{ flex: 1, wordBreak: 'break-all', fontSize: 12 }}>{url}</code>
            <Button size="sm" onClick={() => copy(url)}>{t('Copy')}</Button>
          </div>
          <div className="muted small">{t('Client config')}</div>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, margin: '6px 0' }}>{clientConfig(url, created.token)}</pre>
          <Button size="sm" onClick={() => copy(clientConfig(url, created.token))}>{t('Copy')}</Button>
        </div>}
        <div style={{ borderTop: created ? 'none' : '1px solid var(--line)', paddingTop: 12, marginTop: 4 }}>
          <input className="input" placeholder={t('Token name')} maxLength={60} value={name}
            onChange={e => setName(e.target.value)} autoComplete="off" />
          <div className="muted small" style={{ margin: '10px 0 6px' }}>{t('Choose what this token can do')}</div>
          {['read', 'write', 'delete'].map(s => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
              <Check checked={!!scopes[s]} onChange={v => setScopes(p => ({ ...p, [s]: v }))} label={scopeLabel(s)} />
              <span>{scopeLabel(s)}</span>
            </div>
          ))}
          <div style={{ marginTop: 10 }}>
            <Button disabled={busy || !name.trim() || !chosen.length} onClick={create}>{t('Create token')}</Button>
          </div>
        </div>
      </>}
    </div>
  )
}
