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
