/* ═══════════════════════════════════════════════
   STARTANALYSIS.JS — Vue « Analyse des départs »

   Poste de travail sur UN DÉPART PHYSIQUE :
     Championnat → Meeting → Catégorie → liste des départs → saisie V1 → validation

   Toute la logique métier vit dans startAnalysisCalc.js (pur, testé). Ce module
   ne fait que l'accès Firestore et le rendu.

   Règle absolue : aucune donnée non validée n'alimente les statistiques.
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { logAudit } from './audit.js';
import { requireAuth, isAdmin } from './auth.js';
import { escHtml } from './utils.js';
import { getActiveChampionshipId, getAllChampionships } from './context.js';
import {
  enumerateStarts, buildStartGrid, startDocId, seriesFingerprint,
  validateAnalysis, normalizePoleSide, availableTurn1Positions, pointTurn1InOrder,
  nextFreeTurn1Pos, applyV1OrderProposal, acceptV1Proposals, isV1OrderProposal,
  buildStartGridExport, countStarters,
  orderGridByInterim, orderFinalGridFromSemis, orderByRaceResult,
} from './startAnalysisCalc.js';
import { calcInterimStandings } from './calc.js';
import { createVideoPlayer } from './videoPlayer.js';
import {
  ouvrirCanal, messageGrille, messagePour, MSG_CLASSEMENT, MSG_PRET,
} from './analysisLink.js';
import {
  parseVideoSource, resolveStartTime, formatPreciseTime, buildVideoBlock,
  buildExtractRecipe, PAD_AVANT, PAD_APRES,
  keyboardAction, neighbourStartId, nextRate, ratesFor, SHORTCUT_HELP,
  parseExtractSidecar, pairExtractFiles,
} from './videoPlayerCalc.js';

// ─────────────────────────────────────────────────────────
// ÉTAT
// ─────────────────────────────────────────────────────────

let selectedYear     = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let allMeetings       = [];
let meetingSessions   = [];      // sessions du meeting × catégorie
let startsIndex       = [];      // départs physiques énumérés
let existingAnalyses  = new Map(); // docId → analyse enregistrée
let current           = null;    // { start, rows, analysis, dirty }
let interimOrder      = [];      // driverIds du classement intermédiaire, 1er en tête
let semiFinishOrders  = [];      // ordres d'arrivée des demi-finales, pour la grille de finale
let _initialised      = false;

// ── Lecteur vidéo ──
// Le lecteur vit HORS de la zone re-rendue : changer une position au V1 ne doit
// jamais recharger la vidéo ni perdre la position de lecture.
let player          = null;
// Mode de saisie du V1. Le pointage DANS L'ORDRE évite de traduire de tête ce
// qu'on voit en numéros de position ; le mode position par position reste
// disponible pour corriger un seul pilote sans toucher aux autres.
const CLE_MODE_V1 = 'rx.sanl.pointageOrdonne';
let pointageOrdonne = (() => {
  try { return localStorage.getItem(CLE_MODE_V1) !== '0'; } catch { return true; }
})();
let videoCollapsed  = false;
let sharedFile      = null;   // fichier local courant, réutilisé d'une série à l'autre
let sharedSidecar   = null;   // bloc « rx-extract/1 » accompagnant ce fichier, s'il a été fourni
let videoState      = { time: 0, playing: false, ready: false, error: '' };
let _keysBound      = false;

// ── Pont vers l'outil d'analyse vidéo ──
// L'outil vit dans un document séparé — il lui faut l'isolation d'origine que
// le lecteur YouTube de cette page ne supporte pas. Documents séparés, mais
// même origine : le canal les relie sans passer par des fichiers.
//
// L'adresse est celle du serveur d'outils (`tools/yolox-poc/serve.mjs`). En
// production, l'outil doit être déployé à côté de l'application pour que le
// canal fonctionne : un autre domaine ne verrait rien passer.
const OUTIL_V1 = '/__v1';
let canalAnalyse = null;
let envoiEnAttente = null;    // renvoyé quand l'outil annonce qu'il écoute

const FS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────
// FIRESTORE
// ─────────────────────────────────────────────────────────

async function fsQuery(col, filters) {
  const { collection, query, where, getDocs } = await import(FS);
  const snap = await getDocs(query(collection(db, col), ...filters.map(([f, op, v]) => where(f, op, v))));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadMeetings() {
  if (!db) { allMeetings = []; return; }
  const rows = await fsQuery('meetings', [['year', '==', selectedYear]]);
  const champId = getActiveChampionshipId();
  // Filtre championnat côté client (convention maison : pas d'index composite)
  allMeetings = (champId ? rows.filter(m => m.championshipId === champId || !m.championshipId) : rows)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

/** Championnat DU MEETING — jamais le championnat actif de l'interface. */
function championshipOfMeeting(meeting) {
  const all = getAllChampionships();
  return all.find(c => c.id === meeting?.championshipId) || null;
}

async function loadSessionsAndStarts() {
  meetingSessions = [];
  startsIndex = [];
  existingAnalyses = new Map();
  if (!db || !selectedMeetingId || !selectedCategory) return;

  const meeting = allMeetings.find(m => m.id === selectedMeetingId);
  const championship = championshipOfMeeting(meeting);

  // Toutes les sessions de la catégorie, EC comprise : le classement
  // intermédiaire en a besoin (bonus EC + points de manche).
  const allCatSessions = (await fsQuery('sessions', [['meetingId', '==', selectedMeetingId]]))
    .filter(s => s.category === selectedCategory);

  const sessions = allCatSessions
    .filter(s => s.type !== 'EC')
    .sort((a, b) => {
      const order = { MQ: 1, QF: 2, DF: 3, FIN: 4 };
      return (order[a.type] - order[b.type]) || ((a.num || 0) - (b.num || 0));
    });
  meetingSessions = sessions;

  // Classement intermédiaire à l'issue des manches : c'est LUI qui donne
  // l'ordre de la grille des QF et des DF (le leader est en pole de sa demi).
  interimOrder = [];
  try {
    const interim = await calcInterimStandings(db, allCatSessions, championship);
    interimOrder = interim.map(r => r.driverId);
  } catch (e) {
    console.warn('startAnalysis — classement intermédiaire indisponible :', e);
  }

  // Analyses déjà enregistrées pour ce meeting
  const saved = await fsQuery('startAnalyses', [['meetingId', '==', selectedMeetingId]]);
  for (const a of saved) if (a.category === selectedCategory) existingAnalyses.set(a.id, a);

  // Énumération des départs physiques, session par session
  for (const session of sessions) {
    const [results, participants] = await Promise.all([
      fsQuery('results', [['sessionId', '==', session.id]]),
      fsQuery('sessionParticipants', [['sessionId', '==', session.id]]),
    ]);
    const { starts } = enumerateStarts({ session, results, participants, championship, category: selectedCategory });
    for (const s of starts) {
      startsIndex.push({ ...s, _results: results, _participants: participants, _session: session });
    }
  }

  // Ordres d'arrivée des demi-finales, dans l'ordre DF1, DF2… : la grille de
  // la finale se compose par paires (vainqueur DF1, vainqueur DF2, puis les
  // deuxièmes, etc.) — même règle que la vue Sessions.
  semiFinishOrders = startsIndex
    .filter(st => st.sessionType === 'DF')
    .sort((a, b) => (a.sessionNum || 0) - (b.sessionNum || 0))
    .map(st => orderByRaceResult(
      st._participants.map(p => {
        const r = st._results.find(x => x.driverId === p.driverId) || {};
        return { driverId: p.driverId, ms: r.ms ?? null, status: r.status ?? null };
      })
    ));
}

/**
 * Ordre de la grille d'un départ de phase finale.
 *  • QF / DF : classement intermédiaire à l'issue des manches ;
 *  • FIN     : paires issues des demi-finales, repli sur l'intermédiaire.
 * Les MQ n'en ont pas besoin : leur grille EST le couloir.
 */
