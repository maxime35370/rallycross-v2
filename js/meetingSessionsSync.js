/* ═══════════════════════════════════════════════
   MEETINGSESSIONSSYNC.JS — Sessions attendues d'un meeting, et plan de
   synchronisation quand on le modifie.

   Module PUR (ni Firebase, ni DOM), comme calc.js : meetings.js lui passe
   les sessions existantes et en reçoit un plan { toCreate, toDelete,
   toReorder } qu'il applique dans un batch Firestore.

   Motivation : à la création d'un meeting, les sessions sont générées
   d'après le nombre de manches qualificatives et les catégories choisis.
   Mais à la MODIFICATION, seul le document meeting était mis à jour : un
   meeting passé de 4 à 3 MQ affichait toujours « 3 MQ » dans la liste des
   meetings et… 4 manches dans l'onglet Sessions. Même chose pour une
   catégorie ajoutée ou retirée après coup.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// SESSIONS ATTENDUES (d'après le règlement + le meeting)
// ─────────────────────────────────────────────────────────

/**
 * Gabarits de sessions d'un meeting, dans l'ordre de déroulement.
 * Reproduit la génération historique de meetings.js : EC si activés,
 * nbMQ manches, QF si activés, DF, finale.
 *
 * @param {object} [sessionConfig] — regulation.sessionConfig du championnat
 * @param {number} [nbMQ]          — nombre de MQ du meeting (défaut : règlement, sinon 4)
 * @returns {Array<{ type, label, tours, order, num }>}
 */
export function buildSessionTemplates(sessionConfig, nbMQ) {
  const sc = sessionConfig || {};
  const templates = [];
  let order = 0;

  if (sc.EC?.enabled !== false) {
    templates.push({ type: 'EC', label: 'Essais chronométrés', tours: sc.EC?.laps || 1, order: order++, num: null });
  }

  const mq = nbMQ || sc.MQ?.count || 4;
  for (let i = 1; i <= mq; i++) {
    templates.push({ type: 'MQ', label: 'Manche qualificative ' + i, tours: sc.MQ?.laps || 4, order: order++, num: i });
  }

  if (sc.QF?.enabled) {
    const nbQF = sc.QF?.count || 4;
    for (let i = 1; i <= nbQF; i++) {
      templates.push({ type: 'QF', label: 'Quart de finale ' + i, tours: sc.QF?.laps || 4, order: order++, num: i });
    }
  }

  const nbDF = sc.DF?.count || 2;
  for (let i = 1; i <= nbDF; i++) {
    templates.push({ type: 'DF', label: 'Demi-finale ' + i, tours: sc.DF?.laps || 6, order: order++, num: i });
  }

  templates.push({ type: 'FIN', label: 'Finale', tours: sc.FIN?.laps || 7, order: order++, num: null });
  return templates;
}

// ─────────────────────────────────────────────────────────
// PLAN DE SYNCHRONISATION
// ─────────────────────────────────────────────────────────

/** Clé d'identité d'une session dans un meeting : catégorie + type + numéro. */
export function sessionKey(category, type, num) {
  return `${category}|${type}|${num ?? ''}`;
}

/**
 * Compare les sessions existantes d'un meeting à ce qu'il devrait avoir.
 *
 * Volontairement prudent : on ne touche qu'à ce que l'utilisateur a
 * changé dans le formulaire du meeting (nombre de MQ, catégories).
 *   • MQ dont le numéro dépasse le nouveau nbMQ  → supprimées
 *   • catégorie retirée du meeting               → toutes ses sessions supprimées
 *   • catégorie ajoutée                          → jeu complet de sessions créé
 *   • MQ manquante (nbMQ augmenté)               → créée
 *   • ordre de déroulement des sessions gardées  → réaligné sur les gabarits
 *     (une MQ ajoutée doit passer AVANT les quarts / demi-finales)
 * Les autres écarts (un QF présent alors que le règlement ne l'active
 * plus, par exemple) relèvent du règlement, pas de ce formulaire : ils
 * sont laissés tels quels.
 *
 * @param {object} p
 * @param {Array}  p.existing   — sessions Firestore du meeting
 *        [{ id, category, type, num, order }]
 * @param {Array}  p.templates  — sortie de buildSessionTemplates()
 * @param {string[]} p.categories — catégories du meeting après modification
 * @returns {{ toCreate: Array<{ category, tpl }>, toDelete: Array, toReorder: Array<{ id, order }> }}
 */
export function planSessionSync({ existing = [], templates = [], categories = [] }) {
  const cats  = new Set(categories);
  const nbMQ  = templates.filter(t => t.type === 'MQ').reduce((m, t) => Math.max(m, t.num), 0);
  const tplByKey = {};
  templates.forEach(t => { tplByKey[`${t.type}|${t.num ?? ''}`] = t; });

  const toDelete = [];
  const kept     = [];
  existing.forEach(s => {
    const gone = !cats.has(s.category) || (s.type === 'MQ' && Number(s.num) > nbMQ);
    (gone ? toDelete : kept).push(s);
  });

  const keptKeys = new Set(kept.map(s => sessionKey(s.category, s.type, s.num)));
  const existingCats = new Set(existing.map(s => s.category));

  const toCreate = [];
  categories.forEach(category => {
    const isNewCategory = !existingCats.has(category);
    templates.forEach(tpl => {
      if (keptKeys.has(sessionKey(category, tpl.type, tpl.num))) return;
      // Catégorie déjà présente : on ne complète que les MQ (nbMQ augmenté).
      if (!isNewCategory && tpl.type !== 'MQ') return;
      toCreate.push({ category, tpl });
    });
  });

  const toReorder = [];
  kept.forEach(s => {
    const tpl = tplByKey[`${s.type}|${s.num ?? ''}`];
    if (tpl && Number(s.order) !== tpl.order) toReorder.push({ id: s.id, order: tpl.order });
  });

  return { toCreate, toDelete, toReorder };
}

/**
 * Phrase de confirmation quand des sessions à supprimer contiennent des
 * données (participants assignés ou temps saisis). Retourne null si rien
 * ne sera perdu : pas besoin de déranger l'utilisateur.
 *
 * @param {Array<{ label, category, participants, results }>} rows
 * @returns {string|null}
 */
export function describeSessionDataLoss(rows = []) {
  const loaded = rows.filter(r => (r.participants || 0) > 0 || (r.results || 0) > 0);
  if (!loaded.length) return null;
  const lines = loaded.map(r => {
    const bits = [];
    if (r.participants) bits.push(`${r.participants} pilote${r.participants > 1 ? 's' : ''}`);
    if (r.results)      bits.push(`${r.results} temps`);
    return `• ${r.label} (${r.category}) : ${bits.join(', ')}`;
  });
  return `Les sessions suivantes vont être supprimées avec leurs données :\n\n${lines.join('\n')}\n\nContinuer ?`;
}
