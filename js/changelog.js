/* ═══════════════════════════════════════════════
   CHANGELOG.JS — Nouveautés du site
   Récap des évolutions visibles, mois par mois, et des outils
   disponibles selon le profil (visiteur / connecté / admin).
═══════════════════════════════════════════════ */

import { isAdmin, isViewer } from './auth.js';

// ── Outils disponibles par profil ──────────────
// Chaque niveau cumule les outils du niveau précédent.
const PROFILES = [
  {
    id: 'guest',
    title: 'Sans compte',
    subtitle: 'Ce que tout le monde peut consulter, sans se connecter',
    tools: [
      '🏠 Accueil — vue d\'ensemble et accès rapide par QR code',
      '🏆 Classements — classement de chaque session et classement intermédiaire',
      '🥇 Championnat — classement général, scénarios de titre, graphique d\'évolution',
      '📊 Statistiques — statistiques globales du championnat et des pilotes',
      '📺 Mode Spectateur — suivi en direct (carrousel), pronostics et résultats',
      '📰 Nouveautés — ce récap des évolutions du site',
    ],
  },
  {
    id: 'viewer',
    title: 'Connecté (commentateur)',
    subtitle: 'En plus de ce qui précède, une fois connecté avec un compte commentateur',
    tools: [
      '🏃 Fiches Pilotes — consulter les profils et leurs statistiques détaillées',
      '👥 Pilotes — consulter la liste des pilotes et leurs catégories',
      '📅 Meetings — consulter la liste des meetings et leurs sessions',
      '📋 Engagements — consulter les engagements par meeting et catégorie',
      '🏁 Sessions — consulter le détail de chaque session',
      '⏱️ Chronométrage — suivre les temps et le classement en direct',
    ],
    note: 'Accès en lecture uniquement : aucune saisie ni modification possible avec ce rôle.',
  },
  {
    id: 'admin',
    title: 'Administrateur',
    subtitle: 'Tous les outils ci-dessus, plus la gestion complète de l\'épreuve',
    tools: [
      'Gestion complète (création, modification, suppression) des Fiches Pilotes, Pilotes, Meetings, Engagements et Sessions',
      '⏱️ Chronométrage — saisie des temps en direct',
      '🎥 Analyse des départs — analyse vidéo du premier virage',
      '📈 Stats des départs',
      '🎯 Stratégie Live — projections de qualification en direct',
      '🔑 Accès team — gestion des rôles et des licences de l\'équipe',
      '📋 Journal d\'audit — historique des modifications',
      '⚙️ Configuration et 🏆 Réglages Championnats',
      '🎬 Régie OBS (overlay/control.html) — pilotage des scènes de diffusion',
      '📺 Overlay OBS (overlay/live.html) — incrustation diffusée à l\'antenne',
    ],
  },
];

function currentProfileId() {
  if (isAdmin()) return 'admin';
  if (isViewer()) return 'viewer';
  return 'guest';
}

function renderProfiles() {
  const current = currentProfileId();

  return PROFILES.map(p => {
    const isCurrent = p.id === current;
    return `
      <div class="changelog-profile${isCurrent ? ' is-current' : ''}">
        <div class="changelog-profile-header">
          <h3 class="changelog-profile-title">${p.title}</h3>
          ${isCurrent ? '<span class="badge badge-ec">Votre profil</span>' : ''}
        </div>
        <p class="text-muted" style="font-size:0.82rem;margin:0 0 var(--sp-sm)">${p.subtitle}</p>
        <ul class="changelog-list">
          ${p.tools.map(t => `<li class="changelog-item">${t}</li>`).join('')}
        </ul>
        ${p.note ? `<p class="text-muted" style="font-size:0.78rem;margin-top:var(--sp-sm)">${p.note}</p>` : ''}
      </div>
    `;
  }).join('');
}

