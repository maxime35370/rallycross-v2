/* ═══════════════════════════════════════════════
   CHANGELOG.JS — Nouveautés du site
   Récap des évolutions visibles, mois par mois.
   Contenu statique et curaté (les petits correctifs n'y figurent pas).
═══════════════════════════════════════════════ */

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
      <h2 class="section-title">📰 <span>Nouveautés</span></h2>
      <span class="text-muted" style="font-size:0.82rem">Les évolutions du site, sans les petits correctifs</span>
    </div>
    <div class="changelog-timeline">
      ${months}
    </div>
  `;
}

export function initChangelog() {
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'changelog') renderChangelog();
  });
}
