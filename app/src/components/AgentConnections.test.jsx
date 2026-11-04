// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentConnections, { AgentConnectionsNote } from './AgentConnections.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Settings → Agent connections against a mocked firestore-sync module: the
   card lists what the server says the account has, creates a token with the
   picked scopes and shows the raw token exactly once with the MCP address
   and a client config, and revokes through the confirm sheet. Signed out it
   renders nothing; the local-only note is one plain line. */
const mocks = vi.hoisted(() => {
  const state = { user: null, tokens: [], sheets: [] }
  state.toast = vi.fn()
  state.fbAgentTokens = vi.fn(async op => {
    if (op === 'list') return { tokens: state.tokens }
    if (op === 'create') return { token: 'gym_agent_raw_once', id: 'tok-new', name: 'New', scopes: ['read'] }
    return { ok: true }
  })
  state.mod = {
    onFbAuthChange: fn => { fn({ user: state.user, ready: true }); return () => {} },
    fbAgentTokens: (...a) => state.fbAgentTokens(...a),
  }
  return state
})
vi.mock('../lib/firestore-sync.js', () => mocks.mod)
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: vi.fn() })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: opts => { mocks.sheets.push(opts) } }))

const user = { uid: 'u1', username: 'testuser', email: '', displayName: '', provider: '', providers: [] }
const tk = (id, extra = {}) => ({ id, name: 'Laptop agent', scopes: ['read', 'write'], createdAt: 1730000000000, lastUsedAt: null, ...extra })

let host, root
beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = null
  mocks.tokens = []
  mocks.sheets = []
  mocks.fbAgentTokens.mockImplementation(async op => {
    if (op === 'list') return { tokens: mocks.tokens }
    if (op === 'create') return { token: 'gym_agent_raw_once', id: 'tok-new', name: 'New', scopes: ['read'] }
    return { ok: true }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

async function render() {
  await act(async () => { root.render(<AgentConnections />) })
  await act(async () => {})
}
const btn = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const click = async el => { await act(async () => { el.click() }) }
const typeName = async name => {
  const input = host.querySelector('input')
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, name)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const codedError = msg => { const e = new Error(msg); e.code = 'auth/internal-error'; return e }

describe('AgentConnections', () => {
  it('renders nothing when signed out', async () => {
    mocks.user = null
    await render()
    expect(host.textContent).toBe('')
  })

  it('lists the account tokens with scopes and stamps, and the empty create form', async () => {
    mocks.user = user
    mocks.tokens = [tk('tok-1'), tk('tok-2', { name: 'Health reader', scopes: ['read'], lastUsedAt: 1740000000000 })]
    await render()
    expect(host.textContent).toContain('Agent connections')
    expect(host.textContent).toContain('Laptop agent')
    expect(host.textContent).toContain('Read, Write')
    expect(host.textContent).toContain('Never used')
    expect(host.textContent).toContain('Health reader')
    expect(host.textContent).toContain('Last used')
    expect(btn('Create token').disabled).toBe(true) // no name yet
  })

  it('creates a token with the picked scopes and shows the raw token once with the MCP address and config', async () => {
    mocks.user = user
    mocks.tokens = []
    await render()
    expect(host.textContent).toContain('No tokens yet')
    const input = host.querySelector('input')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(input, 'My laptop')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    // Turn Write on too (the second scope checkbox).
    const checks = [...host.querySelectorAll('[role="checkbox"]')]
    await click(checks[1])
    await click(btn('Create token'))
    const createCall = mocks.fbAgentTokens.mock.calls.find(c => c[0] === 'create')
    expect(createCall[1]).toEqual({ name: 'My laptop', scopes: ['read', 'write'] })
    expect(host.textContent).toContain('gym_agent_raw_once')
    expect(host.textContent).toContain('It will not be shown again')
    expect(host.textContent).toContain('/api/mcp')
    expect(host.textContent).toContain('mcpServers')
    expect(host.textContent).toContain('Bearer gym_agent_raw_once')
  })

  it('revokes through the confirm sheet, scoped to that token id', async () => {
    mocks.user = user
    mocks.tokens = [tk('tok-1')]
    await render()
    await click(btn('Revoke'))
    expect(mocks.sheets.length).toBe(1)
    expect(mocks.sheets[0].title).toBe('Revoke this token?')
    await act(async () => { await mocks.sheets[0].onConfirm() })
    const revokeCall = mocks.fbAgentTokens.mock.calls.find(c => c[0] === 'revoke')
    expect(revokeCall[1]).toEqual({ id: 'tok-1' })
  })

  it('shows the generic message, not the raw text, when a create error carries a code', async () => {
    mocks.user = user
    mocks.tokens = []
    await render()
    mocks.fbAgentTokens.mockImplementation(async op => {
      if (op === 'list') return { tokens: mocks.tokens }
      if (op === 'create') throw codedError('Firebase raw SDK text')
      return { ok: true }
    })
    await typeName('My laptop')
    await click(btn('Create token'))
    expect(mocks.toast).toHaveBeenCalledWith('Something went wrong')
    expect(mocks.toast).not.toHaveBeenCalledWith('Firebase raw SDK text')
  })

  it('shows a server error message when a create error has no code', async () => {
    mocks.user = user
    mocks.tokens = []
    await render()
    mocks.fbAgentTokens.mockImplementation(async op => {
      if (op === 'list') return { tokens: mocks.tokens }
      if (op === 'create') throw new Error('Server said no')
      return { ok: true }
    })
    await typeName('My laptop')
    await click(btn('Create token'))
    expect(mocks.toast).toHaveBeenCalledWith('Server said no')
  })

  it('shows the generic message when a revoke error carries a code', async () => {
    mocks.user = user
    mocks.tokens = [tk('tok-1')]
    await render()
    mocks.fbAgentTokens.mockImplementation(async op => {
      if (op === 'list') return { tokens: mocks.tokens }
      if (op === 'revoke') throw codedError('Firebase raw SDK text')
      return { ok: true }
    })
    await click(btn('Revoke'))
    await act(async () => { await mocks.sheets[0].onConfirm() })
    expect(mocks.toast).toHaveBeenCalledWith('Something went wrong')
    expect(mocks.toast).not.toHaveBeenCalledWith('Firebase raw SDK text')
  })
})

describe('AgentConnectionsNote (local-only)', () => {
  it('is one plain line about needing sync', async () => {
    await act(async () => { root.render(<AgentConnectionsNote />) })
    expect(host.textContent).toContain('Agent connections')
    expect(host.textContent).toContain('need cloud sync')
    expect(host.querySelectorAll('button').length).toBe(0)
    expect(host.querySelectorAll('input').length).toBe(0)
  })
})
