/* ═══════════════════════════════════════════════
   OBS-STUDIO.JS — Logique PURE de la scène « Plateau » (1/3 classement · 2/3 vidéo)
   et des thèmes de fond. Aucune dépendance Firebase / DOM → testable.
═══════════════════════════════════════════════ */

/** Classements affichables dans le tiers gauche (ordre d'affichage / de rotation). */
export const BOARD_IDS = ['manche', 'interim', 'meeting', 'champ'];
export const BOARD_LABEL = {
  manche:  'Manche',
  interim: 'Intermédiaire',
  meeting: 'Meeting',
  champ:   'Championnat',
};

/** Bandeaux possibles sous la vidéo. */
export const BOTTOM_IDS = ['none', 'predict', 'wait', 'sponsors'];
export const BOTTOM_LABEL = {
  none: 'Aucun', predict: '🔮 Prédiction', wait: '⏸️ Attente', sponsors: '📢 Sponsors / info',
};

export const ROTATE_MIN = 5, ROTATE_MAX = 120, ROTATE_DEFAULT = 15;

/** Fonds globaux (DA « Pit Lane »). `carbon` = rendu historique (sobre, sombre). */
export const BG_THEMES = [
  { id: 'carbon',  label: 'Carbone',  swatch: 'linear-gradient(135deg,#12161f,#070809)' },
  { id: 'paddock', label: 'Paddock',  swatch: 'linear-gradient(135deg,#16305c,#0a1428)' },
  { id: 'asphalt', label: 'Asphalte', swatch: 'linear-gradient(135deg,#3a3f4a,#16181d)' },
  { id: 'ember',   label: 'Braise',   swatch: 'linear-gradient(135deg,#7a2a10,#1d0a06)' },
  { id: 'nitro',   label: 'Nitro',    swatch: 'linear-gradient(135deg,#4a2a8a,#120a26)' },
  { id: 'forest',  label: 'Sous-bois', swatch: 'linear-gradient(135deg,#1f5a40,#08170f)' },
  { id: 'chroma',  label: 'Fond vert (chroma)', swatch: '#00ff00' },
];
export const DEFAULT_BG = 'carbon';

export function normalizeBg(id) {
  return BG_THEMES.some(t => t.id === id) ? id : DEFAULT_BG;
}

/** Config « plateau » normalisée (valeurs par défaut + bornes). */
export function studioConfig(raw) {
  const s = raw || {};
  let boards = (Array.isArray(s.boards) ? s.boards : []).filter(b => BOARD_IDS.includes(b));
  boards = BOARD_IDS.filter(b => boards.includes(b));          // ordre canonique, sans doublon
  if (!boards.length) boards = ['manche'];
  const sec = Math.round(Number(s.rotateSec));
  return {
    boards,
    rotate: !!s.rotate,
    rotateSec: Number.isFinite(sec) ? Math.min(ROTATE_MAX, Math.max(ROTATE_MIN, sec)) : ROTATE_DEFAULT,
    active: boards.includes(s.active) ? s.active : boards[0],
    bottom: BOTTOM_IDS.includes(s.bottom) ? s.bottom : 'none',
    showVideo: s.showVideo !== false,
  };
}

/**
 * Classements à parcourir. Rotation active → tous ceux sélectionnés (les vides sont
 * sautés s'il en reste au moins un rempli). Rotation off → uniquement l'« actif ».
 * @param {object} cfg  studioConfig()
 * @param {Object<string,{rows:Array}>} data  classements calculés par id
 */
export function boardCycle(cfg, data) {
  if (!cfg.rotate) return [cfg.active];
  const filled = cfg.boards.filter(id => (data?.[id]?.rows || []).length > 0);
  return filled.length ? filled : cfg.boards;
}

/** Densité des lignes : le classement est affiché EN ENTIER, on réduit la taille selon l'effectif. */
export function densityClass(n) {
  return n <= 12 ? 'sd1' : n <= 20 ? 'sd2' : n <= 28 ? 'sd3' : 'sd4';
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Normalise les lignes d'un classement vers une forme unique d'affichage :
 *   { pos, num, name, main, unit, sub, delta, out, p1 }
 * @param {'manche'|'interim'|'meeting'|'champ'} kind
 * @param {Array} rows lignes telles que produites par obs-data / live.html (non tronquées)
 */
export function normalizeRows(kind, rows) {
  return (rows || []).map((r, i) => {
    let o;
    if (kind === 'manche') {
      o = { pos: r.status ? null : (r.position ?? i + 1), main: r.value || '', unit: '',
        sub: r.points != null && r.points !== '' ? `${r.points} pt` : '', delta: null, out: !!r.status };
    } else if (kind === 'interim') {
      o = { pos: r.position ?? i + 1, main: String(r.totalPoints ?? 0), unit: 'pt', sub: '', delta: r.delta ?? null, out: false };
    } else if (kind === 'meeting') {
      o = { pos: r.position ?? i + 1, main: String(r.total ?? 0), unit: 'pt', sub: '', delta: null, out: false };
    } else {
      o = { pos: r.position ?? i + 1, main: String(r.grandTotal ?? 0), unit: 'pt',
        sub: num(r.meetingPts) != null ? `+${r.meetingPts}` : '', delta: r.delta ?? null, out: false };
    }
    o.num = r.carNumber ?? '';
    o.name = r.lastName || '';
    o.p1 = o.pos === 1;
    return o;
  });
}
