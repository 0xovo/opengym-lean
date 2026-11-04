// In-memory Firestore fake for the agent connector tests and the MCP proof
// script: exactly the Admin SDK surface _agent.js and _lib.js's
// usernameOfUid use. Documents live in one Map keyed by full path
// ("users/<uid>/exercises/<docId>"), so subcollections, transactions and
// cross-user scoping all behave the way the real store's paths do.
// Deep clone that tolerates Admin SDK sentinel values (FieldValue
// .serverTimestamp() is a class instance): non-plain objects become a marker.
function clone(v) {
  if (Array.isArray(v)) return v.map(clone)
  if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return { _serverTimestamp: true }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
  }
  return v
}

export function fakeDb(seed = {}) {
  const store = new Map()
  for (const [path, data] of Object.entries(seed)) store.set(path, clone(data))

  const docSnap = (ref) => {
    const d = store.get(ref._path)
    return { exists: d !== undefined, id: ref.id, data: () => (d === undefined ? undefined : clone(d)) }
  }
  const collSnap = (path) => {
    const docs = []
    for (const [k, v] of store) {
      if (!k.startsWith(path + '/')) continue
      const rest = k.slice(path.length + 1)
      if (rest.includes('/')) continue
      docs.push({ id: rest, data: () => clone(v), ref: docRef(k) })
    }
    return { docs, empty: docs.length === 0, forEach: cb => docs.forEach(cb) }
  }
  const docRef = (path) => {
    const id = path.split('/').pop()
    const ref = {
      _path: path, id,
      async get() { return docSnap(ref) },
      async set(data) { store.set(path, clone(data)) },
      async update(data) { store.set(path, { ...(store.get(path) || {}), ...clone(data) }) },
      async delete() { store.delete(path) },
      collection(name) { return collRef(`${path}/${name}`) },
    }
    return ref
  }
  const query = (path, filters = [], limitN = null) => ({
    where(field, op, value) { return query(path, [...filters, [field, value]], limitN) },
    limit(n) { return query(path, filters, n) },
    async get() {
      const snap = collSnap(path)
      let docs = snap.docs.filter(d => filters.every(([f, v]) => d.data()[f] === v))
      if (limitN) docs = docs.slice(0, limitN)
      return { docs, empty: docs.length === 0, forEach: cb => docs.forEach(cb) }
    },
  })
  const collRef = (path) => ({
    _path: path,
    doc: id => docRef(`${path}/${String(id)}`),
    where: (field, op, value) => query(path, [[field, value]], null),
    async get() { return collSnap(path) },
  })

  return {
    _store: store,
    collection(name) { return collRef(name) },
    async runTransaction(fn) {
      const tx = {
        get: r => r.get(),
        set: (r, data) => { store.set(r._path, clone(data)) },
        update: (r, data) => { store.set(r._path, { ...(store.get(r._path) || {}), ...clone(data) }) },
        delete: r => { store.delete(r._path) },
      }
      await fn(tx)
    },
    batch() { throw new Error('fake has no batch; the agent module uses transactions') },
  }
}

export function fakeRes() {
  return {
    statusCode: null, body: null, headersSent: false,
    status(s) { this.statusCode = s; return this },
    json(o) { this.body = o; this.headersSent = true; return this },
    end() { this.headersSent = true; return this },
  }
}
