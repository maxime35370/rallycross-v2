/* ═══════════════════════════════════════════════
   DRIVER-PROFILE.JS — Fiche pilote complète
   Stats par meeting + synthèse saison + courbes
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { escHtml, msToDisplay } from './utils.js';
import { categoryBadge } from './app.js';
import { calcInterimStandings } from './calc.js';

// ─────────────────────────────────────────────────────────
// BARÈMES
// ─────────────────────────────────────────────────────────

function mqPts(pos) {
  if (pos === 1) return 50;
  if (pos === 2) return 45;
  if (pos === 3) return 42;
  if (pos >= 4)  return Math.max(0, 44 - pos);
  return 0;
}
// Inverse de mqPts : retourne la "place equivalente" pour un nombre de points
// donne. Utilise quand un pilote a un statut (DNF, DSQ_RACE...) qui lui donne
// des points mais pas de classement reel. La place equivalente permet de le
// compter dans la moyenne de position au lieu de l'exclure.
function mqPosFromPts(pts) {
  if (pts == null || pts <= 0) return null;
  if (pts >= 50) return 1;
  if (pts === 45) return 2;
  if (pts === 42) return 3;
  if (pts >= 1 && pts <= 40) return 44 - pts;
  return null; // 41..44 : gap dans le bareme, pas d'inverse exact
}
const DF_PTS  = [0, 10, 8, 6, 5, 4, 3, 2, 1];
const FIN_PTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];

// ─────────────────────────────────────────────────────────
// HELPERS FORMATAGE
// ─────────────────────────────────────────────────────────

const fmtPos = pos => pos == null ? '—' : pos === 1 ? '1er' : `${pos}e`;
// Ecart : positif = retard (rouge), negatif = avance (vert), 0 = egalite.
const fmtGap = ms => {
  if (ms == null) return '—';
  if (ms === 0)   return '<span class="dp-gap-zero">0.000s</span>';
  if (ms < 0)     return `<span class="dp-gap-ahead">−${(Math.abs(ms) / 1000).toFixed(3)}s</span>`;
  return `<span class="dp-gap-behind">+${(ms / 1000).toFixed(3)}s</span>`;
};
const fmtPts = pts => pts == null ? '—' : String(pts);

function fmtAvg(arr, dec = 1, suffix = '') {
  const v = arr.filter(x => x != null && !isNaN(x));
  if (!v.length) return '—';
  return (v.reduce((a, b) => a + b, 0) / v.length).toFixed(dec) + suffix;
}

function fmtAvgGap(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  if (!v.length) return '—';
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return fmtGap(avg);
}

// ─────────────────────────────────────────────────────────
// HELPERS CALCUL
// ─────────────────────────────────────────────────────────

function posAndGap(allResults, driverId) {
  const driverRes = allResults.find(r => r.driverId === driverId);
  if (!driverRes)           return { pos: null, gap: null, status: null };
  if (driverRes.status)     return { pos: null, gap: null, status: driverRes.status };
  if (!driverRes.ms)        return { pos: null, gap: null, status: null };

  const finished = allResults.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
  const idx = finished.findIndex(r => r.driverId === driverId);
  // Si le pilote est 1er : gap = avance sur le 2e (negatif).
  // Sinon : gap = retard sur le 1er (positif).
  // S'il est seul a avoir un temps, gap = null (pas de reference).
  let gap = null;
  if (idx === 0) {
    gap = finished[1] ? driverRes.ms - finished[1].ms : null;
  } else if (idx > 0) {
    gap = driverRes.ms - finished[0].ms;
  }
  return { pos: idx + 1 || null, gap, status: null };
}

// ─────────────────────────────────────────────────────────
// FIRESTORE HELPER
// ─────────────────────────────────────────────────────────

async function fsGet(collName, filters) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const constraints = filters.map(([f, op, v]) => where(f, op, v));
  const snap = await getDocs(query(collection(db, collName), ...constraints));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────────────────
// CHARGEMENT DES DONNÉES
// ─────────────────────────────────────────────────────────

async function loadData(driver) {
  const { collection, doc, getDoc, getDocs, query, where } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // 1. Engagements
  const engSnap = await getDocs(query(
    collection(db, 'engagements'),
    where('driverId', '==', driver.id),
    where('year',     '==', driver.year)
  ));
  const engagements = engSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const meetingIds  = [...new Set(engagements.map(e => e.meetingId))];
  if (!meetingIds.length) return { meetingsData: [], regularity: emptyReg() };

  // 2. Meetings
  const meetings = [];
  for (const mid of meetingIds) {
    const mDoc = await getDoc(doc(db, 'meetings', mid));
    if (mDoc.exists()) meetings.push({ id: mDoc.id, ...mDoc.data() });
  }
  meetings.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // 3. Meeting standings (positions finales sauvegardées)
  const mStandSnap = await getDocs(query(
    collection(db, 'meetingStandings'),
    where('driverId', '==', driver.id),
    where('year',     '==', driver.year),
    where('category', '==', driver.category)
  ));
  const mStandMap = {};
  mStandSnap.docs.forEach(d => {
    const data = d.data();
    mStandMap[data.meetingId] = data.position;
  });

  // 4. Pour chaque meeting : sessions + résultats
  const meetingsData = [];

  for (const meeting of meetings) {
    const sessSnap = await getDocs(query(
      collection(db, 'sessions'),
      where('meetingId', '==', meeting.id),
      where('category',  '==', driver.category)
    ));
    const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!sessions.length) continue;

    // Charger results + participants pour toutes les sessions du meeting
    const resultsMap = {};
    const partsMap   = {};
    for (const sess of sessions) {
      const [rSnap, pSnap] = await Promise.all([
        getDocs(query(collection(db, 'results'),             where('sessionId', '==', sess.id))),
        getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', sess.id))),
      ]);
      resultsMap[sess.id] = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      partsMap[sess.id]   = pSnap.docs.map(d => d.data());
    }

    // Classement intermédiaire (calc.js, sans lecture Firestore interimStandings)
    let myInterim = null;
    try {
      const interim = await calcInterimStandings(db, sessions);
      myInterim = interim.find(r => r.driverId === driver.id) || null;
    } catch {}

    const mStats = buildMeetingStats(
      driver.id, meeting, sessions, resultsMap, partsMap,
      myInterim, mStandMap[meeting.id] ?? null
    );
    meetingsData.push(mStats);
  }

  return { meetingsData, regularity: calcReg(meetingsData) };
}

// ─────────────────────────────────────────────────────────
// CONSTRUCTION STATS PAR MEETING
// ─────────────────────────────────────────────────────────

function buildMeetingStats(driverId, meeting, sessions, resultsMap, partsMap, myInterim, meetingPosition) {
  // EC
  const ecSess = sessions.find(s => s.type === 'EC');
  const ecStats = buildEcStats(driverId, ecSess, resultsMap, partsMap);

  // MQ (toujours 4 slots)
  const mqSessions = sessions.filter(s => s.type === 'MQ').sort((a, b) => a.num - b.num);
  const mqStats    = buildMqStats(driverId, mqSessions, resultsMap, partsMap);
  const totalMQPts = mqStats.reduce((s, mq) => s + (mq.pts ?? 0), 0);

  // Intermédiaire
  const interimStats = myInterim
    ? { pos: myInterim.position, pts: myInterim.interimPoints }
    : { pos: null, pts: null };

  // DF
  const dfSessions = sessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  const dfStats    = buildPhaseStats(driverId, dfSessions, resultsMap, partsMap, DF_PTS);

  // Finale
  const finSess  = sessions.find(s => s.type === 'FIN');
  const finStats = buildPhaseStats(driverId, finSess ? [finSess] : [], resultsMap, partsMap, FIN_PTS);

  const totalMeetingPts = (interimStats.pts ?? 0) + (dfStats.pts ?? 0) + (finStats.pts ?? 0);

  return {
    meeting,
    ecStats,
    mqStats,
    totalMQPts,
    interimStats,
    dfStats,
    finStats,
    totalMeetingPts,
    meetingPosition,
  };
}

function buildEcStats(driverId, sess, resultsMap, partsMap) {
  if (!sess) return { pos: null, pts: null, gap: null };
  const parts = partsMap[sess.id] || [];
  if (!parts.some(p => p.driverId === driverId)) return { pos: null, pts: null, gap: null };
  const results = resultsMap[sess.id] || [];
  const { pos, gap } = posAndGap(results, driverId);
  const pts = pos ? Math.max(0, 6 - pos) : 0;
  return { pos, pts: pts > 0 ? pts : null, gap };
}

function buildMqStats(driverId, mqSessions, resultsMap, partsMap) {
  const stats = [];
  for (let i = 0; i < 4; i++) {
    const mq = mqSessions[i];
    if (!mq) { stats.push({ num: i + 1, pos: null, posForAvg: null, pts: null, gap: null, participated: false, status: null }); continue; }

    const parts = partsMap[mq.id] || [];
    if (!parts.some(p => p.driverId === driverId)) {
      stats.push({ num: mq.num, pos: null, posForAvg: null, pts: null, gap: null, participated: false, status: null });
      continue;
    }

    const results   = resultsMap[mq.id] || [];
    const driverRes = results.find(r => r.driverId === driverId);
    const { pos, gap } = posAndGap(results, driverId);
    const lastPts   = mqPts(parts.length);
    const status    = driverRes?.status ?? null;

    let pts = null;
    if (!driverRes || (!driverRes.ms && !status)) {
      pts = null;
    } else if (status === 'DNS' || status === 'DSQ') {
      pts = 0;
    } else if (status === 'DNF') {
      pts = Math.max(0, lastPts - 1);
    } else if (status === 'DSQ_RACE') {
      pts = Math.max(0, lastPts - 3);
    } else if (pos) {
      pts = mqPts(pos);
    }

    // posForAvg = position utilisee pour calculer les moyennes (cumulee meeting
    // et synthese saison). Pour un finisseur, c'est sa position reelle. Pour
    // un DNF/DSQ-EC classe en marquant des points, on utilise la place equi-
    // valente (inverse du bareme) pour ne pas l'exclure de la moyenne.
    const posForAvg = pos ?? mqPosFromPts(pts);

    stats.push({ num: mq.num, pos, posForAvg, pts, gap, participated: true, status });
  }
  return stats;
}

function buildPhaseStats(driverId, sessions, resultsMap, partsMap, ptsArr) {
  // Sessions ou le pilote est inscrit. Un meme pilote peut figurer dans
  // plusieurs DF (ex. reassignation manuelle DF1 -> DF2), avec parfois un
  // statut "vide" ou DNS dans la DF non disputee. On selectionne la session
  // ou le pilote a la donnee la plus "reelle" :
  //  rang 4 = a un chrono finisseur
  //  rang 3 = DNF classe (manualPosition)
  //  rang 2 = un statut quelconque (DNS/DSQ/DNF sans pos)
  //  rang 1 = inscrit sans aucun resultat
  const candidates = sessions
    .filter(sess => (partsMap[sess.id] || []).some(p => p.driverId === driverId))
    .map(sess => {
      const r = (resultsMap[sess.id] || []).find(x => x.driverId === driverId);
      let rank = 1;
      if (r?.ms != null) rank = 4;
      else if (r?.status === 'DNF' && r?.manualPosition) rank = 3;
      else if (r?.status) rank = 2;
      return { sess, rank };
    })
    .sort((a, b) => b.rank - a.rank);

  if (candidates.length === 0) {
    return { pos: null, pts: null, gap: null, status: null, participated: false };
  }

  const sess = candidates[0].sess;
  const results   = resultsMap[sess.id] || [];
  const driverRes = results.find(r => r.driverId === driverId);
  const { pos: actualPos, gap } = posAndGap(results, driverId);
  const status    = driverRes?.status ?? null;

  // DNF avec position manuelle : on conserve la position pour le bareme.
  const manualPos = (status === 'DNF' && driverRes?.manualPosition) ? driverRes.manualPosition : null;
  const pos = actualPos ?? manualPos;

  let pts = null;
  if (manualPos != null)          pts = ptsArr[manualPos] ?? 0;
  else if (status === 'DSQ_RACE') pts = 1;
  else if (status)                pts = 0;
  else if (pos)                   pts = ptsArr[pos] ?? 0;

  return { pos, pts, gap, status, participated: true };
}

// ─────────────────────────────────────────────────────────
// RÉGULARITÉ
// ─────────────────────────────────────────────────────────

function emptyReg() { return { total: 0, finished: 0, dnf: 0, dns: 0, dsq: 0, pct: 0 }; }

function calcReg(meetingsData) {
  let total = 0, finished = 0, dnf = 0, dns = 0, dsq = 0;
  const count = (status) => {
    total++;
    if (!status)                          finished++;
    else if (status === 'DNF')            dnf++;
    else if (status === 'DNS')            dns++;
    else                                  dsq++;
  };
  for (const m of meetingsData) {
    m.mqStats.forEach(mq => { if (mq.participated) count(mq.status); });
    if (m.dfStats.participated)  count(m.dfStats.status);
    if (m.finStats.participated) count(m.finStats.status);
  }
  return { total, finished, dnf, dns, dsq, pct: total ? Math.round((finished / total) * 100) : 0 };
}

// ─────────────────────────────────────────────────────────
// STATS SAISON
// ─────────────────────────────────────────────────────────

function buildSeasonStats(meetingsData) {
  const ecPos = [], ecPts = [], ecGap = [];
  const mqPos = [], mqPts_a = [], mqGap = [], mqTotalPts = [];
  let mqWins = 0, mqPodiums = 0;
  const intPos = [], intPts = [];
  const dfPos = [], dfPts_a = [], dfGap = [];
  let dfWins = 0, dfPodiums = 0;
  const finPos = [], finPts_a = [], finGap = [];
  let finWins = 0, finPodiums = 0;
  const totPts = [], totPos = [];
 
  for (const m of meetingsData) {
 
    // ← MODIFIÉ : ne compter ce meeting que si au moins 1 résultat réel saisi en MQ
    const hasRealResults = m.mqStats.some(mq =>
      mq.participated && (mq.pts !== null || mq.status !== null)
    );
 
    // EC — OK tel quel car pos est null si pas de temps
    if (m.ecStats.pos != null) ecPos.push(m.ecStats.pos);
    if (m.ecStats.pts != null) ecPts.push(m.ecStats.pts);
    if (m.ecStats.gap != null) ecGap.push(m.ecStats.gap);
 
    // MQ — uniquement si résultats réels
    if (hasRealResults) {
      mqTotalPts.push(m.totalMQPts); // ← MODIFIÉ : conditionné à hasRealResults
 
      for (const mq of m.mqStats) {
        if (!mq.participated) continue;
        if (mq.pts === null) continue; // ← MODIFIÉ : ignorer si pas de résultat réel
        // Moy. position : on prend posForAvg (inclut la place equivalente
        // d'un DNF qui marque des points) pour ne pas exclure les DNF
        // classes. Les victoires/podiums restent bases sur la vraie position.
        if (mq.posForAvg != null) mqPos.push(mq.posForAvg);
        if (mq.pos === 1) mqWins++;
        if (mq.pos != null && mq.pos <= 3) mqPodiums++;
        if (mq.pts != null) mqPts_a.push(mq.pts);
        if (mq.gap != null) mqGap.push(mq.gap);
      }
    }
 
    // Intermédiaire — OK car pos/pts null si pas calculé
    if (m.interimStats.pos != null) intPos.push(m.interimStats.pos);
    if (m.interimStats.pts != null) intPts.push(m.interimStats.pts);
 
    // DF — pos est la position dans la demi du pilote (DF1 ou DF2).
    // Une victoire en demi = victoire de serie qui compte ici.
    if (m.dfStats.participated) {
      if (m.dfStats.pos != null) {
        dfPos.push(m.dfStats.pos);
        if (m.dfStats.pos === 1) dfWins++;
        if (m.dfStats.pos <= 3) dfPodiums++;
      }
      if (m.dfStats.pts != null) dfPts_a.push(m.dfStats.pts);
      if (m.dfStats.gap != null) dfGap.push(m.dfStats.gap);
    }
 
    // Finale
    if (m.finStats.participated) {
      if (m.finStats.pos != null) {
        finPos.push(m.finStats.pos);
        if (m.finStats.pos === 1) finWins++;
        if (m.finStats.pos <= 3) finPodiums++;
      }
      if (m.finStats.pts != null) finPts_a.push(m.finStats.pts);
      if (m.finStats.gap != null) finGap.push(m.finStats.gap);
    }
 
    // Total meeting — ← MODIFIÉ : conditionné à hasRealResults
    if (hasRealResults) {
      totPts.push(m.totalMeetingPts);
      if (m.meetingPosition != null) totPos.push(m.meetingPosition);
    }
  }
 
  return {
    ec:     { avgPos: avg(ecPos), avgPts: avg(ecPts), avgGap: avg(ecGap) },
    mq:     { avgPos: avg(mqPos), avgPts: avg(mqPts_a), avgGap: avg(mqGap), avgTotalPts: avg(mqTotalPts), wins: mqWins, podiums: mqPodiums },
    intern: { avgPos: avg(intPos), avgPts: avg(intPts) },
    df:     { avgPos: avg(dfPos), avgPts: avg(dfPts_a), avgGap: avg(dfGap), wins: dfWins, podiums: dfPodiums },
    fin:    { avgPos: avg(finPos), avgPts: avg(finPts_a), avgGap: avg(finGap), wins: finWins, podiums: finPodiums },
    total:  { avgPts: avg(totPts), avgPos: avg(totPos) },
  };
}

function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ─────────────────────────────────────────────────────────
// RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────

export async function showDriverProfile(driver) {
  let overlay = document.getElementById('dp-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dp-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="dp-container">
      <button class="dp-back" id="dp-back-btn">← Retour aux pilotes</button>
      <div class="dp-loading"><div class="spinner"></div> Chargement de la fiche…</div>
    </div>`;
  overlay.classList.add('is-open');
  document.getElementById('dp-back-btn')?.addEventListener('click', () => overlay.classList.remove('is-open'));

  try {
    const { meetingsData, regularity } = await loadData(driver);
    const seasonStats = buildSeasonStats(meetingsData);
    const totalPoints = meetingsData.reduce((s, m) => s + (m.totalMeetingPts ?? 0), 0);

    overlay.innerHTML = `
      <div class="dp-container">
        <button class="dp-back" id="dp-back-btn">← Retour aux pilotes</button>

        <!-- HEADER -->
        <div class="dp-header">
          <div class="dp-driver-info">
            <span class="dp-car-num">${escHtml(driver.carNumber)}</span>
            <div>
              <div class="dp-name">${escHtml(driver.firstName)} <strong>${escHtml(driver.lastName)}</strong></div>
              <div class="dp-meta">${categoryBadge(driver.category)} · Saison ${driver.year}</div>
            </div>
          </div>
          <div class="dp-kpis">
            <div class="dp-kpi">
              <div class="dp-kpi-val">${meetingsData.length}</div>
              <div class="dp-kpi-lbl">Meetings</div>
            </div>
            <div class="dp-kpi">
              <div class="dp-kpi-val">${totalPoints}</div>
              <div class="dp-kpi-lbl">Points totaux</div>
            </div>
            <div class="dp-kpi dp-kpi--reg"
              title="${regularity.total} courses · ${regularity.finished} finitions · ${regularity.dnf} DNF · ${regularity.dns} DNS · ${regularity.dsq} DSQ/DQ">
              <div class="dp-kpi-val">${regularity.pct}<span style="font-size:0.7em">%</span></div>
              <div class="dp-kpi-lbl">Courses finies ℹ️</div>
            </div>
          </div>
        </div>

        <!-- TABLE -->
        <div class="dp-table-wrap">
          ${renderTable(meetingsData, seasonStats)}
        </div>

        <!-- CHARTS -->
        <div class="dp-charts">
          ${renderCharts(meetingsData)}
        </div>
      </div>
    `;

    document.getElementById('dp-back-btn')?.addEventListener('click', () => overlay.classList.remove('is-open'));

  } catch (err) {
    console.error(err);
    overlay.querySelector('.dp-loading').innerHTML = `<span style="color:var(--clr-danger)">⚠️ Erreur de chargement</span>`;
  }
}

// ─────────────────────────────────────────────────────────
// RENDU TABLEAU
// ─────────────────────────────────────────────────────────

function renderTable(meetingsData, s) {
  const td  = (val, cls = '')   => `<td class="dp-td center ${cls}">${val ?? '—'}</td>`;
  const tdPos = (pos, cls = '') => td(pos == null ? '<span class="dp-na">—</span>' : `<span class="dp-pos">${fmtPos(pos)}</span>`, cls);
  const tdPts = (pts, cls = '') => td(pts == null ? '<span class="dp-na">—</span>' : `<span class="dp-pts-val">${pts}</span>`, cls);
  const tdGap = (ms,  cls = '') => td(fmtGap(ms), cls);
  const tdNA  = (cls = '')      => td('<span class="dp-na">—</span>', cls);

  // Calcul des moyennes cumulees MQ pour un meeting : a la fin de chaque
  // manche k (1..4), on prend la moyenne sur les manches 1..k disputees
  // (uniquement celles avec une valeur valide).
  const cumAvg = (mqStats, getter) => {
    const out = [];
    const acc = [];
    for (const mq of mqStats) {
      const v = mq.participated ? getter(mq) : null;
      if (v != null) acc.push(v);
      out.push(acc.length ? acc.reduce((a, b) => a + b, 0) / acc.length : null);
    }
    return out;
  };

  // Lignes par meeting
  const meetingRows = meetingsData.map(m => {
    const date = m.meeting.date
      ? new Date(m.meeting.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
      : '?';

    // Moy. cumulee de position : on prend posForAvg (qui inclut la place
    // equivalente d'un DNF qui a marque des points) pour ne pas l'exclure.
    const cumPos  = cumAvg(m.mqStats, mq => mq.posForAvg);
    const cumPts  = cumAvg(m.mqStats, mq => mq.pts);
    const cumGap  = cumAvg(m.mqStats, mq => mq.gap);

    return `
      <tr class="dp-meeting-label">
        <td colspan="11" class="dp-meeting-title">📅 ${date} — ${escHtml(m.meeting.location || '?')}</td>
      </tr>
      <tr class="dp-sub-row dp-pos-row">
        <td class="dp-row-label">Position</td>
        ${tdPos(m.ecStats.pos)}
        ${m.mqStats.map(mq => tdPos(mq.pos)).join('')}
        ${tdNA()}
        ${tdPos(m.interimStats.pos, 'dp-interim-col')}
        ${tdPos(m.dfStats.pos)}
        ${tdPos(m.finStats.pos)}
        ${tdPos(m.meetingPosition, 'dp-total-col')}
      </tr>
      <tr class="dp-sub-row dp-pts-row">
        <td class="dp-row-label">Points</td>
        ${tdPts(m.ecStats.pts)}
        ${m.mqStats.map(mq => tdPts(mq.pts)).join('')}
        ${td(`<strong>${m.totalMQPts}</strong>`)}
        ${tdPts(m.interimStats.pts, 'dp-interim-col')}
        ${tdPts(m.dfStats.pts)}
        ${tdPts(m.finStats.pts)}
        ${td(`<strong class="dp-total-pts">${m.totalMeetingPts}</strong>`, 'dp-total-col')}
      </tr>
      <tr class="dp-sub-row dp-gap-row">
        <td class="dp-row-label">Écart 1er</td>
        ${tdGap(m.ecStats.gap)}
        ${m.mqStats.map(mq => tdGap(mq.gap)).join('')}
        ${tdNA()}
        ${tdNA('dp-interim-col')}
        ${tdGap(m.dfStats.gap)}
        ${tdGap(m.finStats.gap)}
        ${tdNA('dp-total-col')}
      </tr>
      <tr class="dp-sub-row dp-cum-row" title="Moyennes cumulees au fil du week-end (manches 1, 1-2, 1-3, 1-4)">
        <td class="dp-row-label">Moy. cumulée pos.</td>
        ${tdNA()}
        ${cumPos.map(v => td(v == null ? '<span class="dp-na">—</span>' : `<span class="dp-pos">${v.toFixed(1)}e</span>`)).join('')}
        ${tdNA()}
        ${tdNA('dp-interim-col')}
        ${tdNA()}
        ${tdNA()}
        ${tdNA('dp-total-col')}
      </tr>
      <tr class="dp-sub-row dp-cum-row">
        <td class="dp-row-label">Moy. cumulée pts</td>
        ${tdNA()}
        ${cumPts.map(v => td(v == null ? '<span class="dp-na">—</span>' : `<span class="dp-pts-val">${v.toFixed(1)}</span>`)).join('')}
        ${tdNA()}
        ${tdNA('dp-interim-col')}
        ${tdNA()}
        ${tdNA()}
        ${tdNA('dp-total-col')}
      </tr>
      <tr class="dp-sub-row dp-cum-row">
        <td class="dp-row-label">Moy. cumulée écart</td>
        ${tdNA()}
        ${cumGap.map(v => td(fmtGap(v))).join('')}
        ${tdNA()}
        ${tdNA('dp-interim-col')}
        ${tdNA()}
        ${tdNA()}
        ${tdNA('dp-total-col')}
      </tr>
    `;
  }).join('');

  // Lignes synthèse saison
  const fmtP = v => v == null ? '—' : v.toFixed(1) + 'e';
  const fmtA = (v, d = 1) => v == null ? '—' : v.toFixed(d);
  // fmtG reutilise fmtGap (couleurs vert/rouge selon signe).
  const fmtG = v => fmtGap(v);

  // Synthese : une seule colonne MQ qui couvre les 4 sous-colonnes MQ1..MQ4
  // (colspan=4) car les valeurs moyennes sont identiques pour ces 4 colonnes.
  const tdMq = (val, cls = '') => `<td class="dp-td center dp-synth-mq ${cls}" colspan="4">${val ?? '—'}</td>`;
  const synthRows = `
    <tr class="dp-synth-label">
      <td colspan="11" class="dp-synth-title">📊 Synthèse saison</td>
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Moy. position</td>
      ${td(fmtP(s.ec.avgPos))}
      ${tdMq(fmtP(s.mq.avgPos))}
      ${tdNA()}
      ${td(fmtP(s.intern.avgPos), 'dp-interim-col')}
      ${td(fmtP(s.df.avgPos))}
      ${td(fmtP(s.fin.avgPos))}
      ${td(fmtP(s.total.avgPos), 'dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Moy. points</td>
      ${td(fmtA(s.ec.avgPts))}
      ${tdMq(fmtA(s.mq.avgPts))}
      ${td(fmtA(s.mq.avgTotalPts, 0))}
      ${td(fmtA(s.intern.avgPts), 'dp-interim-col')}
      ${td(fmtA(s.df.avgPts))}
      ${td(fmtA(s.fin.avgPts))}
      ${td(fmtA(s.total.avgPts, 0), 'dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Moy. écart 1er</td>
      ${td(fmtG(s.ec.avgGap))}
      ${tdMq(fmtG(s.mq.avgGap))}
      ${tdNA()}
      ${tdNA('dp-interim-col')}
      ${td(fmtG(s.df.avgGap))}
      ${td(fmtG(s.fin.avgGap))}
      ${tdNA('dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Victoires</td>
      ${tdNA()}
      ${tdMq(s.mq.wins)}
      ${tdNA()}
      ${tdNA('dp-interim-col')}
      ${td(s.df.wins)}
      ${td(s.fin.wins)}
      ${tdNA('dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Podiums</td>
      ${tdNA()}
      ${tdMq(s.mq.podiums)}
      ${tdNA()}
      ${tdNA('dp-interim-col')}
      ${td(s.df.podiums)}
      ${td(s.fin.podiums)}
      ${tdNA('dp-total-col')}
    </tr>
  `;

  return `
    <table class="dp-table">
      <thead>
        <tr>
          <th class="dp-th-meeting">Meeting</th>
          <th class="center">EC</th>
          <th class="center">MQ1</th>
          <th class="center">MQ2</th>
          <th class="center">MQ3</th>
          <th class="center">MQ4</th>
          <th class="center">Total MQ</th>
          <th class="center dp-interim-col">Intermédiaire</th>
          <th class="center">½ Finale</th>
          <th class="center">Finale</th>
          <th class="center dp-total-col">Total meeting</th>
        </tr>
      </thead>
      <tbody>
        ${meetingRows}
        ${synthRows}
      </tbody>
    </table>
  `;
}

// ─────────────────────────────────────────────────────────
// COURBES DE PROGRESSION
// ─────────────────────────────────────────────────────────

function renderCharts(meetingsData) {
  if (meetingsData.length < 2) return `
    <div class="dp-charts-placeholder">
      📈 Progression disponible à partir de 2 meetings
    </div>`;

  // Données
  const labels = meetingsData.map(m => {
    const d = m.meeting.date
      ? new Date(m.meeting.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
      : '?';
    return `${d}\n${(m.meeting.location || '').split(' ')[0]}`;
  });

  // Cumul points
  let cumul = 0;
  const cumulPts = meetingsData.map(m => { cumul += m.totalMeetingPts ?? 0; return cumul; });

  // Points par meeting
  const meetingPts = meetingsData.map(m => m.totalMeetingPts ?? 0);

  return `
    <div class="dp-charts-grid">
      <div class="dp-chart-box">
        <div class="dp-chart-title">📈 Points cumulés au championnat</div>
        ${svgLineChart(cumulPts, labels, { color: 'var(--clr-accent-2)', minY: 0, yLabel: 'pts' })}
      </div>
      <div class="dp-chart-box">
        <div class="dp-chart-title">🏆 Points par meeting</div>
        ${svgBarChart(meetingPts, labels, { color: 'var(--clr-accent)', yLabel: 'pts' })}
      </div>
    </div>
  `;
}

function svgLineChart(values, labels, opts = {}) {
  const W = 560, H = 160;
  const PAD = { top: 20, right: 20, bottom: 36, left: 44 };
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top - PAD.bottom;

  const minV = opts.minY ?? Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const n = values.length;
  const xStep = n > 1 ? pw / (n - 1) : pw;

  const toX = i => PAD.left + (n > 1 ? i * xStep : pw / 2);
  const toY = v => PAD.top + ph - ((v - minV) / range) * ph;

  const pts = values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
  const area = `M${toX(0)},${toY(minV)} L${toX(0)},${toY(values[0])} ` +
    values.slice(1).map((v, i) => `L${toX(i + 1)},${toY(v)}`).join(' ') +
    ` L${toX(n - 1)},${toY(minV)} Z`;

  // Gridlines
  const nGrid = 4;
  const gridLines = Array.from({ length: nGrid + 1 }, (_, i) => {
    const v = minV + (range / nGrid) * i;
    const y = toY(v);
    return `
      <line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="var(--clr-border)" stroke-width="0.5"/>
      <text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="var(--clr-text-3)">${Math.round(v)}</text>
    `;
  }).join('');

  const dots = values.map((v, i) => `
    <circle cx="${toX(i)}" cy="${toY(v)}" r="4" fill="${opts.color || '#ff5500'}" stroke="var(--clr-bg)" stroke-width="2"/>
    <text x="${toX(i)}" y="${toY(v) - 8}" text-anchor="middle" font-size="9" fill="var(--clr-text-2)" font-weight="600">${v}</text>
  `).join('');

  const xlabels = labels.map((lbl, i) => {
    const parts = lbl.split('\n');
    return `
      <text x="${toX(i)}" y="${H - PAD.bottom + 14}" text-anchor="middle" font-size="9" fill="var(--clr-text-3)">${parts[0]}</text>
      <text x="${toX(i)}" y="${H - PAD.bottom + 24}" text-anchor="middle" font-size="8" fill="var(--clr-text-3)">${parts[1] || ''}</text>
    `;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="dp-svg">
    ${gridLines}
    <path d="${area}" fill="${opts.color || '#ff5500'}" fill-opacity="0.08"/>
    <polyline points="${pts}" fill="none" stroke="${opts.color || '#ff5500'}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    ${xlabels}
  </svg>`;
}

function svgBarChart(values, labels, opts = {}) {
  const W = 560, H = 160;
  const PAD = { top: 20, right: 20, bottom: 36, left: 44 };
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top - PAD.bottom;

  const maxV = Math.max(...values, 1);
  const n = values.length;
  const barW = Math.min(40, (pw / n) * 0.6);
  const gap  = pw / n;

  const toX = i => PAD.left + gap * i + gap / 2;
  const toH = v => (v / maxV) * ph;

  const nGrid = 4;
  const gridLines = Array.from({ length: nGrid + 1 }, (_, i) => {
    const v = Math.round((maxV / nGrid) * i);
    const y = PAD.top + ph - (v / maxV) * ph;
    return `
      <line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="var(--clr-border)" stroke-width="0.5"/>
      <text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="var(--clr-text-3)">${v}</text>
    `;
  }).join('');

  const bars = values.map((v, i) => {
    const x = toX(i) - barW / 2;
    const h = toH(v);
    const y = PAD.top + ph - h;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3"
        fill="${opts.color || '#ff5500'}" fill-opacity="0.75"/>
      <text x="${toX(i)}" y="${y - 4}" text-anchor="middle" font-size="9" fill="var(--clr-text-2)" font-weight="600">${v}</text>
    `;
  }).join('');

  const xlabels = labels.map((lbl, i) => {
    const parts = lbl.split('\n');
    return `
      <text x="${toX(i)}" y="${H - PAD.bottom + 14}" text-anchor="middle" font-size="9" fill="var(--clr-text-3)">${parts[0]}</text>
      <text x="${toX(i)}" y="${H - PAD.bottom + 24}" text-anchor="middle" font-size="8" fill="var(--clr-text-3)">${parts[1] || ''}</text>
    `;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="dp-svg">
    ${gridLines}
    ${bars}
    ${xlabels}
  </svg>`;
}