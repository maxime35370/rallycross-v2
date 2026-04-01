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
const DF_PTS  = [0, 10, 8, 6, 5, 4, 3, 2, 1];
const FIN_PTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];

// ─────────────────────────────────────────────────────────
// HELPERS FORMATAGE
// ─────────────────────────────────────────────────────────

const fmtPos = pos => pos == null ? '—' : pos === 1 ? '1er' : `${pos}e`;
const fmtGap = ms  => ms  == null ? '—' : ms === 0 ? '<span class="dp-winner">●</span>' : `+${(ms / 1000).toFixed(3)}s`;
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
  return avg === 0 ? '0.000s' : `+${(avg / 1000).toFixed(3)}s`;
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
  const gap = finished[0] ? driverRes.ms - finished[0].ms : null;
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
    if (!mq) { stats.push({ num: i + 1, pos: null, pts: null, gap: null, participated: false, status: null }); continue; }

    const parts = partsMap[mq.id] || [];
    if (!parts.some(p => p.driverId === driverId)) {
      stats.push({ num: mq.num, pos: null, pts: null, gap: null, participated: false, status: null });
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

    stats.push({ num: mq.num, pos, pts, gap, participated: true, status });
  }
  return stats;
}

function buildPhaseStats(driverId, sessions, resultsMap, partsMap, ptsArr) {
  for (const sess of sessions) {
    const parts = partsMap[sess.id] || [];
    if (!parts.some(p => p.driverId === driverId)) continue;

    const results   = resultsMap[sess.id] || [];
    const driverRes = results.find(r => r.driverId === driverId);
    const { pos, gap } = posAndGap(results, driverId);
    const status    = driverRes?.status ?? null;

    let pts = null;
    if (status === 'DSQ_RACE') pts = 1;
    else if (status)           pts = 0;
    else if (pos)              pts = ptsArr[pos] ?? 0;

    return { pos, pts, gap, status, participated: true };
  }
  return { pos: null, pts: null, gap: null, status: null, participated: false };
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
  const finPos = [], finPts_a = [], finGap = [];
  let finWins = 0, finPodiums = 0;
  const totPts = [], totPos = [];

  for (const m of meetingsData) {
    if (m.ecStats.pos != null) ecPos.push(m.ecStats.pos);
    if (m.ecStats.pts != null) ecPts.push(m.ecStats.pts);
    if (m.ecStats.gap != null) ecGap.push(m.ecStats.gap);

    mqTotalPts.push(m.totalMQPts);
    for (const mq of m.mqStats) {
      if (!mq.participated) continue;
      if (mq.pos != null) { mqPos.push(mq.pos); if (mq.pos === 1) mqWins++; if (mq.pos <= 3) mqPodiums++; }
      if (mq.pts != null) mqPts_a.push(mq.pts);
      if (mq.gap != null) mqGap.push(mq.gap);
    }

    if (m.interimStats.pos != null) intPos.push(m.interimStats.pos);
    if (m.interimStats.pts != null) intPts.push(m.interimStats.pts);

    if (m.dfStats.participated) {
      if (m.dfStats.pos != null) dfPos.push(m.dfStats.pos);
      if (m.dfStats.pts != null) dfPts_a.push(m.dfStats.pts);
      if (m.dfStats.gap != null) dfGap.push(m.dfStats.gap);
    }

    if (m.finStats.participated) {
      if (m.finStats.pos != null) { finPos.push(m.finStats.pos); if (m.finStats.pos === 1) finWins++; if (m.finStats.pos <= 3) finPodiums++; }
      if (m.finStats.pts != null) finPts_a.push(m.finStats.pts);
      if (m.finStats.gap != null) finGap.push(m.finStats.gap);
    }

    totPts.push(m.totalMeetingPts);
    if (m.meetingPosition != null) totPos.push(m.meetingPosition);
  }

  return {
    ec:     { avgPos: avg(ecPos), avgPts: avg(ecPts), avgGap: avg(ecGap) },
    mq:     { avgPos: avg(mqPos), avgPts: avg(mqPts_a), avgGap: avg(mqGap), avgTotalPts: avg(mqTotalPts), wins: mqWins, podiums: mqPodiums },
    intern: { avgPos: avg(intPos), avgPts: avg(intPts) },
    df:     { avgPos: avg(dfPos), avgPts: avg(dfPts_a), avgGap: avg(dfGap) },
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
  injectStyles();
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

  // Lignes par meeting
  const meetingRows = meetingsData.map(m => {
    const date = m.meeting.date
      ? new Date(m.meeting.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
      : '?';

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
    `;
  }).join('');

  // Lignes synthèse saison
  const fmtP = v => v == null ? '—' : v.toFixed(1) + 'e';
  const fmtA = (v, d = 1) => v == null ? '—' : v.toFixed(d);
  const fmtG = v => v == null ? '—' : v === 0 ? '0.000s' : `+${(v / 1000).toFixed(3)}s`;

  const synthRows = `
    <tr class="dp-synth-label">
      <td colspan="11" class="dp-synth-title">📊 Synthèse saison</td>
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Moy. position</td>
      ${td(fmtP(s.ec.avgPos))}
      ${[1,2,3,4].map(() => td(fmtP(s.mq.avgPos))).join('')}
      ${tdNA()}
      ${td(fmtP(s.intern.avgPos), 'dp-interim-col')}
      ${td(fmtP(s.df.avgPos))}
      ${td(fmtP(s.fin.avgPos))}
      ${td(fmtP(s.total.avgPos), 'dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Moy. points</td>
      ${td(fmtA(s.ec.avgPts))}
      ${[1,2,3,4].map(() => td(fmtA(s.mq.avgPts))).join('')}
      ${td(fmtA(s.mq.avgTotalPts, 0))}
      ${td(fmtA(s.intern.avgPts), 'dp-interim-col')}
      ${td(fmtA(s.df.avgPts))}
      ${td(fmtA(s.fin.avgPts))}
      ${td(fmtA(s.total.avgPts, 0), 'dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Moy. écart 1er</td>
      ${td(fmtG(s.ec.avgGap))}
      ${[1,2,3,4].map(() => td(fmtG(s.mq.avgGap))).join('')}
      ${tdNA()}
      ${tdNA('dp-interim-col')}
      ${td(fmtG(s.df.avgGap))}
      ${td(fmtG(s.fin.avgGap))}
      ${tdNA('dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Victoires</td>
      ${tdNA()}
      ${[1,2,3,4].map(() => td(s.mq.wins)).join('')}
      ${tdNA()}
      ${tdNA('dp-interim-col')}
      ${tdNA()}
      ${td(s.fin.wins)}
      ${tdNA('dp-total-col')}
    </tr>
    <tr class="dp-synth-row">
      <td class="dp-row-label">Podiums</td>
      ${tdNA()}
      ${[1,2,3,4].map(() => td(s.mq.podiums)).join('')}
      ${tdNA()}
      ${tdNA('dp-interim-col')}
      ${tdNA()}
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

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('dp-styles')) return;
  const style = document.createElement('style');
  style.id = 'dp-styles';
  style.textContent = `
    /* Overlay */
    #dp-overlay {
      display: none;
      position: fixed; inset: 0;
      background: var(--clr-bg);
      z-index: 200;
      overflow-y: auto;
    }
    #dp-overlay.is-open { display: block; }

    .dp-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: var(--sp-lg);
    }

    /* Bouton retour */
    .dp-back {
      display: inline-flex; align-items: center; gap: var(--sp-xs);
      padding: 6px 14px;
      background: var(--clr-surface);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-md);
      color: var(--clr-text-2);
      font-size: 0.85rem; font-weight: 600;
      cursor: pointer; margin-bottom: var(--sp-lg);
      transition: all var(--tr-fast);
    }
    .dp-back:hover { background: var(--clr-surface-2); color: var(--clr-text); }

    /* Header */
    .dp-header {
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: var(--sp-md);
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-lg);
      padding: var(--sp-lg);
      margin-bottom: var(--sp-lg);
    }
    .dp-driver-info { display: flex; align-items: center; gap: var(--sp-md); }
    .dp-car-num {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 56px; height: 56px;
      background: var(--clr-accent-dim);
      border: 2px solid var(--clr-accent);
      border-radius: var(--r-md);
      font-family: var(--font-display);
      font-size: 1.3rem; font-weight: 700;
      color: var(--clr-accent-2);
    }
    .dp-name { font-size: 1.2rem; font-weight: 500; color: var(--clr-text); }
    .dp-name strong { font-weight: 700; }
    .dp-meta { font-size: 0.82rem; color: var(--clr-text-3); margin-top: 4px; display: flex; align-items: center; gap: var(--sp-sm); }

    /* KPIs */
    .dp-kpis { display: flex; gap: var(--sp-md); flex-wrap: wrap; }
    .dp-kpi {
      text-align: center;
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-md);
      padding: var(--sp-sm) var(--sp-md);
      min-width: 80px;
    }
    .dp-kpi--reg { cursor: help; border-style: dashed; }
    .dp-kpi-val {
      font-family: var(--font-display);
      font-size: 1.6rem; font-weight: 700;
      color: var(--clr-accent-2);
      line-height: 1;
    }
    .dp-kpi-lbl { font-size: 0.72rem; color: var(--clr-text-3); margin-top: 4px; }

    /* Chargement */
    .dp-loading {
      display: flex; align-items: center; gap: var(--sp-md);
      padding: var(--sp-xl); color: var(--clr-text-2); font-size: 0.95rem;
    }

    /* Tableau */
    .dp-table-wrap { overflow-x: auto; margin-bottom: var(--sp-xl); border-radius: var(--r-lg); border: 1px solid var(--clr-border); }
    .dp-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .dp-table th {
      padding: 10px 8px;
      background: var(--clr-surface);
      color: var(--clr-text-3);
      font-family: var(--font-condensed);
      font-size: 0.72rem; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
      border-bottom: 2px solid var(--clr-border);
      white-space: nowrap;
    }
    .dp-th-meeting { min-width: 110px; text-align: left; padding-left: var(--sp-md); }

    .dp-td { padding: 5px 6px; border-bottom: 1px solid var(--clr-border); white-space: nowrap; }

    /* Ligne meeting label */
    .dp-meeting-label td {
      background: var(--clr-surface);
      border-top: 2px solid var(--clr-border-2);
      border-bottom: none;
    }
    .dp-meeting-title {
      font-family: var(--font-condensed);
      font-size: 0.78rem; font-weight: 700;
      letter-spacing: 0.06em;
      color: var(--clr-text-2);
      padding: 8px var(--sp-md);
    }

    /* Sous-lignes */
    .dp-row-label {
      font-size: 0.72rem; font-weight: 600;
      color: var(--clr-text-3); text-align: right;
      padding-right: var(--sp-sm);
      border-right: 1px solid var(--clr-border);
      white-space: nowrap; min-width: 90px;
    }
    .dp-pos-row td { background: rgba(255,255,255,0.01); }
    .dp-pts-row td { background: rgba(255,85,0,0.03); }
    .dp-gap-row td { background: rgba(0,0,0,0.06); }
    .dp-gap-row .dp-td { font-size: 0.75rem; color: var(--clr-text-3); }

    /* Valeurs */
    .dp-pos  { font-family: var(--font-display); font-weight: 700; color: var(--clr-text); font-size: 0.85rem; }
    .dp-pts-val { font-family: var(--font-display); font-weight: 600; color: var(--clr-accent-2); }
    .dp-total-pts { font-family: var(--font-display); font-weight: 700; color: var(--clr-accent-2); font-size: 1rem; }
    .dp-na { color: var(--clr-text-3); font-size: 0.75rem; }
    .dp-gap { font-size: 0.75rem; color: var(--clr-text-2); }
    .dp-winner { color: var(--clr-success); font-size: 0.8rem; }

    /* Colonnes spéciales */
    .dp-interim-col { border-left: 1px solid var(--clr-border-2); border-right: 1px solid var(--clr-border-2); background: rgba(255,200,0,0.03) !important; }
    .dp-total-col { border-left: 2px solid var(--clr-border-2); background: rgba(255,85,0,0.04) !important; }

    /* Lignes synthèse */
    .dp-synth-label td {
      background: var(--clr-accent-dim);
      border-top: 3px solid var(--clr-accent);
      border-bottom: none;
    }
    .dp-synth-title {
      font-family: var(--font-condensed);
      font-size: 0.78rem; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--clr-accent-2);
      padding: 8px var(--sp-md);
    }
    .dp-synth-row td { background: var(--clr-surface); }
    .dp-synth-row .dp-row-label { font-weight: 700; color: var(--clr-text-2); }

    /* Graphiques */
    .dp-charts { margin-top: var(--sp-lg); }
    .dp-charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--sp-md);
    }
    @media (max-width: 720px) {
      .dp-charts-grid { grid-template-columns: 1fr; }
    }
    .dp-chart-box {
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-lg);
      padding: var(--sp-md);
    }
    .dp-chart-title {
      font-family: var(--font-condensed);
      font-size: 0.78rem; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
    }
    .dp-svg { width: 100%; height: auto; display: block; }
    .dp-charts-placeholder {
      text-align: center; padding: var(--sp-xl);
      color: var(--clr-text-3); font-size: 0.9rem;
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-lg);
    }
  `;
  document.head.appendChild(style);
}