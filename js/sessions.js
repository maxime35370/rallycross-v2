/* ═══════════════════════════════════════════════
   SESSIONS.JS — Assignation des pilotes aux sessions
   EC/MQ : auto + retrait manuel
   DF1/DF2 : répartition alternée depuis classement intermédiaire
   Finale : top 4 de chaque DF + remplaçant si forfait
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml, sessionParticipantId } from './utils.js';
import { getChampionshipConfig } from './settings.js';
import { calcInterimStandings } from './calc.js';
import { distributeIntoQF, getReserves } from './competition.js';
import { getActiveChampionship, getActiveChampionshipId } from './context.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings         = [];
let allSessions         = [];
let engagedDrivers      = [];
let sessionParticipants = {};
let unsubMeetings       = null;
let _activeRegulation   = null;
let unsubSessions       = null;
let unsubEngaged        = null;
let unsubParticipants   = {};

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let selectedSessionId = '';

let _dfStandings  = []; // classement complet pour handleForfait DF
let _dfForfaits   = new Set(); // forfaits DF — exclus des remplaçants DF
let _finForfaits  = new Set(); // forfaits Finale — exclus des remplaçants Finale
let _qfForfaits   = new Set(); // forfaits QF — exclus des remplaçants QF

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];
const SESSION_LABELS = { EC: 'Essais', MQ: 'Qualif.', QF: '¼ Finale', DF: '½ Finale', FIN: 'Finale' };

function getChampCategories() {
  const champ = getActiveChampionship();
  if (champ?.categories?.length) return champ.categories.map(c => c.id || c.name);
  return CATEGORIES;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — CHARGEMENT
// ─────────────────────────────────────────────────────────

async function loadMeetings() {
  if (!db) return;
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubMeetings) unsubMeetings();
  const q = query(
    collection(db, 'meetings'),
    where('year', '==', selectedYear),
    orderBy('date', 'asc')
  );
  unsubMeetings = onSnapshot(q, snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const champId = getActiveChampionshipId();
    allMeetings = champId
      ? all.filter(m => m.championshipId === champId || !m.championshipId)
      : all;
    refreshMeetingSelect();
  });
}

async function loadSessions() {
  if (!db || !selectedMeetingId || !selectedCategory) { allSessions = []; renderSessionList(); return; }
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubSessions) unsubSessions();
  const q = query(
    collection(db, 'sessions'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory),
    orderBy('order',   'asc')
  );
  unsubSessions = onSnapshot(q, snap => {
    allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSessionList();
    loadAllParticipants();
  });
}

async function loadEngaged() {
  if (!db || !selectedMeetingId || !selectedCategory) { engagedDrivers = []; return; }
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'engagements'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  ));
  engagedDrivers = snap.docs
    .map(d => ({ id: d.data().driverId, ...d.data() }))
    .sort((a, b) => a.carNumber - b.carNumber);
}

async function loadAllParticipants() {
  if (!db) return;
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  Object.values(unsubParticipants).forEach(u => u && u());
  unsubParticipants = {};
  sessionParticipants = {};
  for (const session of allSessions) {
    const q = query(collection(db, 'sessionParticipants'), where('sessionId', '==', session.id));
    unsubParticipants[session.id] = onSnapshot(q, snap => {
      sessionParticipants[session.id] = new Set(snap.docs.map(d => d.data().driverId));
      renderSessionList();
      if (selectedSessionId === session.id) renderSessionDetail();
    });
  }
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — PARTICIPANTS
// ─────────────────────────────────────────────────────────

async function addParticipant(sessionId, driver) {
  if (!db) return;
  const { doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const driverId = driver.id || driver.driverId;

  // Garde-fou DF : si le pilote est deja dans l'autre demi-finale, on
  // n'ajoute pas a celle-ci (logique metier inchangee).
  const targetSession = allSessions.find(s => s.id === sessionId);
  if (targetSession?.type === 'DF') {
    const otherDf = allSessions.find(s => s.type === 'DF' && s.id !== sessionId);
    if (otherDf && sessionParticipants[otherDf.id]?.has(driverId)) return;
  }

  // ID deterministe : evite tout doublon meme en cas d'appels concurrents
  // (anciennement addDoc + check getDocs non atomique -> race condition
  // qui creait des doublons quand l'utilisateur cliquait rapidement
  // ou quand plusieurs onglets etaient ouverts).
  // setDoc + merge:true permet d'enregistrer ou de mettre a jour sans
  // creer de nouveau document.
  const docId = sessionParticipantId(sessionId, driverId);
  await setDoc(doc(db, 'sessionParticipants', docId), {
    sessionId,
    meetingId:  selectedMeetingId,
    category:   selectedCategory,
    year:       selectedYear,
    driverId,
    carNumber:  driver.carNumber,
    firstName:  driver.firstName,
    lastName:   driver.lastName,
    createdAt:  new Date(),
  }, { merge: true });
}

async function removeParticipant(sessionId, driverId) {
  if (!db) return;
  const { collection, query, where, getDocs, deleteDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snapPart = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  ));
  for (const d of snapPart.docs) await deleteDoc(d.ref);

  const snapRes = await getDocs(query(
    collection(db, 'results'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  ));
  if (!snapRes.empty) {
    for (const d of snapRes.docs) await deleteDoc(d.ref);
    const session = allSessions.find(s => s.id === sessionId);
    if (session?.type === 'DF' || session?.type === 'FIN') {
      toast('Pilote retiré — son temps a aussi été supprimé', 'warning', 4000);
    }
  }
}

async function getParticipantsData(sessionId) {
  if (!db) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId)
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.carNumber - b.carNumber);
}

// ─────────────────────────────────────────────────────────
// LOGIQUE AUTOMATIQUE
// ─────────────────────────────────────────────────────────

async function autoAssignAll(sessionId) {
  await loadEngaged();
  let count = 0;
  for (const d of engagedDrivers) {
    const already = sessionParticipants[sessionId]?.has(d.id || d.driverId);
    if (!already) { await addParticipant(sessionId, d); count++; }
  }
  toast(count > 0 ? `${count} pilote(s) assigné(s) ✓` : 'Tous déjà assignés', count > 0 ? 'success' : 'info');
}

// ─────────────────────────────────────────────────────────
// AUTO QF — Repartition dans les quarts de finale
// ─────────────────────────────────────────────────────────

async function autoAssignQF() {
  const champ = getActiveChampionship();
  const qfConfig = champ?.sessionConfig?.QF;
  if (!qfConfig?.enabled) {
    toast('Les quarts de finale ne sont pas actives dans ce reglement', 'warning');
    return;
  }

  const nbQF = qfConfig.count || 4;
  const qfSessions = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);
  if (qfSessions.length === 0) {
    toast('Aucune session QF trouvee — recreez le meeting', 'error');
    return;
  }

  // Classement interim
  let ranked = [];
  try { ranked = await calcInterimStandings(db, allSessions, _activeRegulation); } catch {}
  if (ranked.length === 0) {
    toast('Pas assez de resultats MQ pour les QF', 'warning');
    return;
  }

  // Repartir avec competition.js
  const qfs = distributeIntoQF(ranked, qfConfig);

  if (!window.confirm('Auto QF : repartir ' + ranked.slice(0, nbQF * (qfConfig.gridSize || 6)).length + ' pilotes dans ' + nbQF + ' quarts de finale ?')) return;

  // Vider les QF existants + DF + FIN
  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const clearSession = async (sessionId) => {
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await getDocs(query(collection(db, col), where('sessionId', '==', sessionId)));
      if (!snap.empty) { const b = writeBatch(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
  };

  // Vider QF + DF + FIN
  for (const s of allSessions.filter(s => ['QF', 'DF', 'FIN'].includes(s.type))) {
    await clearSession(s.id);
  }

  // Assigner les pilotes dans les QF
  let total = 0;
  for (let q = 0; q < qfs.length && q < qfSessions.length; q++) {
    for (const driver of qfs[q]) {
      await addParticipant(qfSessions[q].id, driver);
      total++;
    }
  }

  toast(total + ' pilotes repartis dans ' + nbQF + ' QF', 'success');
  renderSessionList();
}

async function autoAssignDemis() {
  _dfForfaits = new Set();
  await loadEngaged();

  let ranked = [];
  try { ranked = await calcInterimStandings(db, allSessions, _activeRegulation); } catch {}

  if (ranked.length === 0) {
    toast('⚠️ Pas encore assez de résultats MQ — assignation par numéro de voiture.', 'warning', 4000);
    ranked = engagedDrivers.map((d, i) => ({
      driverId: d.id || d.driverId, carNumber: d.carNumber,
      firstName: d.firstName, lastName: d.lastName, position: i + 1,
    }));
  }

  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  if (!df1 || !df2) { toast('Sessions DF1 et DF2 introuvables', 'error'); return; }

  const { collection: c0, query: q0, where: w0, getDocs: gd0 } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const df1ResultsSnap = await gd0(q0(c0(db, 'results'), w0('sessionId', '==', df1.id)));
  const df2ResultsSnap = await gd0(q0(c0(db, 'results'), w0('sessionId', '==', df2.id)));
  const hasTimedResults = !df1ResultsSnap.empty || !df2ResultsSnap.empty;
  const df1Count = sessionParticipants[df1.id]?.size || 0;
  const df2Count = sessionParticipants[df2.id]?.size || 0;
  const hasExisting = df1Count > 0 || df2Count > 0;

  const fin = allSessions.find(s => s.type === 'FIN');
  const finPartSnap = fin ? await gd0(q0(c0(db, 'sessionParticipants'), w0('sessionId', '==', fin.id))) : null;
  const finResSnap  = fin ? await gd0(q0(c0(db, 'results'), w0('sessionId', '==', fin.id))) : null;
  const finHasData  = !finPartSnap?.empty || !finResSnap?.empty;

  if (hasTimedResults) {
    const finaleMsg = finHasData ? `\n\n⚠️ La Finale sera aussi vidée.` : '';
    if (!window.confirm(`⚠️ Des temps ont déjà été saisis en DF !\n\n• DF1 : ${df1ResultsSnap.size} résultat(s)\n• DF2 : ${df2ResultsSnap.size} résultat(s)\n\nAuto DF va tout supprimer et réassigner.${finaleMsg}\n\nContinuer ?`)) return;
  } else if (hasExisting) {
    const finaleMsg = finHasData ? `\n\n⚠️ La Finale sera aussi vidée.` : '';
    if (!window.confirm(`⚡ Auto DF va réassigner les demi-finales.\n\nDF1 : ${df1Count} / DF2 : ${df2Count} pilotes${finaleMsg}\n\nContinuer ?`)) return;
  }

  const { collection: fc, query: fq, where: fw, getDocs: fgd, writeBatch: fwb } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const clearDf = async (sessionId) => {
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await fgd(fq(fc(db, col), fw('sessionId', '==', sessionId)));
      if (!snap.empty) { const b = fwb(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
    // Vider explicitement le cache local pour eviter une race avec
    // l'event onSnapshot - sans ca le garde-fou de addParticipant
    // ("ne pas ajouter a un DF si le pilote est dans l'autre") peut
    // skipper silencieusement un pilote en se basant sur l'ancien
    // contenu pre-clear (typiquement quand on relance Auto DF apres
    // un premier run QF→DF qui avait reparti differemment).
    if (sessionParticipants[sessionId]) sessionParticipants[sessionId].clear();
  };
  await clearDf(df1.id);
  await clearDf(df2.id);

  const champ = getActiveChampionship();
  const dfGridSize = champ?.sessionConfig?.DF?.gridSize || 8;
  const nbDF = champ?.sessionConfig?.DF?.count || 2;
  const qfEnabled = champ?.sessionConfig?.QF?.enabled;
  const qualPerQF = champ?.sessionConfig?.QF?.qualifiedPerQF || 3;
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);

  const { collection: gc, query: gq, where: gw, getDocs: ggd } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Determination du mode (QF→DF vs MQ→DF) :
  // - Champ sans QF active : toujours MQ direct
  // - Champ avec QF active : demande au cas par cas (la decision peut etre
  //   prise par categorie en cours de meeting si pas assez de pilotes,
  //   forfait tardif, etc.)
  let useQfMode = false;
  if (qfEnabled) {
    const qfSessionsForCheck = allSessions.filter(s => s.type === 'QF');
    let qfHasData = false;
    for (const qf of qfSessionsForCheck) {
      const partSnap = await ggd(gq(gc(db, 'sessionParticipants'), gw('sessionId', '==', qf.id)));
      if (!partSnap.empty) { qfHasData = true; break; }
      const resSnap = await ggd(gq(gc(db, 'results'), gw('sessionId', '==', qf.id)));
      if (!resSnap.empty) { qfHasData = true; break; }
    }
    if (qfHasData) {
      // QF rempli : demander confirmation - source par defaut = QF.
      useQfMode = window.confirm(
        '⚡ Auto DF — Sélection de la source\n\n' +
        '✅ OK : utiliser les résultats des Quarts de finale (recommandé)\n' +
        '❌ Annuler : utiliser directement le classement intermédiaire MQ\n' +
        '          (les QF seront ignorés pour cette répartition)'
      );
    } else {
      // QF non rempli : demander confirmation - source par defaut = MQ direct.
      const ok = window.confirm(
        '⚠️ Pas de données dans les Quarts de finale.\n\n' +
        'Utiliser directement le classement intermédiaire MQ ?\n\n' +
        '✅ OK : MQ → DF directement (saute les QF pour cette catégorie)\n' +
        '❌ Annuler : abandonner Auto DF'
      );
      if (!ok) return;
      useQfMode = false;
    }
  }

  if (useQfMode) {
    // ── Mode QF → DF : prendre les qualifies des QF ──
    const qfSessions = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);
    const qfResults = [];
    for (const qf of qfSessions) {
      const partSnap = await ggd(gq(gc(db, 'sessionParticipants'), gw('sessionId', '==', qf.id)));
      const parts = partSnap.docs.map(d => d.data());
      const resSnap = await ggd(gq(gc(db, 'results'), gw('sessionId', '==', qf.id)));
      const resMap = {};
      resSnap.docs.forEach(d => { resMap[d.data().driverId] = d.data(); });
      const rows = parts.map(p => ({
        driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName, lastName: p.lastName,
        ms: resMap[p.driverId]?.ms ?? null, status: resMap[p.driverId]?.status ?? null,
      }));
      const order = r => r.ms ? r.ms : r.status === 'DNF' ? 9000000 : 9999999;
      rows.sort((a, b) => order(a) - order(b));
      qfResults.push(rows);
    }

    // Repartition QF1+QF3 → DF1, QF2+QF4 → DF2
    for (let dfIdx = 0; dfIdx < dfSessions.length; dfIdx++) {
      const qualifiedForThisDf = [];
      for (let qfIdx = dfIdx; qfIdx < qfResults.length; qfIdx += dfSessions.length) {
        qualifiedForThisDf.push(...qfResults[qfIdx].slice(0, qualPerQF));
      }
      // Trier : 1ers des QF, puis 2emes, puis 3emes — departage par classement MQ
      qualifiedForThisDf.sort((a, b) => {
        const posA = qfResults.find(qf => qf.includes(a))?.indexOf(a) ?? 999;
        const posB = qfResults.find(qf => qf.includes(b))?.indexOf(b) ?? 999;
        if (posA !== posB) return posA - posB;
        const rankA = ranked.findIndex(r => r.driverId === a.driverId);
        const rankB = ranked.findIndex(r => r.driverId === b.driverId);
        return (rankA >= 0 ? rankA : 9999) - (rankB >= 0 ? rankB : 9999);
      });
      for (const driver of qualifiedForThisDf) {
        await addParticipant(dfSessions[dfIdx].id, driver);
      }
    }
  } else {
    // ── Mode classique : MQ → DF directement ──
    const totalDfSlots = dfGridSize * nbDF;
    const topN = ranked.slice(0, totalDfSlots);
    for (let i = 0; i < topN.length; i++) {
      const dfIdx = i % dfSessions.length;
      await addParticipant(dfSessions[dfIdx].id, topN[i]);
    }
  }

  if (fin && finHasData) {
    const { collection: fc2, query: fq2, where: fw2, getDocs: fgd2, writeBatch: fwb2 } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await fgd2(fq2(fc2(db, col), fw2('sessionId', '==', fin.id)));
      if (!snap.empty) { const b = fwb2(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
    toast('Pilotes repartis en DF — Finale videe, relancez Auto Finale', 'success', 5000);
  } else {
    toast('Pilotes repartis en DF', 'success');
  }

  renderSessionList();
  if (selectedSessionId) {
    const panel = document.getElementById('ses-detail-panel');
    const session = allSessions.find(s => s.id === selectedSessionId);
    if (panel && session?.type === 'DF') {
      await renderDfStandings(panel, session, await getParticipantsData(selectedSessionId));
    }
  }
}

async function autoAssignFinale() {
  // Reset forfaits Finale à chaque Auto Finale
  _finForfaits = new Set();

  const fin = allSessions.find(s => s.type === 'FIN');
  if (!fin) { toast('Session Finale introuvable', 'error'); return; }

  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Nombre de qualifies par DF selon le reglement
  const champ = getActiveChampionship();
  const qualPerDF   = champ?.sessionConfig?.DF?.qualifiedPerDF || 4;
  const finGridSize = champ?.sessionConfig?.FIN?.gridSize     || 8;

  const getTopN = async (dfSession) => {
    const partSnap = await getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', dfSession.id)));
    const participants = partSnap.docs.map(d => d.data());
    if (participants.length === 0) return [];
    const resSnap = await getDocs(query(collection(db, 'results'), where('sessionId', '==', dfSession.id)));
    const resultMap = {};
    resSnap.docs.forEach(d => { resultMap[d.data().driverId] = d.data(); });
    const rows = participants.map(p => ({
      driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName, lastName: p.lastName,
      ms: resultMap[p.driverId]?.ms ?? null, status: resultMap[p.driverId]?.status ?? null,
    }));
    if (rows.every(r => !r.ms && !r.status)) return [];
    const order = r => r.ms ? r.ms : r.status === 'DNF' ? 9000000 : r.status === 'DSQ_RACE' ? 9100000 : 9999999;
    rows.sort((a, b) => order(a) - order(b));
    return rows.filter(r => r.ms || r.status === 'DNF').slice(0, qualPerDF);
  };

  // Mode normal : top-N de chaque DF. Pour les categories a petit effectif
  // sans demi-finales (typiquement 6-8 pilotes), on bascule sur le classement
  // intermediaire — top-N (taille de la grille Finale) du classement
  // intermediaire.
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  let finalistes = [];
  let sourceLabel = 'DF';
  for (const df of dfSessions) {
    const topN = await getTopN(df);
    finalistes.push(...topN);
  }
  if (finalistes.length === 0) {
    let interim = [];
    try { interim = await calcInterimStandings(db, allSessions, _activeRegulation); } catch {}
    if (interim.length === 0) {
      toast('Aucun résultat de DF ni de classement intermédiaire disponible.', 'warning');
      return;
    }
    finalistes = interim.slice(0, finGridSize).map(r => ({
      driverId:  r.driverId,
      carNumber: r.carNumber,
      firstName: r.firstName,
      lastName:  r.lastName,
    }));
    sourceLabel = 'classement intermédiaire';
  }

  const finResultsSnap = await getDocs(query(collection(db, 'results'), where('sessionId', '==', fin.id)));
  const finPartSnap    = await getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', fin.id)));
  const names = finalistes.map(d => `#${d.carNumber} ${d.lastName}`).join(', ');

  if (!finResultsSnap.empty) {
    if (!window.confirm(`⚠️ Des temps existent en Finale !\n${finResultsSnap.size} résultat(s) seront supprimés.\n\nRemplacer par (${sourceLabel}) :\n${names}\n\nContinuer ?`)) return;
  } else if (!finPartSnap.empty) {
    if (!window.confirm(`⚡ Auto Finale va assigner (${sourceLabel}) :\n${names}\n\nContinuer ?`)) return;
  }

  for (const col of ['sessionParticipants', 'results']) {
    const snap = await getDocs(query(collection(db, col), where('sessionId', '==', fin.id)));
    if (!snap.empty) { const b = writeBatch(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
  }
  for (const d of finalistes) await addParticipant(fin.id, d);
  toast(`${finalistes.length} finalistes assignés ✓`, 'success');
}

// ─────────────────────────────────────────────────────────
// GESTION FORFAIT QF
// ─────────────────────────────────────────────────────────

async function handleQfForfait(forfaitDriverId) {
  const champ = getActiveChampionship();
  const qfConfig = champ?.sessionConfig?.QF;
  const qfSessions = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);
  if (qfSessions.length === 0) return;

  // Classement MQ
  let ranked = [];
  try { ranked = await calcInterimStandings(db, allSessions, _activeRegulation); } catch {}
  if (ranked.length === 0) { toast('Pas de classement MQ disponible', 'error'); return; }

  const forfaitDriver = ranked.find(r => r.driverId === forfaitDriverId) ||
    engagedDrivers.find(d => (d.id || d.driverId) === forfaitDriverId);
  const forfaitLabel = forfaitDriver ? forfaitDriver.firstName + ' ' + forfaitDriver.lastName + ' (#' + forfaitDriver.carNumber + ')' : forfaitDriverId;

  _qfForfaits.add(forfaitDriverId);

  // Recalculer la distribution complete sans les forfaits
  const nbQF = qfConfig?.count || 4;
  const gridSize = qfConfig?.gridSize || 6;
  const totalSlots = nbQF * gridSize;

  // Exclure les forfaits du classement, prendre les N suivants
  const eligibles = ranked.filter(r => !_qfForfaits.has(r.driverId));
  const qualifies = eligibles.slice(0, totalSlots);

  // Nouveau suppleant = le dernier ajoute (celui qui prend la place en bas)
  const newDriver = qualifies[qualifies.length - 1];
  const reserveLabel = newDriver ? newDriver.firstName + ' ' + newDriver.lastName + ' (#' + newDriver.carNumber + ') entre en grille' : 'Aucun remplacant';

  if (!window.confirm('Forfait ' + forfaitLabel + ' ?\n\nTout le monde remonte d\'une place dans les QF.\n' + reserveLabel + '\n\nLes 4 QF vont etre redistribues. Continuer ?')) {
    _qfForfaits.delete(forfaitDriverId);
    return;
  }

  // Vider tous les QF + DF + FIN
  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  for (const s of allSessions.filter(s => ['QF', 'DF', 'FIN'].includes(s.type))) {
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await getDocs(query(collection(db, col), where('sessionId', '==', s.id)));
      if (!snap.empty) { const b = writeBatch(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
  }

  // Redistribuer les qualifies dans les QF (meme logique que autoAssignQF)
  const qfs = distributeIntoQF(qualifies, qfConfig);
  let total = 0;
  for (let q = 0; q < qfs.length && q < qfSessions.length; q++) {
    for (const driver of qfs[q]) {
      await addParticipant(qfSessions[q].id, driver);
      total++;
    }
  }

  toast('Forfait declare — ' + total + ' pilotes redistribues dans ' + nbQF + ' QF', 'success', 5000);
  renderSessionList();
  renderSessionDetail();
}

// ─────────────────────────────────────────────────────────
// GESTION FORFAIT DF
// ─────────────────────────────────────────────────────────

async function handleForfait(forfaitDriverId) {
  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  if (!df1 || !df2) return;

  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const fetchIds = async (sessionId) => {
    const snap = await getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', sessionId)));
    return new Set(snap.docs.map(d => d.data().driverId));
  };

  const df1Ids = await fetchIds(df1.id);
  const df2Ids = await fetchIds(df2.id);
  const assignedToADf = new Set([...df1Ids, ...df2Ids]);

  const activeInDf = _dfStandings.filter(p => assignedToADf.has(p.driverId));
  const idx = activeInDf.findIndex(p => p.driverId === forfaitDriverId);
  if (idx === -1) return;

  const forfaitDriver = activeInDf[idx];
  _dfForfaits.add(forfaitDriverId);

  const reserves = _dfStandings.filter(p =>
    !assignedToADf.has(p.driverId) && !_dfForfaits.has(p.driverId)
  );
  const reserve = reserves[0];

  const reserveLabel = reserve
    ? `${reserve.firstName} ${reserve.lastName} (#${reserve.carNumber}) entre en grille`
    : 'Aucun remplaçant disponible';

  if (!window.confirm(`🚫 Déclarer forfait ${forfaitDriver.firstName} ${forfaitDriver.lastName} (#${forfaitDriver.carNumber}) ?\n\nTout le monde derrière lui remonte d'une place.\n${reserveLabel}.\n\nContinuer ?`)) {
    _dfForfaits.delete(forfaitDriverId);
    return;
  }

  const [df1Res, df2Res] = await Promise.all([
    getDocs(query(collection(db, 'results'), where('sessionId', '==', df1.id))),
    getDocs(query(collection(db, 'results'), where('sessionId', '==', df2.id))),
  ]);
  if (!df1Res.empty || !df2Res.empty) {
    if (!window.confirm(`⚠️ Des temps ont déjà été saisis en DF !\nIls seront supprimés. Continuer ?`)) {
      _dfForfaits.delete(forfaitDriverId);
      return;
    }
  }

  const newAssignment = [
    ...activeInDf.slice(0, idx),
    ...activeInDf.slice(idx + 1),
    ...(reserve ? [reserve] : []),
  ];

  for (const dfSession of [df1, df2]) {
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await getDocs(query(collection(db, col), where('sessionId', '==', dfSession.id)));
      if (!snap.empty) { const b = writeBatch(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
  }

  for (let i = 0; i < newAssignment.length; i++) {
    await addParticipant(i % 2 === 0 ? df1.id : df2.id, newAssignment[i]);
  }

  const reserveMsg = reserve ? ` — ${reserve.firstName} ${reserve.lastName} entré en grille` : '';
  toast(`Forfait déclaré${reserveMsg} ✓`, 'success', 4000);

  const panel = document.getElementById('ses-detail-panel');
  const session = allSessions.find(s => s.id === selectedSessionId);
  if (panel && session) {
    await renderDfStandings(panel, session, await getParticipantsData(selectedSessionId));
  }
}

// ─────────────────────────────────────────────────────────
// GESTION FORFAIT FINALE
// Quand un finaliste qualifié ne peut pas se présenter :
// - il est retiré de la Finale (Firestore)
// - le 1er remplaçant de sa DF (5ème, 6ème...) entre à sa place
// ─────────────────────────────────────────────────────────

async function handleFinaleForfait(forfaitDriverId, allReplacements, panel, session) {
  const fin = allSessions.find(s => s.type === 'FIN');
  if (!fin) return;

  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Trouver le pilote forfait parmi les assignés à la Finale
  const finParts = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', fin.id)
  ));
  const assignedIds = new Set(finParts.docs.map(d => d.data().driverId));
  const forfaitPart = finParts.docs.map(d => d.data()).find(p => p.driverId === forfaitDriverId);
  if (!forfaitPart) return;

  // Marquer comme forfait AVANT de chercher le remplaçant
  _finForfaits.add(forfaitDriverId);

  // 1er remplaçant disponible (non forfait, non déjà en Finale)
  const reserve = allReplacements.find(r =>
    !assignedIds.has(r.driverId) && !_finForfaits.has(r.driverId)
  );

  const reserveLabel = reserve
    ? `${reserve.firstName} ${reserve.lastName} (#${reserve.carNumber}) — ${reserve.dfPosition}e de DF${reserve.dfNum}`
    : 'Aucun remplaçant disponible';

  if (!window.confirm(
    `🚫 Déclarer forfait ${forfaitPart.firstName} ${forfaitPart.lastName} (#${forfaitPart.carNumber}) pour la Finale ?\n\n` +
    `Remplaçant : ${reserveLabel}.\n\nContinuer ?`
  )) {
    _finForfaits.delete(forfaitDriverId);
    return;
  }

  // Vérifier si des résultats existent déjà en Finale
  const finRes = await getDocs(query(collection(db, 'results'), where('sessionId', '==', fin.id)));
  if (!finRes.empty) {
    if (!window.confirm(`⚠️ Des temps ont déjà été saisis en Finale !\nIls seront supprimés pour ce pilote. Continuer ?`)) {
      _finForfaits.delete(forfaitDriverId);
      return;
    }
  }

  // Retirer le forfait de la Finale
  await removeParticipant(fin.id, forfaitDriverId);

  // Ajouter le remplaçant si disponible
  if (reserve) {
    await addParticipant(fin.id, reserve);
    toast(`Forfait déclaré — ${reserve.firstName} ${reserve.lastName} entre en Finale ✓`, 'success', 4000);
  } else {
    toast(`Forfait déclaré — aucun remplaçant disponible`, 'warning', 4000);
  }

  // Re-render
  const updated = await getParticipantsData(fin.id);
  await renderFinaleStandings(panel, session, updated);
}

// ─────────────────────────────────────────────────────────
// RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-sessions').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🏁 <span>Sessions</span></h2>
    </div>
    <div class="toolbar" style="flex-wrap:wrap">
      <select class="toolbar-select" id="ses-year">
        ${years.map(y => `<option value="${y}" ${y === selectedYear ? 'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="ses-meeting" style="flex:1;min-width:200px">
        <option value="">— Sélectionner un meeting —</option>
      </select>
      <select class="toolbar-select" id="ses-category">
        <option value="">— Catégorie —</option>
        ${getChampCategories().map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>
    <div class="ses-layout" id="ses-layout">
      <div class="ses-list-panel" id="ses-list-panel">
        <div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">Sélectionnez un meeting et une catégorie</div>
      </div>
      <div class="ses-detail-panel" id="ses-detail-panel">
        <div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">Sélectionnez une session</div>
      </div>
    </div>
  `;
  bindEvents();
  refreshMeetingSelect();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('ses-meeting');
  if (!sel) return;
  const prev = selectedMeetingId;
  sel.innerHTML = `<option value="">— Sélectionner un meeting —</option>`;
  allMeetings.forEach(m => {
    const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR') : '?';
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${d} — ${m.location || '?'}`;
    if (m.id === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderSessionList() {
  const panel = document.getElementById('ses-list-panel');
  if (!panel) return;

  if (!selectedMeetingId || !selectedCategory) {
    panel.innerHTML = `<div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">Sélectionnez un meeting et une catégorie</div>`;
    return;
  }
  if (allSessions.length === 0) {
    panel.innerHTML = `<div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">Aucune session trouvée.</div>`;
    return;
  }

  const hasDf  = allSessions.some(s => s.type === 'DF');
  const hasFin = allSessions.some(s => s.type === 'FIN');

  panel.innerHTML = `
    <div class="ses-list-header">
      <span class="ses-list-title">Sessions</span>
      <div class="ses-list-actions">
        ${allSessions.some(s => s.type === 'QF') ? `<button class="btn btn-secondary btn-sm" id="ses-auto-qf-btn">⚡ Auto QF</button>` : ''}
        ${hasDf  ? `<button class="btn btn-secondary btn-sm" id="ses-auto-df-btn">⚡ Auto DF</button>` : ''}
        ${hasFin ? `<button class="btn btn-secondary btn-sm" id="ses-auto-fin-btn">⚡ Auto Finale</button>` : ''}
      </div>
    </div>
    <div class="ses-cards">${allSessions.map(s => sessionCard(s)).join('')}</div>
  `;

  panel.querySelectorAll('.ses-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedSessionId = card.dataset.id;
      panel.querySelectorAll('.ses-card').forEach(c => c.classList.remove('is-active'));
      card.classList.add('is-active');
      renderSessionDetail();
    });
  });

  document.getElementById('ses-auto-qf-btn')?.addEventListener('click', e => { e.stopPropagation(); autoAssignQF(); });
  document.getElementById('ses-auto-df-btn')?.addEventListener('click', e => { e.stopPropagation(); autoAssignDemis(); });
  document.getElementById('ses-auto-fin-btn')?.addEventListener('click', e => { e.stopPropagation(); autoAssignFinale(); });

  if (selectedSessionId) {
    panel.querySelector(`[data-id="${selectedSessionId}"]`)?.classList.add('is-active');
  }
}

function sessionCard(session) {
  const count = sessionParticipants[session.id]?.size || 0;
  const typeCls = session.type.toLowerCase();
  const label = session.type === 'MQ' ? `MQ${session.num}`
    : session.type === 'DF' ? `DF${session.num}`
    : SESSION_LABELS[session.type] || session.type;
  return `
    <div class="ses-card ses-card--${typeCls} ${selectedSessionId === session.id ? 'is-active' : ''}" data-id="${session.id}">
      <div class="ses-card-badge">${label}</div>
      <div class="ses-card-info">
        <div class="ses-card-label">${escHtml(session.label)}</div>
        <div class="ses-card-tours">${session.tours} tour${session.tours > 1 ? 's' : ''}</div>
      </div>
      <div class="ses-card-count">${count}<span>pilotes</span></div>
    </div>
  `;
}

async function renderSessionDetail() {
  const panel = document.getElementById('ses-detail-panel');
  if (!panel || !selectedSessionId) return;

  const session = allSessions.find(s => s.id === selectedSessionId);
  if (!session) return;

  const participants   = await getParticipantsData(selectedSessionId);
  const participantIds = new Set(participants.map(p => p.driverId));

  await loadEngaged();
  let otherDfIds = new Set();
  if (session.type === 'DF') {
    const otherDf = allSessions.find(s => s.type === 'DF' && s.id !== selectedSessionId);
    if (otherDf) otherDfIds = sessionParticipants[otherDf.id] || new Set();
  }

  // QF : exclure les pilotes deja dans un autre QF
  let otherQfIds = new Set();
  if (session.type === 'QF') {
    const otherQfs = allSessions.filter(s => s.type === 'QF' && s.id !== selectedSessionId);
    for (const qf of otherQfs) {
      const ids = sessionParticipants[qf.id] || new Set();
      ids.forEach(id => otherQfIds.add(id));
    }
  }

  if (session.type === 'QF')  { await renderQfStandings(panel, session, participants); return; }
  if (session.type === 'DF')  { await renderDfStandings(panel, session, participants); return; }
  if (session.type === 'FIN') { await renderFinaleStandings(panel, session, participants); return; }

  let notAssigned = engagedDrivers.filter(d => {
    const id = d.id || d.driverId;
    return !participantIds.has(id) && !otherDfIds.has(id) && !otherQfIds.has(id);
  });

  // Pour QF : trier par classement intermediaire MQ
  if (session.type === 'QF') {
    try {
      const ranked = await calcInterimStandings(db, allSessions, _activeRegulation);
      const rankMap = {};
      ranked.forEach((r, i) => { rankMap[r.driverId] = i; });
      notAssigned.sort((a, b) => {
        const ra = rankMap[a.id || a.driverId] ?? 9999;
        const rb = rankMap[b.id || b.driverId] ?? 9999;
        return ra - rb;
      });
    } catch { /* fallback: tri par numero */ }
  }

  const isEcOrMq = session.type === 'EC' || session.type === 'MQ';
  const isQF = session.type === 'QF';

  panel.innerHTML = `
    <div class="ses-detail-header">
      <div>
        <div class="ses-detail-label">${escHtml(session.label)}</div>
        <div class="ses-detail-meta">${session.tours} tour${session.tours > 1?'s':''} · ${participants.length} pilote${participants.length>1?'s':''}</div>
      </div>
      ${isEcOrMq ? `<button class="btn btn-primary btn-sm" id="ses-auto-all-btn">✅ Assigner tous les engagés</button>` : ''}
    </div>
    <div class="ses-detail-section">
      <div class="ses-section-title"><span class="eng-group-dot eng-group-dot--on"></span>Assignés (${participants.length})</div>
      ${participants.length === 0
        ? `<div class="ses-empty">Aucun pilote assigné</div>`
        : participants.map(p => `
          <div class="ses-pilot-row">
            <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
            <span class="ses-pilot-name">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
            ${isQF ? `<button class="btn btn-danger btn-sm ses-qf-forfait-btn" data-driver-id="${p.driverId}" title="Declarer forfait">🚫</button>` : ''}
            <button class="btn btn-danger btn-sm ses-remove-btn" data-driver-id="${p.driverId}">✕</button>
          </div>`).join('')}
    </div>
    ${notAssigned.length > 0 ? `
      <div class="ses-detail-section">
        <div class="ses-section-title"><span class="eng-group-dot eng-group-dot--off"></span>Non assignés (${notAssigned.length})</div>
        ${notAssigned.map((d, idx) => `
          <div class="ses-pilot-row ses-pilot-row--dim">
            ${session.type === 'QF' ? '<span class="ses-pilot-rank text-muted" style="font-size:0.78rem;min-width:24px">' + (idx + 1) + '</span>' : ''}
            <span class="ses-pilot-num">${escHtml(d.carNumber)}</span>
            <span class="ses-pilot-name">${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></span>
            <button class="btn btn-secondary btn-sm ses-add-btn" data-driver-id="${d.id || d.driverId}">＋</button>
          </div>`).join('')}
      </div>` : ''}
  `;

  document.getElementById('ses-auto-all-btn')?.addEventListener('click', () => autoAssignAll(selectedSessionId));
  panel.querySelectorAll('.ses-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => { await removeParticipant(selectedSessionId, btn.dataset.driverId); renderSessionDetail(); });
  });
  panel.querySelectorAll('.ses-add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driver = engagedDrivers.find(d => (d.id || d.driverId) === btn.dataset.driverId);
      if (driver) { await addParticipant(selectedSessionId, driver); renderSessionDetail(); }
    });
  });
  // Forfait QF
  panel.querySelectorAll('.ses-qf-forfait-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQfForfait(btn.dataset.driverId));
  });
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('ses-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value); selectedMeetingId = ''; selectedSessionId = ''; loadMeetings();
  });
  document.getElementById('ses-meeting')?.addEventListener('change', e => {
    selectedMeetingId = e.target.value; selectedSessionId = ''; loadSessions(); loadEngaged();
  });
  document.getElementById('ses-category')?.addEventListener('change', e => {
    selectedCategory = e.target.value; selectedSessionId = ''; loadSessions(); loadEngaged();
  });
}