const CHANGELOG = [
  {
    month: 'Octobre 2026',
    items: [
      'Miroir Realtime Database pour les résultats et l\'état régie : le coût Firestore ne dépend plus du nombre de viewers.',
      'Nouveau rôle "commentateur" en lecture seule, pour suivre la course sans pouvoir la modifier.',
      'Régie : mode préparation avec moniteur d\'aperçu dédié avant de mettre une scène à l\'antenne.',
      'Overlay : transitions douces entre les scènes (fondu, rotation des classements, glissement des lignes).',
      'Cache des manches et des meetings pour réduire fortement les lectures Firestore.',
    ],
  },
  {
    month: 'Septembre 2026',
    items: [
      'Championnat : scénarios de titre calculés selon les meetings restants.',
      'L\'analyse du premier virage devient une vue à part entière de l\'application.',
      'Pronostics : connexion Twitch, bot de chat dédié, automatisation FFSA par catégorie et classement de saison.',
      'Pronostics : historique personnel, classement par ratio et "indice d\'audace".',
    ],
  },
  {
    month: 'Août 2026',
    items: [
      'Stratégie Live : projections de qualification en direct (scénarios, what-if, mode hybride pendant une manche en cours).',
      'Analyse des départs : lecteur vidéo dédié, saisie du V1 par pointage et statistiques complètes par couloir/série.',
      'Accès team : gestion des rôles et des licences pour l\'équipe (comptes dédiés, recherche, meetings filtrés).',
    ],
  },
  {
    month: 'Juillet 2026',
    items: [
      'Lancement des pronostics spectateurs : vote en direct, classement par épreuve et par saison, overlay dédié.',
      'Images de résultats partageables pour les réseaux sociaux.',
      'Accès direct par QR code ou lien, avec bascule automatique en mode spectateur pour les non-admins.',
      'Bandeau info / sponsors piloté depuis la régie.',
    ],
  },
  {
    month: 'Juin 2026',
    items: [
      'Première version du studio de diffusion OBS : régie, scènes (grille, écran d\'attente, dashboard) et overlays live.',
      'Dashboard championnat évolutif avec grilles et classements mis à jour en direct pendant les manches.',
      'Bandeau de prédiction d\'objectifs en direct, recalculé à chaque saisie de temps.',
      'Graphique d\'évolution du classement intermédiaire (places et points).',
    ],
  },
  {
    month: 'Mai 2026',
    items: [
      'Mode FIA pour la composition des séries de manches qualificatives.',
      'Points et position intermédiaire affichés en direct sur l\'écran de chronométrage.',
      'Statistiques pilote enrichies : écarts, moyennes, DNF, victoires en demi/finale.',
      'Construction automatique de la grille de finale depuis le classement intermédiaire.',
    ],
  },
  {
    month: 'Avril 2026',
    items: [
      'Règlements personnalisables par championnat (cascade FIA, quarts de finale, repêchages, nombre de pilotes par série).',
      'Fiches pilotes multi-championnats avec statistiques globales cumulées.',
      'Import automatique des temps depuis un chronométreur live (ITS Live).',
      'QR code spectateur pour un accès direct en plein écran au mode spectateur.',
      'Journal d\'audit des modifications et authentification de l\'équipe.',
    ],
  },
  {
    month: 'Mars 2026',
    items: [
      'Mise en ligne de l\'application : gestion des pilotes, des meetings, des engagements et des championnats.',
      'Génération automatique des sessions et premier moteur de calcul des classements.',
      'Reconnaissance photo des feuilles de temps (extraction des numéros, noms et temps).',
    ],
  },
];

function renderChangelog() {
  const view = document.getElementById('view-changelog');
  if (!view) return;

  const months = CHANGELOG.map(({ month, items }) => `
    <div class="changelog-month">
      <h3 class="changelog-month-title">${month}</h3>
      <ul class="changelog-list">
        ${items.map(item => `<li class="changelog-item">${item}</li>`).join('')}
      </ul>
    </div>
  `).join('');

  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🧰 <span>Outils disponibles</span></h2>
      <span class="text-muted" style="font-size:0.82rem">Ce que vous pouvez faire sur le site, selon votre profil</span>
    </div>
    <div class="changelog-profiles">
      ${renderProfiles()}
    </div>

    <div class="section-header" style="margin-top:var(--sp-2xl)">
      <h2 class="section-title">📰 <span>Nouveautés</span></h2>
      <span class="text-muted" style="font-size:0.82rem">Les évolutions du site, sans les petits correctifs</span>
    </div>
    <div class="changelog-timeline">
      ${months}
    </div>
  `;
}

let _isActive = false;

export function initChangelog() {
  document.addEventListener('viewchange', e => {
    _isActive = e.detail.view === 'changelog';
    if (_isActive) renderChangelog();
  });

  // Le profil (connexion/déconnexion) peut changer pendant que la page est ouverte.
  document.addEventListener('authchange', () => {
    if (_isActive) renderChangelog();
  });
}
