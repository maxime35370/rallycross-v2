/* ═══════════════════════════════════════════════
   SESSIONS.JS — Assignation des pilotes aux sessions
   EC/MQ : auto + retrait manuel
   DF1/DF2 : répartition alternée depuis classement intermédiaire
   Finale : top 4 de chaque DF + remplaçant si forfait
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml } from './utils.js';
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
  const { collection, addDoc, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const driverId = driver.id || driver.driverId;
  const snap = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  ));
  if (!snap.empty) return;

  const targetSession = allSessions.find(s => s.id === sessionId);
  if (targetSession?.type === 'DF') {
    const otherDf = allSessions.find(s => s.type === 'DF' && s.id !== sessionId);
    if (otherDf && sessionParticipants[otherDf.id]?.has(driverId)) return;
  }

  await addDoc(collection(db, 'sessionParticipants'), {
    sessionId,
    meetingId:  selectedMeetingId,
    category:   selectedCategory,
    year:       selectedYear,
    driverId,
    carNumber:  driver.carNumber,
    firstName:  driver.firstName,
    lastName:   driver.lastName,
    createdAt:  new Date(),
  });
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
  };
  await clearDf(df1.id);
  await clearDf(df2.id);

  // Nombre de pilotes par DF selon le reglement
  const champ = getActiveChampionship();
  const dfGridSize = champ?.sessionConfig?.DF?.gridSize || 8;
  const nbDF = champ?.sessionConfig?.DF?.count || 2;
  const totalDfSlots = dfGridSize * nbDF;

  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  const topN = ranked.slice(0, totalDfSlots);
  for (let i = 0; i < topN.length; i++) {
    const dfIdx = i % dfSessions.length;
    await addParticipant(dfSessions[dfIdx].id, topN[i]);
  }

  if (fin && finHasData) {
    const { collection: fc2, query: fq2, where: fw2, getDocs: fgd2, writeBatch: fwb2 } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await fgd2(fq2(fc2(db, col), fw2('sessionId', '==', fin.id)));
      if (!snap.empty) { const b = fwb2(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
    toast(`${top16.length} pilotes répartis en DF1/DF2 ✓ — Finale vidée, relancez Auto Finale`, 'success', 5000);
  } else {
    toast(`${top16.length} pilotes répartis en DF1/DF2 ✓`, 'success');
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

  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  const fin = allSessions.find(s => s.type === 'FIN');
  if (!df1 || !df2 || !fin) { toast('Sessions introuvables', 'error'); return; }

  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Nombre de qualifies par DF selon le reglement
  const champ = getActiveChampionship();
  const qualPerDF = champ?.sessionConfig?.DF?.qualifiedPerDF || 4;

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

  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  const allDfQualified = [];
  for (const df of dfSessions) {
    const topN = await getTopN(df);
    allDfQualified.push(...topN);
  }
  if (allDfQualified.length === 0) {
    toast('Aucun résultat de DF disponible.', 'warning'); return;
  }

  const finalistes = allDfQualified;
  const finResultsSnap = await getDocs(query(collection(db, 'results'), where('sessionId', '==', fin.id)));
  const finPartSnap    = await getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', fin.id)));
  const names = finalistes.map(d => `#${d.carNumber} ${d.lastName}`).join(', ');

  if (!finResultsSnap.empty) {
    if (!window.confirm(`⚠️ Des temps existent en Finale !\n${finResultsSnap.size} résultat(s) seront supprimés.\n\nRemplacer par :\n${names}\n\nContinuer ?`)) return;
  } else if (!finPartSnap.empty) {
    if (!window.confirm(`⚡ Auto Finale va assigner :\n${names}\n\nContinuer ?`)) return;
  }

  for (const col of ['sessionParticipants', 'results']) {
    const snap = await getDocs(query(collection(db, col), where('sessionId', '==', fin.id)));
    if (!snap.empty) { const b = writeBatch(db); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
  }
  for (const d of finalistes) await addParticipant(fin.id, d);
  toast(`${finalistes.length} finalistes assignés ✓`, 'success');
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

  if (session.type === 'DF')  { await renderDfStandings(panel, session, participants); return; }
  if (session.type === 'FIN') { await renderFinaleStandings(panel, session, participants); return; }

  const notAssigned = engagedDrivers.filter(d => {
    const id = d.id || d.driverId;
    return !participantIds.has(id) && !otherDfIds.has(id);
  });
  const isEcOrMq = session.type === 'EC' || session.type === 'MQ';

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
            <button class="btn btn-danger btn-sm ses-remove-btn" data-driver-id="${p.driverId}">✕</button>
          </div>`).join('')}
    </div>
    ${notAssigned.length > 0 ? `
      <div class="ses-detail-section">
        <div class="ses-section-title"><span class="eng-group-dot eng-group-dot--off"></span>Non assignés (${notAssigned.length})</div>
        ${notAssigned.map(d => `
          <div class="ses-pilot-row ses-pilot-row--dim">
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

async function renderDfStandings(panel, session, assignedParticipants) {
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
            Pilotes 17+ : remplaçants potentiels si forfait
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

  const df1Qualified    = df1Results.filter(r => r.ms || r.status === 'DNF').slice(0, 4);
  const df2Qualified    = df2Results.filter(r => r.ms || r.status === 'DNF').slice(0, 4);
  const df1Replacements = df1Results.filter(r => r.ms || r.status === 'DNF').slice(4);
  const df2Replacements = df2Results.filter(r => r.ms || r.status === 'DNF').slice(4);

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
    ...df1Replacements.map((r, i) => ({ ...r, dfNum: 1, dfPosition: i + 5 })),
    ...df2Replacements.map((r, i) => ({ ...r, dfNum: 2, dfPosition: i + 5 })),
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

  panel.innerHTML = `
    <div class="ses-detail-header">
      <div>
        <div class="ses-detail-label">Finale</div>
        <div class="ses-detail-meta">7 tours · ${assignedParticipants.length} pilote${assignedParticipants.length>1?'s':''} assigné${assignedParticipants.length>1?'s':''}</div>
      </div>
      <button class="btn btn-primary btn-sm" id="ses-auto-fin-btn2">⚡ Auto Finale</button>
    </div>

    ${df1Results.length === 0 && df2Results.length === 0 ? `
      <div class="ses-df-notice">⚠️ Aucun résultat de DF. Chronométrez les DF d'abord.</div>` : ''}

    ${_finForfaits.size > 0 ? `
      <div class="ses-df-notice" style="background:rgba(255,85,0,0.08);border-color:var(--clr-accent)">
        🚫 ${_finForfaits.size} forfait(s) déclaré(s) pour la Finale
      </div>` : ''}

    <div class="ses-fin-section-title">
      <span>Qualifiés — 4 premiers de chaque ½ finale</span>
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
        const driver = [...df1Results, ...df2Results].find(d => d.driverId === driverId);
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
      try { _activeRegulation = await getChampionshipConfig(); } catch { _activeRegulation = null; }
      renderView();
      await loadMeetings();
      if (selectedMeetingId && selectedCategory) {
        await loadEngaged();
        await loadSessions();
      }
    }
  });

  // Recharger quand on change de championnat
  document.addEventListener('championshipchange', () => {
    loadMeetings();
  });
}