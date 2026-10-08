/* Faux SDK Firestore, en mémoire, qui COMPTE les documents renvoyés (ce que
   Firestore facture). Substitué au module CDN `firebase-firestore.js` par
   l'alias de vitest.config.js — jamais utilisé hors tests.

   État partagé via globalThis.__fakeFirestore pour que le test y injecte des
   données et lise les compteurs. */

const state = (globalThis.__fakeFirestore ||= {
  store: {},                       // collection → documents
  counter: { docs: 0, queries: 0 },
});

export function collection(_db, name) { return { name }; }
export function where(field, op, value) { return { field, op, value }; }
export function query(col, ...constraints) { return { col, constraints }; }
export async function getDocs({ col, constraints }) {
  const rows = (state.store[col.name] || []).filter(r =>
    constraints.every(c => c.op === '==' && r[c.field] === c.value));
  state.counter.queries += 1;
  state.counter.docs += rows.length;
  return { docs: rows.map(r => ({ id: r.id, data: () => r })), size: rows.length, empty: !rows.length };
}

// doc()/getDoc()/setDoc()/deleteDoc() : lecture/écriture d'un document unique
// par id, utilisées par js/sessionCache.js. Même compteur que getDocs (un
// getDoc lu = un document facturé).
export function doc(_db, name, docId) { return { name, docId }; }
export async function getDoc({ name, docId }) {
  const rows = state.store[name] || [];
  const found = rows.find(r => r.id === docId);
  state.counter.queries += 1;
  if (found) state.counter.docs += 1;
  return { exists: () => !!found, id: docId, data: () => found };
}
export async function setDoc({ name, docId }, data) {
  state.store[name] = state.store[name] || [];
  const rows = state.store[name];
  const idx = rows.findIndex(r => r.id === docId);
  const row = { id: docId, ...data };
  if (idx >= 0) rows[idx] = row; else rows.push(row);
}
export async function deleteDoc({ name, docId }) {
  state.store[name] = (state.store[name] || []).filter(r => r.id !== docId);
}
