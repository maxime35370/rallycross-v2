/* ═══════════════════════════════════════════════
   PROJECTIONSTATS.JS — Vue « Projection de qualification »

   Module de VUE uniquement : il charge (via qualificationData.js) et affiche.
   Tout le calcul vit dans js/projection/*, pur et testé.

   Trois onglets :
     • Situation      — lecture d'un pilote au checkpoint courant d'un meeting
     • Historique     — courbes par écart au seuil et par points
     • Qualité données — sur quoi reposent réellement les chiffres

   Deux règles de présentation, non négociables :
     1. tout taux est affiché avec son effectif et son niveau de confiance ;
     2. DONNÉES HISTORIQUES et SIMULATION sont visuellement séparées et ne sont
        jamais additionnées. À ce stade (LOT 1), aucune simulation n'existe :
        les emplacements concernés annoncent explicitement leur absence plutôt
        que de laisser croire à une projection.
═══════════════════════════════════════════════ */

import { escHtml } from './utils.js';
import { loadHistory, loadContexts, clearCache } from './projection/qualificationData.js';
import {
  filterObservations, distinctValues, aggregateByGap, aggregateByPoints,
  buildHistoricalOutlook, formatGap, resultDistribution,
  conditionalQualificationByResult, rateStats,
} from './projection/qualificationHistory.js';
import { buildStateAfterRace } from './projection/qualificationState.js';
import {
  resolveQualificationThreshold, isTrivialQualification, gapToThreshold,
  checkRegulationSupport,
} from './projection/qualificationRules.js';
import { buildDataQualityReport } from './projection/dataQuality.js';
import { collectRaceObservations, buildDriverModels, describeModel } from './projection/driverPerformanceModel.js';
import {
  simulateFromCheckpoint, simulateScenarioMatrix, defaultScenarioLadder,
  hasRealResult,
} from './projection/scenarioSimulator.js';
import { buildRaceCertainties } from './projection/raceCertainties.js';
import {
  buildLiveObjective, directRivals, pickScenarios, mathematicalChronoTarget,
  SITUATION_LABELS,
} from './projection/liveStrategy.js';
import { computeTargetResult, marginalGains, classifyStrategy } from './projection/strategyTargetCalculator.js';
import { runBacktest, LEAKAGE_MODES } from './projection/qualificationBacktest.js';
import { MESSAGES, MIN_CASES_TO_SHOW_RATE, SIMULATION, STRATEGY } from './projection/projectionConfig.js';
import { isAdmin, isRealUser, isVerifiedUser } from './auth.js';
import { getAccessState, loadPersonByDriver } from './access/licenses.js';
import {
  allowedDriverIds, canAnalyseDriver, denialMessage, accessSummary,
  viewerState, VIEWER, licenseValidity, DENIAL,
} from './access/licenseCalc.js';

// ─────────────────────────────────────────────────────────
// ÉTAT
// ─────────────────────────────────────────────────────────

let _initialised = false;
let _loading = false;
let _loaded = false;
let _error = null;

let observations = [];
let contexts = [];
let championshipsById = {};
let report = null;

let activeTab = 'strategy';

const filters = {
  championshipId: '',
  category: '',
  year: '',
  circuit: '',
  checkpoint: 3,
};

const situation = {
  meetingKey: '',     // `${meetingId}||${category}`
  checkpoint: null,   // null = dernière manche courue
  driverId: '',
};

/** Résultats de simulation, mémorisés par pilote et checkpoint. */
const simCache = new Map();
let simSeed = SIMULATION.defaultSeed;
let simProfile = SIMULATION.defaultProfile;
let whatIfState = { key: null, running: false, progress: 0, data: null, raceNum: null };
let matrixState = { key: null, running: false, progress: 0, data: null };
let objectiveState = { key: null, running: false, data: null };
let backtestState = { running: false, progress: 0, data: null, checkpoint: 3, leakageMode: LEAKAGE_MODES[0] };

// ─────────────────────────────────────────────────────────
// ACCÈS COMMERCIAL
//
// Le moteur n'est PAS touché : il continue de charger tout le plateau et
// d'utiliser tous les pilotes comme adversaires dans les simulations. Seul
// le PILOTE ANALYSÉ est restreint — c'est-à-dire le sélecteur, et lui seul.
//
// Et il faut le dire clairement : tant que js/projection/* est servi au
// navigateur, ce filtre est un confort d'interface, pas une barrière. La
// protection réelle est dans les règles Firestore, qui empêchent quiconque
// de se fabriquer une licence. Voir docs/monetisation/PLAN-A0-ET-POC-VIDEO.md §1.6.
// ─────────────────────────────────────────────────────────

/** driverId → personId, chargé une fois depuis la collection publique `drivers`. */
let _personByDriver = new Map();

async function ensurePersonMap() {
  if (_personByDriver.size) return;
  try { _personByDriver = await loadPersonByDriver(); }
  catch (e) { console.error('[projection] carte pilote', e); }
}

/**
 * Construit le verrou pour un contexte meeting × catégorie.
 *
 * @returns {{admin, ready, allowed:Set<string>, licenses, meeting, needsLogin, needsVerify}}
 */
function buildGate(ctx, standings = []) {
  const access = getAccessState();
  const admin = isAdmin();
  const meeting = {
    id: ctx?.meetingId,
    championshipId: ctx?.meeting?.championshipId ?? null,
    year: ctx?.meeting?.year,
  };
  // On ne présente au filtre QUE les inscriptions réellement au départ de
  // ce meeting : une même fiche pilote peut porter une inscription dans un
  // autre championnat, qui n'a rien à faire ici.
  const driverIds = standings.map(d => d.driverId);
  const allowed = allowedDriverIds({
    licenses: access.licenses, personByDriver: _personByDriver,
    driverIds, meeting, isAdmin: admin,
  });
  const viewer = viewerState({
    isAdmin: admin, isRealUser: isRealUser(), isVerified: isVerifiedUser(),
    accessReady: access.ready, licenses: access.licenses,
  });
  return {
    admin,
    viewer,
    ready: viewer.ready,
    allowed,
    licenses: access.licenses,
    meeting,
  };
}

/** Bandeau : ce à quoi ce compte a droit, ici et maintenant. */
function renderAccessBanner(gate) {
  if (gate.admin) {
    return `<div class="acc-banner acc-banner--admin">
      <span class="acc-banner__icon">🔑</span>
      <span><strong>Administrateur</strong></span>
      <span class="acc-banner__scope">accès complet, tous pilotes et tous meetings</span>
    </div>`;
  }
  if (!gate.licenses.length) return '';
  const resume = accessSummary({ licenses: gate.licenses });
  if (!resume.length) return '';
  return `<div class="acc-banner">
    <span class="acc-banner__icon">🔑</span>
    <span><strong>Votre accès</strong></span>
    <span class="acc-banner__scope">${resume.map(r =>
      `${escHtml(r.personLabel)} — ${escHtml(r.scopeLabel)}`).join(' · ')}</span>
  </div>`;
}

/**
 * Écran affiché quand rien n'est analysable ici.
 *
 * Jamais un écran vide : un client qui a bien un accès, mais ailleurs, doit
 * comprendre en une phrase que ce n'est pas une panne.
 */
function renderLocked(gate) {
  if (gate.viewer.level === VIEWER.anonymous) {
    return `<div class="acc-locked">
      <div class="acc-locked__icon">🔒</div>
      <div class="acc-locked__title">Stratégie Live est réservé aux teams disposant d'un accès</div>
      <div class="acc-locked__msg">Connectez-vous depuis le menu pour retrouver vos pilotes.</div>
      <div class="acc-locked__hint">Les classements, le championnat, les statistiques et le mode
        spectateur restent accessibles sans compte.</div>
    </div>`;
  }
  if (gate.viewer.level === VIEWER.unverified) {
    return `<div class="acc-locked">
      <div class="acc-locked__icon">✉️</div>
      <div class="acc-locked__title">Adresse e-mail à vérifier</div>
      <div class="acc-locked__msg">Votre accès s'ouvrira dès que votre adresse sera confirmée.
        Ouvrez le lien reçu par e-mail, puis cliquez <strong>« J'ai vérifié »</strong> dans le menu.</div>
      <div class="acc-locked__hint">Sans ce clic, la session garde son ancien jeton pendant une heure :
        l'adresse est bien vérifiée, mais l'application ne le sait pas encore.</div>
    </div>`;
  }
  const resume = accessSummary({ licenses: gate.licenses });

  // Le team a bien un accès, mais aucun meeting de son périmètre n'a encore
  // de manche courue. Lui dire « analyse non incluse » serait faux et
  // l'inquiéterait à tort : il n'y a simplement rien à analyser pour
  // l'instant.
  if (resume.length) {
    return `<div class="acc-locked">
      <div class="acc-locked__icon">⏳</div>
      <div class="acc-locked__title">Aucune manche courue dans votre périmètre</div>
      <div class="acc-locked__msg">L'analyse s'ouvrira dès la première manche terminée.</div>
      <div class="acc-locked__hint">Votre accès :
        ${resume.map(r => `${escHtml(r.personLabel)} — ${escHtml(r.scopeLabel)}`).join(' · ')}</div>
    </div>`;
  }

  // Le team a des licences, mais AUCUNE n'est valide. Le motif n'est alors
  // pas le périmètre : c'est une suspension, une révocation ou une échéance.
  // Afficher « un autre championnat ou un autre meeting » serait faux, et
  // enverrait le client chercher un problème qui n'existe pas.
  if (gate.licenses.length) {
    const motifs = gate.licenses.map(l => licenseValidity(l, Date.now()).reason).filter(Boolean);
    const motif = motifs.includes(DENIAL.expired) ? DENIAL.expired
                : motifs.includes(DENIAL.notActive) ? DENIAL.notActive
                : motifs.includes(DENIAL.notYetValid) ? DENIAL.notYetValid
                : DENIAL.wrongScope;
    return `<div class="acc-locked">
      <div class="acc-locked__icon">🔒</div>
      <div class="acc-locked__title">Accès fermé</div>
      <div class="acc-locked__msg">${escHtml(denialMessage(motif, { hasAnyLicense: true }))}</div>
      <div class="acc-locked__hint">Contactez l'organisation si vous pensez qu'il s'agit d'une erreur.</div>
    </div>`;
  }

  return `<div class="acc-locked">
    <div class="acc-locked__icon">🔒</div>
    <div class="acc-locked__title">Analyse non incluse</div>
    <div class="acc-locked__msg">${escHtml(denialMessage('no_license', { hasAnyLicense: false }))}</div>
  </div>`;
}

/** Message précis quand un pilote choisi sort du périmètre. */
function renderDriverDenial(gate, driverId) {
  const d = canAnalyseDriver({
    licenses: gate.licenses, driverId, personByDriver: _personByDriver,
    meeting: gate.meeting, isAdmin: gate.admin,
  });
  if (d.allowed) return '';
  return `<div class="acc-locked">
    <div class="acc-locked__icon">🔒</div>
    <div class="acc-locked__title">Analyse non incluse</div>
    <div class="acc-locked__msg">${escHtml(denialMessage(d.reason, { hasAnyLicense: gate.licenses.length > 0 }))}</div>
  </div>`;
}

/**
 * Inscriptions analysables dans CE contexte meeting × catégorie.
 *
 * Version légère de `buildGate`, qui ne reconstruit pas le classement : on
 * se contente des pilotes présents dans le contexte. Assez pour répondre
 * « ce team a-t-il quelque chose à voir ici ? », et assez léger pour être
 * appelé sur chaque meeting de la saison.
 */
function contextAllowedIds(ctx) {
  const access = getAccessState();
  return allowedDriverIds({
    licenses: access.licenses,
    personByDriver: _personByDriver,
    driverIds: Object.keys(ctx?.driversById || {}),
    meeting: {
      id: ctx?.meetingId,
      championshipId: ctx?.meeting?.championshipId ?? null,
      year: ctx?.meeting?.year,
    },
    isAdmin: isAdmin(),
  });
}

/**
 * Ne garder que les meetings où le team a réellement quelque chose à voir.
 *
 * ── Pourquoi filtrer plutôt que refuser après coup ─────────────────────
 * Un team disposant d'une saison Euro RX voyait la liste ENTIÈRE : les sept
 * meetings du Championnat de France, toutes catégories confondues, soit une
 * quarantaine de lignes dont deux ou trois le concernaient. Il devait
 * chercher les siennes, et tomber sur « analyse non incluse » à chaque
 * essai manqué. On ne propose donc que ce qui est ouvert.
 *
 * L'administrateur n'est jamais filtré : il doit voir tout le calendrier.
 */
function allowedCandidates(candidates) {
  if (isAdmin()) return candidates;
  return candidates.filter(c => contextAllowedIds(c).size > 0);
}

/** Options du sélecteur, restreintes aux inscriptions autorisées. */
function driverOptions(standings, gate, selectedId) {
  const list = standings.filter(d => gate.allowed.has(d.driverId));
  return list.map(d => `<option value="${escHtml(d.driverId)}" ${d.driverId === selectedId ? 'selected' : ''}>
      P${d.position} · #${escHtml(String(d.carNumber))} ${escHtml(d.lastName || '')} ${escHtml(d.firstName || '')}
    </option>`).join('');
}

// ─────────────────────────────────────────────────────────
// HELPERS DE FORMAT
// ─────────────────────────────────────────────────────────

const pct = (r) => (r == null ? '—' : `${(100 * r).toFixed(1).replace('.', ',')} %`);

/** Un taux ne s'affiche jamais nu : effectif + confiance l'accompagnent. */
function rateCell(stats) {
  if (!stats || !stats.n) return `<span class="prj-n">aucun cas</span>`;
  const c = stats.confidence;
  // Sous le minimum, on n'affiche PAS de pourcentage : seulement le comptage
  // brut. Un « 4/4 » se lit comme ce qu'il est ; un « 100 % » induirait en
  // erreur sur un effectif de 4.
  return c.showRate
    ? `<strong>${pct(stats.rate)}</strong> <span class="prj-n">${stats.qualified}/${stats.n}</span> ${confBadge(c)}`
    : `<span class="prj-n">${stats.qualified}/${stats.n} cas</span> ${confBadge(c)}`;
}

function confBadge(c) {
  if (!c) return '';
  return `<span class="prj-conf prj-conf--${c.level}" title="Intervalle 95 % : ${pct(c.interval.low)} – ${pct(c.interval.high)}">${escHtml(c.label)}</span>`;
}

function band(kind) {
  if (kind === 'simulation')  return `<div class="prj-band prj-band--simulation">${escHtml(MESSAGES.sectionSimulation)}</div>`;
  if (kind === 'strategy')    return `<div class="prj-band prj-band--strategy">${escHtml(MESSAGES.sectionStrategy)}</div>`;
  // Quatrième bande, volontairement distincte des trois autres : ce qu'elle
  // contient est démontré, pas estimé. La confusion visuelle serait le pire
  // défaut possible de cette vue.
  if (kind === 'certainties') return `<div class="prj-band prj-band--certainties">${escHtml(MESSAGES.sectionCertainties)}</div>`;
  // L'objectif porte sa propre bande : réutiliser celle de l'interprétation
  // stratégique afficherait deux titres voisins qui disent presque la même
  // chose, juste au-dessus de la seule ligne que le team doit lire.
  if (kind === 'objective') return `<div class="prj-band prj-band--strategy">${escHtml(MESSAGES.sectionObjective)}</div>`;
  if (kind === 'plain') return '';
  return `<div class="prj-band prj-band--historical">${escHtml(MESSAGES.sectionHistorical)}</div>`;
}