// ─────────────────────────────────────────────────────────
// VUE DF
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// RENDU QF — classement + grille + forfait
// ─────────────────────────────────────────────────────────

async function renderQfStandings(panel, session, assignedParticipants) {
  const champ = getActiveChampionship();
  const qfConfig = champ?.sessionConfig?.QF || {};
  const nbQF = qfConfig.count || 4;
  const gridSize = qfConfig.gridSize || 6;
  const gridLayout = qfConfig.gridLayout || null;

  const qfSessions = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);

  // Fetch all QF assignments
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
  const qfAssignments = {};
  for (const qf of qfSessions) {
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', qf.id)));
    snap.docs.forEach(d => { qfAssignments[d.data().driverId] = qf.num; });
  }

  const currentQfIds = new Set();
  const partSnap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', session.id)));
  partSnap.docs.forEach(d => currentQfIds.add(d.data().driverId));
  const currentParticipants = partSnap.docs.map(d => d.data());

  // MQ ranking
  let ranked = [];
  try { ranked = await calcInterimStandings(db, allSessions, _activeRegulation); } catch {}

  // Build grid display
  let gridHtml = '';
  if (gridLayout && gridLayout.positions && currentParticipants.length > 0) {
    const lanes = gridLayout.lanes || 5;
    const rows = gridLayout.rows || 3;
    const positions = gridLayout.positions;

    // Map position number → driver
    // Sort participants by their MQ ranking for grid assignment
    const sortedParts = [...currentParticipants];
    const rankMap = {};
    ranked.forEach((r, i) => { rankMap[r.driverId] = i; });
    sortedParts.sort((a, b) => (rankMap[a.driverId] ?? 9999) - (rankMap[b.driverId] ?? 9999));

    const posToDriver = {};
    let posIdx = 0;
    const sortedPositions = Object.entries(positions).sort((a, b) => a[1] - b[1]);
    for (const [key, posNum] of sortedPositions) {
      if (posIdx < sortedParts.length) {
        posToDriver[key] = sortedParts[posIdx++];
      }
    }

    gridHtml = '<div class="ses-grid-display"><div class="ses-grid-title">Grille de depart — QF' + session.num + '</div>';
    gridHtml += '<table class="ses-grid-table"><thead><tr><th></th>';
    for (let c = 0; c < lanes; c++) gridHtml += '<th>C' + (c + 1) + '</th>';
    gridHtml += '</tr></thead><tbody>';
    for (let r = 0; r < rows; r++) {
      gridHtml += '<tr><td class="ses-grid-row-label">L' + (r + 1) + '</td>';
      for (let c = 0; c < lanes; c++) {
        const key = r + '-' + c;
        const driver = posToDriver[key];
        if (driver) {
          gridHtml += '<td class="ses-grid-cell ses-grid-cell--filled">' +
            '<span class="ses-grid-num">' + escHtml(driver.carNumber) + '</span>' +
            '<span class="ses-grid-name">' + escHtml(driver.lastName) + '</span></td>';
        } else if (positions[key]) {
          gridHtml += '<td class="ses-grid-cell ses-grid-cell--empty">(' + positions[key] + ')</td>';
        } else {
          gridHtml += '<td class="ses-grid-cell"></td>';
        }
      }
      gridHtml += '</tr>';
    }
    gridHtml += '</tbody></table></div>';
  }

  // Assigned list with forfait buttons
  const assignedHtml = currentParticipants.length === 0
    ? '<div class="ses-empty">Aucun pilote assigne</div>'
    : currentParticipants.map(p => {
        const mqPos = ranked.findIndex(r => r.driverId === p.driverId);
        return '<div class="ses-pilot-row">' +
          '<span class="ses-pilot-rank text-muted" style="font-size:0.78rem;min-width:24px">' + (mqPos >= 0 ? mqPos + 1 : '—') + '</span>' +
          '<span class="ses-pilot-num">' + escHtml(p.carNumber) + '</span>' +
          '<span class="ses-pilot-name">' + escHtml(p.firstName) + ' <strong>' + escHtml(p.lastName) + '</strong></span>' +
          '<button class="btn btn-danger btn-sm ses-qf-forfait-btn" data-driver-id="' + p.driverId + '" title="Declarer forfait">🚫</button>' +
          '<button class="btn btn-danger btn-sm ses-remove-btn" data-driver-id="' + p.driverId + '">✕</button>' +
          '</div>';
      }).join('');

  // Pilotes pas (encore) places dans un QF de cette categorie/meeting.
  // Permet a l'utilisateur d'ajouter manuellement un pilote retire d'un
  // autre QF (typiquement quand l'auto QF a place quelqu'un qui finalement
  // ne court pas, donc on le retire et on doit reassigner les autres).
  // Tries par classement intermediaire (rang MQ) ascendant.
  const unassigned = engagedDrivers
    .filter(d => !qfAssignments[d.id || d.driverId])
    .map(d => {
      const id = d.id || d.driverId;
      const mqPos = ranked.findIndex(r => r.driverId === id);
      return { d, mqPos: mqPos >= 0 ? mqPos : 9999 };
    })
    .sort((a, b) => a.mqPos - b.mqPos)
    .map(({ d, mqPos }) => ({ d, mqPos }));

  const unassignedHtml = unassigned.length === 0
    ? '<div class="ses-empty text-muted" style="font-size:0.82rem">Tous les pilotes sont deja assignes a un QF</div>'
    : unassigned.map(({ d, mqPos }) => {
        const id = d.id || d.driverId;
        return '<div class="ses-pilot-row ses-pilot-row--dim">' +
          '<span class="ses-pilot-rank text-muted" style="font-size:0.78rem;min-width:24px">' + (mqPos < 9999 ? mqPos + 1 : '—') + '</span>' +
          '<span class="ses-pilot-num">' + escHtml(d.carNumber) + '</span>' +
          '<span class="ses-pilot-name">' + escHtml(d.firstName) + ' <strong>' + escHtml(d.lastName) + '</strong></span>' +
          '<button class="btn btn-secondary btn-sm ses-qf-add-btn" data-driver-id="' + id + '" title="Ajouter a ce QF">＋</button>' +
          '</div>';
      }).join('');

  panel.innerHTML = '<div class="ses-detail-header"><div>' +
    '<div class="ses-detail-label">' + escHtml(session.label) + '</div>' +
    '<div class="ses-detail-meta">' + session.tours + ' tours · ' + currentParticipants.length + ' pilote(s)</div>' +
    '</div></div>' +
    (_qfForfaits.size > 0 ? '<div class="ses-df-notice" style="background:rgba(255,85,0,0.08);border-color:var(--clr-accent)">🚫 ' + _qfForfaits.size + ' forfait(s) declare(s) — Auto QF pour reinitialiser</div>' : '') +
    gridHtml +
    '<div class="ses-detail-section">' +
    '<div class="ses-section-title"><span class="eng-group-dot eng-group-dot--on"></span>Assignes (' + currentParticipants.length + ')</div>' +
    assignedHtml +
    '</div>' +
    '<div class="ses-detail-section">' +
    '<div class="ses-section-title"><span class="eng-group-dot eng-group-dot--off"></span>Non assignes a un QF (' + unassigned.length + ')</div>' +
    unassignedHtml +
    '</div>';

  // Bind forfait + remove buttons
  panel.querySelectorAll('.ses-qf-forfait-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { handleQfForfait(btn.dataset.driverId); });
  });
  panel.querySelectorAll('.ses-remove-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      await removeParticipant(selectedSessionId, btn.dataset.driverId);
      renderSessionDetail();
    });
  });
  panel.querySelectorAll('.ses-qf-add-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const id = btn.dataset.driverId;
      const driver = engagedDrivers.find(d => (d.id || d.driverId) === id);
      if (driver) {
        await addParticipant(selectedSessionId, driver);
        renderSessionDetail();
      }
    });
  });
}