function gridOrderFor(start) {
  if (start.sessionType === 'MQ') return null;
  if (start.sessionType === 'FIN') {
    return orderFinalGridFromSemis(start.driverIds, semiFinishOrders, interimOrder);
  }
  return orderGridByInterim(start.driverIds, interimOrder);
}

async function saveAnalysis(doc_, { validated }) {
  if (!requireAuth()) return false;
  const { doc, setDoc } = await import(FS);
  const payload = { ...doc_, status: validated ? 'validated' : 'draft', updatedAt: new Date() };
  if (validated) { payload.validatedAt = new Date(); payload.validatedBy = 'regie'; }
  try {
    await setDoc(doc(db, 'startAnalyses', doc_.id), payload, { merge: true });
    logAudit(validated ? 'update' : 'create', 'startAnalysis', doc_.id, {
      label: `${doc_.startLabel} — ${doc_.category}`,
      status: payload.status,
    });
    existingAnalyses.set(doc_.id, { ...payload });
    return true;
  } catch (err) {
    console.error('startAnalysis save:', err);
    toast('Erreur lors de l\'enregistrement', 'error');
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// RENDU — cadre général
// ─────────────────────────────────────────────────────────

function renderView() {
  const el = document.getElementById('view-startAnalysis');
  if (!el) return;
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  el.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🎥 <span>Analyse des départs</span></h2>
    </div>

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="sanl-year">
        ${years.map(y => `<option value="${y}" ${y === selectedYear ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="sanl-meeting"><option value="">— Meeting —</option></select>
      <select class="toolbar-select" id="sanl-category"><option value="">— Catégorie —</option></select>
    </div>

    <div class="sanl-layout">
      <aside class="sanl-list" id="sanl-list"></aside>
      <div class="sanl-right">
        <section class="sanl-video" id="sanl-video"></section>
        <section class="sanl-work" id="sanl-work"></section>
      </div>
    </div>
  `;
  refreshMeetingSelect();
  bindToolbar();
  bindKeyboard();
  renderList();
  renderVideoPanel();
  renderWork();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('sanl-meeting');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Meeting —</option>' + allMeetings.map(m => {
    const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '?';
    return `<option value="${m.id}" ${m.id === selectedMeetingId ? 'selected' : ''}>${d} — ${escHtml(m.location || '?')}</option>`;
  }).join('');

  const cat = document.getElementById('sanl-category');
  const meeting = allMeetings.find(m => m.id === selectedMeetingId);
  const cats = Array.isArray(meeting?.categories) ? meeting.categories : [];
  if (cat) {
    cat.innerHTML = '<option value="">— Catégorie —</option>' + cats.map(c =>
      `<option value="${escHtml(c)}" ${c === selectedCategory ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
  }
}

// ─────────────────────────────────────────────────────────
// RENDU — liste des départs physiques
// ─────────────────────────────────────────────────────────

const STATE_ICON = { validated: '✅', draft: '🟡' };

function renderList() {
  const el = document.getElementById('sanl-list');
  if (!el) return;

  if (!selectedMeetingId || !selectedCategory) {
    el.innerHTML = `<div class="sanl-empty">Sélectionnez un meeting et une catégorie.</div>`;
    return;
  }
  if (startsIndex.length === 0) {
    el.innerHTML = `
      <div class="sanl-empty">
        Aucun départ exploitable pour cette catégorie.<br>
        <span class="text-muted" style="font-size:0.78rem">
          Pour les manches, la série et le couloir de chaque pilote doivent être
          renseignés dans la vue Chronométrage.
        </span>
      </div>`;
    return;
  }

  // Regroupement par session, pour lire « MQ1 › Série 1..6 »
  const bySession = new Map();
  for (const s of startsIndex) {
    const key = s.sessionId;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(s);
  }

  const nbValidated = [...existingAnalyses.values()].filter(a => a.status === 'validated').length;

  el.innerHTML = `
    <div class="sanl-list-head">
      <span>${startsIndex.length} départ${startsIndex.length > 1 ? 's' : ''}</span>
      <span class="sanl-count-ok">${nbValidated} validé${nbValidated > 1 ? 's' : ''}</span>
    </div>
    ${[...bySession.entries()].map(([sid, starts]) => {
      const s0 = starts[0];
      const head = (s0.sessionType === 'MQ' ? 'MQ' : s0.sessionType) + (s0.sessionNum || '');
      return `
        <div class="sanl-group">
          <div class="sanl-group-title">${escHtml(head)}</div>
          ${starts.map(st => {
            const id = startDocId(st.sessionId, st.startIndex);
            const saved = existingAnalyses.get(id);
            const icon = saved ? (STATE_ICON[saved.status] || '⚪') : '⚪';
            const isCur = current?.start && startDocId(current.start.sessionId, current.start.startIndex) === id;
            // ⚠️ réservé aux vrais problèmes non encore validés : un DNS est une
            // information (st.notes), pas une alerte.
            const warn = (!saved && st.warnings?.length) ? ' ⚠️' : '';
            return `
              <button class="sanl-item ${isCur ? 'is-active' : ''}" data-id="${escHtml(id)}">
                <span class="sanl-item-icon">${icon}</span>
                <span class="sanl-item-label">${escHtml(st.startLabel)}</span>
                <span class="sanl-item-meta">${st.starters} pil.${warn}</span>
              </button>`;
          }).join('')}
        </div>`;
    }).join('')}
  `;

  el.querySelectorAll('.sanl-item').forEach(btn => {
    btn.addEventListener('click', () => selectStart(btn.dataset.id));
  });
}

// ─────────────────────────────────────────────────────────
// SÉLECTION D'UN DÉPART
// ─────────────────────────────────────────────────────────

function selectStart(docId) {
  if (current?.dirty && !window.confirm('Modifications non enregistrées. Changer de départ ?')) return;

  const start = startsIndex.find(s => startDocId(s.sessionId, s.startIndex) === docId);
  if (!start) return;

  // Changer de départ périme ce qu'on renverrait à l'outil : sans cela, un
  // outil rechargé plus tard recevrait la grille du départ précédent.
  envoiEnAttente = null;

  const meeting = allMeetings.find(m => m.id === selectedMeetingId);
  const { rows, warnings } = buildStartGrid({
    start,
    results: start._results,
    participants: start._participants,
    rankedDriverIds: gridOrderFor(start),
  });

  const saved = existingAnalyses.get(docId);
  if (saved?.rows?.length) {
    // Réapplique les valeurs saisies précédemment sur la grille reconstruite
    const savedById = new Map(saved.rows.map(r => [r.driverId, r]));
    for (const row of rows) {
      const s = savedById.get(row.driverId);
      if (s) {
        row.turn1Pos = s.turn1Pos ?? null;
        row.confidence = s.confidence || 'green';
        row.note = s.note || '';
        row.corrected = !!s.corrected;
        // La proposition est relue elle aussi : importée une fois, elle doit
        // être encore là quand on revient sur ce départ.
        row.autoTurn1Pos = s.autoTurn1Pos ?? null;
        row.autoConfidence = s.autoConfidence ?? null;
        if (s.gridPos != null && start.sessionType !== 'MQ') row.gridPos = s.gridPos;
      }
    }
    if (start.sessionType !== 'MQ') rows.sort((a, b) => (a.gridPos ?? 99) - (b.gridPos ?? 99));
  }

  current = {
    start,
    rows,
    warnings,
    meeting,
    video: {
      kind:      saved?.video?.kind || null,
      youtubeId: saved?.video?.youtubeId || null,
      fileName:  saved?.video?.fileName || null,
      startAt:   saved?.video?.startAt ?? null,
      turn1At:   saved?.video?.turn1At ?? null,
      fps:       saved?.video?.fps ?? null,
    },
    orderCompleteness: saved?.orderCompleteness || 'complete',
    savedStatus: saved?.status || null,
    integrityMismatch: saved?.integrity?.seriesFingerprint
      ? saved.integrity.seriesFingerprint !== seriesFingerprint(start.driverIds)
      : false,
    dirty: false,
  };
  renderList();
  renderVideoPanel();
  renderWork();
}

// ─────────────────────────────────────────────────────────
// RENDU — poste de travail
// ─────────────────────────────────────────────────────────

function renderWork() {
  const el = document.getElementById('sanl-work');
  if (!el) return;

  if (!current) {
    el.innerHTML = `
      <div class="sanl-placeholder">
        <div class="placeholder-icon">🎥</div>
        <div class="placeholder-title">Sélectionnez un départ</div>
        <div class="placeholder-desc">
          Une analyse = un départ physique réel.<br>
          Une manche de 6 séries représente 6 départs distincts.
        </div>
      </div>`;
    return;
  }

  const { start, rows, warnings } = current;
  const meeting = current.meeting;
  const poleSide = normalizePoleSide(meeting?.poleSide);
  const readOnly = !isAdmin();
  // n = pilotes réellement au départ : un DNS n'était pas sur la grille
  const n = countStarters(rows);
  const nbDns = rows.length - n;

  const noteHtml = [...(start.notes || [])].map(n =>
    `<div class="sanl-note">ℹ️ ${escHtml(n)}</div>`).join('');
  const warnHtml = [...(warnings || [])].map(w =>
    `<div class="sanl-warn">⚠️ ${escHtml(w)}</div>`).join('');

  const integrityHtml = current.integrityMismatch
    ? `<div class="sanl-warn sanl-warn--strong">⚠️ Cette analyse a été validée sur une composition
       de série différente de celle enregistrée aujourd'hui. Vérifiez avant de revalider.</div>`
    : '';

  el.innerHTML = `
    <div class="sanl-work-head">
      <div>
        <div class="sanl-work-title">${escHtml(start.startLabel)}</div>
        <div class="sanl-work-sub">
          ${escHtml(meeting?.location || '')} · ${escHtml(selectedCategory)} ·
          ${n} partant${n > 1 ? 's' : ''}${nbDns ? ` <span class="sanl-dns-note">(+${nbDns} DNS)</span>` : ''} ·
          couloir 1 ${poleSide === 'left' ? 'à gauche' : 'à droite'} (intérieur)
        </div>
      </div>
      <div class="sanl-status">
        ${current.savedStatus === 'validated' ? '✅ Validée'
          : current.savedStatus === 'draft' ? '🟡 Brouillon' : '⚪ Non enregistrée'}
      </div>
    </div>

    ${integrityHtml}
    ${noteHtml}
    ${warnHtml}

    <div class="sanl-mode">
      <label>
        <input type="checkbox" id="sanl-mode-ordre" ${pointageOrdonne ? 'checked' : ''} ${readOnly ? 'disabled' : ''}>
        Pointer dans l'ordre de passage
      </label>
      <span class="sanl-mode-aide">${pointageOrdonne
        ? 'Cliquez les pilotes dans l\'ordre où ils franchissent le virage — la numérotation suit.'
        : 'Choisissez la position de chaque pilote une par une.'}</span>
    </div>

    <div class="sanl-completeness">
      <label>Visibilité à l'image de mesure :</label>
      <select class="form-select" id="sanl-completeness" ${readOnly ? 'disabled' : ''}>
        <option value="complete"     ${current.orderCompleteness === 'complete' ? 'selected' : ''}>Toutes les voitures vues</option>
        <option value="leaders_only" ${current.orderCompleteness === 'leaders_only' ? 'selected' : ''}>Seules les premières, mais je certifie l'ordre</option>
        <option value="partial"      ${current.orderCompleteness === 'partial' ? 'selected' : ''}>Ordre non garanti (bloque la validation)</option>
      </select>
    </div>

    <div class="table-wrap">
      <table class="sanl-table">
        <thead>
          <tr>
            <th style="width:52px">Grille</th>
            ${start.sessionType === 'MQ' ? '' : '<th style="width:46px" title="Ligne physique">Ligne</th>'}
            <th style="width:56px" title="Couloir physique">Couloir</th>
            <th class="sanl-col-pilote">Pilote</th>
            <th style="width:52px" class="center">N°</th>
            <th class="center sanl-col-v1" style="min-width:${pointageOrdonne ? 76 : n * 31 + 14}px">1er virage</th>
            <th style="width:74px" class="center">Arrivée</th>
            <th class="center sanl-col-conf">Confiance</th>
          </tr>
        </thead>
        <tbody>${rows.map((r, i) => renderRow(r, i, start, readOnly)).join('')}</tbody>
      </table>
    </div>

    <div class="sanl-actions">
      <input type="file" id="sanl-proposal-file" accept="application/json,.json" hidden>
      <button class="btn btn-secondary" id="sanl-open-analysis" ${readOnly ? 'disabled' : ''}
        title="Ouvrir l'outil d'analyse avec la grille, la vidéo et les deux timecodes déjà en place">🎬 Analyser la vidéo</button>
      <button class="btn btn-secondary" id="sanl-export-grid"
        title="Exporter la grille en fichier — utile seulement si l'outil tourne sur une autre machine">📤 Exporter la grille</button>
      <button class="btn btn-secondary" id="sanl-import-proposal" ${readOnly ? 'disabled' : ''}
        title="Charger un classement proposé par l'analyse vidéo (rx-v1-order/1)">📥 Importer une proposition</button>
      <button class="btn btn-secondary" id="sanl-accept-proposal" ${readOnly || !rows.some(r => Number.isInteger(r.autoTurn1Pos)) ? 'disabled' : ''}
        title="Reprendre les positions proposées — les saisies manuelles sont conservées">✔️ Reprendre les propositions</button>
      <button class="btn btn-secondary" id="sanl-clear" ${readOnly ? 'disabled' : ''}>Effacer les positions V1</button>
      <button class="btn btn-secondary" id="sanl-draft" ${readOnly ? 'disabled' : ''}>💾 Enregistrer en brouillon</button>
      <button class="btn btn-primary"   id="sanl-validate" ${readOnly ? 'disabled' : ''}>✅ Valider l'analyse</button>
      <button class="btn btn-primary"   id="sanl-validate-next" ${readOnly ? 'disabled' : ''}
        title="Valider puis ouvrir le départ suivant (N)">✅ Valider → départ suivant</button>
    </div>
    <div class="sanl-feedback" id="sanl-feedback"></div>
  `;

  bindWork();
  refreshFeedback();
}

function renderRow(r, i, start, readOnly) {
  const n = start.starters;
  if (r.didNotStart) return renderNonStarterRow(r, start);
  const finish = r.finishPosInStart != null ? `P${r.finishPosInStart}`
    : (r.finishStatus ? `<span class="badge badge-dnf">${escHtml(r.finishStatus)}</span>` : '—');
  const v1Buttons = v1ButtonsHtml(r, n, readOnly);

  return `
    <tr data-driver="${escHtml(r.driverId)}">
      <td class="center"><strong>${r.gridPos != null ? 'P' + r.gridPos : '—'}</strong></td>
      ${start.sessionType === 'MQ' ? '' : `<td class="center">${r.gridRow ?? '—'}</td>`}
      <td class="center">${r.lane ?? '<span class="text-muted">—</span>'}</td>
      <td>${escHtml(((r.firstName || '') + ' ' + (r.lastName || '')).trim() || r.driverId)}</td>
      <td class="center">${r.carNumber ?? '—'}</td>
      <td class="center"><div class="sanl-v1-group" data-driver="${escHtml(r.driverId)}">${v1Buttons}${v1AutoBadgeHtml(r)}</div></td>
      <td class="center">${finish}</td>
      <td class="center">
        <select class="form-select sanl-conf" data-driver="${escHtml(r.driverId)}" ${readOnly ? 'disabled' : ''}>
          <option value="green"  ${r.confidence === 'green' ? 'selected' : ''}>🟢 Fiable</option>
          <option value="yellow" ${r.confidence === 'yellow' ? 'selected' : ''}>🟡 À vérifier</option>
          <option value="red"    ${r.confidence === 'red' ? 'selected' : ''}>🔴 Incertain</option>
        </select>
      </td>
    </tr>`;
}

/**
 * Pastille de PROPOSITION automatique.
 *
 * Elle est posée À CÔTÉ des boutons, jamais à leur place : ce que la machine
 * propose et ce que l'opérateur a saisi ne doivent pas pouvoir être confondus
 * d'un coup d'œil. Elle disparaît dès que la position est saisie.
 */
function v1AutoBadgeHtml(row) {
  const auto = Number.isInteger(row.autoTurn1Pos) ? row.autoTurn1Pos : null;
  if (auto == null || Number.isInteger(row.turn1Pos)) return '';
  const c = Number(row.autoConfidence);
  const conf = Number.isFinite(c) ? ` · confiance ${Math.round(c * 100)} %` : '';
  return `<span class="sanl-v1-auto" title="Proposition de l'analyse vidéo${escHtml(conf)} — à confirmer">P${auto}</span>`;
}

/**
 * Bouton unique du POINTAGE DANS L'ORDRE.
 *
 * On désigne les voitures dans l'ordre où elles franchissent le virage ; la
 * numérotation suit. Le bouton montre la position obtenue, ou la position qui
 * serait attribuée — pour qu'on sache où l'on en est sans compter.
 */
function v1OrderButtonHtml(row, starters, readOnly) {
  const place = Number.isInteger(row.turn1Pos) ? row.turn1Pos : null;
  const suivante = nextFreeTurn1Pos(current.rows, starters);
  // Plus une seule place libre et ce pilote non classé : rien à faire.
  const disabled = readOnly || (place == null && suivante == null);
  const texte = place != null ? `P${place}` : (suivante != null ? `→ P${suivante}` : '—');
  const titre = place != null
    ? `Retirer ce pilote de P${place} — les suivants remontent d'un cran`
    : (suivante != null ? `Placer ce pilote en P${suivante}` : 'Toutes les positions sont prises');
  return `<button type="button"
    class="sanl-v1-btn sanl-v1-btn--ordre${place != null ? ' is-active' : ''}"
    data-driver="${escHtml(row.driverId)}" data-ordre="1"
    aria-pressed="${place != null}" ${disabled ? 'disabled' : ''}
    title="${escHtml(titre)}">${texte}</button>`;
}

/**
 * Boutons de position au premier virage pour un pilote.
 * Une position prise par un AUTRE pilote est désactivée ; celle du pilote
 * lui-même reste toujours cliquable pour permettre de la retirer.
 */
function v1ButtonsHtml(row, starters, readOnly) {
  if (pointageOrdonne) return v1OrderButtonHtml(row, starters, readOnly);
  const avail = new Set(availableTurn1Positions(row.driverId, current.rows, starters));
  let html = '';
  for (let k = 1; k <= starters; k++) {
    const active = row.turn1Pos === k;
    const disabled = !avail.has(k) || readOnly;
    html += `<button type="button" class="sanl-v1-btn${active ? ' is-active' : ''}"
      data-driver="${escHtml(row.driverId)}" data-pos="${k}"
      aria-pressed="${active}" ${disabled ? 'disabled' : ''}
      title="${active ? 'Cliquer pour retirer' : `Placer ce pilote en P${k} au 1er virage`}"
      >P${k}</button>`;
  }
  return html;
}

/**
 * Met à jour l'état des boutons après chaque clic : la position choisie devient
 * indisponible pour les autres pilotes. On ne re-rend pas tout le tableau afin
 * de ne pas perdre la position de défilement.
 */
function refreshV1Buttons() {
  if (!current) return;
  const n = current.start.starters;
  const readOnly = !isAdmin();
  document.querySelectorAll('.sanl-v1-group').forEach(group => {
    const row = current.rows.find(r => r.driverId === group.dataset.driver);
    if (!row) return;
    group.innerHTML = v1ButtonsHtml(row, n, readOnly) + v1AutoBadgeHtml(row);
  });
  bindV1Buttons();
}

/** (Ré)attache les clics sur les boutons de position. */
function bindV1Buttons() {
  document.querySelectorAll('.sanl-v1-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Pointage dans l'ordre : la logique vit dans le module pur, qui rend
      // une NOUVELLE liste — retrait compris, avec resserrement des suivants.
      if (btn.dataset.ordre) {
        current.rows = pointTurn1InOrder(btn.dataset.driver, current.rows, countStarters(current.rows));
        current.dirty = true;
        refreshV1Buttons();
        refreshFeedback();
        return;
      }
      const row = current.rows.find(r => r.driverId === btn.dataset.driver);
      if (!row) return;
      const pos = parseInt(btn.dataset.pos, 10);
      // Clic sur la position déjà active → on la retire (pas besoin d'un « — »)
      row.turn1Pos = row.turn1Pos === pos ? null : pos;
      row.corrected = true;
      current.dirty = true;
      refreshV1Buttons();
      refreshFeedback();
    });
  });
}

/**
 * Ligne d'un pilote DNS : il n'était pas sur la grille, donc aucun bouton de
 * position. Son couloir reste affiché et VIDE — les autres pilotes ne sont pas
 * renumérotés pour autant.
 */
function renderNonStarterRow(r, start) {
  const name = escHtml(((r.firstName || '') + ' ' + (r.lastName || '')).trim() || r.driverId);
  const cols = start.sessionType === 'MQ' ? 1 : 2;   // Grille (+ Ligne hors MQ)
  return `
    <tr class="sanl-row-dns" data-driver="${escHtml(r.driverId)}">
      <td class="center">${r.gridPos != null ? 'P' + r.gridPos : '—'}</td>
      ${start.sessionType === 'MQ' ? '' : `<td class="center">${r.gridRow ?? '—'}</td>`}
      <td class="center">${r.lane ?? '—'}</td>
      <td>${name}</td>
      <td class="center">${r.carNumber ?? '—'}</td>
      <td class="center" colspan="3">
        <span class="sanl-dns-tag">DNS — n'a pas pris le départ</span>
      </td>
    </tr>`;
}

function refreshFeedback() {
  const el = document.getElementById('sanl-feedback');
  if (!el || !current) return;
  const v = validateAnalysis({ rows: current.rows, orderCompleteness: current.orderCompleteness });
  el.innerHTML = [
    ...v.errors.map(e => `<div class="sanl-err">⛔ ${escHtml(e)}</div>`),
    ...v.warnings.map(w => `<div class="sanl-warn">⚠️ ${escHtml(w)}</div>`),
    v.ok && v.warnings.length === 0 ? '<div class="sanl-ok">✅ Prêt à valider</div>' : '',
  ].join('');
  const btn = document.getElementById('sanl-validate');
  if (btn) btn.disabled = !v.ok || !isAdmin();
}

// ─────────────────────────────────────────────────────────
// LECTEUR VIDÉO
// ─────────────────────────────────────────────────────────

/** Identifiants des départs, dans l'ordre affiché : sert à « suivant/précédent ». */
function startIdsInOrder() {
  return startsIndex.map(st => startDocId(st.sessionId, st.startIndex));
}

function currentDocId() {
  return current?.start ? startDocId(current.start.sessionId, current.start.startIndex) : null;
}

/**
 * Panneau vidéo. Sa coquille n'est construite qu'UNE fois : le lecteur ne doit
 * pas être recréé à chaque saisie, sinon la vidéo repart au début.
 */
function renderVideoPanel() {
  const el = document.getElementById('sanl-video');
  if (!el) return;

  if (!current) {
    destroyPlayer();
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';

  if (!el.querySelector('#sanl-player')) {
    el.className = `sanl-video${videoCollapsed ? ' is-collapsed' : ''}`;
    el.innerHTML = videoShellHtml();
    bindVideoControls();
    ensurePlayer();
  } else if (!player) {
    // Coquille intacte mais lecteur détruit : le recréer plutôt que laisser
    // des commandes sans effet.
    ensurePlayer();
  }
  applySourceForCurrent();
  refreshVideoUi();
}

function videoShellHtml() {
  return `
    <div class="sanl-video-head">
      <span class="sanl-video-title">🎬 Lecteur vidéo</span>
      <div class="sanl-nav">
        <button class="vp-btn" id="sanl-prev" title="Départ précédent (P)">◀ Précédent</button>
        <button class="vp-btn" id="sanl-next" title="Départ suivant (N)">Suivant ▶</button>
        <button class="vp-btn" id="sanl-video-toggle">${videoCollapsed ? 'Afficher' : 'Masquer'}</button>
      </div>
    </div>

    <div class="vp-source">
      <input type="text" class="vp-url" id="sanl-vurl" placeholder="Lien YouTube (https://youtu.be/…)">
      <button class="vp-btn" id="sanl-vload">Charger</button>
      <label class="vp-btn vp-file-label" title="Sélectionne la vidéo ET son .json : la cadence exacte y est écrite">
        📁 Fichier local <span class="vp-file-hint">(+ son .json)</span>
        <input type="file" id="sanl-vfile" accept="video/*,application/json,.json" multiple>
      </label>
      <span class="vp-local-note" id="sanl-vsource"></span>
    </div>

    <div id="sanl-player"></div>

    <div class="vp-bar">
      <button class="vp-btn" id="sanl-vplay" title="Lecture / pause (Espace)">▶︎</button>
      <button class="vp-btn" id="sanl-vjb"  title="− 5 s (⇧←)">−5s</button>
      <button class="vp-btn" id="sanl-vsb"  title="− 1 s (←)">−1s</button>
      <button class="vp-btn" id="sanl-vfp"  title="Image précédente (⌥← ou ,)">⏮ img</button>
      <button class="vp-btn" id="sanl-vfn"  title="Image suivante (⌥→ ou .)">img ⏭</button>
      <button class="vp-btn" id="sanl-vsf"  title="+ 1 s (→)">+1s</button>
      <button class="vp-btn" id="sanl-vjf"  title="+ 5 s (⇧→)">+5s</button>
      <span class="vp-time" id="sanl-vtime">—</span>
      <button class="vp-btn" id="sanl-vslow" title="Plus lent (↓)">−</button>
      <span class="vp-rate vp-meta" id="sanl-vrate">×1</span>
      <button class="vp-btn" id="sanl-vfast" title="Plus rapide (↑)">+</button>
      <span class="vp-sep"></span>
      <button class="vp-btn vp-btn--mark" id="sanl-vmarkd" title="Marquer l'instant du départ (D)">⏱ Départ ici</button>
      <button class="vp-btn vp-btn--mark vp-btn--primary" id="sanl-vmarkv" title="Marquer l'image du 1er virage (V)">🎯 Image V1</button>
      <button class="vp-btn" id="sanl-vfull" title="Plein écran (F)">⛶</button>
    </div>

    <div class="vp-marks" id="sanl-vmarks"></div>
    <div class="vp-hint">
      ${SHORTCUT_HELP.map(([k, label]) => `<kbd>${escHtml(k)}</kbd> ${escHtml(label)}`).join(' · ')}
    </div>`;
}

function ensurePlayer() {
  const host = document.getElementById('sanl-player');
  if (!host) return;
  destroyPlayer();
  player = createVideoPlayer(host, {
    onTime: (t) => { videoState.time = t; refreshTimeDisplay(); },
    onReady: (info) => {
      videoState.ready = true;
      videoState.error = '';
      if (info.fps && current) current.video.fps = info.fps;
      refreshVideoUi();
    },
    onPlayState: (playing) => {
      videoState.playing = playing;
      const b = document.getElementById('sanl-vplay');
      if (b) b.textContent = playing ? '❚❚' : '▶︎';
    },
    onError: (msg) => { videoState.error = msg || ''; refreshVideoUi(); },
  });
}

/**
 * Le meeting ou la catégorie a changé : la vidéo chargée ne correspond plus.
 * Le fichier local, lui, est conservé — c'est souvent le même enregistrement
 * pour toute une journée de course.
 */
function resetVideo() {
  destroyPlayer();
  _loadedKey = '';
}

function destroyPlayer() {
  if (player) { try { player.destroy(); } catch { /* déjà détruit */ } player = null; }
  videoState = { time: 0, playing: false, ready: false, error: '' };
}

/**
 * Charge la source correspondant au départ sélectionné, et se place au
 * timecode connu. Ne recharge rien si la même source est déjà à l'écran :
 * enchaîner deux séries de la même vidéo doit être instantané.
 */
let _loadedKey = '';

function applySourceForCurrent() {
  if (!player || !current) return;
  const meeting = current.meeting;
  const resolved = resolveStartTime({
    analysisVideo: current.video,
    meetingTimecodes: meeting?.videoTimecodes,
    meetingVideos: meeting?.videos,
    sessionType: current.start.sessionType,
    sessionNum: current.start.sessionNum,
    category: selectedCategory,
    startIndex: current.start.startIndex,
  });
  current._resolved = resolved;

  const wantsFile = current.video.kind === 'file' && sharedFile;
  const key = wantsFile
    ? `file:${sharedFile.name}`
    : (resolved.youtubeId ? `yt:${resolved.youtubeId}` : '');

  const at = resolved.seconds ?? 0;
  if (!key) { _loadedKey = ''; return; }

  if (key === _loadedKey) {
    // Même vidéo : un simple repositionnement suffit.
    if (resolved.seconds != null) player.seek(at);
    return;
  }
  _loadedKey = key;
  // Cadence annoncée au lecteur plutôt que devinée. Le sidecar l'emporte : il
  // décrit le fichier chargé, quelle que soit la série sélectionnée. À défaut,
  // on ne réutilise la cadence enregistrée que si elle a été établie sur CE
  // fichier — l'annoncer à tort désactiverait la mesure sans rien signaler.
  const knownFps = sharedSidecar?.fps
    ?? (sharedFile && current.video.fileName === sharedFile.name ? current.video.fps : null);
  if (wantsFile) player.loadFile(sharedFile, at, { fps: knownFps });
  else player.loadYoutube(resolved.youtubeId, at);
}

function refreshTimeDisplay() {
  const el = document.getElementById('sanl-vtime');
  if (!el || !player) return;
  const fps = player.fps || current?.video?.fps || null;
  el.textContent = formatPreciseTime(videoState.time, { fps: fps || undefined, frames: !!fps });
}

function refreshVideoUi() {
  if (!current) return;
  const marks = document.getElementById('sanl-vmarks');
  const src   = document.getElementById('sanl-vsource');
  const rate  = document.getElementById('sanl-vrate');
  const ids   = startIdsInOrder();
  const id    = currentDocId();

  const prev = document.getElementById('sanl-prev');
  const next = document.getElementById('sanl-next');
  if (prev) prev.disabled = !neighbourStartId(ids, id, -1);
  if (next) next.disabled = !neighbourStartId(ids, id, +1);

  if (rate && player) rate.textContent = `×${player.rate}`;

  if (src) {
    const r = current._resolved || {};
    const kind = player?.kind;
    const bits = [];
    if (kind === 'file') bits.push(`📁 ${escHtml(player.fileName || '')}`);
    else if (kind === 'youtube') bits.push('▶ YouTube');
    else bits.push('aucune source');
    // La provenance est affichée : une cadence mesurée peut être fausse (elle
    // reflète la présentation, pas le fichier), une cadence de sidecar non.
    if (player?.fps) {
      bits.push(`${player.fps} img/s ${player.fpsSource === 'declared' ? '(sidecar)' : '(mesurée)'}`);
    } else if (player?.kind === 'file') {
      bits.push('cadence inconnue');
    }
    if (r.source === 'meeting') {
      bits.push(r.approximate
        ? '⚠️ timecode du meeting : il vise la 1ʳᵉ série de cette session'
        : 'timecode du meeting');
    }
    if (videoState.error) bits.push(`⚠️ ${escHtml(videoState.error)}`);
    src.innerHTML = bits.join(' · ');
  }

  if (marks) {
    const v = current.video;
    const fps = player?.fps || v.fps || null;
    const fmt = (t) => formatPreciseTime(t, { fps: fps || undefined, frames: !!fps });
    marks.innerHTML = `
      <span>⏱ Départ :
        ${v.startAt != null
          ? `<button class="vp-btn vp-mark-val" id="sanl-goto-start">${fmt(v.startAt)}</button>`
          : '<span class="vp-mark--unset">non marqué</span>'}
      </span>
      <span>🎯 Image V1 :
        ${v.turn1At != null
          ? `<button class="vp-btn vp-mark-val" id="sanl-goto-v1">${fmt(v.turn1At)}</button>`
          : '<span class="vp-mark--unset">non marquée</span>'}
      </span>
      ${extraitHtml()}`;
    document.getElementById('sanl-goto-start')?.addEventListener('click',
      () => player?.seek(current.video.startAt));
    document.getElementById('sanl-goto-v1')?.addEventListener('click',
      () => player?.seek(current.video.turn1At));
    document.getElementById('sanl-extrait')?.addEventListener('click', telechargerRecette);
  }
  refreshTimeDisplay();
}

// ─────────────────────────────────────────────────────────
// PRÉPARER L'EXTRAIT
//
// Le navigateur ne découpe pas la retransmission : récupérer les flux de
// YouTube depuis une page web contourne sa restriction d'accès. La coupe reste
// le travail de `tools/extract-manche`, en local. Ce qu'on supprime ici, c'est
// la recopie à la main des deux timecodes et de l'identité de la manche.
// ─────────────────────────────────────────────────────────

/**
 * Les deux instants et l'identité de la manche, tels que l'extracteur les
 * attend.
 *
 * Le garde-fou décisif est `kind === 'youtube'` : marqués sur un FICHIER local,
 * les mêmes instants sont comptés depuis le début de l'extrait, pas depuis le
 * début de la retransmission. La commande découperait alors quelques secondes
 * du tout début de la vidéo — sans rien signaler.
 */
function recetteExtrait() {
  const v = current?.video;
  if (!v || v.kind !== 'youtube') return null;
  const m = current.meeting;
  const annee = m?.date ? new Date(m.date).getFullYear() : null;
  return {
    youtubeId: current._resolved?.youtubeId || v.youtubeId || null,
    startAt: v.startAt, turn1At: v.turn1At,
    location: m?.location || null,
    year: Number.isFinite(annee) ? annee : null,
    category: selectedCategory || null,
    sessionType: current.start?.sessionType || null,
    sessionNum: current.start?.sessionNum ?? null,
    serie: current.start?.startIndex ?? null,
    // Les clés Firestore : la ligne de commande ne les aurait jamais, et sans
    // elles le sidecar ne sait pas à quelle manche l'extrait appartient.
    meetingId: selectedMeetingId || null,
    sessionId: current.start?.sessionId || null,
    championshipId: m?.championshipId || null,
  };
}

function extraitHtml() {
  const params = recetteExtrait();
  if (!params) return '';
  const r = buildExtractRecipe(params);
  const titre = r.ok
    ? `Télécharger la recette — extrait de ${r.clipDuration.toFixed(1)} s, de ${formatPreciseTime(r.clipStart)} à ${formatPreciseTime(r.clipEnd)}. `
      + 'Double-clique ensuite le raccourci « extraire-derniere-recette » sur ton Bureau.'
    : `Il manque ${r.manques.join(', ')}`;
  return `<button class="vp-btn vp-btn--mark" id="sanl-extrait" ${r.ok ? '' : 'disabled'}
    title="${escHtml(titre)}">✂️ Préparer l'extrait${r.ok ? ` (${r.clipDuration.toFixed(1)} s)` : ''}</button>`;
}

/**
 * Dépose la recette dans les téléchargements. Le raccourci sur le Bureau ira
 * la chercher : un clic ici, un double-clic là-bas, aucun terminal.
 */
function telechargerRecette() {
  const params = recetteExtrait();
  const r = params ? buildExtractRecipe(params) : { ok: false, manques: ['une retransmission YouTube'] };
  if (!r.ok) { toast(`Il manque ${r.manques.join(', ')}`, 'error'); return; }

  const a = document.createElement('a');
  a.download = r.nom;
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r.recette, null, 2)], { type: 'application/json' }));
  a.click();
  toast(`Recette prête : ${r.clipDuration.toFixed(1)} s (départ −${PAD_AVANT} s → V1 +${PAD_APRES} s). `
    + 'Double-clique « extraire-derniere-recette ».', 'success');
}