function section(kind, title, body) {
  return `<div class="prj-section">${band(kind)}<div class="prj-body">
    ${title ? `<h3 class="prj-section-title">${escHtml(title)}</h3>` : ''}
    ${body}
  </div></div>`;
}

function card(label, value, sub) {
  return `<div class="prj-card">
    <div class="prj-card-label">${escHtml(label)}</div>
    <div class="prj-card-value">${value}</div>
    ${sub ? `<div class="prj-card-sub">${sub}</div>` : ''}
  </div>`;
}

function warn(text, blocking) {
  return `<div class="prj-warning${blocking ? ' prj-warning--blocking' : ''}"><span>${blocking ? '⛔' : '⚠️'}</span><span>${text}</span></div>`;
}

function notes(list) {
  if (!list?.length) return '';
  return `<ul class="prj-notes">${list.map(m => `<li>${escHtml(m)}</li>`).join('')}</ul>`;
}

function why(title, rows) {
  return `<details class="prj-why"><summary>${escHtml(title)}</summary>
    <div class="prj-why-body"><dl>
      ${rows.filter(Boolean).map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${v}</dd>`).join('')}
    </dl></div></details>`;
}

/** Barre horizontale : un taux, son effectif, son intervalle. */
function barRow(label, stats, { highlight = false } = {}) {
  const c = stats.confidence;
  // Aucune barre n'est tracée sous le minimum de cas : une barre pleine
  // largeur hachurée se lisait comme un taux de 100 %, exactement l'erreur
  // que ce garde-fou doit empêcher.
  const track = c.showRate
    ? `<div class="prj-bar-fill" style="width:${Math.round(100 * stats.rate)}%"
           title="Intervalle 95 % : ${pct(c.interval.low)} – ${pct(c.interval.high)}"></div>`
    : `<span class="prj-bar-empty">échantillon insuffisant (n &lt; ${MIN_CASES_TO_SHOW_RATE})</span>`;
  return `<div class="prj-bar-row">
    <div class="prj-bar-label${highlight ? ' is-cut' : ''}">${escHtml(label)}</div>
    <div class="prj-bar-track${c.showRate ? '' : ' is-empty'}">${track}</div>
    <div class="prj-bar-value">${rateCell(stats)}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────
// CHARGEMENT
// ─────────────────────────────────────────────────────────

async function load() {
  if (_loading) return;
  _loading = true;
  _error = null;
  try {
    const h = await loadHistory({});
    observations = h.observations;
    contexts = h.contexts;
    championshipsById = h.championshipsById;
    report = buildDataQualityReport(contexts, { championshipsById });
    _loaded = true;
  } catch (e) {
    console.error('projection : chargement', e);
    _error = e?.message || String(e);
  } finally {
    _loading = false;
  }
}

/** Observations correspondant aux filtres de l'onglet Historique. */
function selected() {
  return filterObservations(observations, {
    championshipId: filters.championshipId,
    category: filters.category,
    year: filters.year || undefined,
    circuit: filters.circuit,
  });
}

// ─────────────────────────────────────────────────────────
// RENDU — CADRE
// ─────────────────────────────────────────────────────────

function renderView() {
  const el = document.getElementById('view-projection');
  if (!el) return;

  el.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🎯 <span>Stratégie Live</span></h2>
    </div>
    <div class="prj-tabs">
      <button class="prj-tab ${activeTab === 'strategy' ? 'is-active' : ''}" data-tab="strategy">🎯 Stratégie</button>
      <button class="prj-tab ${activeTab === 'situation' ? 'is-active' : ''}" data-tab="situation">Analyse détaillée</button>
      <button class="prj-tab ${activeTab === 'history' ? 'is-active' : ''}" data-tab="history">Historique</button>
      <button class="prj-tab ${activeTab === 'backtest' ? 'is-active' : ''}" data-tab="backtest">Backtest</button>
      <button class="prj-tab ${activeTab === 'quality' ? 'is-active' : ''}" data-tab="quality">Qualité des données</button>
    </div>
    <div id="prj-content"></div>
  `;

  el.querySelectorAll('.prj-tab').forEach(b => {
    b.addEventListener('click', () => { activeTab = b.dataset.tab; renderView(); });
  });

  renderContent();
}

function renderContent() {
  const el = document.getElementById('prj-content');
  if (!el) return;

  if (_loading || !_loaded) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Chargement de l'historique…</div>`;
    return;
  }
  if (_error) {
    el.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div>
      <div class="placeholder-title">Impossible de charger les données</div>
      <div class="placeholder-desc">${escHtml(_error)}</div></div>`;
    return;
  }

  if (activeTab === 'strategy') renderStrategy(el);
  else if (activeTab === 'situation') renderSituation(el);
  else if (activeTab === 'history') renderHistory(el);
  else if (activeTab === 'backtest') renderBacktest(el);
  else renderQuality(el);
}

// ─────────────────────────────────────────────────────────
// ONGLET « EN SITUATION »
// ─────────────────────────────────────────────────────────

/** Meetings ayant au moins une manche courue — les seuls exploitables ici. */
function situationCandidates() {
  // Une manche en cours suffit à rendre le meeting analysable, même si aucune
  // manche n'est encore terminée : c'est justement le direct.
  return contexts
    .filter(c => c.lastCompletedRace > 0 || c.raceInProgress != null)
    .sort((a, b) => String(b.meeting?.date).localeCompare(String(a.meeting?.date))
      || String(a.category).localeCompare(String(b.category)));
}

// ─────────────────────────────────────────────────────────
// ÉCRAN OPÉRATIONNEL — « STRATÉGIE »
// ─────────────────────────────────────────────────────────

/**
 * L'écran qu'on ouvre pendant un meeting.
 *
 * Il répond à une seule question à la fois, dans l'ordre où elle se pose :
 * où en est mon pilote, que doit-il faire, et qu'est-ce qui est déjà acquis.
 * Tout le reste — Monte-Carlo, historique, matrice, qualité des données — vit
 * dans les autres onglets ou dans des panneaux repliés.
 *
 * La logique s'inverse d'elle-même une fois le pilote passé : la question
 * devient « que doivent faire les autres ? ».
 */
function renderStrategy(el) {
  const tous = situationCandidates();
  if (!tous.length) {
    el.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">🎯</div>
      <div class="placeholder-title">Aucun meeting avec des manches courues</div></div>`;
    return;
  }

  // Les droits doivent être connus AVANT de filtrer : sinon on afficherait
  // une liste vide à quelqu'un qui a bien un accès, le temps du chargement.
  const gate0 = buildGate(null, []);
  if (!gate0.ready) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Vérification de votre accès…</div>`;
    return;
  }

  const candidates = allowedCandidates(tous);
  if (!candidates.length) {
    el.innerHTML = renderAccessBanner(gate0) + renderLocked(gate0);
    return;
  }

  const ctx = candidates.find(c => c.key === situation.meetingKey) || candidates[0];
  situation.meetingKey = ctx.key;

  const checkpoint = ctx.completedRaces.includes(situation.checkpoint)
    ? situation.checkpoint : ctx.lastCompletedRace;
  const state = buildStateAfterRace(ctx, checkpoint);
  const thresholdInfo = resolveQualificationThreshold({
    regulation: ctx.regulation, observedPhaseCounts: ctx.observedPhaseCounts, engagedCount: ctx.engagedCount,
  });
  const threshold = thresholdInfo.threshold;
  const support = checkRegulationSupport(ctx.regulation);

  // ── Verrou commercial ────────────────────────────────────────────────
  const gate = buildGate(ctx, state.standings);
  if (!gate.ready) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Vérification de votre accès…</div>`;
    return;
  }
  // Un pilote sélectionné puis devenu hors périmètre — changement de
  // meeting, ou licence révoquée pendant la session — ne doit pas rester
  // affiché : on le libère et on explique.
  if (situation.driverId && !gate.allowed.has(situation.driverId)) {
    situation.driverId = '';
    objectiveState = { key: null, running: false, data: null };
  }

  // Rien d'analysable ICI — mais le sélecteur de meeting RESTE affiché.
  //
  // Le masquer serait un piège : un team qui a acheté Lohéac FFSA et dont
  // l'écran s'ouvre sur Lohéac Euro RX verrait « analyse non incluse » sans
  // aucun moyen d'atteindre le meeting qu'il a payé. Il conclurait que le
  // produit ne marche pas. Seuls le sélecteur de PILOTE et l'analyse sont
  // verrouillés ; la navigation entre meetings ne l'est jamais.
  if (!gate.allowed.size) {
    el.innerHTML = `
      ${renderAccessBanner(gate)}
      <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
        <select class="toolbar-select" id="prj-meeting" style="flex:1;min-width:220px">
          ${candidates.map(c => `<option value="${escHtml(c.key)}" ${c.key === ctx.key ? 'selected' : ''}>
            ${escHtml(c.meeting?.date || '')} · ${escHtml(c.meeting?.location || c.meetingId)} · ${escHtml(c.category)}
          </option>`).join('')}
        </select>
      </div>
      ${renderLocked(gate)}`;
    document.getElementById('prj-meeting')?.addEventListener('change', e => {
      situation.meetingKey = e.target.value;
      situation.checkpoint = null;
      situation.driverId = '';
      objectiveState = { key: null, running: false, data: null };
      renderContent();
    });
    return;
  }

  const driver = state.standings.find(d => d.driverId === situation.driverId) || null;

  // Manche concernée : celle en cours, sinon la prochaine. Le même écran sert
  // donc à préparer Q3 après Q2, sans logique séparée.
  const raceNum = ctx.raceInProgress ?? ctx.races.find(r => r.num > checkpoint)?.num ?? null;
  const race = raceNum != null ? ctx.races.find(r => r.num === raceNum) : null;

  el.innerHTML = `
    ${renderAccessBanner(gate)}
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="prj-meeting" style="flex:1;min-width:220px">
        ${candidates.map(c => `<option value="${escHtml(c.key)}" ${c.key === ctx.key ? 'selected' : ''}>
          ${escHtml(c.meeting?.date || '')} · ${escHtml(c.meeting?.location || c.meetingId)} · ${escHtml(c.category)}
        </option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-driver" style="flex:1;min-width:220px">
        <option value="">— Choisir un pilote —</option>
        ${driverOptions(state.standings, gate, situation.driverId)}
      </select>
    </div>
    ${!support.supported ? warn(`${escHtml(MESSAGES.unsupportedRegulation)} — ${escHtml(support.reasons.join(' '))}`, true) : ''}
    <div id="prj-strategy-body"></div>
  `;

  document.getElementById('prj-meeting')?.addEventListener('change', e => {
    situation.meetingKey = e.target.value;
    situation.checkpoint = null;
    situation.driverId = '';
    objectiveState = { key: null, running: false, data: null };
    renderContent();
  });
  document.getElementById('prj-driver')?.addEventListener('change', e => {
    situation.driverId = e.target.value;
    objectiveState = { key: null, running: false, data: null };
    renderContent();
  });

  const body = document.getElementById('prj-strategy-body');
  if (!support.supported) { body.innerHTML = ''; return; }

  if (!driver) {
    body.innerHTML = `${renderLiveBanner(ctx, ctx.raceInProgress != null ? race : null)}
      <div class="tim-placeholder"><div class="placeholder-icon">🎯</div>
        <div class="placeholder-title">Choisissez un pilote</div>
        <div class="placeholder-desc">
          ${raceNum != null
            ? `L'objectif portera sur la manche Q${raceNum}${ctx.raceInProgress != null ? ' (en cours)' : ' (à venir)'}.`
            : 'Toutes les manches qualificatives sont courues.'}
        </div></div>
      ${renderStandingsTable(state, thresholdInfo, null)}`;
    return;
  }

  const key = objectiveKey(ctx, checkpoint, driver);
  // Calcul lancé automatiquement : sur cet écran, la consigne est l'objet même
  // de la visite. Demander un clic supplémentaire n'aurait aucun sens en bord
  // de piste.
  if (objectiveState.key !== key && !objectiveState.running && raceNum != null) {
    computeObjective(ctx, state, threshold, checkpoint, driver);
  }

  body.innerHTML = [
    renderStrategyHeadline(ctx, state, thresholdInfo, checkpoint, driver, raceNum),
    renderStrategyMain(ctx, checkpoint, driver, threshold, raceNum),
    driver ? renderCertainties(ctx, checkpoint, driver, threshold) : '',
    renderStrategyLinks(),
    renderStandingsTable(state, thresholdInfo, driver),
  ].join('');

  bindSimulationControls(ctx, state, threshold, checkpoint, driver);
  document.querySelectorAll('[data-goto-tab]').forEach(b => {
    b.addEventListener('click', () => { activeTab = b.dataset.gotoTab; renderView(); });
  });
}

/** Bandeau d'identité : qui, où, contre quel seuil, et sur quelle manche. */
function renderStrategyHeadline(ctx, state, thresholdInfo, checkpoint, driver, raceNum) {
  const gap = gapToThreshold(driver.position, thresholdInfo.threshold);
  const enCours = ctx.raceInProgress === raceNum;
  const race = raceNum != null ? ctx.races.find(r => r.num === raceNum) : null;

  return `<div class="prj-strategy-head">
    <div>
      <div class="prj-strategy-title">
        ${raceNum != null ? `STRATÉGIE Q${raceNum}` : 'MANCHES TERMINÉES'} —
        #${escHtml(String(driver.carNumber))} ${escHtml(driver.lastName || '')}
      </div>
      <div class="prj-strategy-sub">
        P${driver.position} intermédiaire · ${driver.totalPoints} pts · seuil P${thresholdInfo.threshold}
        · ${escHtml(formatGap(gap))}
        ${race ? ` · Q${raceNum} ${enCours ? `EN COURS — ${race.ranCount}/${race.engagedCount} résultats` : 'à venir'}` : ''}
      </div>
    </div>
  </div>`;
}

/** Renvoie vers le second niveau, sans le mélanger à la consigne. */
function renderStrategyLinks() {
  return `<div class="prj-strategy-links">
    <button class="btn btn-secondary btn-sm" data-goto-tab="situation">Analyse détaillée · Monte-Carlo, what-if, matrice</button>
    <button class="btn btn-secondary btn-sm" data-goto-tab="history">Historique comparable</button>
    <button class="btn btn-secondary btn-sm" data-goto-tab="quality">Qualité des données</button>
  </div>`;
}

/**
 * Le bloc principal : objectif, référence chrono, avertissement série, risque
 * d'incident, et — après le passage — ce que les autres doivent faire.
 */
function renderStrategyMain(ctx, checkpoint, driver, threshold, raceNum) {
  if (raceNum == null) {
    return section('certainties', null,
      '<p style="margin:0">Toutes les manches qualificatives sont courues : le classement est un fait, il n\'y a plus de consigne à donner.</p>');
  }
  const key = objectiveKey(ctx, checkpoint, driver);
  if (objectiveState.key !== key || !objectiveState.data) {
    return section('objective', null,
      '<div class="loading-state"><div class="spinner"></div> Calcul de l\'objectif…</div>');
  }

  const { objective: o, rivals, scenarios, maths } = objectiveState.data;
  if (!o) return '';
  const situ = SITUATION_LABELS[o.mode] || SITUATION_LABELS.target;

  // ── Après le passage : que doivent faire les autres ? ───────────────────
  if (o.mode === 'afterRun') {
    const r = o.resilience;
    const acquis = r?.safeWhatever
      ? `<p class="prj-strategy-certain">Même si tous les ${r.pendingCount} pilotes restants battent son chrono, il reste dans la zone qualificative.</p>`
      : r && r.maxBeatenBy != null
        ? `<p class="prj-strategy-certain">Il faudrait qu'au moins ${r.maxBeatenBy + 1} des ${r.pendingCount} pilotes restants battent son chrono pour que sa qualification ne soit plus acquise.</p>`
        : r
          ? `<p class="prj-n" style="margin:var(--sp-sm) 0 0">Sa qualification n'est pas encore démontrable : elle dépend des résultats des ${r.pendingCount} pilotes restants. Le chiffre ci-dessus reste une probabilité.</p>`
          : '';
    const menaces = (o.threats || []).slice(0, 5);
    // La situation est qualifiée du même mot avant et après le passage : un
    // écran qui change de vocabulaire selon le moment se relit mal.
    const situApres = r?.safeWhatever ? SITUATION_LABELS.settled : situ;
    return section('objective', null, `
      <div class="prj-situation prj-situation--${situApres.tone}">${escHtml(situApres.label)}</div>
      <div class="prj-objective">
        <div class="prj-objective-main">
          <div class="prj-objective-goal">✅ Résultat Q${o.raceNum} acquis${r?.provisionalPosition ? ` — P${r.provisionalPosition} provisoire` : ''}</div>
          ${r?.ms != null ? `<div class="prj-objective-chrono">⏱ ${escHtml(fmtMs(r.ms))}</div>` : ''}
        </div>
        <div class="prj-objective-side">
          <div class="prj-objective-prob">${pct(o.probability)}</div>
          <div class="prj-objective-prob-label">qualification projetée</div>
        </div>
      </div>
      <p class="prj-objective-compare">${o.remainingToRun} pilote${o.remainingToRun > 1 ? 's' : ''} rest${o.remainingToRun > 1 ? 'ent' : 'e'} à courir.
         ${escHtml(MESSAGES.afterOurRun)}</p>
      ${acquis}
      ${menaces.length ? `<h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">
          Qui peut encore le faire basculer</h4>
        <div class="prj-scroll"><table class="prj-table">
          <thead><tr><th>Pilote encore à courir</th><th class="center">Finit devant lui</th></tr></thead>
          <tbody>${menaces.map(m => `<tr>
            <td>${driverLabel(ctx, m.driverId)} ${escHtml(m.firstName || '')}</td>
            <td class="center">${pct(m.probabilityAhead)}</td>
          </tr>`).join('')}</tbody></table></div>` : ''}
      ${renderObjectiveDetail(ctx, o, rivals)}`);
  }

  // ── Avant le passage : que doit faire notre pilote ? ────────────────────
  let titre = '', chrono = null, sous = '';
  if (o.mode === 'settled') {
    titre = MESSAGES.objectiveSettled;
    sous = MESSAGES.objectiveNone;
  } else if (o.mode === 'comfortable') {
    titre = 'Large plage de résultats compatible';
    sous = MESSAGES.objectiveComfortable;
  } else if (o.mode === 'dependent') {
    titre = 'Aucun résultat ne suffit à lui seul';
    sous = o.best ? `Même « ${o.best.label} » ne donne que ${pct(o.best.probability)}.` : '';
  } else if (o.target) {
    titre = `${o.target.label} ou mieux`;
    chrono = o.target.reference?.beat != null ? fmtMs(o.target.reference.beat) : null;
    sous = chrono
      ? (o.exact ? MESSAGES.chronoCertain(chrono, o.target.rank)
                 : MESSAGES.chronoProbabilistic(chrono, o.target.rank, pct(o.target.probability)))
      : '';
  }

  const menace = (o.seriesThreat || []).filter(m => (m.probabilityBeatsTarget ?? 0) >= 0.25);
  const grand = o.mode === 'target' ? o.probabilityAtTarget : o.probability;

  return section('objective', null, `
    <div class="prj-situation prj-situation--${situ.tone}">${escHtml(situ.label)}</div>
    <div class="prj-objective">
      <div class="prj-objective-main">
        <div class="prj-objective-label">OBJECTIF</div>
        <div class="prj-objective-goal">🎯 ${escHtml(titre)}</div>
        ${chrono ? `<div class="prj-objective-label" style="margin-top:var(--sp-sm)">RÉFÉRENCE ACTUELLE</div>
                    <div class="prj-objective-chrono">⏱ battre ${escHtml(chrono)}</div>` : ''}
      </div>
      <div class="prj-objective-side">
        <div class="prj-objective-prob">${pct(grand)}</div>
        <div class="prj-objective-prob-label">${o.mode === 'target' ? 'si l\'objectif est atteint' : 'qualification projetée'}</div>
      </div>
    </div>
    ${o.mode === 'target' ? `<p class="prj-objective-compare">
        Sans cette cible : <strong>${pct(o.probability)}</strong>
        ${o.justBehind ? ` · une place derrière : <strong>${pct(o.justBehind.probability)}</strong>` : ''}
      </p>` : ''}
    ${sous ? `<p style="margin:var(--sp-sm) 0 0">${escHtml(sous)}</p>` : ''}
    ${menace.length && chrono ? warn(escHtml(MESSAGES.seriesMatesWarning(chrono, menace.length))) : ''}
    ${o.incident ? `<p class="prj-objective-risk">⚠️ ${escHtml(o.incident.status)} → <strong>${pct(o.incident.probability)}</strong> de qualification</p>` : ''}
    ${maths && !maths.impossible && !maths.unconditional && maths.beat != null
      ? `<p class="prj-strategy-certain">Battre ${escHtml(fmtMs(maths.beat))}
           (${driverLabel(ctx, maths.beatDriverId)}) rend la qualification acquise quels que soient les résultats restants.</p>`
      : ''}
    ${scenarios?.length ? `<h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">Chemins possibles</h4>
       <ul class="prj-notes">${scenarios.map(sc => `<li><strong>${escHtml(sc.label)}</strong> — ${pct(sc.probability)}</li>`).join('')}</ul>` : ''}
    ${renderSeriesPanel(ctx, o)}
    ${renderObjectiveDetail(ctx, o, rivals)}`);
}