// ─────────────────────────────────────────────────────────
// RENDU DF DEPUIS QF — montre les resultats QF groupes par position
// ─────────────────────────────────────────────────────────

async function renderDfFromQf(panel, session) {
  const champ = getActiveChampionship();
  const qualPerQF = champ?.sessionConfig?.QF?.qualifiedPerQF || 3;
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  const qfSessions = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);

  const fs = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

  // Fetch current DF participants
  const currentDfSnap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', session.id)));
  const currentDfIds = new Set(currentDfSnap.docs.map(d => d.data().driverId));

  // Fetch all DF participants
  const allDfIds = new Set();
  for (const df of dfSessions) {
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', df.id)));
    snap.docs.forEach(d => allDfIds.add(d.data().driverId));
  }

  // Get QF results
  const qfResults = [];
  for (const qf of qfSessions) {
    const partSnap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', qf.id)));
    const parts = partSnap.docs.map(d => d.data());
    const resSnap = await fs.getDocs(fs.query(fs.collection(db, 'results'), fs.where('sessionId', '==', qf.id)));
    const resMap = {};
    resSnap.docs.forEach(d => { resMap[d.data().driverId] = d.data(); });
    const rows = parts.map(p => ({
      driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName, lastName: p.lastName,
      ms: resMap[p.driverId]?.ms ?? null, status: resMap[p.driverId]?.status ?? null,
      qfNum: qf.num,
    }));
    const order = r => r.ms ? r.ms : r.status === 'DNF' ? 9000000 : 9999999;
    rows.sort((a, b) => order(a) - order(b));
    // Assign QF position
    let pos = 1;
    rows.forEach(r => { r.qfPosition = (r.ms || r.status === 'DNF') ? pos++ : null; });
    qfResults.push(rows);
  }

  // MQ ranking for tiebreaking
  let mqRanking = [];
  try { mqRanking = await calcInterimStandings(db, allSessions, _activeRegulation); } catch {}
  const mqRankMap = {};
  mqRanking.forEach((r, i) => { mqRankMap[r.driverId] = i; });

  // Build qualified list grouped by QF position
  // For this DF: which QFs feed into it?
  // DF1 ← QF1+QF3, DF2 ← QF2+QF4
  const dfIdx = dfSessions.findIndex(d => d.id === session.id);
  const feedingQfs = [];
  for (let q = dfIdx; q < qfSessions.length; q += dfSessions.length) {
    if (qfResults[q]) feedingQfs.push({ qfNum: q + 1, results: qfResults[q] });
  }

  // Build qualified drivers sorted by QF position then MQ rank
  const qualified = [];
  for (let posLevel = 1; posLevel <= qualPerQF; posLevel++) {
    const driversAtPos = [];
    for (const fqf of feedingQfs) {
      const driver = fqf.results.find(r => r.qfPosition === posLevel);
      if (driver) driversAtPos.push(driver);
    }
    // Sort by MQ ranking for tiebreak within same QF position
    driversAtPos.sort((a, b) => (mqRankMap[a.driverId] ?? 9999) - (mqRankMap[b.driverId] ?? 9999));
    qualified.push(...driversAtPos);
  }

  // Reserves: QF drivers not qualified, sorted by QF position then MQ rank
  const qualifiedIds = new Set(qualified.map(d => d.driverId));
  const reserves = [];
  for (const fqf of feedingQfs) {
    fqf.results.forEach(r => {
      if (!qualifiedIds.has(r.driverId) && r.qfPosition) {
        reserves.push(r);
      }
    });
  }
  reserves.sort((a, b) => {
    if ((a.qfPosition || 99) !== (b.qfPosition || 99)) return (a.qfPosition || 99) - (b.qfPosition || 99);
    return (mqRankMap[a.driverId] ?? 9999) - (mqRankMap[b.driverId] ?? 9999);
  });

  const feedingLabels = feedingQfs.map(f => 'QF' + f.qfNum).join(' + ');

  // Detect replacements: drivers in DF session but not in qualified list
  const qualifiedIds2 = new Set(qualified.map(d => d.driverId));
  const replacementIds = new Set();
  currentDfSnap.docs.forEach(d => {
    if (!qualifiedIds2.has(d.data().driverId)) replacementIds.add(d.data().driverId);
  });

  let html = '<div class="ses-detail-header"><div>' +
    '<div class="ses-detail-label">' + escHtml(session.label) + '</div>' +
    '<div class="ses-detail-meta">' + session.tours + ' tours · ' + currentDfIds.size + ' pilotes assignes</div>' +
    '</div>' +
    '<button class="btn btn-secondary btn-sm" id="ses-auto-df-inline">⚡ Auto DF</button></div>';

  // Forfait notice
  if (_dfForfaits.size > 0) {
    html += '<div class="ses-df-notice" style="background:rgba(255,85,0,0.08);border-color:var(--clr-accent)">' +
      '🚫 ' + _dfForfaits.size + ' forfait(s) declare(s)</div>';
  }

  // Grid display using gridLayout from regulation
  const dfGridLayout = champ?.sessionConfig?.DF?.gridLayout;
  if (dfGridLayout && dfGridLayout.positions && currentDfIds.size > 0) {
    const gLanes = dfGridLayout.lanes || 5;
    const gRows = dfGridLayout.rows || 3;
    const gPositions = dfGridLayout.positions;

    // Sort grid: qualified (non-forfait) in QF order first, replacements at the end
    const currentParts = currentDfSnap.docs.map(d => d.data());
    const qualifiedInDf = [];
    qualified.forEach(d => {
      if (currentDfIds.has(d.driverId) && !_dfForfaits.has(d.driverId)) qualifiedInDf.push(d);
    });
    const qualifiedIdSet = new Set(qualifiedInDf.map(d => d.driverId));
    const replacementsInDf = currentParts.filter(d => !qualifiedIdSet.has(d.driverId));
    // Trier les remplacants par classement intermediaire MQ ascendant.
    // Cas critique : mode MQ-direct (qualified vide) → tous les pilotes
    // sont consideres "replacement", donc ce tri determine l'ordre de
    // grille. La regle reglementaire est "meilleur classement = position
    // prioritaire / pole", donc on suit le rang MQ croissant.
    replacementsInDf.sort((a, b) => {
      const rankA = mqRankMap[a.driverId] ?? 9999;
      const rankB = mqRankMap[b.driverId] ?? 9999;
      return rankA - rankB;
    });
    const sortedGridParts = [...qualifiedInDf, ...replacementsInDf];

    const gPosToDriver = {};
    let gIdx = 0;
    const gSortedPos = Object.entries(gPositions).sort((a, b) => a[1] - b[1]);
    for (const [key, posNum] of gSortedPos) {
      if (gIdx < sortedGridParts.length) gPosToDriver[key] = sortedGridParts[gIdx++];
    }

    html += '<div class="ses-grid-display"><div class="ses-grid-title">Grille de depart — DF' + session.num + '</div>';
    html += '<table class="ses-grid-table"><thead><tr><th></th>';
    for (let c = 0; c < gLanes; c++) html += '<th>C' + (c + 1) + '</th>';
    html += '</tr></thead><tbody>';
    for (let r = 0; r < gRows; r++) {
      html += '<tr><td class="ses-grid-row-label">L' + (r + 1) + '</td>';
      for (let c = 0; c < gLanes; c++) {
        const key = r + '-' + c;
        const driver = gPosToDriver[key];
        if (driver) {
          const isReplacement = replacementIds.has(driver.driverId);
          html += '<td class="ses-grid-cell ses-grid-cell--filled' + (isReplacement ? ' ses-grid-cell--replacement' : '') + '">' +
            '<span class="ses-grid-num">' + escHtml(driver.carNumber) + '</span>' +
            '<span class="ses-grid-name">' + escHtml(driver.lastName) + '</span></td>';
        } else if (gPositions[key]) {
          html += '<td class="ses-grid-cell ses-grid-cell--empty">(' + gPositions[key] + ')</td>';
        } else {
          html += '<td class="ses-grid-cell"></td>';
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  // Qualified header
  html += '<div class="ses-df-notice" style="background:rgba(30,215,96,0.08);border-color:var(--clr-success)">' +
    'Qualifies — ' + qualPerQF + ' premiers de chaque QF (' + feedingLabels + ') · 🚫 = Declarer forfait' +
    '</div>';

  // Qualified list grouped by position
  let currentPosLevel = 0;
  qualified.forEach((driver, i) => {
    const posLevel = Math.floor(i / feedingQfs.length) + 1;
    if (posLevel !== currentPosLevel) {
      currentPosLevel = posLevel;
      if (posLevel > 1) html += '<div style="border-top:1px solid var(--clr-border);margin:var(--sp-xs) 0"></div>';
    }
    const isAssigned = currentDfIds.has(driver.driverId);
    const isInOtherDf = allDfIds.has(driver.driverId) && !currentDfIds.has(driver.driverId);
    const isForfait = _dfForfaits.has(driver.driverId);
    html += '<div class="ses-df-row ' + (isForfait ? 'ses-df-row--forfait' : '') + ' ' + (isAssigned ? 'ses-df-row--assigned' : '') + ' ' + (isInOtherDf ? 'ses-df-row--other' : '') + '">' +
      '<span class="ses-df-pos">' + (isForfait ? '—' : (i + 1)) + '</span>' +
      '<span class="ses-df-pill ses-df-pill--1">QF' + driver.qfNum + '</span>' +
      '<span class="ses-pilot-num">' + escHtml(driver.carNumber) + '</span>' +
      '<span class="ses-pilot-name"' + (isForfait ? ' style="text-decoration:line-through;opacity:0.5"' : '') + '>' + escHtml(driver.firstName) + ' <strong>' + escHtml(driver.lastName) + '</strong></span>' +
      (isForfait
        ? '<span style="font-size:0.75rem;color:var(--clr-danger)">🚫 Forfait</span>' +
          '<span class="ses-df-actions"><button class="btn btn-secondary btn-sm ses-annuler-df-qf-forfait-btn" data-driver-id="' + driver.driverId + '">↩ Annuler</button></span>'
        : '<span class="ses-df-pts">' + (driver.qfPosition ? driver.qfPosition + 'e QF' + driver.qfNum : '—') + '</span>' +
          '<span class="ses-df-actions">' +
          (isAssigned ? '<span style="color:var(--clr-success)">✓</span> <button class="btn btn-ghost btn-sm ses-df-qf-forfait-btn" data-driver-id="' + driver.driverId + '" title="Declarer forfait">🚫</button> <button class="btn btn-danger btn-sm ses-df-qf-remove-btn" data-driver-id="' + driver.driverId + '">✕</button>' : '') +
          '</span>') +
      '</div>';
  });

  // Mode MQ-direct (pas de feeding QF rempli) : la boucle qualified.forEach
  // ci-dessus n'affiche rien, donc les pilotes deja en grille n'ont aucun
  // bouton de retrait. On rajoute ici une liste "Pilotes assignes" avec
  // ✕ pour permettre une correction manuelle (ex: retirer un pilote mal
  // classe pour le remplacer par un pilote de la section "Non assignes").
  const isMqDirectMode = qualified.length === 0 && currentDfIds.size > 0;
  if (isMqDirectMode) {
    const currentDriversInDf = currentDfSnap.docs.map(d => d.data())
      .map(d => ({ d, mqRank: mqRankMap[d.driverId] ?? 9999 }))
      .sort((a, b) => a.mqRank - b.mqRank);
    html += '<div style="margin-top:var(--sp-md);padding:var(--sp-sm) 0;color:var(--clr-text-3);font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em">' +
      'Pilotes assignes (' + currentDriversInDf.length + ')</div>';
    currentDriversInDf.forEach(({ d, mqRank }, i) => {
      const isForfait = _dfForfaits.has(d.driverId);
      html += '<div class="ses-df-row ses-df-row--assigned' + (isForfait ? ' ses-df-row--forfait' : '') + '">' +
        '<span class="ses-df-pos">' + (i + 1) + '</span>' +
        '<span class="ses-df-pill ses-df-pill--reserve">MQ</span>' +
        '<span class="ses-pilot-num">' + escHtml(d.carNumber) + '</span>' +
        '<span class="ses-pilot-name"' + (isForfait ? ' style="text-decoration:line-through;opacity:0.5"' : '') + '>' + escHtml(d.firstName) + ' <strong>' + escHtml(d.lastName) + '</strong></span>' +
        '<span class="ses-df-pts">' + (mqRank < 9999 ? (mqRank + 1) + 'e MQ' : '—') + '</span>' +
        '<span class="ses-df-actions">' +
        '<button class="btn btn-danger btn-sm ses-df-qf-remove-btn" data-driver-id="' + d.driverId + '" title="Retirer du DF">✕</button>' +
        '</span></div>';
    });
  }

  // Reserves
  if (reserves.length > 0) {
    html += '<div style="margin-top:var(--sp-md);padding:var(--sp-sm) 0;color:var(--clr-text-3);font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em">' +
      'Remplacants potentiels — tries par position QF puis classement intermediaire</div>';
    reserves.forEach((driver, i) => {
      const isNowInDf = currentDfIds.has(driver.driverId);
      html += '<div class="ses-df-row ses-df-row--reserve' + (isNowInDf ? ' ses-df-row--assigned' : '') + '">' +
        '<span class="ses-df-pos">' + (i + 1) + '</span>' +
        '<span class="ses-df-pill ses-df-pill--1">QF' + driver.qfNum + '</span>' +
        '<span class="ses-pilot-num">' + escHtml(driver.carNumber) + '</span>' +
        '<span class="ses-pilot-name">' + escHtml(driver.firstName) + ' <strong>' + escHtml(driver.lastName) + '</strong></span>' +
        '<span class="ses-df-pts">' + (driver.qfPosition || '—') + 'e QF' + driver.qfNum + '</span>' +
        (isNowInDf ? '<span style="color:var(--clr-success);font-size:0.75rem;font-weight:600">✓ Remplacant</span>' : '') +
        '</div>';
    });
  }

  // Pilotes engages non assignes a aucun DF.
  // Cas d'usage : auto-DF en mode MQ direct (saute QF) qui n'a pas tous
  // les pilotes ; pilotes en QF non-feeding non requalifies ailleurs ;
  // pilotes manuellement retires des DF ; DNS QF avant que les DF soient
  // calcules. Permet de les rajouter manuellement a CE DF.
  const reserveIds = new Set(reserves.map(r => r.driverId));
  const qualifiedAllIds = new Set(qualified.map(d => d.driverId));
  const unassignedDf = engagedDrivers
    .filter(d => {
      const id = d.id || d.driverId;
      if (qualifiedAllIds.has(id)) return false;
      if (reserveIds.has(id)) return false;
      if (allDfIds.has(id)) return false;
      return true;
    })
    .map(d => {
      const id = d.id || d.driverId;
      return { d, id, mqRank: mqRankMap[id] ?? 9999 };
    })
    .sort((a, b) => a.mqRank - b.mqRank);

  if (unassignedDf.length > 0) {
    html += '<div style="margin-top:var(--sp-md);padding:var(--sp-sm) 0;color:var(--clr-text-3);font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em">' +
      'Non assignes a un DF (' + unassignedDf.length + ')</div>';
    unassignedDf.forEach(({ d, id, mqRank }) => {
      html += '<div class="ses-df-row ses-df-row--reserve">' +
        '<span class="ses-df-pos">' + (mqRank < 9999 ? mqRank + 1 : '—') + '</span>' +
        '<span class="ses-df-pill ses-df-pill--reserve">MQ</span>' +
        '<span class="ses-pilot-num">' + escHtml(d.carNumber) + '</span>' +
        '<span class="ses-pilot-name">' + escHtml(d.firstName) + ' <strong>' + escHtml(d.lastName) + '</strong></span>' +
        '<span class="ses-df-pts">' + (mqRank < 9999 ? (mqRank + 1) + 'e MQ' : '—') + '</span>' +
        '<span class="ses-df-actions"><button class="btn btn-secondary btn-sm ses-df-add-unassigned-btn" data-driver-id="' + id + '" title="Ajouter a ce DF">＋</button></span>' +
        '</div>';
    });
  }

  panel.innerHTML = html;

  document.getElementById('ses-auto-df-inline')?.addEventListener('click', () => autoAssignDemis());

  // Forfait in DF (QF mode): replace with first reserve
  panel.querySelectorAll('.ses-df-qf-forfait-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const driverId = btn.dataset.driverId;
      const forfaitDriver = qualified.find(d => d.driverId === driverId);
      if (!forfaitDriver) return;

      const reserve = reserves[0];
      const forfaitLabel = forfaitDriver.firstName + ' ' + forfaitDriver.lastName + ' (#' + forfaitDriver.carNumber + ')';
      const reserveLabel = reserve
        ? reserve.firstName + ' ' + reserve.lastName + ' (#' + reserve.carNumber + ') — ' + reserve.qfPosition + 'e QF' + reserve.qfNum
        : 'Aucun remplacant disponible';

      if (!window.confirm('Forfait ' + forfaitLabel + ' ?\n\nRemplacant : ' + reserveLabel + '\n\nContinuer ?')) return;

      // Track forfait visually
      _dfForfaits.add(driverId);

      // Remove forfait from DF
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', session.id), fs.where('driverId', '==', driverId)));
      if (!snap.empty) {
        const b = fs.writeBatch(db);
        snap.docs.forEach(d => b.delete(d.ref));
        await b.commit();
      }

      // Remove results too
      const resSnap = await fs.getDocs(fs.query(fs.collection(db, 'results'), fs.where('sessionId', '==', session.id), fs.where('driverId', '==', driverId)));
      if (!resSnap.empty) {
        const b = fs.writeBatch(db);
        resSnap.docs.forEach(d => b.delete(d.ref));
        await b.commit();
      }

      // Add reserve
      if (reserve) {
        await addParticipant(session.id, reserve);
      }

      toast('Forfait declare' + (reserve ? ' — ' + reserve.firstName + ' ' + reserve.lastName + ' entre en grille' : ''), 'success', 4000);
      renderSessionDetail();
    });
  });

  // Annuler forfait DF (QF mode)
  panel.querySelectorAll('.ses-annuler-df-qf-forfait-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const driverId = btn.dataset.driverId;
      const driver = qualified.find(d => d.driverId === driverId);
      _dfForfaits.delete(driverId);
      toast('Forfait annule — ' + (driver?.firstName || '') + ' ' + (driver?.lastName || '') + ' est de nouveau disponible', 'info', 3000);
      renderSessionDetail();
    });
  });

  // Remove button
  panel.querySelectorAll('.ses-df-qf-remove-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      await removeParticipant(session.id, btn.dataset.driverId);
      renderSessionDetail();
    });
  });

  // Bouton + pour ajouter manuellement un pilote non assigne a ce DF
  panel.querySelectorAll('.ses-df-add-unassigned-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const id = btn.dataset.driverId;
      const driver = engagedDrivers.find(d => (d.id || d.driverId) === id);
      if (!driver) return;
      await addParticipant(session.id, driver);
      renderSessionDetail();
    });
  });
}

