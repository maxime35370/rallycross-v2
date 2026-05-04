/* ═══════════════════════════════════════════════
   PERSONPROFILE.JS — Stats globales cross-championnats
   Affiche la carriere d'une personne a travers tous
   les championnats/saisons/categories
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { escHtml } from './utils.js';
import { toast, categoryBadge } from './app.js';
import { mqPoints, qfPoints, dfPoints, finPoints, interimPoints, calcInterimStandings } from './calc.js';
import { getChampionshipConfig } from './settings.js';

// ─────────────────────────────────────────────────────────
// CHARGEMENT DES DONNEES
// ─────────────────────────────────────────────────────────

async function loadPersonData(personId) {
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
  const { collection, query, where, getDocs } = fs;

  // 1. Toutes les inscriptions (drivers) liees a cette personne
  const driversSnap = await getDocs(query(collection(db, 'drivers'), where('personId', '==', personId)));
  const drivers = driversSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (drivers.length === 0) {
    return { drivers: [], byChampionship: [], totals: null };
  }

  // 2. Tous les championnats referencees
  const champIds = [...new Set(drivers.map(d => d.championshipId).filter(Boolean))];
  const champMap = {};
  if (champIds.length > 0) {
    const champSnap = await getDocs(collection(db, 'championships'));
    champSnap.docs.forEach(d => { champMap[d.id] = { id: d.id, ...d.data() }; });
  }

  // 3. Pour chaque inscription, recuperer les resultats + meetings
  const byChampionship = [];
  const allMeetingsPts = [];
  let totalWins = 0, totalPodiums = 0, totalMeetings = 0;

  for (const drv of drivers) {
    // Engagements du pilote
    const engSnap = await getDocs(query(collection(db, 'engagements'), where('driverId', '==', drv.id)));
    const meetingIds = [...new Set(engSnap.docs.map(d => d.data().meetingId))];

    // Meetings correspondants
    const meetings = [];
    for (const mid of meetingIds) {
      const mDocSnap = await getDocs(query(collection(db, 'meetings'), where('__name__', '==', mid)));
      if (!mDocSnap.empty) {
        meetings.push({ id: mDocSnap.docs[0].id, ...mDocSnap.docs[0].data() });
      }
    }

    // Resultats bruts
    const resSnap = await getDocs(query(collection(db, 'results'), where('driverId', '==', drv.id)));
    const resultsByMeeting = {};
    resSnap.docs.forEach(d => {
      const r = d.data();
      if (!resultsByMeeting[r.meetingId]) resultsByMeeting[r.meetingId] = [];
      resultsByMeeting[r.meetingId].push(r);
    });

    // Reglement du championnat pour les baremes
    let regulation = null;
    if (drv.championshipId) {
      try { regulation = await getChampionshipConfig(drv.championshipId); } catch {}
    }

    // Agreger par meeting : calculer les points a la volee
    const meetingStats = [];
    for (const m of meetings) {
      const mResults = resultsByMeeting[m.id] || [];
      if (mResults.length === 0) continue;

      let dfTotal = 0, finTotal = 0;
      let finPosition = null;

      // Points DF et FIN : calculer depuis les resultats bruts
      const driverSessionIds = [...new Set(mResults.map(r => r.sessionId))];

      for (const sid of driverSessionIds) {
        const driverResult = mResults.find(r => r.sessionId === sid);
        if (!driverResult) continue;
        const sType = driverResult.sessionType;

        // MQ ne donne PAS de points championnat (sert uniquement au classement intermediaire)
        if (sType === 'DF' || sType === 'FIN') {
          const allSessionResults = await getDocs(query(collection(db, 'results'), where('sessionId', '==', sid)));
          const allRows = allSessionResults.docs.map(d => d.data());
          const finished = allRows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
          const dnfWithPos = allRows.filter(r => r.status === 'DNF' && r.manualPosition);

          let driverPos = null;
          const finIdx = finished.findIndex(r => r.driverId === drv.id);
          if (finIdx >= 0) {
            driverPos = finIdx + 1;
          } else {
            const dnfRow = dnfWithPos.find(r => r.driverId === drv.id);
            if (dnfRow?.manualPosition) driverPos = dnfRow.manualPosition;
          }

          if (driverPos !== null) {
            if (sType === 'DF')  dfTotal += dfPoints(driverPos, regulation);
            if (sType === 'FIN') {
              finTotal += finPoints(driverPos, regulation);
              finPosition = driverPos;
            }
          }
        }
      }

      // Points intermediaires
      let interimTotal = 0;
      try {
        // Charger toutes les sessions du meeting (une seule requete simple par meetingId)
        const sessSnap = await getDocs(query(collection(db, 'sessions'), where('meetingId', '==', m.id)));
        const meetingSessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(s => s.category === drv.category);
        if (meetingSessions.length > 0) {
          const interim = await calcInterimStandings(db, meetingSessions, regulation);
          const iRow = interim.find(r => r.driverId === drv.id);
          if (iRow?.interimPoints) interimTotal = iRow.interimPoints;
        }
      } catch {}

      const total = interimTotal + dfTotal + finTotal;
      if (total > 0 || mResults.some(r => r.ms || r.status)) {
        meetingStats.push({
          meetingId: m.id,
          meetingDate: m.date || '',
          meetingName: m.location || '?',
          finalPosition: finPosition,
          totalPoints: total,
          participated: true,
        });
      }
    }

    meetingStats.sort((a, b) => (a.meetingDate || '').localeCompare(b.meetingDate || ''));

    // Stats du driver
    const wins = meetingStats.filter(m => m.finalPosition === 1).length;
    const podiums = meetingStats.filter(m => m.finalPosition && m.finalPosition <= 3).length;
    const points = meetingStats.reduce((s, m) => s + (m.totalPoints || 0), 0);
    const bestPosition = meetingStats.reduce((best, m) => {
      if (!m.finalPosition) return best;
      return best === null || m.finalPosition < best ? m.finalPosition : best;
    }, null);

    totalWins += wins;
    totalPodiums += podiums;
    totalMeetings += meetingStats.length;
    meetingStats.forEach(m => allMeetingsPts.push(m.totalPoints || 0));

    byChampionship.push({
      driverId: drv.id,
      carNumber: drv.carNumber,
      category: drv.category,
      year: drv.year,
      championshipId: drv.championshipId,
      championshipName: champMap[drv.championshipId]?.name || 'Sans championnat',
      meetings: meetingStats,
      wins,
      podiums,
      points,
      bestPosition,
    });
  }

  // Tri : plus recent en premier
  byChampionship.sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return (a.championshipName || '').localeCompare(b.championshipName || '');
  });

  return {
    drivers,
    byChampionship,
    totals: {
      meetings: totalMeetings,
      wins: totalWins,
      podiums: totalPodiums,
      totalPoints: allMeetingsPts.reduce((s, p) => s + p, 0),
      championships: [...new Set(byChampionship.map(b => b.championshipId).filter(Boolean))].length,
      seasons: [...new Set(byChampionship.map(b => b.year))].length,
    },
  };
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

export async function showPersonProfile(person) {
  let overlay = document.getElementById('pp-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pp-overlay';
    overlay.className = 'pp-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="pp-container">
      <div class="pp-loading">
        <div class="spinner"></div>
        <div>Agregation des donnees de carriere...</div>
      </div>
    </div>
  `;
  overlay.classList.add('is-open');

  try {
    const data = await loadPersonData(person.id);
    renderContent(overlay, person, data);
  } catch (err) {
    console.error(err);
    overlay.innerHTML = `
      <div class="pp-container">
        <button class="pp-close" id="pp-close-btn">✕ Fermer</button>
        <div class="pp-error">Erreur de chargement des donnees.</div>
      </div>
    `;
    document.getElementById('pp-close-btn')?.addEventListener('click', () => overlay.classList.remove('is-open'));
  }
}

function renderContent(overlay, person, data) {
  const { drivers, byChampionship, totals } = data;

  const header = `
    <div class="pp-header">
      <div class="pp-person-info">
        <div class="pp-person-icon">🏃</div>
        <div>
          <div class="pp-person-name">${escHtml(person.firstName)} <strong>${escHtml(person.lastName)}</strong></div>
          <div class="pp-person-meta">
            ${person.licenseNumber ? 'Licence ' + escHtml(person.licenseNumber) + ' · ' : ''}
            ${person.nationality ? escHtml(person.nationality) + ' · ' : ''}
            ${person.team ? escHtml(person.team) : ''}
          </div>
        </div>
      </div>
      ${totals ? `
      <div class="pp-kpis">
        <div class="pp-kpi"><div class="pp-kpi-val">${totals.championships}</div><div class="pp-kpi-lbl">Championnats</div></div>
        <div class="pp-kpi"><div class="pp-kpi-val">${totals.seasons}</div><div class="pp-kpi-lbl">Saisons</div></div>
        <div class="pp-kpi"><div class="pp-kpi-val">${totals.meetings}</div><div class="pp-kpi-lbl">Meetings</div></div>
        <div class="pp-kpi"><div class="pp-kpi-val pp-kpi--gold">${totals.wins}</div><div class="pp-kpi-lbl">Victoires</div></div>
        <div class="pp-kpi"><div class="pp-kpi-val pp-kpi--podium">${totals.podiums}</div><div class="pp-kpi-lbl">Podiums</div></div>
        <div class="pp-kpi"><div class="pp-kpi-val">${totals.totalPoints}</div><div class="pp-kpi-lbl">Points totaux</div></div>
      </div>` : ''}
    </div>
  `;

  let body = '';
  if (drivers.length === 0) {
    body = `
      <div class="pp-empty">
        <div style="font-size:2rem">🔗</div>
        <div class="pp-empty-title">Aucune inscription liee a cette fiche</div>
        <div class="pp-empty-desc">
          Aucun pilote n'est actuellement lie a cette fiche personne.
          Liez des inscriptions depuis la vue Pilotes pour voir les stats de carriere ici.
        </div>
      </div>
    `;
  } else {
    body = `
      <div class="pp-section">
        <div class="pp-section-title">Inscriptions par championnat / saison</div>
        ${byChampionship.map(ch => renderChampionshipBlock(ch)).join('')}
      </div>
    `;
  }

  overlay.innerHTML = `
    <div class="pp-container">
      <button class="pp-close" id="pp-close-btn">✕</button>
      ${header}
      ${body}
    </div>
  `;

  document.getElementById('pp-close-btn')?.addEventListener('click', () => overlay.classList.remove('is-open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('is-open'); });
}

function renderChampionshipBlock(ch) {
  return `
    <div class="pp-champ-block">
      <div class="pp-champ-head">
        <div>
          <span class="pp-champ-name">${escHtml(ch.championshipName)}</span>
          <span class="pp-champ-year">${escHtml(ch.year)}</span>
          <span class="pp-champ-cat">${categoryBadge(ch.category)}</span>
          <span class="pp-champ-num">N° ${escHtml(ch.carNumber)}</span>
        </div>
        <div class="pp-champ-stats">
          <span title="Victoires">🥇 ${ch.wins}</span>
          <span title="Podiums">🏆 ${ch.podiums}</span>
          ${ch.bestPosition ? '<span title="Meilleure position">⭐ ' + ch.bestPosition + '</span>' : ''}
          <span title="Points totaux">📊 ${ch.points} pts</span>
        </div>
      </div>
      ${ch.meetings.length === 0 ? `
        <div class="pp-champ-empty">Aucun meeting participe pour cette inscription.</div>
      ` : `
        <div class="table-wrap">
          <table class="pp-meetings-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Meeting</th>
                <th class="center">Position finale</th>
                <th class="center">Points</th>
              </tr>
            </thead>
            <tbody>
              ${ch.meetings.map(m => `
                <tr>
                  <td>${formatDate(m.meetingDate)}</td>
                  <td><strong>${escHtml(m.meetingName)}</strong></td>
                  <td class="center">${renderPositionBadge(m.finalPosition)}</td>
                  <td class="center"><strong>${m.totalPoints || 0}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderPositionBadge(pos) {
  if (!pos) return '<span class="text-muted">—</span>';
  if (pos === 1) return '<span class="pp-pos pp-pos--gold">🥇 1er</span>';
  if (pos === 2) return '<span class="pp-pos pp-pos--silver">🥈 2e</span>';
  if (pos === 3) return '<span class="pp-pos pp-pos--bronze">🥉 3e</span>';
  return '<span class="pp-pos">' + pos + 'e</span>';
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return dateStr;
  }
}