function markMoment(which) {
  if (!player || !current) return;
  if (!player.kind) { toast('Chargez d\'abord une vidéo', 'error'); return; }
  player.pause();
  const t = player.getTime();
  current.video[which] = Math.round(t * 1000) / 1000;
  current.video.kind = player.kind;
  if (player.kind === 'youtube') current.video.youtubeId = current._resolved?.youtubeId || current.video.youtubeId;
  if (player.kind === 'file') current.video.fileName = player.fileName;
  if (player.fps) current.video.fps = player.fps;
  current.dirty = true;
  refreshVideoUi();
  toast(which === 'turn1At' ? 'Image V1 marquée ✓' : 'Instant du départ marqué ✓', 'success');
}

function bindVideoControls() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

  on('sanl-video-toggle', () => {
    videoCollapsed = !videoCollapsed;
    document.getElementById('sanl-video')?.classList.toggle('is-collapsed', videoCollapsed);
    const b = document.getElementById('sanl-video-toggle');
    if (b) b.textContent = videoCollapsed ? 'Afficher' : 'Masquer';
  });

  on('sanl-prev', () => goToNeighbour(-1));
  on('sanl-next', () => goToNeighbour(+1));

  on('sanl-vload', () => {
    const raw = document.getElementById('sanl-vurl')?.value || '';
    const parsed = parseVideoSource(raw);
    if (!parsed) { toast('Lien YouTube non reconnu', 'error'); return; }
    current.video.kind = 'youtube';
    current.video.youtubeId = parsed.videoId;
    current.dirty = true;
    _loadedKey = `yt:${parsed.videoId}`;
    player.loadYoutube(parsed.videoId, parsed.startAt ?? current.video.startAt ?? 0);
    refreshVideoUi();
  });

  document.getElementById('sanl-vfile')?.addEventListener('change', async (e) => {
    const { video: file, sidecar } = pairExtractFiles(e.target.files || []);
    if (!file) { toast('Aucun fichier vidéo dans la sélection', 'error'); return; }

    // Le sidecar porte la cadence relevée par ffprobe à l'extraction. La lire
    // vaut infiniment mieux que la deviner : `requestVideoFrameCallback` mesure
    // la cadence de PRÉSENTATION, qui tombe à 30 dès que le navigateur saute
    // une image sur deux — ce qui arrive sur du 1080p60.
    sharedSidecar = null;
    if (sidecar) {
      try {
        sharedSidecar = parseExtractSidecar(await sidecar.text());
        if (!sharedSidecar) toast(`${sidecar.name} n'est pas un sidecar rx-extract/1`, 'error');
      } catch {
        toast(`Lecture impossible de ${sidecar.name}`, 'error');
      }
    }

    // Le fichier reste sur la machine : aucune donnée n'est envoyée à Firebase.
    sharedFile = file;
    current.video.kind = 'file';
    current.video.fileName = file.name;
    if (sharedSidecar?.fps) current.video.fps = sharedSidecar.fps;
    current.dirty = true;
    _loadedKey = `file:${file.name}`;
    player.loadFile(file, current.video.startAt ?? 0, { fps: sharedSidecar?.fps ?? null });
    refreshVideoUi();
  });

  on('sanl-vplay', () => player?.togglePlay());
  on('sanl-vjb', () => player?.step(-1, 'large'));
  on('sanl-vsb', () => player?.step(-1, 'medium'));
  on('sanl-vfp', () => player?.step(-1, 'frame'));
  on('sanl-vfn', () => player?.step(+1, 'frame'));
  on('sanl-vsf', () => player?.step(+1, 'medium'));
  on('sanl-vjf', () => player?.step(+1, 'large'));
  on('sanl-vfull', () => player?.toggleFullscreen());
  on('sanl-vslow', () => changeRate(-1));
  on('sanl-vfast', () => changeRate(+1));
  on('sanl-vmarkd', () => markMoment('startAt'));
  on('sanl-vmarkv', () => markMoment('turn1At'));
}