async function renderDfStandings(panel, session, assignedParticipants) {
  const champ = getActiveChampionship();
  const qfEnabled = champ?.sessionConfig?.QF?.enabled;

  // Si QF actifs, utiliser le rendu specifique QF→DF
  if (qfEnabled) {
    await renderDfFromQf(panel, session);
    return;
  }

  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);

  const freshFetch = async (sessionId) => {
    if (!sessionId) return new Set();
    const { collection: c2, query: q2, where: w2, getDocs: gd2 } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const snap = await gd2(q2(c2(db, 'sessionParticipants'), w2('sessionId', '==', sessionId)));
    return new Set(snap.docs.map(d => d.data().driverId));
  };

  const df1Ids = await freshFetch(df1?.id);
  const df2Ids = await freshFetch(df2?.id);
  const assignedToADf = new Set([...df1Ids, ...df2Ids]);

  let rawStandings = await calcInterimStandings(db, allSessions, _activeRegulation);
  if (rawStandings.length === 0) {
    rawStandings = engagedDrivers.map((d, i) => ({
      driverId: d.id || d.driverId, carNumber: d.carNumber,
      firstName: d.firstName, lastName: d.lastName, totalPoints: null, position: i + 1,
    }));
  }

  _dfStandings = rawStandings;

  const assignedStandings = rawStandings.filter(p =>  assignedToADf.has(p.driverId));
  const reserveStandings  = rawStandings.filter(p => !assignedToADf.has(p.driverId) && !_dfForfaits.has(p.driverId));
  const forfaitStandings  = rawStandings.filter(p =>  _dfForfaits.has(p.driverId));

  const hasRealStandings = rawStandings[0]?.totalPoints != null;
  panel._standings = rawStandings;

  const currentDf  = session.num;
  const otherDf    = currentDf === 1 ? 2 : 1;
  const currentIds = currentDf === 1 ? df1Ids : df2Ids;
  const otherIds   = currentDf === 1 ? df2Ids : df1Ids;

  // Build grid display for current DF using gridLayout
  let dfGridHtml = '';
  const dfGridLayout = champ?.sessionConfig?.DF?.gridLayout;
  if (dfGridLayout && dfGridLayout.positions && currentIds.size > 0) {
    const gLanes = dfGridLayout.lanes || 5;
    const gRows = dfGridLayout.rows || 3;
    const gPositions = dfGridLayout.positions;

    // Get actual participants sorted by MQ ranking
    const { collection: gc, query: gq, where: gw, getDocs: ggd } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const partSnap = await ggd(gq(gc(db, 'sessionParticipants'), gw('sessionId', '==', session.id)));
    const currentParts = partSnap.docs.map(d => d.data());
    const rankMap = {};
    rawStandings.forEach((r, i) => { rankMap[r.driverId] = i; });
    const sortedGridParts = [...currentParts].sort((a, b) => (rankMap[a.driverId] ?? 9999) - (rankMap[b.driverId] ?? 9999));

    const gPosToDriver = {};
    let gIdx = 0;
    const gSortedPos = Object.entries(gPositions).sort((a, b) => a[1] - b[1]);
    for (const [key] of gSortedPos) {
      if (gIdx < sortedGridParts.length) gPosToDriver[key] = sortedGridParts[gIdx++];
    }

    dfGridHtml = '<div class="ses-grid-display"><div class="ses-grid-title">Grille de depart — DF' + session.num + '</div>';
    dfGridHtml += '<table class="ses-grid-table"><thead><tr><th></th>';
    for (let c = 0; c < gLanes; c++) dfGridHtml += '<th>C' + (c + 1) + '</th>';
    dfGridHtml += '</tr></thead><tbody>';
    for (let r = 0; r < gRows; r++) {
      dfGridHtml += '<tr><td class="ses-grid-row-label">L' + (r + 1) + '</td>';
      for (let c = 0; c < gLanes; c++) {
        const key = r + '-' + c;
        const driver = gPosToDriver[key];
        if (driver) {
          dfGridHtml += '<td class="ses-grid-cell ses-grid-cell--filled">' +
            '<span class="ses-grid-num">' + escHtml(driver.carNumber) + '</span>' +
            '<span class="ses-grid-name">' + escHtml(driver.lastName) + '</span></td>';
        } else if (gPositions[key]) {
          dfGridHtml += '<td class="ses-grid-cell ses-grid-cell--empty">(' + gPositions[key] + ')</td>';
        } else {
          dfGridHtml += '<td class="ses-grid-cell"></td>';
        }
      }
      dfGridHtml += '</tr>';
    }
    dfGridHtml += '</tbody></table></div>';
  }

  panel.innerHTML = `
    <div class="ses-detail-header">
      <div>
        <div class="ses-detail-label">${escHtml(session.label)}</div>
        <div class="ses-detail-meta">${session.tours} tours · ${currentIds.size} pilote${currentIds.size > 1 ? 's' : ''} assigné${currentIds.size > 1 ? 's' : ''}</div>
      </div>
      <button class="btn btn-secondary btn-sm" id="ses-auto-df-inline">⚡ Auto DF</button>
    </div>

    ${!hasRealStandings ? `<div class="ses-df-notice">⚠️ Pas encore assez de résultats MQ.</div>` : ''}
    ${_dfForfaits.size > 0 ? `<div class="ses-df-notice" style="background:rgba(255,85,0,0.08);border-color:var(--clr-accent)">🚫 ${_dfForfaits.size} forfait(s) déclaré(s)</div>` : ''}

    ${dfGridHtml}

    <div class="ses-df-standings">
      <div class="ses-df-legend">
        <span class="ses-df-pill ses-df-pill--1">DF1</span><span>Places impaires</span>
        <span class="ses-df-pill ses-df-pill--2" style="margin-left:var(--sp-md)">DF2</span><span>Places paires</span>
        <span style="margin-left:auto;font-size:0.72rem;color:var(--clr-text-3)">🚫 = Déclarer forfait</span>
      </div>

      ${assignedStandings.map((p, i) => {
        const pos = i + 1;
        const dfNum = pos % 2 === 1 ? 1 : 2;
        const isInCurrentDf = currentIds.has(p.driverId);
        const isInOtherDf   = otherIds.has(p.driverId);
        let actionBtn = '';
        if (isInCurrentDf) {
          actionBtn = `
            <button class="btn btn-ghost btn-sm ses-df-action" data-action="remove" data-driver-id="${p.driverId}" data-df="${currentDf}">✕</button>
            <button class="btn btn-secondary btn-sm ses-df-action" data-action="swap" data-driver-id="${p.driverId}" data-df="${currentDf}">→ DF${otherDf}</button>`;
        } else if (isInOtherDf) {
          actionBtn = `<button class="btn btn-secondary btn-sm ses-df-action" data-action="swap" data-driver-id="${p.driverId}" data-df="${otherDf}">→ DF${currentDf}</button>`;
        } else {
          actionBtn = `<button class="btn btn-primary btn-sm ses-df-action" data-action="add" data-driver-id="${p.driverId}" data-df="${currentDf}">＋ DF${currentDf}</button>`;
        }
        return `
          <div class="ses-df-row ${isInCurrentDf ? 'ses-df-row--assigned' : ''} ${isInOtherDf ? 'ses-df-row--other' : ''}">
            <span class="ses-df-pos">${pos}</span>
            <span class="ses-df-pill ses-df-pill--${dfNum}">DF${dfNum}</span>
            <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
            <span class="ses-pilot-name">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
            <span class="ses-df-pts">
              ${hasRealStandings && p.totalPoints != null
                ? `${p.totalPoints} <span class="ses-df-pts-label">pts</span>`
                : `<span class="ses-df-pts-pos">(${pos}ème)</span>`}
            </span>
            <span class="ses-df-actions">
              <button class="btn btn-ghost btn-sm ses-forfait-btn" data-driver-id="${p.driverId}" title="Déclarer forfait">🚫</button>
              ${actionBtn}
            </span>
          </div>`;
      }).join('')}

      ${reserveStandings.length > 0 ? `
        <div class="ses-df-row ses-df-row--reserve">
          <span style="grid-column:1/-1;color:var(--clr-text-3);font-size:0.8rem;padding:var(--sp-sm) 0">
            Pilotes ${assignedStandings.length + 1}+ : remplaçants potentiels si forfait
          </span>
        </div>
        ${reserveStandings.map((p, i) => `
          <div class="ses-df-row ses-df-row--reserve">
            <span class="ses-df-pos">${assignedStandings.length + i + 1}</span>
            <span class="ses-df-pill ses-df-pill--reserve">RES</span>
            <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
            <span class="ses-pilot-name">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
            ${hasRealStandings && p.totalPoints != null ? `<span class="ses-df-pts">${p.totalPoints} pts</span>` : ''}
          </div>`).join('')}
      ` : ''}

      ${forfaitStandings.length > 0 ? `
        <div class="ses-df-row ses-df-row--reserve" style="margin-top:var(--sp-sm)">
          <span style="grid-column:1/-1;color:var(--clr-danger);font-size:0.8rem;padding:var(--sp-sm) 0">
            🚫 Forfaits déclarés — non rappelables (sauf annulation)
          </span>
        </div>
        ${forfaitStandings.map(p => `
          <div class="ses-df-row ses-df-row--reserve" style="opacity:0.5">
            <span class="ses-df-pos">—</span>
            <span class="ses-df-pill ses-df-pill--reserve">FRF</span>
            <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
            <span class="ses-pilot-name" style="text-decoration:line-through">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
            ${hasRealStandings && p.totalPoints != null ? `<span class="ses-df-pts">${p.totalPoints} pts</span>` : ''}
            <span class="ses-df-actions">
              <button class="btn btn-secondary btn-sm ses-annuler-forfait-btn" data-driver-id="${p.driverId}">↩ Annuler</button>
            </span>
          </div>`).join('')}
      ` : ''}
    </div>
  `;

  document.getElementById('ses-auto-df-inline')?.addEventListener('click', () => autoAssignDemis());

  panel.querySelectorAll('.ses-forfait-btn').forEach(btn => {
    btn.addEventListener('click', async () => await handleForfait(btn.dataset.driverId));
  });

  panel.querySelectorAll('.ses-annuler-forfait-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driverId = btn.dataset.driverId;
      const driver = _dfStandings.find(p => p.driverId === driverId);
      _dfForfaits.delete(driverId);
      toast(`Forfait annulé — ${driver?.firstName || ''} ${driver?.lastName || ''} est de nouveau disponible`, 'info', 3000);
      await renderDfStandings(panel, session, await getParticipantsData(selectedSessionId));
    });
  });

  panel.querySelectorAll('.ses-df-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driverId  = btn.dataset.driverId;
      const fromDfNum = parseInt(btn.dataset.df);
      const action    = btn.dataset.action;
      const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
      const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
      if (!df1 || !df2) return;
      const fromSession = fromDfNum === 1 ? df1 : df2;
      const toSession   = fromDfNum === 1 ? df2 : df1;
      const driver = (panel._standings || []).find(p => p.driverId === driverId);
      if (!driver) return;
      if (action === 'remove')      await removeParticipant(fromSession.id, driverId);
      else if (action === 'add')    await addParticipant(fromSession.id, driver);
      else if (action === 'swap') { await removeParticipant(fromSession.id, driverId); await addParticipant(toSession.id, driver); }
      await renderDfStandings(panel, session, await getParticipantsData(selectedSessionId));
    });
  });
}

