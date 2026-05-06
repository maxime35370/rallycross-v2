/* ═══════════════════════════════════════════════
   PROVIDERS/INDEX.JS — Registry des fournisseurs de
   chronométrage. Architecture extensible : ajouter
   un nouveau provider = créer un fichier dans ce
   dossier et l'enregistrer ci-dessous.
═══════════════════════════════════════════════ */

import * as itsLive from './itsLive.js';

// ─────────────────────────────────────────────────────────
// CONTRAT D'UN PROVIDER
// Chaque module doit exporter au minimum :
//   - id           (string unique)
//   - name         (string lisible)
//   - description  (string courte)
//   - configSchema { championship: [...], meeting: [...] }
//   - listSessions(config)  → [{ session_id, name, category, type, raw }]
//   - getRanking(config)    → [{ carNumber, time_ms, status, position,
//                                firstName, lastName, raw }]
//
// Optionnels : listSeasons, listEvents, getEvent (helpers de découverte).
// ─────────────────────────────────────────────────────────

const PROVIDERS = {
  [itsLive.id]: itsLive,
};

export function getProvider(id) {
  return id ? (PROVIDERS[id] || null) : null;
}

export function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));
}

export function getDefaultProviderId() {
  return Object.keys(PROVIDERS)[0] || null;
}