/** Composition de la série et menace des coéquipiers, repliée. */
function renderSeriesPanel(ctx, o) {
  if (!o.series) return '';
  const mates = o.series.pendingMates || [];
  return why(`Série ${o.series.num} — ${mates.length} coéquipier${mates.length > 1 ? 's' : ''} encore à courir`, [
    ['Composition', o.series.inferred ? escHtml(MESSAGES.inferredSeries) : 'renseignée dans les résultats'],
    ['Déjà passés dans la série', String(o.series.ranMembers)],
    ['Encore à courir', mates.length
      ? mates.map(m => driverLabel(ctx, m.driverId)).join(' · ')
      : 'aucun — la cible chrono est exacte'],
    ...((o.seriesThreat || []).length ? [['Menace sur la cible',
      `<div class="prj-scroll"><table class="prj-table">
        <thead><tr><th>Coéquipier</th><th class="center">Bat le chrono cible</th></tr></thead>
        <tbody>${o.seriesThreat.map(m => `<tr>
          <td>${driverLabel(ctx, m.driverId)}</td>
          <td class="center">${pct(m.probabilityBeatsTarget)}</td>
        </tr>`).join('')}</tbody></table></div>`]] : []),
  ]);
}

/** Échelle de cibles et concurrents directs, repliés : c'est la partie ingénieur. */
function renderObjectiveDetail(ctx, o, rivals) {
  return why('Pourquoi ? — échelle de cibles et concurrents directs', [
    ['Manche', `Q${o.raceNum}`],
    ['Pilotes encore à courir', String(o.pendingOthers)],
    ['Nature de la cible', o.exact
      ? 'exacte — plus personne d\'autre ne doit rouler'
      : 'probabiliste — d\'autres pilotes doivent encore rouler'],
    ...((o.ladder || []).length ? [['Échelle de cibles', `<div class="prj-scroll"><table class="prj-table">
        <thead><tr><th>Hypothèse</th><th>Chrono à battre</th><th class="center">P(qualif)</th><th class="center">Place médiane</th></tr></thead>
        <tbody>${o.ladder.map(e => `<tr${o.target && e.rank === o.target.rank ? ' class="is-target"' : ''}>
          <td>${escHtml(e.label || `P${e.rank}`)}</td>
          <td>${e.reference?.beat != null ? escHtml(fmtMs(e.reference.beat)) : '—'}</td>
          <td class="center">${pct(e.probability)}</td>
          <td class="center">${e.medianRacePosition != null ? `P${e.medianRacePosition}` : '—'}</td>
        </tr>`).join('')}</tbody></table></div>`]] : []),
    ['Concurrents directs', `<div class="prj-scroll"><table class="prj-table">
        <thead><tr><th>Pilote</th><th class="center">Impact</th><th class="center">S'il réussit</th><th class="center">S'il abandonne</th></tr></thead>
        <tbody>${(rivals?.all || []).map(r => `<tr>
          <td>${driverLabel(ctx, r.driverId)}</td>
          <td class="center">${r.settled ? 'résultat acquis' : `${(100 * r.impact).toFixed(1)} pt`}</td>
          <td class="center">${r.settled ? '—' : pct(r.probabilityIfRivalBest)}</td>
          <td class="center">${r.settled ? '—' : pct(r.probabilityIfRivalOut)}</td>
        </tr>`).join('')}</tbody></table></div>`],
    ['Seuil « concurrent direct »', `${(100 * (rivals?.minImpact ?? STRATEGY.directRivalMinImpact)).toFixed(0)} points de probabilité — choix de lisibilité ; l'impact de chacun reste listé ci-dessus`],
    ['Méthode', 'chaque hypothèse simule TOUS les pilotes non encore passés, coéquipiers de série compris, puis relit le classement complet de la manche'],
    ['Traduction en chrono', escHtml(MESSAGES.chronoIsATranslation)],
    ['Graine', `<code>${simSeed}</code>`],
  ]);
}