// ─────────────────────────────────────────────────────────
// VUE FINALE — avec gestion forfait
// ─────────────────────────────────────────────────────────

async function renderFinaleStandings(panel, session, assignedParticipants) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  const assignedIds = new Set(assignedParticipants.map(p => p.driverId));

  const getDfResults = async (dfSession) => {
    if (!dfSession) return [];
    const [resSnap, partSnap] = await Promise.all([
      getDocs(query(collection(db, 'results'), where('sessionId', '==', dfSession.id))),
      getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', dfSession.id))),
    ]);
    const resultMap = {};
    resSnap.docs.forEach(d => { resultMap[d.data().driverId] = d.data(); });
    return partSnap.docs.map(d => d.data()).map(p => ({
      driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName, lastName: p.lastName,
      ms: resultMap[p.driverId]?.ms ?? null, status: resultMap[p.driverId]?.status ?? null,
      points: resultMap[p.driverId]?.points ?? null,
    })).sort((a, b) => {
      const order = r => r.ms ? r.ms : r.status === 'DNF' ? 9e6 : 9e9;
      return order(a) - order(b);
    });
  };

  const interimCalc = await calcInterimStandings(db, allSessions, _activeRegulation);
  const interimMap  = {};
  interimCalc.forEach(r => { interimMap[r.driverId] = r.position ?? 999; });
  const getInterimPoints = (driverId) => (interimCalc.find(d => d.driverId === driverId)?.interimPoints ?? 0);

  const df1Results = await getDfResults(df1);
  const df2Results = await getDfResults(df2);

  // Categories a petit effectif : pas de demi-finale, on construit la grille
  // Finale a partir du classement intermediaire directement.
  const noDfMode = df1Results.length === 0 && df2Results.length === 0;

  const champ2 = getActiveChampionship();
  const qualPerDF = champ2?.sessionConfig?.DF?.qualifiedPerDF || 4;

  const df1Qualified    = df1Results.filter(r => r.ms || r.status === 'DNF').slice(0, qualPerDF);
  const df2Qualified    = df2Results.filter(r => r.ms || r.status === 'DNF').slice(0, qualPerDF);
  const df1Replacements = df1Results.filter(r => r.ms || r.status === 'DNF').slice(qualPerDF);
  const df2Replacements = df2Results.filter(r => r.ms || r.status === 'DNF').slice(qualPerDF);

  const maxPairs = Math.max(df1Qualified.length, df2Qualified.length);
  const pairs = [];
  for (let i = 0; i < maxPairs; i++) {
    const d1 = df1Qualified[i] || null;
    const d2 = df2Qualified[i] || null;
    let first = d1, second = d2;
    if (d1 && d2 && (interimMap[d2.driverId] ?? 999) < (interimMap[d1.driverId] ?? 999)) {
      first = d2; second = d1;
    }
    pairs.push({ rank: i + 1, first, second });
  }

  // Tous les remplaçants triés par position DF puis classement intermédiaire
  const allReplacements = [
    ...df1Replacements.map((r, i) => ({ ...r, dfNum: 1, dfPosition: i + qualPerDF + 1 })),
    ...df2Replacements.map((r, i) => ({ ...r, dfNum: 2, dfPosition: i + qualPerDF + 1 })),
  ].map(r => ({ ...r, totalMeetingPoints: (r.points ?? 0) + getInterimPoints(r.driverId) }))
   .sort((a, b) => a.dfPosition !== b.dfPosition
     ? a.dfPosition - b.dfPosition
     : (interimMap[a.driverId] ?? 999) - (interimMap[b.driverId] ?? 999));

  // Forfaits Finale déclarés
  const forfaitFinaleDrivers = assignedParticipants.filter(p => _finForfaits.has(p.driverId));

  const pilotCard = (d, dfNum) => {
    if (!d) return `<div class="ses-fin-empty">—</div>`;
    const isAssigned  = assignedIds.has(d.driverId);
    const isForfait   = _finForfaits.has(d.driverId);
    const interimPos  = interimMap[d.driverId];
    return `
      <div class="ses-fin-pilot ${isAssigned && !isForfait ? 'ses-fin-pilot--assigned' : ''}" ${isForfait ? 'style="opacity:0.4"' : ''}>
        <span class="ses-df-pill ses-df-pill--${dfNum}">DF${dfNum}</span>
        <span class="ses-pilot-num">${escHtml(d.carNumber)}</span>
        <span class="ses-pilot-name" ${isForfait ? 'style="text-decoration:line-through"' : ''}>
          ${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong>
        </span>
        ${interimPos && interimPos < 999 ? `<span class="ses-fin-interim">${interimPos}ème</span>` : ''}
        ${isAssigned && !isForfait ? '<span class="ses-df-check">✓</span>' : ''}
        ${isForfait ? `<span style="font-size:0.75rem;color:var(--clr-danger)">🚫 Forfait</span>` : ''}
        ${!isAssigned && !isForfait ? `
          <button class="btn btn-primary btn-sm ses-df-action" data-action="add" data-driver-id="${d.driverId}" data-df="fin">＋</button>
        ` : isAssigned && !isForfait ? `
          <button class="btn btn-ghost btn-sm ses-fin-forfait-btn" data-driver-id="${d.driverId}" title="Déclarer forfait pour la Finale">🚫</button>
          <button class="btn btn-danger btn-sm ses-df-action" data-action="remove-fin" data-driver-id="${d.driverId}">✕</button>
        ` : ''}
      </div>`;
  };

  // Variante de pilotCard sans pastille DF, utilisee quand on construit la
  // Finale a partir du classement intermediaire (categorie sans demi-finale).
  const interimPilotCard = (d) => {
    if (!d) return `<div class="ses-fin-empty">—</div>`;
    const isAssigned = assignedIds.has(d.driverId);
    const isForfait  = _finForfaits.has(d.driverId);
    return `
      <div class="ses-fin-pilot ${isAssigned && !isForfait ? 'ses-fin-pilot--assigned' : ''}" ${isForfait ? 'style="opacity:0.4"' : ''}>
        <span class="ses-pilot-num">${escHtml(d.carNumber)}</span>
        <span class="ses-pilot-name" ${isForfait ? 'style="text-decoration:line-through"' : ''}>
          ${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong>
        </span>
        ${isAssigned && !isForfait ? '<span class="ses-df-check">✓</span>' : ''}
        ${isForfait ? `<span style="font-size:0.75rem;color:var(--clr-danger)">🚫 Forfait</span>` : ''}
        ${!isAssigned && !isForfait ? `
          <button class="btn btn-primary btn-sm ses-df-action" data-action="add" data-driver-id="${d.driverId}" data-df="fin">＋</button>
        ` : isAssigned && !isForfait ? `
          <button class="btn btn-ghost btn-sm ses-fin-forfait-btn" data-driver-id="${d.driverId}" title="Déclarer forfait pour la Finale">🚫</button>
          <button class="btn btn-danger btn-sm ses-df-action" data-action="remove-fin" data-driver-id="${d.driverId}">✕</button>
        ` : ''}
      </div>`;
  };

  // Build Finale grid display using gridLayout
  let finGridHtml = '';
  const champ3 = getActiveChampionship();
  const finGridLayout = champ3?.sessionConfig?.FIN?.gridLayout;
  if (finGridLayout && finGridLayout.positions && assignedParticipants.length > 0) {
    const gLanes = finGridLayout.lanes || 5;
    const gRows = finGridLayout.rows || 3;
    const gPositions = finGridLayout.positions;

    // Sort by DF position (same order as the qualified pairs list):
    // pair 1 first/second, pair 2 first/second, etc.
    const sortedFinParts = [];
    for (const p of pairs) {
      if (p.first && assignedIds.has(p.first.driverId) && !_finForfaits.has(p.first.driverId)) sortedFinParts.push(p.first);
      if (p.second && assignedIds.has(p.second.driverId) && !_finForfaits.has(p.second.driverId)) sortedFinParts.push(p.second);
    }
    // Ajoute les assignés pas encore placés : ajouts manuels et — SURTOUT quand
    // il n'y a pas de demi-finale — la totalité des finalistes. On les ordonne
    // par classement intermédiaire (meilleure position = pole), sinon la grille
    // sans 1/2 finale suivrait l'ordre d'insertion (les numéros de voiture).
    const pairIds = new Set(sortedFinParts.map(d => d.driverId));
    assignedParticipants
      .filter(p => !pairIds.has(p.driverId) && !_finForfaits.has(p.driverId))
      .sort((a, b) => (interimMap[a.driverId] ?? 999) - (interimMap[b.driverId] ?? 999))
      .forEach(p => sortedFinParts.push(p));

    const gPosToDriver = {};
    let gIdx = 0;
    const gSortedPos = Object.entries(gPositions).sort((a, b) => a[1] - b[1]);
    for (const [key] of gSortedPos) {
      if (gIdx < sortedFinParts.length) gPosToDriver[key] = sortedFinParts[gIdx++];
    }

    finGridHtml = '<div class="ses-grid-display"><div class="ses-grid-title">Grille de depart — Finale</div>';
    finGridHtml += '<table class="ses-grid-table"><thead><tr><th></th>';
    for (let c = 0; c < gLanes; c++) finGridHtml += '<th>C' + (c + 1) + '</th>';
    finGridHtml += '</tr></thead><tbody>';
    for (let r = 0; r < gRows; r++) {
      finGridHtml += '<tr><td class="ses-grid-row-label">L' + (r + 1) + '</td>';
      for (let c = 0; c < gLanes; c++) {
        const key = r + '-' + c;
        const driver = gPosToDriver[key];
        if (driver) {
          finGridHtml += '<td class="ses-grid-cell ses-grid-cell--filled">' +
            '<span class="ses-grid-num">' + escHtml(driver.carNumber) + '</span>' +
            '<span class="ses-grid-name">' + escHtml(driver.lastName) + '</span></td>';
        } else if (gPositions[key]) {
          finGridHtml += '<td class="ses-grid-cell ses-grid-cell--empty">(' + gPositions[key] + ')</td>';
        } else {
          finGridHtml += '<td class="ses-grid-cell"></td>';
        }
      }
      finGridHtml += '</tr>';
    }
    finGridHtml += '</tbody></table></div>';
  }

  panel.innerHTML = `
    <div class="ses-detail-header">
      <div>
        <div class="ses-detail-label">Finale</div>
        <div class="ses-detail-meta">7 tours · ${assignedParticipants.length} pilote${assignedParticipants.length>1?'s':''} assigné${assignedParticipants.length>1?'s':''}</div>
      </div>
      <button class="btn btn-primary btn-sm" id="ses-auto-fin-btn2">⚡ Auto Finale</button>
    </div>

    ${noDfMode && interimCalc.length === 0 ? `
      <div class="ses-df-notice">⚠️ Aucun résultat MQ encore. Chronométrez les manches qualificatives.</div>` : ''}
    ${noDfMode && interimCalc.length > 0 ? `
      <div class="ses-df-notice" style="background:rgba(0,150,255,0.08);border-color:var(--clr-info, #4aa)">
        ℹ️ Pas de demi-finale pour cette catégorie (effectif réduit). Sélectionnez les finalistes depuis le classement intermédiaire ci-dessous.
      </div>` : ''}

    ${_finForfaits.size > 0 ? `
      <div class="ses-df-notice" style="background:rgba(255,85,0,0.08);border-color:var(--clr-accent)">
        🚫 ${_finForfaits.size} forfait(s) déclaré(s) pour la Finale
      </div>` : ''}

    ${finGridHtml}

    ${noDfMode && interimCalc.length > 0 ? `
      <div class="ses-fin-section-title">
        <span>Classement intermédiaire — sélectionnez les finalistes</span>
        <span class="text-muted" style="font-size:0.75rem">🚫 = Déclarer forfait Finale</span>
      </div>
      ${interimCalc.map(d => `
        <div class="ses-fin-pair">
          <span class="ses-fin-rank">${d.position ?? '—'}</span>
          <div class="ses-fin-pair-pilots">${interimPilotCard(d)}</div>
          <span class="ses-fin-total-pts">${d.interimPoints ?? 0} pts</span>
        </div>`).join('')}
    ` : `
      <div class="ses-fin-section-title">
        <span>Qualifi\u00e9s — ${qualPerDF} premiers de chaque \u00bd finale</span>
        <span class="text-muted" style="font-size:0.75rem">🚫 = Déclarer forfait Finale</span>
      </div>

      ${pairs.map(p => `
        <div class="ses-fin-pair">
          <span class="ses-fin-rank">${p.rank}</span>
          <div class="ses-fin-pair-pilots">
            ${pilotCard(p.first,  p.first  === df1Qualified[p.rank-1] || (!df2Qualified[p.rank-1] && p.first) ? 1 : 2)}
            ${p.second ? pilotCard(p.second, p.second === df2Qualified[p.rank-1] || (!df1Qualified[p.rank-1] && p.second) ? 2 : 1) : ''}
          </div>
        </div>`).join('')}
    `}

    ${allReplacements.length > 0 ? `
      <div class="ses-fin-section-title" style="margin-top:var(--sp-lg)">
        Remplaçants potentiels
        <span class="text-muted" style="font-size:0.75rem">triés par position DF puis classement intermédiaire</span>
      </div>
      ${allReplacements.map((d, i) => {
        const isAssigned = assignedIds.has(d.driverId);
        const isForfait  = _finForfaits.has(d.driverId);
        return `
          <div class="ses-fin-pair ${isForfait ? '' : isAssigned ? '' : 'ses-fin-pair--reserve'}">
            <span class="ses-fin-rank ${isForfait || isAssigned ? '' : 'ses-fin-rank--reserve'}">${i+1}</span>
            <div class="ses-fin-pair-pilots">${pilotCard(d, d.dfNum)}</div>
            <span class="ses-fin-total-pts">
              ${d.dfPosition}e DF${d.dfNum}
              <span style="font-size:0.68rem;color:var(--clr-text-3)">· inter. ${interimMap[d.driverId] ?? '?'}e</span>
            </span>
          </div>`;
      }).join('')}
    ` : ''}

    ${forfaitFinaleDrivers.length > 0 ? `
      <div class="ses-fin-section-title" style="margin-top:var(--sp-lg);color:var(--clr-danger)">
        🚫 Forfaits Finale — non rappelables
        <span class="text-muted" style="font-size:0.75rem">Utilisez ↩ Annuler pour corriger une erreur</span>
      </div>
      ${forfaitFinaleDrivers.map(p => `
        <div class="ses-fin-pair" style="opacity:0.4">
          <span class="ses-fin-rank">—</span>
          <div class="ses-fin-pair-pilots">
            <div class="ses-fin-pilot">
              <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
              <span class="ses-pilot-name" style="text-decoration:line-through">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
              <button class="btn btn-secondary btn-sm ses-annuler-fin-forfait-btn" data-driver-id="${p.driverId}"
                style="opacity:1">↩ Annuler</button>
            </div>
          </div>
        </div>`).join('')}
    ` : ''}
  `;

  document.getElementById('ses-auto-fin-btn2')?.addEventListener('click', () => autoAssignFinale());

  // Boutons forfait Finale
  panel.querySelectorAll('.ses-fin-forfait-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await handleFinaleForfait(btn.dataset.driverId, allReplacements, panel, session);
    });
  });

  // Boutons annuler forfait Finale
  panel.querySelectorAll('.ses-annuler-fin-forfait-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driverId = btn.dataset.driverId;
      _finForfaits.delete(driverId);
      toast('Forfait Finale annulé — pilote disponible à nouveau', 'info', 3000);
      const updated = await getParticipantsData(allSessions.find(s => s.type === 'FIN')?.id || '');
      await renderFinaleStandings(panel, session, updated);
    });
  });

  // Boutons assignation manuelle
  panel.querySelectorAll('.ses-df-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driverId = btn.dataset.driverId;
      const action   = btn.dataset.action;
      const fin      = allSessions.find(s => s.type === 'FIN');
      if (!fin) return;
      if (action === 'add') {
        // Recherche dans les resultats DF + le classement intermediaire (pour
        // les categories a petit effectif sans demi-finale).
        const driver = [...df1Results, ...df2Results, ...interimCalc].find(d => d.driverId === driverId);
        if (driver) await addParticipant(fin.id, driver);
      } else if (action === 'remove-fin') {
        await removeParticipant(fin.id, driverId);
      }
      const updated = await getParticipantsData(fin.id);
      await renderFinaleStandings(panel, session, updated);
    });
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initSessions() {
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'sessions') {
      // Charger le reglement DU CHAMPIONNAT SELECTIONNE dans le header,
      // pas celui qui porte le flag isActive en DB. Sinon les calculs
      // (calcInterimStandings, points MQ/DF, etc.) appliquent une autre
      // reglementation que celle visible cote utilisateur → bug observe :
      // page Classement et page DF affichaient des rangs MQ differents
      // pour les memes pilotes (Tuma 12e cote Classement, 13e cote DF).
      // Pattern aligne sur standings.js:27-30.
      try {
        const champId = getActiveChampionshipId();
        _activeRegulation = champId
          ? await getChampionshipConfig(champId)
          : await getChampionshipConfig();
      } catch { _activeRegulation = null; }
      renderView();
      await loadMeetings();
      if (selectedMeetingId && selectedCategory) {
        await loadEngaged();
        await loadSessions();
      }
    }
  });

  // Recharger quand on change de championnat
  document.addEventListener('championshipchange', async () => {
    // Recharger AUSSI le reglement : changement de championnat = potentiellement
    // changement de tiebreaker, baremes de points, EC config, etc. Sinon les
    // calculs en cours (calcInterimStandings, points par session) appliquent
    // la regle du championnat precedemment selectionne.
    try {
      const champId = getActiveChampionshipId();
      _activeRegulation = champId
        ? await getChampionshipConfig(champId)
        : await getChampionshipConfig();
    } catch { _activeRegulation = null; }
    loadMeetings();
  });
}