function changeRate(dir) {
  if (!player) return;
  player.setRate(nextRate(ratesFor(player.kind), player.rate, dir));
  const el = document.getElementById('sanl-vrate');
  if (el) el.textContent = `×${player.rate}`;
}

function goToNeighbour(dir) {
  const target = neighbourStartId(startIdsInOrder(), currentDocId(), dir);
  if (!target) { toast(dir > 0 ? 'Dernier départ de la catégorie' : 'Premier départ'); return; }
  selectStart(target);
}

// ─────────────────────────────────────────────────────────
// CLAVIER
// ─────────────────────────────────────────────────────────

function bindKeyboard() {
  if (_keysBound) return;
  _keysBound = true;
  document.addEventListener('keydown', (e) => {
    // Uniquement quand la vue est visible et qu'un départ est ouvert.
    const view = document.getElementById('view-startAnalysis');
    if (!view || view.style.display === 'none' || !current) return;
    const action = keyboardAction(e);
    if (!action) return;

    const needsPlayer = action !== 'nextStart' && action !== 'prevStart';
    if (needsPlayer && !player?.kind) return;

    e.preventDefault();
    switch (action) {
      case 'togglePlay':   player.togglePlay(); break;
      case 'stepBack':     player.step(-1, 'medium'); break;
      case 'stepForward':  player.step(+1, 'medium'); break;
      case 'jumpBack':     player.step(-1, 'large'); break;
      case 'jumpForward':  player.step(+1, 'large'); break;
      case 'framePrev':    player.step(-1, 'frame'); break;
      case 'frameNext':    player.step(+1, 'frame'); break;
      case 'slower':       changeRate(-1); break;
      case 'faster':       changeRate(+1); break;
      case 'markTurn1':    markMoment('turn1At'); break;
      case 'markStart':    markMoment('startAt'); break;
      case 'fullscreen':   player.toggleFullscreen(); break;
      case 'nextStart':    goToNeighbour(+1); break;
      case 'prevStart':    goToNeighbour(-1); break;
      default: break;
    }
  });
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindToolbar() {
  document.getElementById('sanl-year')?.addEventListener('change', async (e) => {
    selectedYear = parseInt(e.target.value, 10);
    selectedMeetingId = ''; selectedCategory = ''; current = null;
    resetVideo();
    await loadMeetings();
    refreshMeetingSelect(); renderList(); renderVideoPanel(); renderWork();
  });

  document.getElementById('sanl-meeting')?.addEventListener('change', async (e) => {
    selectedMeetingId = e.target.value; selectedCategory = ''; current = null;
    resetVideo();
    refreshMeetingSelect();
    await loadSessionsAndStarts();
    renderList(); renderVideoPanel(); renderWork();
  });

  document.getElementById('sanl-category')?.addEventListener('change', async (e) => {
    selectedCategory = e.target.value; current = null;
    resetVideo();
    await loadSessionsAndStarts();
    renderList(); renderVideoPanel(); renderWork();
  });
}

function bindWork() {
  bindV1Buttons();

  document.querySelectorAll('.sanl-conf').forEach(sel => {
    sel.addEventListener('change', () => {
      const row = current.rows.find(r => r.driverId === sel.dataset.driver);
      if (!row) return;
      row.confidence = sel.value;
      current.dirty = true;
      refreshFeedback();
    });
  });

  document.getElementById('sanl-mode-ordre')?.addEventListener('change', (e) => {
    pointageOrdonne = e.target.checked;
    // Le choix suit l'opérateur d'un départ à l'autre : c'est une habitude de
    // travail, pas une donnée de l'analyse. Rien n'est envoyé en base.
    try { localStorage.setItem(CLE_MODE_V1, pointageOrdonne ? '1' : '0'); } catch { /* stockage refusé */ }
    renderWork();
  });

  document.getElementById('sanl-completeness')?.addEventListener('change', (e) => {
    current.orderCompleteness = e.target.value;
    current.dirty = true;
    refreshFeedback();
  });

  document.getElementById('sanl-open-analysis')?.addEventListener('click', ouvrirAnalyse);

  document.getElementById('sanl-export-grid')?.addEventListener('click', () => {
    const doc = buildStartGridExport({
      start: current.start, rows: current.rows, poleSide: current.meeting?.poleSide,
    });
    const a = document.createElement('a');
    a.download = `grille-${(current.start.startLabel || 'depart').replace(/[^\w-]+/g, '_')}.json`;
    a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    a.click();
    toast(`Grille exportée : ${doc.drivers.length} pilote(s)`, 'success');
  });

  document.getElementById('sanl-import-proposal')?.addEventListener('click', () => {
    document.getElementById('sanl-proposal-file')?.click();
  });

  document.getElementById('sanl-proposal-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';                      // re-choisir le même fichier reste possible
    if (!f) return;
    let doc = null;
    try { doc = JSON.parse(await f.text()); } catch { toast('Fichier illisible', 'error'); return; }
    if (!isV1OrderProposal(doc)) { toast('Ce fichier n\'est pas un classement rx-v1-order/1', 'error'); return; }
    appliquerProposition(doc);
  });

  document.getElementById('sanl-accept-proposal')?.addEventListener('click', () => {
    const { rows: maj, accepted, skipped } = acceptV1Proposals(current.rows);
    current.rows = maj;
    if (accepted) current.dirty = true;
    renderWork();
    toast(skipped
      ? `${accepted} position(s) reprise(s), ${skipped} laissée(s) de côté (conflit avec une saisie)`
      : `${accepted} position(s) reprise(s)`, skipped ? 'warning' : 'success');
  });

  document.getElementById('sanl-clear')?.addEventListener('click', () => {
    current.rows.forEach(r => { r.turn1Pos = null; });
    current.dirty = true;
    renderWork();
  });

  document.getElementById('sanl-draft')?.addEventListener('click', () => persist(false));
  document.getElementById('sanl-validate')?.addEventListener('click', () => persist(true));
  document.getElementById('sanl-validate-next')?.addEventListener('click', async () => {
    if (await persist(true)) goToNeighbour(+1);
  });
}

