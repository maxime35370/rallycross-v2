/* Stub minimal du SDK firebase-firestore, adossé à un instantané JSON des
   collections réelles (tools/qualification-audit/data/), servi par le serveur
   de test sous /__data/.

   N'implémente que la surface de LECTURE utilisée par l'application :
   collection / doc / query / where / orderBy / limit / getDocs / getDoc /
   onSnapshot. Les écritures sont volontairement inertes — un smoke test ne
   doit jamais modifier quoi que ce soit.

   Ne sert QUE tools/smoke/projectionSmoke.mjs. L'environnement de test n'a pas
   accès à gstatic.com : sans ce stub, aucune vue à données ne serait exerçable
   dans un vrai navigateur. */

const cache = new Map();

async function loadCollection(name) {
  if (!cache.has(name)) {
    const res = await fetch(`/__data/${name}.json`);
    cache.set(name, res.ok ? await res.json() : []);
  }
  return cache.get(name);
}

export function getFirestore() { return { __stub: true }; }
export function initializeFirestore() { return { __stub: true }; }
export function persistentLocalCache() { return {}; }
export function persistentMultipleTabManager() { return {}; }

export function collection(_db, name) { return { __type: 'collection', name }; }
export function doc(_db, name, id) {
  if (name && typeof name === 'object' && name.__type === 'collection') return { __type: 'doc', name: name.name, id };
  return { __type: 'doc', name, id };
}
export function where(field, op, value) { return { __type: 'where', field, op, value }; }
export function orderBy(field, dir = 'asc') { return { __type: 'orderBy', field, dir }; }
export function limit(n) { return { __type: 'limit', n }; }
export function query(col, ...constraints) { return { __type: 'query', col, constraints }; }

function matches(row, c) {
  const v = row[c.field];
  switch (c.op) {
    case '==':  return v === c.value;
    case '!=':  return v !== c.value;
    case '>':   return v > c.value;
    case '>=':  return v >= c.value;
    case '<':   return v < c.value;
    case '<=':  return v <= c.value;
    case 'in':  return Array.isArray(c.value) && c.value.includes(v);
    case 'array-contains': return Array.isArray(v) && v.includes(c.value);
    default:    return true;
  }
}

function snapshotOf(rows) {
  const docs = rows.map(r => ({ id: r.id, data: () => r, exists: () => true }));
  return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
}

export async function getDocs(target) {
  const isQuery = target?.__type === 'query';
  const col = isQuery ? target.col : target;
  let rows = [...await loadCollection(col.name)];
  if (isQuery) {
    for (const c of target.constraints) {
      if (c.__type === 'where') rows = rows.filter(r => matches(r, c));
    }
    for (const c of target.constraints) {
      if (c.__type === 'orderBy') {
        rows.sort((a, b) => (c.dir === 'desc' ? -1 : 1)
          * String(a[c.field]).localeCompare(String(b[c.field]), 'fr', { numeric: true }));
      }
    }
    const lim = target.constraints.find(c => c.__type === 'limit');
    if (lim) rows = rows.slice(0, lim.n);
  }
  return snapshotOf(rows);
}

export async function getDoc(ref) {
  const rows = await loadCollection(ref.name);
  const row = rows.find(r => r.id === ref.id);
  return { id: ref.id, exists: () => !!row, data: () => row };
}

export function onSnapshot(target, cb) {
  getDocs(target).then(snap => cb(snap)).catch(() => {});
  return () => {};
}

// Écritures inertes : un smoke test ne modifie rien.
const noop = async () => {};
export const setDoc = noop;
export const addDoc = async () => ({ id: 'stub' });
export const updateDoc = noop;
export const deleteDoc = noop;
export function writeBatch() { return { set: () => {}, delete: () => {}, update: () => {}, commit: noop }; }
export const serverTimestamp = () => new Date();
