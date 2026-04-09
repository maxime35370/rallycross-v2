/* ═══════════════════════════════════════════════
   CONTEXT.JS — Contexte championnat actif
   Partage entre tous les modules pour filtrer
   pilotes, meetings, engagements, etc.
═══════════════════════════════════════════════ */

import { db } from './firebase.js';

// ─────────────────────────────────────────────────────────
// ETAT
// ─────────────────────────────────────────────────────────

const LS_KEY = 'rx_active_championship';

let _championships = [];
let _activeChampId = localStorage.getItem(LS_KEY) || '';
let _activeChamp   = null;

// ─────────────────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────────────────

/** ID du championnat selectionne (string vide = aucun) */
export function getActiveChampionshipId() {
  return _activeChampId;
}

/** Objet complet du championnat actif (null si aucun) */
export function getActiveChampionship() {
  return _activeChamp;
}

/** Liste de tous les championnats charges */
export function getAllChampionships() {
  return _championships;
}

// ─────────────────────────────────────────────────────────
// CHARGEMENT
// ─────────────────────────────────────────────────────────

export async function loadChampionships() {
  if (!db) { _championships = []; return; }
  try {
    const { collection, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const snap = await getDocs(collection(db, 'championships'));
    _championships = [];
    snap.forEach(d => _championships.push({ id: d.id, ...d.data() }));
    _championships.sort((a, b) => (b.year - a.year) || (a.name || '').localeCompare(b.name || ''));
  } catch (e) {
    console.error('Context – loadChampionships:', e);
    _championships = [];
  }

  // Si l'ID sauvegarde n'existe plus, prendre le premier actif
  _activeChamp = _championships.find(c => c.id === _activeChampId) || null;
  if (!_activeChamp) {
    _activeChamp = _championships.find(c => c.isActive) || _championships[0] || null;
    _activeChampId = _activeChamp?.id || '';
    localStorage.setItem(LS_KEY, _activeChampId);
  }
}

// ─────────────────────────────────────────────────────────
// SELECTION
// ─────────────────────────────────────────────────────────

export function setActiveChampionship(champId) {
  _activeChampId = champId || '';
  _activeChamp = _championships.find(c => c.id === _activeChampId) || null;
  localStorage.setItem(LS_KEY, _activeChampId);

  // Notifier tous les modules
  document.dispatchEvent(new CustomEvent('championshipchange', {
    detail: { championshipId: _activeChampId, championship: _activeChamp },
  }));
}

// ─────────────────────────────────────────────────────────
// RENDU DU SELECTEUR (pour le header)
// ─────────────────────────────────────────────────────────

export function renderChampionshipSelector() {
  const container = document.getElementById('championship-selector');
  if (!container) return;

  if (_championships.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  const options = _championships.map(c =>
    `<option value="${c.id}" ${c.id === _activeChampId ? 'selected' : ''}>` +
    `${c.name || 'Sans nom'}${c.isActive ? ' ●' : ''}` +
    `</option>`
  ).join('');

  container.innerHTML = `
    <select class="champ-selector-select" id="champ-selector-select">
      ${options}
    </select>
  `;

  document.getElementById('champ-selector-select')
    ?.addEventListener('change', (e) => {
      setActiveChampionship(e.target.value);
    });
}