// ─────────────────────────────────────────────────────────
// ENREGISTREMENT
// ─────────────────────────────────────────────────────────

function buildDoc() {
  const { start, rows, meeting } = current;
  const championship = championshipOfMeeting(meeting);
  return {
    id: startDocId(start.sessionId, start.startIndex),
    sessionId: start.sessionId,
    meetingId: selectedMeetingId,
    championshipId: meeting?.championshipId || null,
    year: selectedYear,
    category: selectedCategory,
    sessionType: start.sessionType,
    sessionNum: start.sessionNum ?? null,
    startIndex: start.startIndex,
    startLabel: start.startLabel,
    circuitLabel: meeting?.location || '',
    regulationKey: championship?.regulation || championship?.name || '',
    gridLanes: start.gridLanes,
    gridRowsTotal: start.gridRowsTotal,
    gridLayoutKey: start.gridLayoutKey,
    gridSource: start.gridSource,
    starters: countStarters(rows),
    lanesUsed: rows.filter(r => r.lane != null).length,
    orderCompleteness: current.orderCompleteness,
    analysis: { engine: 'manual', version: 1, ranAt: new Date(), warnings: start.warnings || [] },
    integrity: { seriesFingerprint: seriesFingerprint(start.driverIds) },
    // Repères vidéo du départ. Un fichier local n'est JAMAIS téléversé : seul
    // son nom est conservé pour retrouver le bon fichier à la prochaine session.
    video: buildVideoBlock(current.video),
    rows: rows.map(r => ({
      driverId: r.driverId,
      carNumber: r.carNumber ?? null,
      didNotStart: !!r.didNotStart,
      gridPos: r.gridPos ?? null,
      gridRow: r.gridRow ?? null,
      lane: r.lane ?? null,
      turn1Pos: r.turn1Pos ?? null,
      autoTurn1Pos: r.autoTurn1Pos ?? null,
      autoConfidence: r.autoConfidence ?? null,
      finishPosInStart: r.finishPosInStart ?? null,
      finishStatus: r.finishStatus ?? null,
      confidence: r.confidence || 'green',
      corrected: !!r.corrected,
      note: r.note || '',
    })),
    createdAt: existingAnalyses.get(startDocId(start.sessionId, start.startIndex))?.createdAt || new Date(),
  };
}