function renderSituation(el) {
  const tous = situationCandidates();
  if (!tous.length) {
    el.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">📐</div>
      <div class="placeholder-title">Aucun meeting avec des manches courues</div></div>`;
    return;
  }

  // Même filtrage que l'écran opérationnel : les deux onglets donnent accès
  // aux mêmes probabilités, ils ne peuvent pas proposer des périmètres
  // différents.
  const gate0 = buildGate(null, []);
  if (!gate0.ready) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Vérification de votre accès…</div>`;
    return;
  }
  const candidates = allowedCandidates(tous);
  if (!candidates.length) {
    el.innerHTML = renderAccessBanner(gate0) + renderLocked(gate0);
    return;
  }

  const ctx = candidates.find(c => c.key === situation.meetingKey) || candidates[0];
  situation.meetingKey = ctx.key;

  const checkpoints = ctx.completedRaces;
  const checkpoint = checkpoints.includes(situation.checkpoint)
    ? situation.checkpoint
    : ctx.lastCompletedRace;
  // Le moteur est piloté par l'état RÉEL du meeting : la manche en cours n'est
  // pas un cas particulier « après Q3 », c'est simplement la première manche
  // encore ouverte au checkpoint courant.
  const live = ctx.raceInProgress != null && checkpoint === ctx.lastCompletedRace
    ? ctx.races.find(r => r.num === ctx.raceInProgress) : null;

  const state = buildStateAfterRace(ctx, checkpoint);
  // `thresholdInfo` porte la valeur ET sa provenance ; le simulateur, lui,
  // attend un NOMBRE. Les confondre rendait tout le monde non qualifié en
  // silence — d'où le nommage explicite.
  const thresholdInfo = resolveQualificationThreshold({
    regulation: ctx.regulation,
    observedPhaseCounts: ctx.observedPhaseCounts,
    engagedCount: ctx.engagedCount,
  });
  const threshold = thresholdInfo.threshold;
  const support = checkRegulationSupport(ctx.regulation);
  const trivial = isTrivialQualification(ctx.engagedCount, threshold);

  // Même verrou que l'écran opérationnel : l'onglet d'analyse détaillée
  // donne accès aux mêmes probabilités, il ne peut pas être plus permissif.
  const gate = buildGate(ctx, state.standings);
  if (!gate.ready) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Vérification de votre accès…</div>`;
    return;
  }
  if (situation.driverId && !gate.allowed.has(situation.driverId)) {
    situation.driverId = '';
    objectiveState = { key: null, running: false, data: null };
  }
  // Même principe que l'écran opérationnel : le sélecteur de meeting reste
  // accessible pour que le team puisse rejoindre son périmètre.
  if (!gate.allowed.size) {
    el.innerHTML = `
      ${renderAccessBanner(gate)}
      <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
        <select class="toolbar-select" id="prj-meeting" style="flex:1;min-width:220px">
          ${candidates.map(c => `<option value="${escHtml(c.key)}" ${c.key === ctx.key ? 'selected' : ''}>
            ${escHtml(c.meeting?.date || '')} · ${escHtml(c.meeting?.location || c.meetingId)} · ${escHtml(c.category)}
          </option>`).join('')}
        </select>
      </div>
      ${renderLocked(gate)}`;
    document.getElementById('prj-meeting')?.addEventListener('change', e => {
      situation.meetingKey = e.target.value;
      situation.checkpoint = null;
      situation.driverId = '';
      renderContent();
    });
    return;
  }

  const driver = state.standings.find(d => d.driverId === situation.driverId) || null;

  el.innerHTML = `
    ${renderAccessBanner(gate)}
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="prj-meeting" style="flex:1;min-width:220px">
        ${candidates.map(c => `<option value="${escHtml(c.key)}" ${c.key === ctx.key ? 'selected' : ''}>
          ${escHtml(c.meeting?.date || '')} · ${escHtml(c.meeting?.location || c.meetingId)} · ${escHtml(c.category)}
        </option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-checkpoint" ${checkpoints.length ? '' : 'disabled'}>
        ${checkpoints.length
          ? checkpoints.map(n => `<option value="${n}" ${n === checkpoint ? 'selected' : ''}>Après Q${n}</option>`).join('')
          : '<option>Aucune manche terminée</option>'}
      </select>
      <select class="toolbar-select" id="prj-driver" style="flex:1;min-width:200px">
        <option value="">— Choisir un pilote —</option>
        ${driverOptions(state.standings, gate, situation.driverId)}
      </select>
    </div>
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <label class="prj-inline-field">Tirages
        <select class="toolbar-select" id="prj-profile">
          ${Object.entries(SIMULATION.profiles).map(([id, n]) =>
            `<option value="${id}" ${id === simProfile ? 'selected' : ''}>${n.toLocaleString('fr-FR')}</option>`).join('')}
        </select>
      </label>
      <label class="prj-inline-field" title="Même graine = simulation strictement reproductible">Graine
        <input class="toolbar-select" type="number" id="prj-seed" value="${simSeed}" style="width:120px">
      </label>
    </div>
    ${!support.supported ? warn(`${escHtml(MESSAGES.unsupportedRegulation)} — ${escHtml(support.reasons.join(' '))}`, true) : ''}
    <div id="prj-situation-body"></div>
  `;

  // Changer de meeting ou de checkpoint change la liste des manches restantes :
  // la manche retenue pour les scénarios doit repartir de la PROCHAINE, sinon
  // elle reste figée sur un choix qui n'a plus de sens (par exemple Q4 alors
  // qu'on vient de reculer au checkpoint après Q2).
  const resetScenarioRace = () => {
    whatIfState = { key: null, running: false, progress: 0, data: null, raceNum: null };
    matrixState = { key: null, running: false, progress: 0, data: null };
    objectiveState = { key: null, running: false, data: null };
  };
  document.getElementById('prj-meeting')?.addEventListener('change', e => {
    situation.meetingKey = e.target.value;
    situation.checkpoint = null;
    situation.driverId = '';
    resetScenarioRace();
    renderContent();
  });
  document.getElementById('prj-checkpoint')?.addEventListener('change', e => {
    situation.checkpoint = Number(e.target.value);
    resetScenarioRace();
    renderContent();
  });
  document.getElementById('prj-driver')?.addEventListener('change', e => {
    situation.driverId = e.target.value;
    renderContent();
  });

  const body = document.getElementById('prj-situation-body');
  if (!support.supported) { body.innerHTML = ''; return; }

  body.innerHTML = [
    renderSituationHeader(ctx, state, thresholdInfo, checkpoint, trivial),
    renderLiveBanner(ctx, live),
    driver ? renderCertainties(ctx, checkpoint, driver, threshold) : '',
    driver ? renderObjective(ctx, state, threshold, checkpoint, driver) : '',
    driver ? renderDriverOutlook(ctx, state, thresholdInfo, checkpoint, driver, trivial) : '',
    driver ? renderSimulation(ctx, state, threshold, checkpoint, driver) : renderSimulationIntro(checkpoint, ctx),
    driver && whatIfState.data && whatIfState.key === whatIfKey(ctx, checkpoint, driver, whatIfRaceOf(ctx, checkpoint))
      ? renderStrategySection() : '',
    driver ? renderMatrixBlock(ctx, state, checkpoint, driver) : '',
    renderStandingsTable(state, thresholdInfo, driver),
  ].join('');

  bindSimulationControls(ctx, state, threshold, checkpoint, driver);
}

function renderSituationHeader(ctx, state, threshold, checkpoint, trivial) {
  const remaining = state.remainingRaces;
  const cards = [
    card('Meeting', escHtml(ctx.meeting?.location || ctx.meetingId), escHtml(ctx.category)),
    card('Checkpoint', `Après Q${checkpoint}`, remaining.length
      ? `Reste ${remaining.map(n => `Q${n}`).join(', ')}`
      : 'Manches qualificatives terminées'),
    card('Engagés', String(ctx.engagedCount), `${state.count} classés`),
    card('Places qualificatives', threshold.threshold != null ? String(threshold.threshold) : '—', escHtml(threshold.label)),
  ].join('');

  const trivialNote = trivial
    ? warn(escHtml(MESSAGES.trivialQualification(ctx.engagedCount, threshold.threshold)))
    : '';

  return section('historical', null, `${trivialNote}<div class="prj-cards">${cards}</div>`);
}

/**
 * Bandeau « manche en cours » : combien de résultats réels, combien de pilotes
 * restent, et où en sont les séries — en disant ce qu'on sait, et seulement ça.
 */
function renderLiveBanner(ctx, live) {
  if (!live) return '';
  const c = buildRaceCertainties({ context: ctx, driverId: null, threshold: null });
  const d = c.description;
  const pending = live.pendingDriverIds
    .map(id => ctx.driversById?.[id])
    .filter(Boolean)
    .map(p => `#${escHtml(String(p.carNumber ?? '?'))} ${escHtml(p.lastName || '')}`);

  return `<div class="prj-live">
    <div class="prj-live-head">
      <span class="prj-live-dot"></span>
      <strong>${escHtml(d.drivers)}</strong>
    </div>
    <div class="prj-live-bar">
      <div class="prj-live-bar-fill" style="width:${Math.round(100 * live.ranCount / Math.max(1, live.engagedCount))}%"></div>
    </div>
    <p class="prj-n" style="margin:var(--sp-xs) 0 0">${escHtml(d.series)}</p>
    <p class="prj-n" style="margin:var(--sp-xs) 0 0">
      ${escHtml(MESSAGES.hybridNotice(live.ranCount, live.pendingDriverIds.length))}
    </p>
    ${pending.length ? `<p class="prj-n" style="margin:var(--sp-xs) 0 0">Restent à courir : ${pending.join(' · ')}</p>` : ''}
  </div>`;
}

/**
 * Bloc CERTITUDES.
 *
 * Règle absolue : rien ici ne provient d'un tirage. Une métrique voisine mais
 * non déterministe reste dans le bloc simulation, sous la forme « dans X % des
 * simulations » — jamais présentée comme un fait.
 */
function renderCertainties(ctx, checkpoint, driver, threshold) {
  const c = buildRaceCertainties({ context: ctx, driverId: driver.driverId, threshold, checkpoint });
  if (c.raceNum == null) return '';

  const b = c.bounds;
  const cards = [
    card('Position provisoire', b?.hasRun && b.provisionalPosition != null ? `P${b.provisionalPosition}` : (b?.status || '—'),
      b?.hasRun ? `manche ${c.raceNum} courue` : `pas encore passé en manche ${c.raceNum}`),
    card('Meilleure position possible', b ? `P${b.bestPosition}` : '—',
      b?.hasRun ? 'aucun pilote déjà classé derrière ne peut repasser devant' : 'tout reste ouvert'),
    card('Pire position théorique', b ? `P${b.worstPosition}` : '—',
      b ? `si les ${b.pendingCount} pilote${b.pendingCount > 1 ? 's' : ''} restant${b.pendingCount > 1 ? 's' : ''} le devance${b.pendingCount > 1 ? 'nt' : ''}` : ''),
    card('Points de la manche', c.points && c.points.min === c.points.max ? String(c.points.min)
      : (c.points ? `${c.points.min} – ${c.points.max}` : '—'),
      c.points?.includesIncident ? 'borne basse : abandon compris' : 'encadrement exact'),
  ].join('');

  const list = c.statements.length
    ? `<ul class="prj-certainties">${c.statements.map(x => `<li>${escHtml(x.text)}</li>`).join('')}</ul>`
    : `<p class="prj-n" style="margin:0">Aucun énoncé ne peut être démontré à ce stade.</p>`;

  const suite = c.stillAProjection
    ? `<p class="prj-n" style="margin:var(--sp-sm) 0 0">${escHtml(MESSAGES.stillAProjection)}</p>` : '';

  return section('certainties', null, `
    <p class="prj-n" style="margin:0 0 var(--sp-sm)">${escHtml(MESSAGES.certaintiesScope)}</p>
    <div class="prj-cards">${cards}</div>
    ${list}
    ${suite}
    ${why('Sur quoi repose chaque énoncé ?', [
      ['Nature', 'déduction — aucun tirage, aucune graine, aucun modèle'],
      ['Manche en cours', `Q${c.raceNum}`],
      ['Résultats déjà connus', `${c.progress.ranCount} sur ${c.progress.engagedCount}`],
      ['Séries', escHtml(c.description.series)],
      ['Dernière manche du meeting', c.isLastRace ? 'oui — un verdict est possible' : 'non — la qualification reste une probabilité'],
      ['Verdict mathématique', c.verdict ? escHtml(c.verdict.state) : 'sans objet'],
      ...(c.verdict ? [
        ['Total minimum garanti', String(c.verdict.minTotal)],
        ['Total maximum atteignable', String(c.verdict.maxTotal)],
        ['Adversaires pouvant encore passer devant', String(c.verdict.rivalsAbleToPass)],
        ['Méthode', 'chaque adversaire est crédité de son meilleur résultat encore possible : une conclusion « qualifié » est donc valide à coup sûr'],
      ] : []),
    ])}`);
}

/** Chrono lisible : 2:31.488. */
function fmtMs(ms) {
  if (ms == null) return '—';
  const t = Math.round(ms);
  return `${Math.floor(t / 60000)}:${String(Math.floor(t % 60000 / 1000)).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
}

const driverLabel = (ctx, id) => {
  const d = ctx.driversById?.[id] || {};
  return `#${escHtml(String(d.carNumber ?? '?'))} ${escHtml(d.lastName || '')}`;
};

function objectiveKey(ctx, checkpoint, driver) {
  return `${ctx.key}|${checkpoint}|${driver.driverId}|${simSeed}`;
}

/**
 * OBJECTIF PILOTE.
 *
 * Ce bloc est lu en quelques secondes, juste avant un départ, par quelqu'un qui
 * doit transmettre une consigne à la radio. Il ne contient donc qu'une cible et
 * un chrono ; toute la statistique vit en dessous, repliée.
 *
 * Il ne s'affiche que pendant une manche : hors manche, il n'y a pas de consigne
 * à donner, seulement une projection.
 */
function renderObjective(ctx, state, threshold, checkpoint, driver) {
  const raceNum = ctx.raceInProgress ?? null;
  if (raceNum == null || threshold == null) return '';
  const key = objectiveKey(ctx, checkpoint, driver);

  if (objectiveState.running && objectiveState.key === key) {
    return section('strategy', MESSAGES.sectionObjective,
      '<div class="loading-state"><div class="spinner"></div> Calcul de l\'objectif…</div>');
  }
  if (objectiveState.key !== key || !objectiveState.data) {
    return section('strategy', MESSAGES.sectionObjective, `
      <p class="prj-n">Traduit la situation réelle en une consigne transmissible. Le calcul simule
         tous les pilotes non encore passés, coéquipiers de série compris.</p>
      <button class="btn btn-primary" id="prj-objective">Calculer l'objectif Q${raceNum}</button>`);
  }

  const { objective: o, rivals, scenarios, maths } = objectiveState.data;
  if (!o) return '';

  // ── Titre de la consigne, selon la situation ────────────────────────────
  let titre = '', sous = '', chrono = '';
  if (o.mode === 'afterRun') {
    titre = MESSAGES.afterOurRun;
  } else if (o.mode === 'settled') {
    titre = MESSAGES.objectiveSettled;
    sous = MESSAGES.objectiveNone;
  } else if (o.mode === 'comfortable') {
    titre = MESSAGES.objectiveComfortable;
  } else if (o.mode === 'dependent') {
    titre = MESSAGES.objectiveDependent;
    sous = o.best ? `Même P${o.best.provisionalTarget} au provisoire ne donne que ${pct(o.best.probability)}.` : '';
  } else if (o.target) {
    titre = `Être P${o.target.provisionalTarget} au provisoire de la manche, ou mieux`;
    chrono = o.target.reference?.beat != null ? fmtMs(o.target.reference.beat) : null;
    sous = chrono
      ? (o.exact
          ? MESSAGES.chronoCertain(chrono, o.target.provisionalTarget)
          : MESSAGES.chronoProbabilistic(chrono, o.target.provisionalTarget, pct(o.target.probability)))
      : '';
  }

  const menace = (o.seriesThreat || []).filter(m => (m.probabilityBeatsTarget ?? 0) >= 0.25);
  const avertissement = (o.mode === 'target' && chrono && menace.length)
    ? warn(escHtml(MESSAGES.seriesMatesWarning(chrono, menace.length)))
    : '';

  const bandeau = `
    <div class="prj-objective">
      <div class="prj-objective-main">
        <div class="prj-objective-goal">🎯 ${escHtml(titre)}</div>
        ${chrono ? `<div class="prj-objective-chrono">⏱ ${escHtml(chrono)}</div>` : ''}
      </div>
      <div class="prj-objective-side">
        <div class="prj-objective-prob">${pct(o.mode === 'target' ? o.probabilityAtTarget : o.probability)}</div>
        <div class="prj-objective-prob-label">${o.mode === 'target' ? 'si l\'objectif est atteint' : 'qualification projetée'}</div>
      </div>
    </div>
    ${o.mode === 'target' ? `<p class="prj-objective-compare">
       Sans cette cible : <strong>${pct(o.probability)}</strong>
       ${o.justBehind ? ` · une place derrière (P${o.justBehind.provisionalTarget}) : <strong>${pct(o.justBehind.probability)}</strong>` : ''}
     </p>` : ''}
    ${sous ? `<p style="margin:var(--sp-sm) 0 0">${escHtml(sous)}</p>` : ''}`;

  // ── Certitude chrono, quand elle existe ─────────────────────────────────
  const certain = maths && !maths.impossible && !maths.unconditional && maths.beat != null
    ? `<p style="margin:var(--sp-sm) 0 0">
         <strong>Cible mathématique</strong> — battre ${escHtml(fmtMs(maths.beat))}
         (${driverLabel(ctx, maths.beatDriverId)}) rend la qualification acquise quels que soient
         les résultats restants.</p>`
    : '';

  // ── Menace des coéquipiers de série ─────────────────────────────────────
  const serie = o.series ? `
    <h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">
      Série ${o.series.num}${o.series.inferred ? ' (déduite)' : ''} — ${o.series.pendingMates.length} coéquipier${o.series.pendingMates.length > 1 ? 's' : ''} encore à courir</h4>
    ${o.series.inferred ? `<p class="prj-n">${escHtml(MESSAGES.inferredSeries)}</p>` : ''}
    ${menace.length ? `<div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Coéquipier de série</th><th class="center">Bat le chrono cible</th></tr></thead>
      <tbody>${o.seriesThreat.map(m => `<tr>
        <td>${driverLabel(ctx, m.driverId)} ${escHtml(m.firstName || '')}</td>
        <td class="center">${pct(m.probabilityBeatsTarget)}</td>
      </tr>`).join('')}</tbody></table></div>` : ''}` : '';

  // ── Scénarios, 3 au plus ────────────────────────────────────────────────
  const scenariosHtml = scenarios?.length ? `
    <h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">Chemins possibles</h4>
    <ul class="prj-notes">${scenarios.map(sc =>
      `<li><strong>${escHtml(sc.label)}</strong> — ${pct(sc.probability)}</li>`).join('')}</ul>` : '';

  // ── Détail, replié : c'est la partie ingénieur ──────────────────────────
  const detail = why('Détail — échelle de cibles et concurrents directs', [
    ['Manche', `Q${o.raceNum}`],
    ['Pilotes encore à courir', String(o.pendingOthers)],
    ['Nature de la cible', o.exact ? 'exacte — plus personne d\'autre ne doit rouler' : 'probabiliste — d\'autres pilotes doivent encore rouler'],
    ['Échelle de cibles', `<div class="prj-scroll"><table class="prj-table">
        <thead><tr><th>Cible provisoire</th><th>Chrono à battre</th><th class="center">P(qualif)</th><th class="center">Place médiane</th></tr></thead>
        <tbody>${(o.ladder || []).map(e => `<tr${o.target && e.provisionalTarget === o.target.provisionalTarget ? ' class="is-target"' : ''}>
          <td>${e.behindAll ? 'derrière tous les pilotes déjà passés' : `P${e.provisionalTarget}`}</td>
          <td>${e.reference?.beat != null ? escHtml(fmtMs(e.reference.beat)) : '—'}</td>
          <td class="center">${pct(e.probability)}</td>
          <td class="center">${e.medianRacePosition != null ? `P${e.medianRacePosition}` : '—'}</td>
        </tr>`).join('')}</tbody></table></div>`],
    ['Concurrents directs', `<div class="prj-scroll"><table class="prj-table">
        <thead><tr><th>Pilote</th><th class="center">Impact</th><th class="center">S'il réussit</th><th class="center">S'il abandonne</th></tr></thead>
        <tbody>${(rivals?.all || []).map(r => `<tr>
          <td>${driverLabel(ctx, r.driverId)}</td>
          <td class="center">${r.settled ? 'résultat acquis' : `${(100 * r.impact).toFixed(1)} pt`}</td>
          <td class="center">${r.settled ? '—' : pct(r.probabilityIfRivalBest)}</td>
          <td class="center">${r.settled ? '—' : pct(r.probabilityIfRivalOut)}</td>
        </tr>`).join('')}</tbody></table></div>`],
    ['Seuil « concurrent direct »', `${(100 * (rivals?.minImpact ?? STRATEGY.directRivalMinImpact)).toFixed(0)} points de probabilité — choix de lisibilité, l'impact réel de chacun est listé ci-dessus`],
    ['Méthode', 'chaque hypothèse simule TOUS les pilotes non encore passés, coéquipiers de série compris, puis relit le classement complet de la manche'],
    ['Traduction en chrono', escHtml(MESSAGES.chronoIsATranslation)],
    ['Graine', `<code>${simSeed}</code>`],
  ]);

  return section('strategy', MESSAGES.sectionObjective,
    `${bandeau}${avertissement}${certain}${serie}${scenariosHtml}${detail}`);
}

async function computeObjective(ctx, state, threshold, checkpoint, driver) {
  const key = objectiveKey(ctx, checkpoint, driver);
  objectiveState = { key, running: true, data: null };
  renderContent();
  await new Promise(r => setTimeout(r, 0));

  const { run } = runBaseSimulation(ctx, state, threshold, checkpoint, driver);
  const { models } = modelsFor(ctx, state, checkpoint);

  const objective = buildLiveObjective({
    context: ctx, checkpoint, models, threshold, driverId: driver.driverId,
    baseRun: run, seed: simSeed,
  });
  const rivals = directRivals({
    context: ctx, checkpoint, models, threshold, driverId: driver.driverId,
    baseRun: run, seed: simSeed,
  });
  const maths = mathematicalChronoTarget({
    context: ctx, raceNum: ctx.raceInProgress, driverId: driver.driverId, threshold, checkpoint,
  });

  objectiveState = {
    key, running: false,
    data: { objective, rivals, maths, scenarios: pickScenarios({ objective, rivals }) },
  };
  renderContent();
}

function renderDriverOutlook(ctx, state, threshold, checkpoint, driver, trivial) {
  const gap = gapToThreshold(driver.position, threshold.threshold);
  const finalRace = ctx.plannedRaceCount;

  // L'historique EXCLUT le meeting analysé : sinon on lirait le résultat qu'on
  // cherche à anticiper.
  const history = filterObservations(observations).filter(o => o.meetingId !== ctx.meetingId);

  const outlook = buildHistoricalOutlook({
    observations: history, checkpoint, finalRace,
    driver: { points: driver.totalPoints, position: driver.position, gap },
    filters: { championshipId: ctx.meeting?.championshipId, category: ctx.category },
  });

  const c = outlook.comparable;
  const cards = [
    card('Points', String(driver.totalPoints), `après Q${checkpoint}`),
    card('Classement', `P${driver.position}`, `sur ${state.count} classés`),
    card('Écart au seuil', escHtml(formatGap(gap)), gap <= 0 ? 'dans la zone qualificative' : 'hors zone qualificative'),
    card('Taux historique', c.confidence.showRate ? pct(c.rate) : '—',
      `${c.qualified}/${c.n} cas · ${confBadge(c.confidence)}`),
  ].join('');

  const whyPanel = why('Pourquoi ce chiffre ?', [
    ['Situation analysée', `${escHtml(formatGap(gap))} — ${driver.totalPoints} pts après Q${checkpoint}`],
    ['Cas comparables', `${c.n}`],
    ['dont qualifiés', `${c.qualified}`],
    ['Taux historique', c.confidence.showRate ? pct(c.rate) : `non affiché (n &lt; ${MIN_CASES_TO_SHOW_RATE})`],
    ['Intervalle 95 %', `${pct(c.confidence.interval.low)} – ${pct(c.confidence.interval.high)}`],
    ['Confiance', escHtml(c.confidence.label)],
    ['Périmètre retenu', escHtml(c.label)],
    ['Périmètres essayés', c.tried.map(t => `${escHtml(t.label)} → ${t.n} cas`).join('<br>')],
    ['Seuil de qualification', escHtml(threshold.label)],
    ['Meeting analysé', 'exclu de l\'historique'],
    ['Nature', 'observation historique — aucune simulation'],
  ]);

  const pointsView = outlook.pointsView.available
    ? `<p style="margin:var(--sp-sm) 0 0;font-size:.85rem">
         Lecture en points, à catégorie fixée — tranche <strong>${escHtml(outlook.pointsView.bucket.label)}</strong> :
         ${rateCell(outlook.pointsView.bucket)}
       </p>`
    : `<p class="prj-n" style="margin:var(--sp-sm) 0 0">Lecture en points indisponible ici : ${escHtml(outlook.pointsView.warning || 'périmètre non homogène')}</p>`;

  const remaining = outlook.remaining.map(r => renderRemainingRace(r, c.n)).join('');

  return section('historical',
    `${driver.firstName || ''} ${driver.lastName || ''} — ce qu'ont vécu les pilotes dans la même situation`,
    `${trivial ? warn(escHtml(MESSAGES.trivialQualification(ctx.engagedCount, threshold.threshold))) : ''}
     <div class="prj-cards">${cards}</div>
     ${notes(outlook.messages)}
     ${pointsView}
     ${whyPanel}
     ${remaining}`);
}

function renderRemainingRace(r, nComparables) {
  const d = r.distribution;
  if (!d.total) {
    return `<p class="prj-n" style="margin-top:var(--sp-md)">Q${r.raceNum} — aucun cas comparable exploitable.</p>`;
  }
  return `
    <h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">
      Q${r.raceNum} — résultats obtenus par ces ${nComparables} pilotes comparables
    </h4>
    <p class="prj-n">Place médiane ${d.median ?? '—'} · moyenne ${d.mean != null ? d.mean.toFixed(1).replace('.', ',') : '—'} ·
       ${d.withStatus} sans place (DNF / DNS / DSQ)</p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr>
        <th>Résultat en Q${r.raceNum}</th>
        <th class="center">Cas</th>
        <th class="center">Part</th>
        <th>Qualifiés au final</th>
      </tr></thead>
      <tbody>
        ${r.conditional.map(cnd => {
          const dist = d.byBucket.find(b => b.id === cnd.id);
          return `<tr>
            <td>${escHtml(cnd.label)}</td>
            <td class="center">${cnd.n}</td>
            <td class="center">${dist ? pct(dist.share) : '—'}</td>
            <td>${rateCell(cnd)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;
}

function renderStandingsTable(state, threshold, focus) {
  const rows = state.standings.map(d => {
    const isCut = threshold.threshold != null && d.position === threshold.threshold;
    return `<tr class="${d.driverId === focus?.driverId ? 'is-focus' : ''} ${isCut ? 'prj-cutline' : ''}">
      <td class="center">P${d.position}</td>
      <td class="center">#${escHtml(String(d.carNumber))}</td>
      <td>${escHtml(d.lastName || '')} ${escHtml(d.firstName || '')}</td>
      <td class="center">${d.totalPoints}</td>
      <td class="center">${escHtml(formatGap(gapToThreshold(d.position, threshold.threshold)))}</td>
    </tr>`;
  }).join('');

  // Bande neutre : ce tableau est l'état COURANT du meeting, pas une
  // observation historique. Le libellé « données historiques » y serait faux.
  return section('plain', 'Classement intermédiaire au checkpoint', `
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th class="center">Pos.</th><th class="center">N°</th><th>Pilote</th>
        <th class="center">Points</th><th class="center">Écart au seuil</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="prj-n" style="margin-top:var(--sp-sm)">La ligne pointillée marque la dernière place qualificative.</p>
  `);
}

/** Aucun pilote sélectionné : on annonce ce que la simulation fera. */
function renderSimulationIntro(checkpoint, ctx) {
  const remaining = ctx.plannedRaceCount - checkpoint;
  return section('simulation', null, remaining > 0
    ? `<p style="margin:0">Sélectionnez un pilote pour simuler ${remaining > 1 ? `les ${remaining} manches restantes` : 'la manche restante'}.</p>`
    : `<p style="margin:0">Toutes les manches qualificatives sont courues : il n'y a rien à simuler,
       seule l'analyse réelle s'applique.</p>`);
}

// ─────────────────────────────────────────────────────────
// SIMULATION MONTE-CARLO
// ─────────────────────────────────────────────────────────

/**
 * Modèles de performance du meeting, sans donnée postérieure au checkpoint.
 * Même règle qu'au backtest : ce que le moteur voit en direct est exactement
 * ce qu'il aurait vu ce jour-là.
 */
function modelsFor(ctx, state, checkpoint) {
  const observations = collectRaceObservations(contexts).filter(o =>
    o.meetingId !== ctx.meetingId || o.raceNum <= checkpoint);
  return buildDriverModels({
    driverIds: state.standings.map(d => d.driverId),
    observations,
    scope: {
      meetingId: ctx.meetingId, year: ctx.meeting?.year,
      category: ctx.category, circuit: ctx.meeting?.location,
    },
  });
}

function runBaseSimulation(ctx, state, threshold, checkpoint, driver) {
  const key = `${ctx.key}|${checkpoint}|${driver.driverId}|${simSeed}|${simProfile}`;
  if (simCache.has(key)) return simCache.get(key);

  const { models, pooled } = modelsFor(ctx, state, checkpoint);
  // Adversaires suivis : ceux qui gravitent autour de la dernière place
  // qualificative, seuls capables de faire basculer la situation.
  const rivalIds = state.standings
    .filter(d => d.driverId !== driver.driverId && Math.abs(d.position - threshold) <= 4)
    .map(d => d.driverId);

  const run = simulateFromCheckpoint({
    context: ctx, checkpoint, models, threshold,
    focusDriverId: driver.driverId, rivalIds,
    simulations: SIMULATION.profiles[simProfile], seed: simSeed,
  });
  const out = { run, models, pooled, model: models[driver.driverId] };
  simCache.set(key, out);
  return out;
}

function renderSimulation(ctx, state, threshold, checkpoint, driver) {
  const remaining = ctx.plannedRaceCount - checkpoint;
  if (remaining <= 0) {
    return section('simulation', null,
      `<p style="margin:0">Toutes les manches qualificatives sont courues : le moteur ne simule rien
       et se contente du résultat réel.</p>`);
  }

  const { run, model, pooled } = runBaseSimulation(ctx, state, threshold, checkpoint, driver);
  const lastRace = ctx.plannedRaceCount;

  const cards = [
    card('Probabilité globale', run.probability != null ? pct(run.probability) : '—',
      `${run.qualifiedCount}/${run.countedCount} tirages · tous résultats confondus`),
    card('Classement final médian', run.medianPosition != null ? `P${run.medianPosition}` : '—',
      `moyenne ${run.meanPosition != null ? run.meanPosition.toFixed(1).replace('.', ',') : '—'}`),
    card('Score final médian', run.medianPoints != null ? String(run.medianPoints) : '—',
      `actuel ${driver.totalPoints} pts`),
    card('Seuil de qualification', run.medianCut != null ? `${run.medianCut} pts` : '—',
      run.cutRange ? `80 % des cas entre ${run.cutRange.low} et ${run.cutRange.high}` : ''),
  ].join('');

  // Une probabilité de 100 % sur N tirages n'est PAS une certitude : elle dit
  // que le cas contraire n'est pas apparu, pas qu'il est impossible. Le bloc
  // CERTITUDES, lui, ne contient que du démontrable.
  const extreme = run.probability === 1 || run.probability === 0;
  const nuance = extreme
    ? `<p class="prj-n" style="margin:var(--sp-sm) 0 0">
         ${escHtml(MESSAGES.inSimulations(pct(run.probability)))}
         Sur ${run.simulations} tirages, le cas contraire n'est pas apparu — ce n'est pas une démonstration
         qu'il est impossible. Seul le bloc CERTITUDES énonce ce qui est acquis.</p>`
    : '';

  return section('simulation', `Projection après Q${lastRace}`, `
    <div class="prj-cards">${cards}</div>
    ${nuance}
    ${model?.weaklyObserved ? warn('Ce pilote est peu observé : sa distribution est volontairement large, et la probabilité qui en découle est d\'autant moins précise.') : ''}
    ${renderPositionChart(run)}
    ${why('Comment cette probabilité est-elle obtenue ?', [
      ['Tirages', `${run.simulations}`],
      ['Graine', `<code>${run.seed}</code> — même graine, même résultat`],
      ['Manches simulées', run.remainingRaces.map(n => `Q${n}`).join(', ')],
      ['Tirages qualifiés', `${run.qualifiedCount} sur ${run.countedCount}`],
      ['Seuil médian de qualification', run.medianCut != null ? `${run.medianCut} pts` : '—'],
      ['Score actuel', `${driver.totalPoints} pts`],
      ...(model ? describeModel(model) : []),
      ['Dispersion de plateau', pooled ? pooled.dispersion.toFixed(2) : '—'],
      ['Taux d\'incident de plateau', pooled ? `${(100 * pooled.incidentRate).toFixed(1)} %` : '—'],
      ['Données utilisées', `manches Q1 à Q${checkpoint} de ce meeting + historique ; aucune donnée postérieure`],
    ])}
    ${renderRivals(run)}
    ${renderWhatIfBlock(ctx, checkpoint, driver)}
  `);
}

function renderPositionChart(run) {
  if (!run.positionDistribution.length) return '';
  const max = Math.max(...run.positionDistribution.map(e => e.share));
  const rows = run.positionDistribution.map(e => `
    <div class="prj-bar-row">
      <div class="prj-bar-label">P${e.value}</div>
      <div class="prj-bar-track"><div class="prj-bar-fill prj-bar-fill--sim" style="width:${Math.round(100 * e.share / max)}%"></div></div>
      <div class="prj-bar-value"><strong>${pct(e.share)}</strong> <span class="prj-n">${e.count}</span></div>
    </div>`).join('');
  return `<h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">Distribution du classement final</h4>
    <div class="prj-chart">${rows}</div>`;
}

function renderRivals(run) {
  const rivals = run.rivals.filter(r => r.probabilityAhead != null).slice(0, 6);
  if (!rivals.length) return '';
  return `<h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">
      Adversaires susceptibles de passer devant</h4>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Pilote</th><th class="center">Probabilité de finir devant</th></tr></thead>
      <tbody>${rivals.map(r => `<tr>
        <td>#${escHtml(String(r.carNumber ?? '?'))} ${escHtml(r.lastName || '')} ${escHtml(r.firstName || '')}</td>
        <td class="center">${pct(r.probabilityAhead)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ─────────────────────────────────────────────────────────
// SCÉNARIOS « ET SI » + INTERPRÉTATION STRATÉGIQUE
// ─────────────────────────────────────────────────────────

function whatIfKey(ctx, checkpoint, driver, raceNum) {
  return `${ctx.key}|${checkpoint}|${driver.driverId}|${simSeed}|r${raceNum}`;
}

/** Manche sur laquelle porte le « et si » : la PROCHAINE par défaut. */
function whatIfRaceOf(ctx, checkpoint) {
  const remaining = ctx.races.filter(r => r.num > checkpoint).map(r => r.num).sort((a, b) => a - b);
  return whatIfState.raceNum && remaining.includes(whatIfState.raceNum)
    ? whatIfState.raceNum : remaining[0];
}

function renderWhatIfBlock(ctx, checkpoint, driver) {
  const remaining = ctx.races.filter(r => r.num > checkpoint).map(r => r.num).sort((a, b) => a - b);
  const raceNum = whatIfRaceOf(ctx, checkpoint);
  const key = whatIfKey(ctx, checkpoint, driver, raceNum);

  const selector = remaining.length > 1
    ? `<label class="prj-inline-field">Manche à imposer
         <select class="toolbar-select" id="prj-whatif-race">
           ${remaining.map(n => `<option value="${n}" ${n === raceNum ? 'selected' : ''}>Q${n}</option>`).join('')}
         </select>
       </label>`
    : '';

  const head = `<h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">
      Scénarios « et si » sur Q${raceNum}</h4>`;

  // Le pilote a déjà couru cette manche : il n'y a plus d'hypothèse à explorer.
  // Proposer quand même le bouton laisserait croire qu'un autre résultat est
  // encore possible.
  if (hasRealResult(ctx, raceNum, driver.driverId)) {
    const autres = remaining.filter(n => !hasRealResult(ctx, n, driver.driverId));
    return `${head}
      ${warn(escHtml(MESSAGES.whatIfUnavailable(raceNum)))}
      ${autres.length
        ? `<div class="toolbar" style="gap:var(--sp-sm)">
             <label class="prj-inline-field">Manche à imposer
               <select class="toolbar-select" id="prj-whatif-race">
                 ${autres.map(n => `<option value="${n}">Q${n}</option>`).join('')}
               </select>
             </label>
           </div>`
        : '<p class="prj-n">Aucune manche ne reste ouverte à un scénario pour ce pilote.</p>'}`;
  }

  if (whatIfState.running && whatIfState.key === key) {
    return `${head}<div class="loading-state"><div class="spinner"></div> Simulation ${whatIfState.progress} %…</div>`;
  }
  if (whatIfState.key === key && whatIfState.data) return '';
  return `${head}
    <p class="prj-n">Une simulation complète par résultat possible : c'est long, donc lancé à la demande.</p>
    <div class="toolbar" style="gap:var(--sp-sm)">${selector}
      <button class="btn btn-primary" id="prj-whatif">Calculer les scénarios Q${raceNum}</button>
    </div>`;
}

/** Tableau des scénarios + cible, rendus hors du bloc simulation. */
function renderStrategySection() {
  const d = whatIfState.data;
  if (!d) return '';
  const { entries, target, gains, classification, seed, simulations, raceNum, lastRace, marginOfErrorPct } = d;
  const isIntermediateRace = raceNum < lastRace;
  const atTarget = target.probabilityAtTarget != null ? pct(target.probabilityAtTarget) : '—';

  const positions = entries.filter(e => e.kind === 'position');
  const statuses = entries.filter(e => e.kind === 'status');

  const rowOf = (e, highlightTarget) => {
    const g = gains.find(x => x.from === e.position);
    const isTarget = highlightTarget && target.target != null && e.position === target.target;
    const inter = e.intermediate;
    return `<tr class="${isTarget ? 'is-focus' : ''}">
      <td>${escHtml(e.label)}${isTarget ? ' <span class="prj-chip prj-chip--info">cible</span>' : ''}</td>
      <td class="center"><strong>${e.probability != null ? pct(e.probability) : '—'}</strong></td>
      <td class="center">${g ? `${g.gainPct >= 0 ? '+' : ''}${g.gainPct.toFixed(1).replace('.', ',')} pt` : '—'}</td>
      ${isIntermediateRace ? `
        <td class="center">${inter?.medianPosition != null ? `P${inter.medianPosition}` : '—'}</td>
        <td class="center">${inter?.medianPoints != null ? `${inter.medianPoints} pts` : '—'}</td>
        <td class="center">${inter?.medianGap != null ? escHtml(formatGap(inter.medianGap)) : '—'}</td>
      ` : `<td class="center">${e.medianPoints != null ? `${e.medianPoints} pts` : '—'}</td>`}
    </tr>`;
  };

  const headers = isIntermediateRace
    ? `<th class="center">Classement médian après Q${raceNum}</th>
       <th class="center">Points après Q${raceNum}</th>
       <th class="center">Écart au seuil après Q${raceNum}</th>`
    : `<th class="center">Score final médian</th>`;

  // Le risque d'incident est présenté SÉPARÉMENT des résultats classés : ce
  // sont deux natures d'événement différentes, et les mélanger dans la même
  // colonne laisserait croire à un continuum. Aucune recommandation n'est tirée
  // de cette comparaison — seulement les chiffres.
  const incident = statuses.length ? `
    <h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">
      Manche non terminée — Q${raceNum}</h4>
    <p class="prj-n">Événements d'une autre nature qu'un résultat classé : ils sont comptés à part.</p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Hypothèse</th><th class="center">Probabilité conditionnelle</th>
        ${isIntermediateRace ? `<th class="center">Classement médian après Q${raceNum}</th><th class="center">Écart au seuil</th>` : '<th class="center">Score final médian</th>'}</tr></thead>
      <tbody>${statuses.map(e => `<tr>
        <td>${escHtml(e.label)}</td>
        <td class="center"><strong>${e.probability != null ? pct(e.probability) : '—'}</strong></td>
        ${isIntermediateRace
          ? `<td class="center">${e.intermediate?.medianPosition != null ? `P${e.intermediate.medianPosition}` : '—'}</td>
             <td class="center">${e.intermediate?.medianGap != null ? escHtml(formatGap(e.intermediate.medianGap)) : '—'}</td>`
          : `<td class="center">${e.medianPoints != null ? `${e.medianPoints} pts` : '—'}</td>`}
      </tr>`).join('')}</tbody>
    </table></div>
    ${target.target != null && statuses[0]?.probability != null ? `
      <p style="margin-top:var(--sp-sm)">Pour mémoire, côte à côte :
        <strong>${escHtml(target.targetLabel)}</strong> → ${atTarget} ·
        <strong>${escHtml(statuses[0].label)}</strong> → ${pct(statuses[0].probability)}.
        <span class="prj-n">Deux estimations conditionnelles, présentées sans interprétation.</span></p>` : ''}` : '';

  return section('strategy', `Scénarios Q${raceNum} et résultat cible`, `
    <div class="prj-cards">
      ${card('Probabilité globale', d.baseProbability != null ? pct(d.baseProbability) : '—',
        `tous résultats Q${raceNum} confondus`)}
      ${card(`Résultat cible Q${raceNum}`, target.targetLabel || '—',
        target.averageGainAtTarget != null
          ? `gain moyen ${target.averageGainAtTarget.toFixed(2).replace('.', ',')} pt/place`
          : 'chaque place compte sur toute la courbe')}
      ${card('Probabilité si ce résultat', atTarget, 'conditionnelle, pas une garantie')}
      ${card('Classification', `<span class="prj-class prj-class--${classification.id}">${escHtml(classification.label)}</span>`,
        escHtml(classification.description))}
    </div>
    <p style="margin:var(--sp-md) 0 var(--sp-sm)">${escHtml(target.statement || '')}</p>
    ${target.target != null ? warn(escHtml(MESSAGES.targetNotAGuarantee(target.targetLabel, atTarget))) : ''}
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr>
        <th>Hypothèse imposée en Q${raceNum}<br><span class="prj-n">${escHtml(MESSAGES.probabilityForced)}</span></th>
        <th class="center">Probabilité conditionnelle<br><span class="prj-n">de qualification finale</span></th>
        <th class="center">Gain d'une place</th>
        ${headers}</tr></thead>
      <tbody>${positions.map(e => rowOf(e, true)).join('')}</tbody>
    </table></div>
    ${incident}
    <ul class="prj-notes">
      <li><strong>Probabilité globale</strong> — ${escHtml(MESSAGES.probabilityGlobal)}</li>
      <li><strong>Hypothèse imposée</strong> — ${escHtml(MESSAGES.probabilityForced)}</li>
      <li><strong>Probabilité conditionnelle</strong> — ${escHtml(MESSAGES.probabilityConditional)}</li>
      <li>Chaque valeur est estimée sur ${simulations} tirages, soit environ ± ${marginOfErrorPct.toFixed(1)} point d'incertitude.</li>
    </ul>
    ${why('Comment le résultat cible est-il déterminé ?', [
      ['Règle', escHtml(target.rule)],
      ['Seuil τ', `${target.thresholdPct} point de pourcentage par place`],
      ['Probabilité à P1', target.probabilityAtBest != null ? pct(target.probabilityAtBest) : '—'],
      ['Probabilité à la cible', atTarget],
      ['Ce que la cible n\'est PAS', `un seuil de qualification : la probabilité à la cible vaut ${atTarget}, pas 100 %`],
      ['Statuts exclus du calcul', 'un abandon n\'est pas une place : il est mesuré à part'],
      ['Classification', `${escHtml(classification.label)} — ${escHtml(classification.reason)}`],
      ['Tirages par scénario', `${simulations} (± ${marginOfErrorPct.toFixed(1)} pt)`],
      ['Graine', `<code>${seed}</code> — identique pour tous les scénarios, pour que la comparaison ne mesure pas le bruit`],
      ['Nature', 'projection statistique — ni certitude, ni consigne de course'],
    ])}
  `);
}

/** Lance les scénarios en rendant la main au navigateur entre chaque. */
async function computeWhatIf(ctx, state, threshold, checkpoint, driver) {
  const raceNum = whatIfRaceOf(ctx, checkpoint);
  // Garde de dernier recours : le moteur lèverait de toute façon, mieux vaut
  // ne pas avoir déclenché le calcul.
  if (hasRealResult(ctx, raceNum, driver.driverId)) { renderContent(); return; }
  const lastRace = ctx.plannedRaceCount;
  const { models } = modelsFor(ctx, state, checkpoint);
  const entrants = (ctx.races.find(r => r.num === raceNum)?.rows || []).length || state.count;

  whatIfState = { key: whatIfKey(ctx, checkpoint, driver, raceNum), running: true, progress: 0, data: null, raceNum };
  renderContent();

  const entries = [];
  const positions = Array.from({ length: entrants }, (_, i) => i + 1);
  const statuses = ['DNF', 'DNS', 'DSQ'];
  const total = positions.length + statuses.length;
  let done = 0;

  const push = (forced, entry) => {
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint, models, threshold, focusDriverId: driver.driverId,
      forced: { [raceNum]: { [driver.driverId]: forced } },
      simulations: SIMULATION.whatIfSimulations, seed: simSeed,
      // Suivi de l'état intermédiaire seulement si la manche imposée n'est pas
      // la dernière : sinon « après cette manche » et « au final » se confondent.
      trackStateAfterRace: raceNum < lastRace ? raceNum : null,
    });
    entries.push({
      ...entry,
      probability: run.probability,
      medianPoints: run.medianPoints,
      medianPosition: run.medianPosition,
      intermediate: run.intermediate,
    });
  };

  for (const position of positions) {
    push({ position }, { kind: 'position', position, label: `P${position}` });
    done++;
    whatIfState.progress = Math.round(100 * done / total);
    renderContent();
    await new Promise(r => setTimeout(r, 0));   // laisse l'interface respirer
  }
  for (const status of statuses) {
    push({ status }, { kind: 'status', status, label: status });
    done++;
  }

  const target = computeTargetResult(entries);
  whatIfState = {
    key: whatIfState.key, running: false, progress: 100, raceNum,
    data: {
      raceNum, lastRace, entries, target, gains: marginalGains(entries),
      baseProbability: runBaseSimulation(ctx, state, threshold, checkpoint, driver).run.probability,
      classification: classifyStrategy({ probability: runBaseSimulation(ctx, state, threshold, checkpoint, driver).run.probability, target }),
      seed: simSeed, simulations: SIMULATION.whatIfSimulations,
      marginOfErrorPct: 100 * Math.sqrt(0.25 / SIMULATION.whatIfSimulations),
    },
  };
  renderContent();
}

// ─────────────────────────────────────────────────────────
// MATRICE DE SCÉNARIOS CROISÉS
// ─────────────────────────────────────────────────────────

function matrixKey(ctx, checkpoint, driver) {
  return `${ctx.key}|${checkpoint}|${driver.driverId}|${simSeed}`;
}

function renderMatrixBlock(ctx, state, checkpoint, driver) {
  const remaining = ctx.races.filter(r => r.num > checkpoint).map(r => r.num).sort((a, b) => a - b);
  if (remaining.length < 2) return '';
  const acquis = remaining.find(n => hasRealResult(ctx, n, driver.driverId));
  if (acquis != null) {
    return section('strategy', `Matrice Q${remaining[0]} × Q${remaining[remaining.length - 1]}`,
      warn(escHtml(MESSAGES.whatIfUnavailable(acquis))));
  }
  const key = matrixKey(ctx, checkpoint, driver);

  if (matrixState.running && matrixState.key === key) {
    return section('strategy', `Matrice Q${remaining[0]} × Q${remaining[remaining.length - 1]}`,
      `<div class="loading-state"><div class="spinner"></div> Calcul ${matrixState.progress} %…</div>`);
  }
  if (matrixState.key !== key || !matrixState.data) {
    return section('strategy', `Matrice Q${remaining[0]} × Q${remaining[remaining.length - 1]}`, `
      <p class="prj-n">Probabilité finale de qualification pour chaque combinaison d'hypothèses sur les deux
         manches restantes, les autres pilotes restant simulés dans chaque cellule.</p>
      <p class="prj-n">Une matrice complète place par place coûterait des dizaines de minutes de calcul : les
         hypothèses sont donc un échantillon de places réparties sur le plateau, et chaque cellule est estimée
         sur un nombre de tirages annoncé.</p>
      <button class="btn btn-primary" id="prj-matrix">Calculer la matrice</button>`);
  }
  return renderMatrix(matrixState.data);
}

function renderMatrix(m) {
  const cols = m.cells[0]?.columns || [];
  const cell = (p) => {
    if (p == null) return `<td class="center prj-dq-off">—</td>`;
    const v = Math.round(100 * p);
    return `<td class="center prj-cell" style="--p:${v}">${v} %</td>`;
  };
  return section('strategy', `Matrice Q${m.rowRace} × Q${m.colRace}`, `
    <p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Chaque cellule : probabilité finale de qualification si le pilote fait le résultat de la LIGNE en
      Q${m.rowRace} et celui de la COLONNE en Q${m.colRace}. Les autres pilotes sont simulés normalement
      dans chaque cellule — ce n'est jamais une simple addition de points.
    </p>
    <div class="prj-scroll"><table class="prj-table prj-matrix">
      <thead><tr><th>Q${m.rowRace} ＼ Q${m.colRace}</th>
        ${cols.map(c => `<th class="center">${escHtml(c.col.label)}</th>`).join('')}
        <th class="center">Classement médian après Q${m.rowRace}</th></tr></thead>
      <tbody>${m.cells.map(row => `<tr>
        <th>${escHtml(row.row.label)}</th>
        ${row.columns.map(c => cell(c.probability)).join('')}
        <td class="center prj-n">${row.medianPositionAfterRow != null ? `P${row.medianPositionAfterRow}` : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${why('Comment cette matrice est-elle calculée ?', [
      ['Tirages par cellule', `${m.simulations}`],
      ['Incertitude indicative', `± ${m.marginOfErrorPct.toFixed(1)} point de pourcentage`],
      ['Graine', `<code>${m.seed}</code> — identique pour toute la matrice`],
      ['Mutualisation', `la manche Q${m.rowRace} n'est simulée qu'une fois par tirage, puis réutilisée pour toutes les colonnes`],
      ['Nombres aléatoires communs', 'les autres pilotes vivent les mêmes courses dans toute la matrice, donc les écarts entre cellules sont plus fiables que les valeurs absolues'],
      ['Hypothèses retenues', 'un échantillon de places réparties sur le plateau, plus l\'abandon — une matrice complète coûterait des dizaines de minutes'],
      ['Nature', 'projection statistique conditionnelle à DEUX hypothèses ; ni prévision, ni garantie'],
    ])}`);
}

async function computeMatrix(ctx, state, threshold, checkpoint, driver) {
  const { models } = modelsFor(ctx, state, checkpoint);
  const ladder = defaultScenarioLadder(state.count);
  matrixState = { key: matrixKey(ctx, checkpoint, driver), running: true, progress: 0, data: null };
  renderContent();
  await new Promise(r => setTimeout(r, 30));

  // Le calcul est découpé ligne par ligne pour que la progression s'affiche.
  const rows = [];
  for (let i = 0; i < ladder.length; i++) {
    const part = simulateScenarioMatrix({
      context: ctx, checkpoint, models, threshold, focusDriverId: driver.driverId,
      rowScenarios: [ladder[i]], colScenarios: ladder,
      simulations: SIMULATION.matrixSimulations, seed: simSeed,
    });
    rows.push(...part.cells);
    matrixState.progress = Math.round(100 * (i + 1) / ladder.length);
    if (i === ladder.length - 1) {
      matrixState = { ...matrixState, running: false, data: { ...part, cells: rows } };
    }
    renderContent();
    await new Promise(r => setTimeout(r, 0));
  }
}

function bindSimulationControls(ctx, state, threshold, checkpoint, driver) {
  document.getElementById('prj-whatif')?.addEventListener('click', () => {
    computeWhatIf(ctx, state, threshold, checkpoint, driver);
  });
  document.getElementById('prj-whatif-race')?.addEventListener('change', (e) => {
    whatIfState = { key: null, running: false, progress: 0, data: null, raceNum: Number(e.target.value) };
    renderContent();
  });
  document.getElementById('prj-matrix')?.addEventListener('click', () => {
    computeMatrix(ctx, state, threshold, checkpoint, driver);
  });
  document.getElementById('prj-objective')?.addEventListener('click', () => {
    if (driver) computeObjective(ctx, state, threshold, checkpoint, driver);
  });
  document.getElementById('prj-seed')?.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) {
      simSeed = v; simCache.clear();
      whatIfState = { key: null, running: false, progress: 0, data: null };
      objectiveState = { key: null, running: false, data: null };
      renderContent();
    }
  });
  document.getElementById('prj-profile')?.addEventListener('change', (e) => {
    simProfile = e.target.value; simCache.clear(); renderContent();
  });
}

// ─────────────────────────────────────────────────────────
// ONGLET « HISTORIQUE »
// ─────────────────────────────────────────────────────────

function renderHistory(el) {
  const all = observations;
  const champs = [...new Set(all.map(o => o.championshipId).filter(Boolean))];
  const cats = distinctValues(filters.championshipId ? all.filter(o => o.championshipId === filters.championshipId) : all, 'category');
  const years = distinctValues(all, 'year');
  const circuits = distinctValues(all, 'circuit');

  el.innerHTML = `
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="prj-h-champ">
        <option value="">Tous championnats</option>
        ${champs.map(id => `<option value="${escHtml(id)}" ${id === filters.championshipId ? 'selected' : ''}>${escHtml(championshipsById[id]?.name || id)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-cat">
        <option value="">Toutes catégories</option>
        ${cats.map(c => `<option value="${escHtml(c)}" ${c === filters.category ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-year">
        <option value="">Toutes saisons</option>
        ${years.map(y => `<option value="${y}" ${String(y) === String(filters.year) ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-circuit">
        <option value="">Tous circuits</option>
        ${circuits.map(c => `<option value="${escHtml(c)}" ${c === filters.circuit ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-cp">
        ${[1, 2, 3].map(n => `<option value="${n}" ${n === filters.checkpoint ? 'selected' : ''}>Après Q${n}</option>`).join('')}
      </select>
    </div>
    <div id="prj-history-body"></div>
  `;

  const on = (id, key, cast = v => v) => document.getElementById(id)
    ?.addEventListener('change', e => { filters[key] = cast(e.target.value); renderContent(); });
  on('prj-h-champ', 'championshipId');
  on('prj-h-cat', 'category');
  on('prj-h-year', 'year', v => (v ? Number(v) : ''));
  on('prj-h-circuit', 'circuit');
  on('prj-h-cp', 'checkpoint', v => Number(v));

  const obs = selected();
  const body = document.getElementById('prj-history-body');

  if (!obs.length) {
    body.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">📊</div>
      <div class="placeholder-title">Aucun cas exploitable pour cette sélection</div>
      <div class="placeholder-desc">Les meetings où tous les engagés tiennent dans les places
      qualificatives sont exclus : la qualification y est mécanique.</div></div>`;
    return;
  }

  body.innerHTML = [
    renderHistorySummary(obs),
    renderGapChart(obs),
    renderPointsChart(obs),
    renderFinalRaceAnalysis(obs),
  ].join('');
}

function renderHistorySummary(obs) {
  const meetings = new Set(obs.map(o => o.meetingId)).size;
  const cats = new Set(obs.map(o => o.category)).size;
  const seasons = new Set(obs.map(o => o.year)).size;
  const s = rateStats(obs);
  return section('historical', null, `<div class="prj-cards">
    ${card('Cas exploitables', String(obs.length), 'hors qualification mécanique')}
    ${card('Meetings', String(meetings), `${cats} catégorie${cats > 1 ? 's' : ''} · ${seasons} saison${seasons > 1 ? 's' : ''}`)}
    ${card('Qualifiés', String(s.qualified), `soit ${pct(s.rate)}`)}
    ${card('Confiance globale', escHtml(s.confidence.label), `intervalle ${pct(s.confidence.interval.low)} – ${pct(s.confidence.interval.high)}`)}
  </div>`);
}

function renderGapChart(obs) {
  const cp = filters.checkpoint;
  const agg = aggregateByGap(obs, cp);
  if (!agg.rows.length) return '';
  const rows = agg.rows.map(r => barRow(r.label, r, { highlight: r.gap === 0 })).join('');
  const thin = agg.rows.filter(r => !r.confidence.showRate).length;
  const thinNote = thin > agg.rows.length / 2
    ? warn(`À ce périmètre, ${thin} écarts sur ${agg.rows.length} comptent moins de ${MIN_CASES_TO_SHOW_RATE} cas. Élargissez les filtres pour une lecture fiable.`)
    : '';

  return section('historical',
    `Taux de qualification finale par écart au seuil — après Q${cp}`,
    `<p class="prj-n" style="margin-bottom:var(--sp-sm)">
       Axe normalisé : comparable entre catégories et championnats, contrairement aux points.
       Négatif = dans la zone qualificative. ${agg.total} cas.
     </p>
     ${thinNote}
     <div class="prj-chart">${rows}</div>
     ${why('Comment lire cette courbe ?', [
       ['Lecture', 'chaque ligne regroupe les pilotes qui étaient à cet écart de la dernière place qualificative après Q' + cp],
       ['Qualifié', 'au sens de la règle sportive (classement final ≤ seuil)'],
       ['Sans barre', `effectif inférieur à ${MIN_CASES_TO_SHOW_RATE} cas : le comptage brut est affiché, pas de taux`],
       ['Exclusions', 'meetings où tous les engagés tiennent dans les places qualificatives'],
       ['Nature', 'observations mesurées — aucune simulation'],
     ])}`);
}

const POINTS_WHY = [
  ['Raison', 'le barème dépend de la taille du plateau : à position égale, un pilote marque plus de points dans une catégorie à 30 engagés que dans une à 10'],
  ['Conséquence', 'mélanger les catégories rend la courbe non monotone et trompeuse'],
  ['Condition', 'championnat et catégorie doivent être fixés dans les filtres'],
  ['Tranches', 'largeur adaptée pour viser un effectif exploitable, plafonnée pour rester lisible'],
];

function renderPointsChart(obs) {
  const cp = filters.checkpoint;
  const agg = aggregateByPoints(obs, cp, { filters });
  if (!agg.rows.length) return '';

  // Hors périmètre homogène, la courbe n'est PAS tracée : elle mélangerait des
  // barèmes incomparables et se lirait pourtant comme une courbe valide.
  if (!agg.comparable) {
    return section('historical', `Taux de qualification finale par points — après Q${cp}`,
      `${warn(escHtml(agg.warning))}
       <p class="prj-n">Filtres manquants : ${agg.missingFilters.map(f => f === 'championshipId' ? 'championnat' : 'catégorie').join(' et ')}.</p>
       ${why('Pourquoi cette vue est-elle conditionnée ?', POINTS_WHY)}`);
  }

  const rows = agg.rows.map(r => barRow(r.label, r)).join('');
  const head = `<p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Tranches adaptatives : leur largeur s'ajuste à l'échantillon plutôt que d'imposer un pas fixe. ${agg.total} cas.
    </p>`;

  return section('historical', `Taux de qualification finale par points — après Q${cp}`,
    `${head}<div class="prj-chart">${rows}</div>
     ${why('Pourquoi cette vue est-elle conditionnée ?', POINTS_WHY)}`);
}

function renderFinalRaceAnalysis(obs) {
  const cp = filters.checkpoint;
  const finalRaces = [...new Set(obs.map(o => o.finalRace))];
  if (finalRaces.length !== 1) {
    return section('historical', 'Analyse de la dernière manche',
      `<p class="prj-n">La sélection mélange des meetings avec des nombres de manches différents (${finalRaces.join(', ')}). Affinez les filtres pour cette analyse.</p>`);
  }
  const last = finalRaces[0];
  if (last <= cp) return '';

  const groups = [-2, -1, 0, 1, 2].map(gap => {
    const cases = obs.filter(o => o.checkpoints?.[cp]?.gap === gap);
    return { gap, cases, dist: resultDistribution(cases, last), cond: conditionalQualificationByResult(cases, last) };
  }).filter(g => g.cases.length);

  if (!groups.length) return '';

  const tables = groups.map(g => `
    <h4 class="prj-section-title" style="margin-top:var(--sp-md);font-size:.95rem">
      Après Q${cp} : ${escHtml(formatGap(g.gap))} <span class="prj-n">— ${g.cases.length} cas</span>
    </h4>
    <p class="prj-n">Place médiane en Q${last} : ${g.dist.median ?? '—'} · ${g.dist.withStatus} sans place (DNF / DNS / DSQ)</p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Résultat en Q${last}</th><th class="center">Cas</th><th class="center">Part</th><th>Qualifiés au final</th></tr></thead>
      <tbody>${g.cond.map(c => {
        const d = g.dist.byBucket.find(b => b.id === c.id);
        return `<tr><td>${escHtml(c.label)}</td><td class="center">${c.n}</td>
          <td class="center">${d ? pct(d.share) : '—'}</td><td>${rateCell(c)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`).join('');

  return section('historical', `Ce qui s'est passé en Q${last} selon la position après Q${cp}`,
    `<p class="prj-n">Constat brut : quels résultats ces pilotes ont obtenu, et combien se sont qualifiés.
       Les causes ne sont pas observables dans les données et ne sont donc pas interprétées ici.</p>
     ${tables}`);
}

// ─────────────────────────────────────────────────────────
// ONGLET « BACKTEST »
// ─────────────────────────────────────────────────────────

function renderBacktest(el) {
  const b = backtestState;
  el.innerHTML = `
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="prj-bt-cp">
        ${[1, 2, 3].map(n => `<option value="${n}" ${n === b.checkpoint ? 'selected' : ''}>Après Q${n}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-bt-mode">
        <option value="leaveOneMeetingOut" ${b.leakageMode === 'leaveOneMeetingOut' ? 'selected' : ''}>Meeting analysé exclu</option>
        <option value="strictlyPrior" ${b.leakageMode === 'strictlyPrior' ? 'selected' : ''}>Meetings antérieurs uniquement</option>
      </select>
      <button class="btn btn-primary" id="prj-bt-run" ${b.running ? 'disabled' : ''}>
        ${b.running ? `Calcul ${b.progress} %…` : 'Lancer le backtest'}</button>
    </div>
    <div id="prj-bt-body"></div>`;

  document.getElementById('prj-bt-cp')?.addEventListener('change', e => { backtestState.checkpoint = Number(e.target.value); backtestState.data = null; renderContent(); });
  document.getElementById('prj-bt-mode')?.addEventListener('change', e => { backtestState.leakageMode = e.target.value; backtestState.data = null; renderContent(); });
  document.getElementById('prj-bt-run')?.addEventListener('click', () => runBacktestUi());

  const body = document.getElementById('prj-bt-body');
  if (b.running) { body.innerHTML = `<div class="loading-state"><div class="spinner"></div> ${b.progress} %</div>`; return; }
  if (!b.data) {
    body.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">🎯</div>
      <div class="placeholder-title">Le Monte-Carlo apporte-t-il quelque chose ?</div>
      <div class="placeholder-desc">Chaque meeting historique est rejoué depuis le checkpoint choisi,
      sans aucune donnée postérieure, et les prédicteurs sont comparés au résultat réel.</div></div>`;
    return;
  }
  body.innerHTML = renderBacktestResults(b.data);
}

async function runBacktestUi() {
  backtestState.running = true; backtestState.progress = 0; backtestState.data = null;
  renderContent();
  // Laisse le navigateur peindre l'état « en cours » avant de bloquer.
  await new Promise(r => setTimeout(r, 30));
  const data = runBacktest({
    contexts, observations, championshipsById,
    checkpoint: backtestState.checkpoint,
    leakageMode: backtestState.leakageMode,
    seed: simSeed,
  });
  backtestState = { ...backtestState, running: false, progress: 100, data };
  renderContent();
}

function renderBacktestResults(r) {
  const num = (v, d = 4) => v == null ? '—' : v.toFixed(d).replace('.', ',');
  const skill = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1).replace('.', ',')} %`;

  const line = (name, e, note) => `<tr>
    <td>${escHtml(name)}${note ? ` <span class="prj-n">${escHtml(note)}</span>` : ''}</td>
    <td class="center">${e.n}</td>
    <td class="center"><strong>${num(e.brier)}</strong></td>
    <td class="center">${skill(e.skill)}</td>
    <td class="center">${e.accuracy ? pct(e.accuracy.rate) : '—'}</td>
  </tr>`;

  const compare = section('strategy', `Comparaison globale — après Q${r.checkpoint}`, `
    <p class="prj-n" style="margin-bottom:var(--sp-sm)">
      ${r.groups} meetings × catégorie · ${r.cases} cas pilote · taux de base ${pct(r.baseRate)} ·
      ${r.simulations} tirages par meeting · graine <code>${r.seed}</code>
    </p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Prédicteur</th><th class="center">Cas</th><th class="center">Brier</th>
        <th class="center">Compétence</th><th class="center">Justesse @ ${r.decisionThreshold}</th></tr></thead>
      <tbody>
        ${line('Climatologie', r.climatology, 'taux global, identique pour tous')}
        ${line('Historique (LOT 1)', r.historical, `repli ${r.historicalFallbacks} fois`)}
        ${line('Monte-Carlo (LOT 2)', r.monteCarlo)}
      </tbody>
    </table></div>
    <div class="prj-verdict prj-verdict--${r.verdict.winner}">${escHtml(r.verdict.label)}</div>
    ${why('Comment la fuite temporelle est-elle évitée ?', [
      ['Régime', r.leakageMode === 'strictlyPrior' ? 'seuls les meetings antérieurs en date sont utilisés' : 'le meeting analysé est retiré en entier de l\'historique'],
      ['Manches du meeting analysé', `uniquement Q1 à Q${r.checkpoint}`],
      ['Liste des partants', 'plateau du checkpoint reconduit — la liste d\'inscrits d\'une manche future révélerait des forfaits'],
      ['Seuil de qualification', `donnée de format, connue avant le meeting · ${r.thresholdDivergences} groupe(s) où il diffère du règlement`],
      ['Brier score', 'moyenne des carrés d\'écart entre probabilité annoncée et réalité — plus bas = meilleur'],
      ['Compétence', 'progression relative face à la climatologie'],
    ])}`);

  const calib = section('historical', 'Calibration — annoncé contre observé', `
    <p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Parmi les pilotes annoncés entre 70 et 80 %, combien se sont réellement qualifiés ?
      Un modèle calibré colle la diagonale.
    </p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Tranche annoncée</th>
        <th class="center" colspan="3">Historique</th>
        <th class="center" colspan="3">Monte-Carlo</th></tr>
        <tr><th></th><th class="center">n</th><th class="center">annoncé</th><th class="center">observé</th>
        <th class="center">n</th><th class="center">annoncé</th><th class="center">observé</th></tr></thead>
      <tbody>${r.historical.calibration.map((h, i) => {
        const m = r.monteCarlo.calibration[i];
        if (!h.n && !m.n) return '';
        const cells = (b) => b.n
          ? `<td class="center">${b.n}</td><td class="center">${pct(b.meanPredicted)}</td><td class="center">${pct(b.observedRate)}</td>`
          : `<td class="center prj-dq-off" colspan="3">—</td>`;
        return `<tr><td>${escHtml(h.label)}</td>${cells(h)}${cells(m)}</tr>`;
      }).join('')}</tbody>
    </table></div>`);

  const byGap = section('historical', 'Comparaison par position relative au seuil', `
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Écart au seuil après Q${r.checkpoint}</th><th class="center">Cas</th>
        <th class="center">Observé</th><th class="center">Brier historique</th>
        <th class="center">Brier Monte-Carlo</th><th class="center">Meilleur</th></tr></thead>
      <tbody>${r.byGap.filter(g => g.n >= 5).map(g => `<tr>
        <td>${escHtml(formatGap(g.gap))}</td>
        <td class="center">${g.n}</td>
        <td class="center">${pct(g.observedRate)}</td>
        <td class="center">${num(g.historical)}</td>
        <td class="center">${num(g.monteCarlo)}</td>
        <td class="center">${g.monteCarlo < g.historical ? '<span class="prj-chip prj-chip--ok">Monte-Carlo</span>' : g.monteCarlo > g.historical ? '<span class="prj-chip prj-chip--info">historique</span>' : '<span class="prj-chip">égalité</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="prj-n" style="margin-top:var(--sp-sm)">Écarts de moins de 5 cas non affichés.</p>`);

  const byCat = section('historical', 'Comparaison par catégorie', `
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Championnat / catégorie</th><th class="center">Cas</th><th class="center">Observé</th>
        <th class="center">Brier historique</th><th class="center">Brier Monte-Carlo</th><th class="center">Meilleur</th></tr></thead>
      <tbody>${r.byCategory.map(c => `<tr>
        <td>${escHtml(c.key)}${c.n < 30 ? ' <span class="prj-conf prj-conf--low">effectif faible</span>' : ''}</td>
        <td class="center">${c.n}</td>
        <td class="center">${pct(c.observedRate)}</td>
        <td class="center">${num(c.historical)}</td>
        <td class="center">${num(c.monteCarlo)}</td>
        <td class="center">${c.monteCarlo < c.historical ? '<span class="prj-chip prj-chip--ok">Monte-Carlo</span>' : '<span class="prj-chip prj-chip--info">historique</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`);

  return [compare, calib, byGap, byCat].join('');
}

// ─────────────────────────────────────────────────────────
// ONGLET « QUALITÉ DES DONNÉES »
// ─────────────────────────────────────────────────────────

function renderQuality(el) {
  const s = report.summary;
  const cov = s.checkpointCoverage;
  const checkpoints = [...new Set([
    ...Object.keys(cov.withDefaultRule), ...Object.keys(cov.withProjectionRule),
  ])].map(Number).sort((a, b) => a - b);

  const blockers = report.blockers.length
    ? warn(`${escHtml(MESSAGES.unsupportedRegulation)} pour : ${report.blockers.map(b => `${escHtml(b.championshipName)} (${escHtml(b.reasons.join(' '))})`).join(', ')}`, true)
    : '';

  el.innerHTML = [
    blockers,
    section('historical', 'Ce sur quoi reposent les chiffres', `<div class="prj-cards">
      ${card('Groupes meeting × catégorie', String(s.totalGroups),
        `${s.completeGroups} complets · ${s.partialGroups} partiels · ${s.emptyGroups} sans résultat`)}
      ${card('Exploitables', String(s.exploitableGroups), `${s.trivialGroups} exclus (qualification mécanique)`)}
      ${card('Meetings complets', String(s.meetings), `${s.seasons.join(', ')}`)}
      ${card('Championnats', String(s.championships.length), escHtml(s.championships.join(' · ')))}
      ${card('Cas pilote', String(observations.length), `${filterObservations(observations).length} exploitables`)}
      ${card('Divergences règle / réalité', String(s.divergenceCount), 'forfaits et repêchages')}
      ${card('Participations en double', String(s.duplicateParticipants),
        s.duplicateParticipants ? `sur ${s.groupsWithDuplicates} groupe${s.groupsWithDuplicates > 1 ? 's' : ''} · ignorées au calcul` : 'aucune')}
    </div>
    ${s.duplicateParticipants ? warn(`${s.duplicateParticipants} document${s.duplicateParticipants > 1 ? 's' : ''} <em>sessionParticipants</em> inscrivent un pilote deux fois à la même manche. Le module les ignore, mais le nombre d'engagés affiché ailleurs dans l'application en est faussé — et avec lui les points attribués aux DNF.`) : ''}`),

    renderDuplicateProtection(s),

    section('historical', 'Couverture des checkpoints', `
      <p class="prj-n" style="margin-bottom:var(--sp-sm)">
        Nombre de lignes pilote reconstruites après chaque manche, sur les meetings complets.
        La règle de l'application exige 2 manches classées pour figurer au classement intermédiaire :
        elle est correcte pour attribuer des points, mais rend le checkpoint après Q1 inexploitable.
        Le module de projection n'en exige qu'une.
      </p>
      <div class="prj-scroll"><table class="prj-table">
        <thead><tr><th>Règle appliquée</th>${checkpoints.map(n => `<th class="center">Après Q${n}</th>`).join('')}</tr></thead>
        <tbody>
          <tr><td>Application (min. 2 manches classées)</td>
            ${checkpoints.map(n => `<td class="center ${cov.withDefaultRule[n] ? '' : 'prj-dq-warn'}">${cov.withDefaultRule[n] ?? 0}</td>`).join('')}</tr>
          <tr><td>Projection (min. 1 manche classée)</td>
            ${checkpoints.map(n => `<td class="center prj-dq-ok">${cov.withProjectionRule[n] ?? 0}</td>`).join('')}</tr>
        </tbody>
      </table></div>`),

    renderDivergences(),
    renderGroupsTable(),
  ].join('');
}

/**
 * État observable de la protection anti-doublon.
 *
 * La règle Firestore ne peut pas être interrogée depuis l'application. Ce qui
 * PEUT l'être, c'est sa conséquence : si un document à identifiant historique
 * apparaît avec une date postérieure au déploiement, c'est que la règle n'est
 * pas active. C'est le seul contrôle honnête possible depuis ici.
 */
function renderDuplicateProtection(s) {
  const date = s.legacyNewest ? String(s.legacyNewest).slice(0, 10) : null;
  return section('historical', 'Protection contre les inscriptions en double', `
    <div class="prj-cards">
      ${card('Identifiants historiques', String(s.legacyIdCount || 0), 'documents antérieurs à la protection')}
      ${card('Plus récent d\'entre eux', date || '—', 'aucun ne devrait être postérieur au déploiement')}
      ${card('Doublons subsistants', String(s.duplicateParticipants || 0), 'ignorés au calcul, non supprimés')}
    </div>
    <ul class="prj-notes">
      <li>À l'écriture, l'identifiant d'une inscription est <code>sessionId_driverId</code> : deux enregistrements
          concurrents du même pilote visent le même document et s'écrasent, au lieu d'en créer deux.</li>
      <li>La règle Firestore correspondante impose ce format à la création. Elle est versionnée dans
          <code>firestore.rules</code> mais doit être <strong>déployée manuellement</strong> dans la console
          — voir <code>docs/qualification-projection/ANTI-DOUBLONS.md</code>.</li>
      <li>Les documents à identifiant historique ne sont <strong>pas supprimés</strong> par ce module : leur
          reprise relève d'une migration dédiée.</li>
      <li>Contrôle : si la date ci-dessus devient postérieure à votre déploiement, c'est que la règle
          n'est pas active.</li>
    </ul>`);
}

function renderDivergences() {
  if (!report.divergences.length) {
    return section('historical', 'Divergences règle / réalité',
      `<p class="prj-n">Aucune : tous les pilotes classés qualifiés étaient bien présents en phase suivante.</p>`);
  }
  return section('historical', `Divergences règle / réalité (${report.divergences.length})`, `
    <p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Ces pilotes sont les seuls cas où la règle sportive et la réalité s'écartent.
      La projection se calibre sur la règle : un forfait n'est pas prévisible.
    </p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Meeting</th><th>Catégorie</th><th>Pilote</th>
        <th class="center">Pos.</th><th class="center">Seuil</th><th>Explication</th></tr></thead>
      <tbody>${report.divergences.map(d => `<tr>
        <td>${escHtml(d.meetingLabel)}</td>
        <td>${escHtml(d.category)}</td>
        <td>#${escHtml(String(d.carNumber ?? '?'))} ${escHtml(d.lastName || '?')}</td>
        <td class="center">${d.position != null ? 'P' + d.position : '—'}</td>
        <td class="center">${d.threshold ?? '—'}</td>
        <td>${escHtml(d.description)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`);
}

function renderGroupsTable() {
  const rows = report.groups.map(g => {
    const races = g.races.map(r => {
      if (!r.hasResults) return `<span class="prj-dq-off" title="Manche non courue">·</span>`;
      const cls = (r.empty > 0 || r.duplicates > 0) ? 'prj-dq-warn' : 'prj-dq-ok';
      const dup = r.duplicates ? ` · ${r.duplicates} inscription(s) en double ignorée(s)` : '';
      return `<span class="${cls}" title="${r.engaged} engagés · ${r.timed} chronos · ${r.withStatus} statuts · ${r.empty} sans saisie${dup}">${r.results}</span>`;
    }).join(' ');

    const etat = !g.hasAnyResult ? '<span class="prj-chip">à venir</span>'
      : g.isComplete
        ? (g.trivial ? '<span class="prj-chip prj-chip--info">mécanique</span>' : '<span class="prj-chip prj-chip--ok">exploitable</span>')
        : '<span class="prj-chip prj-chip--ko">incomplet</span>';

    return `<tr>
      <td>${escHtml(g.meetingDate || '')}</td>
      <td>${escHtml(g.meetingLabel)}</td>
      <td>${escHtml(g.category)}</td>
      <td class="center">${g.engagedCount}</td>
      <td class="prj-dq-race center">${races}</td>
      <td class="center">${g.threshold ?? '—'}</td>
      <td class="center"><span class="prj-chip" title="${escHtml(g.thresholdLabel)}">${escHtml(g.thresholdSource)}</span></td>
      <td class="center">${g.divergenceCount || '—'}</td>
      <td class="center">${g.duplicateParticipants ? `<span class="prj-chip prj-chip--ko">${g.duplicateParticipants}</span>` : '—'}</td>
      <td class="center">${etat}</td>
    </tr>`;
  }).join('');

  return section('historical', 'Détail meeting par meeting', `
    <p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Chaque cellule de manche indique le nombre de résultats saisis ; un point signale une manche non courue.
      Survolez pour le détail engagés / chronos / statuts.
    </p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Date</th><th>Meeting</th><th>Catégorie</th><th class="center">Engagés</th>
        <th class="center">Q1 Q2 Q3 Q4</th><th class="center">Seuil</th><th class="center">Source</th>
        <th class="center">Div.</th><th class="center" title="Participations en double, ignorées au calcul">Doub.</th>
        <th class="center">État</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initProjection() {
  if (_initialised) return;
  _initialised = true;

  document.addEventListener('viewchange', async e => {
    if (e.detail.view !== 'projection') return;
    renderView();
    await ensurePersonMap();
    if (!_loaded && !_loading) {
      await load();
    }
    renderContent();
  });

  // Connexion, déconnexion, attribution ou RÉVOCATION d'une licence : les
  // droits sont suivis en temps réel, donc l'écran se réaligne sans que le
  // team ait à recharger la page. C'est ce qui rend une révocation
  // immédiate plutôt que théorique.
  const onAccessChanged = () => {
    if (document.getElementById('view-projection')?.style.display === 'none') return;
    renderContent();
  };
  document.addEventListener('accesschange', onAccessChanged);
  document.addEventListener('authchange', onAccessChanged);

  // Un changement de championnat peut modifier les règlements chargés :
  // on repart des documents plutôt que d'un cache potentiellement obsolète.
  document.addEventListener('championshipchange', () => {
    clearCache();
    _loaded = false;
    observations = []; contexts = []; report = null;
    if (document.getElementById('view-projection')?.style.display !== 'none') {
      renderView();
      load().then(renderContent);
    }
  });
}

/** Exporté pour un futur point d'entrée depuis la vue Classements. */
export async function preloadProjection() {
  if (!_loaded && !_loading) await load();
  return { observations, contexts, championshipsById };
}

// Réexport utilisé par les points d'entrée croisés (aucun calcul ici).
export { loadContexts };