// ─────────────────────────────────────────────────────────
// PONT AVEC L'OUTIL D'ANALYSE VIDÉO
//
// Exporter une grille, la retrouver dans son dossier, la recharger, refaire le
// chemin inverse : pour quelques secondes de vidéo, c'est plus long que la
// mesure elle-même. Les deux documents sont de même origine — ils peuvent se
// parler. On n'utilise PAS `window.opener` : l'isolation d'origine de l'outil
// (COOP `same-origin`) coupe précisément ce lien. Le canal, lui, traverse, et
// il transporte le FICHIER vidéo par clonage : aucun octet ne part sur le
// réseau, et l'opérateur n'a pas à re-désigner l'extrait.
// ─────────────────────────────────────────────────────────

/** L'identifiant du départ ouvert, tel que le porte la grille exportée. */
function idDuDepartCourant() {
  if (!current?.start) return null;
  try { return startDocId(current.start.sessionId, current.start.startIndex); } catch { return null; }
}

/** Branche le canal une fois pour toutes, s'il est disponible. */
function brancherPont() {
  const canal = ouvrirCanal();
  if (!canal) return null;

  canal.ecouter((msg) => {
    // L'outil vient de s'ouvrir et annonce qu'il écoute : notre premier envoi
    // est parti dans le vide, on le refait. Sans cette poignée de main, la
    // grille n'arrive jamais.
    if (messagePour(msg, MSG_PRET) && envoiEnAttente) {
      canal.poster(envoiEnAttente);
      return;
    }
    // Le classement ne concerne que le départ ouvert ici : deux onglets sur
    // deux départs ne doivent pas se remplir l'un l'autre.
    if (!current || !messagePour(msg, MSG_CLASSEMENT, idDuDepartCourant())) return;
    if (!isV1OrderProposal(msg.doc)) { toast('Classement reçu mais illisible', 'error'); return; }
    appliquerProposition(msg.doc);
  });
  return canal;
}

/**
 * Ouvre l'outil avec tout ce qu'il faut : la grille nommée, les deux
 * timecodes, et l'extrait lui-même quand il est chargé ici.
 */
function ouvrirAnalyse() {
  if (!current) return;
  canalAnalyse = canalAnalyse || brancherPont();
  if (!canalAnalyse) {
    toast('Ce navigateur ne sait pas relier deux onglets : passez par l\'export de grille', 'error');
    return;
  }

  const grid = buildStartGridExport({
    start: current.start, rows: current.rows, poleSide: current.meeting?.poleSide,
  });
  envoiEnAttente = messageGrille({
    grid, file: sharedFile, sidecar: sharedSidecar,
    startAt: current.video.startAt, turn1At: current.video.turn1At,
  });                                      // le départ vient de la grille elle-même

  // Une fenêtre NOMMÉE : un deuxième clic réutilise l'onglet au lieu d'en
  // empiler un troisième.
  const onglet = window.open(OUTIL_V1, 'rx-analyse-video');
  if (!onglet) { toast('Le navigateur a bloqué l\'ouverture de l\'outil', 'error'); return; }

  // L'outil peut déjà être ouvert : dans ce cas il reçoit tout de suite. Sinon
  // il répondra `pret` en se chargeant, et nous renverrons.
  canalAnalyse.poster(envoiEnAttente);

  // On dit ce qui MANQUE plutôt que de laisser l'opérateur le découvrir.
  const manques = [];
  if (!sharedFile) manques.push('l\'extrait vidéo');
  if (current.video.startAt == null) manques.push('l\'instant du départ');
  if (current.video.turn1At == null) manques.push('l\'instant du premier virage');
  toast(manques.length
    ? `Outil ouvert — à compléter sur place : ${manques.join(', ')}`
    : `Outil ouvert avec la grille (${grid.drivers.length} pilotes), l'extrait et les deux timecodes`,
    manques.length ? 'warning' : 'success');
}

/**
 * Applique une proposition, d'où qu'elle vienne — fichier ou canal.
 *
 * On dit ce qui a été ÉCARTÉ, pas seulement ce qui a marché : une proposition
 * à moitié comprise doit se voir.
 */
function appliquerProposition(doc) {
  const { rows: maj, applied, rejected } = applyV1OrderProposal({
    rows: current.rows, proposal: doc, starters: countStarters(current.rows),
  });
  current.rows = maj;
  renderWork();
  if (rejected.length) {
    toast(`${applied} proposition(s) retenue(s), ${rejected.length} écartée(s) — ${rejected[0].raison}`, 'warning');
  } else {
    toast(`${applied} proposition(s) retenue(s)`, 'success');
  }
}

async function persist(validated) {
  if (!current) return false;
  if (validated) {
    const v = validateAnalysis({ rows: current.rows, orderCompleteness: current.orderCompleteness });
    if (!v.ok) { toast(v.errors[0], 'error', 5000); return false; }
  }
  const ok = await saveAnalysis(buildDoc(), { validated });
  if (!ok) return false;
  current.dirty = false;
  current.savedStatus = validated ? 'validated' : 'draft';
  toast(validated ? 'Analyse validée ✓' : 'Brouillon enregistré', 'success');
  renderList();
  renderWork();
  return true;
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initStartAnalysis() {
  document.addEventListener('viewchange', async (e) => {
    if (e.detail?.view !== 'startAnalysis') return;
    if (!_initialised) {
      _initialised = true;
      await loadMeetings();
    }
    renderView();
  });

  document.addEventListener('championshipchange', async () => {
    if (!_initialised) return;
    selectedMeetingId = ''; selectedCategory = ''; current = null;
    await loadMeetings();
    if (document.getElementById('view-startAnalysis')?.style.display !== 'none') renderView();
  });
}
