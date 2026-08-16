/* ═══════════════════════════════════════════════
   VIDEOTIMECODES.JS — Éditeur vidéos & timecodes
   d'un meeting. Permet d'associer une ou plusieurs
   vidéos YouTube au meeting, puis de saisir un
   timecode par (session × catégorie).
   Ces timecodes servent ensuite au bouton
   « ▶ Voir la course » dans la vue Chronométrage.
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';
import {
  escHtml, uid,
  parseTimecode, formatTimecode, extractYoutubeId,
  timecodeKey,
} from './utils.js';
import { getActiveChampionship } from './context.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let _state = null;

// ─────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────

function ensureModal() {
  let modal = document.getElementById('vid-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'vid-modal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" style="max-width:920px;width:95vw">
      <div class="modal-header">
        <span class="modal-title" id="vid-modal-title">🎥 Vidéos & timecodes</span>
        <button class="modal-close" id="vid-modal-close">✕</button>
      </div>
      <div class="modal-body" id="vid-modal-body"></div>
      <div class="modal-footer" id="vid-modal-footer"></div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('vid-modal-close').addEventListener('click', tryClose);
  modal.addEventListener('click', e => { if (e.target === modal) tryClose(); });
  return modal;
}

function openModal() { ensureModal().classList.add('is-open'); }
function closeModal() {
  const modal = document.getElementById('vid-modal');
  if (modal) modal.classList.remove('is-open');
  _state = null;
}

function tryClose() {
  if (_state?.dirty && !window.confirm('Modifications non enregistrées. Fermer quand même ?')) return;
  closeModal();
}

// ─────────────────────────────────────────────────────────
// ENTRÉE PUBLIQUE
// ─────────────────────────────────────────────────────────

/**
 * Ouvre l'éditeur pour un meeting donné.
 * @param {string} meetingId
 */
export async function openVideoEditor(meetingId) {
  if (!requireAuth()) return;
  if (!db) { toast('Firebase non connecté', 'error'); return; }

  const { doc, getDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDoc(doc(db, 'meetings', meetingId));
  if (!snap.exists()) { toast('Meeting introuvable', 'error'); return; }
  const meeting = { id: meetingId, ...snap.data() };

  _state = {
    meeting,
    videos:    (meeting.videos || []).map(v => ({ id: v.id || uid(), label: v.label || '', url: v.url || '' })),
    timecodes: JSON.parse(JSON.stringify(meeting.videoTimecodes || {})),
    dirty:     false,
  };

  ensureModal();
  render();
  openModal();
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function render() {
  if (!_state) return;
  const { meeting, videos, timecodes } = _state;

  const dateLabel = meeting.date
    ? new Date(meeting.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '';
  document.getElementById('vid-modal-title').textContent =
    `🎥 Vidéos & timecodes — ${meeting.location || '?'}${dateLabel ? ` (${dateLabel})` : ''}`;

  document.getElementById('vid-modal-body').innerHTML = `
    ${renderVideosSection(videos)}
    ${renderTimecodesSection(meeting, videos, timecodes)}
  `;

  document.getElementById('vid-modal-footer').innerHTML = `
    <button class="btn btn-secondary" id="vid-cancel">Annuler</button>
    <button class="btn btn-primary" id="vid-save">💾 Enregistrer</button>
  `;

  bindEvents();
}

function renderVideosSection(videos) {
  return `
    <div style="margin-bottom:var(--sp-lg)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-sm)">
        <h3 style="margin:0;font-size:1rem">📺 Vidéos YouTube</h3>
        <button class="btn btn-secondary btn-sm" id="vid-add-video">＋ Ajouter une vidéo</button>
      </div>
      <div class="text-muted" style="font-size:0.78rem;margin-bottom:var(--sp-sm)">
        Ajoutez les URLs YouTube couvrant ce meeting (ex : une par jour — Samedi, Dimanche…).
      </div>
      <div id="vid-list" style="display:flex;flex-direction:column;gap:6px">
        ${videos.length === 0
          ? `<div class="text-muted" style="text-align:center;padding:var(--sp-md);border:2px dashed var(--clr-border-2);border-radius:var(--r-lg)">
              Aucune vidéo. Cliquez sur ＋ pour en ajouter une.
            </div>`
          : videos.map((v, i) => renderVideoRow(v, i)).join('')}
      </div>
    </div>
  `;
}

function renderVideoRow(v, i) {
  const urlValid = !v.url || extractYoutubeId(v.url);
  const warn = v.url && !urlValid
    ? `<span title="URL YouTube non reconnue" style="color:var(--clr-warning);font-size:1.1rem">⚠</span>`
    : '';
  return `
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input class="form-input vid-label" placeholder="Label (ex: Samedi)"
        style="width:140px;min-width:100px" data-idx="${i}"
        value="${escHtml(v.label || '')}">
      <input class="form-input vid-url" placeholder="URL YouTube"
        style="flex:1;min-width:200px" data-idx="${i}"
        value="${escHtml(v.url || '')}">
      ${warn}
      <button class="btn btn-danger btn-icon vid-delete" data-idx="${i}" title="Supprimer">🗑️</button>
    </div>
  `;
}

function renderTimecodesSection(meeting, videos, timecodes) {
  const cats = Array.isArray(meeting.categories) ? meeting.categories : [];
  const champ = getActiveChampionship();
  const sc = champ?.sessionConfig || {};

  // Construire la liste des sessions du meeting selon le règlement
  const sessions = [];
  if (sc.EC?.enabled !== false) sessions.push({ type: 'EC', num: null, label: 'EC' });
  const nbMQ = meeting.nbMQ || sc.MQ?.count || 4;
  for (let i = 1; i <= nbMQ; i++) sessions.push({ type: 'MQ', num: i, label: `MQ${i}` });
  if (sc.QF?.enabled) {
    const nbQF = sc.QF.count || 4;
    for (let i = 1; i <= nbQF; i++) sessions.push({ type: 'QF', num: i, label: `QF${i}` });
  }
  const nbDF = sc.DF?.count || 2;
  for (let i = 1; i <= nbDF; i++) sessions.push({ type: 'DF', num: i, label: `DF${i}` });
  sessions.push({ type: 'FIN', num: null, label: 'FIN' });

  if (videos.length === 0) {
    return `
      <div style="padding:var(--sp-md);text-align:center;border:2px dashed var(--clr-border-2);border-radius:var(--r-lg)">
        <div class="text-muted">Ajoutez d'abord au moins une vidéo ci-dessus pour saisir des timecodes.</div>
      </div>
    `;
  }

  if (cats.length === 0) {
    return `
      <div style="padding:var(--sp-md);text-align:center;border:2px dashed var(--clr-border-2);border-radius:var(--r-lg)">
        <div class="text-muted">Aucune catégorie sur ce meeting.</div>
      </div>
    `;
  }

  return `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-sm);gap:var(--sp-sm);flex-wrap:wrap">
        <h3 style="margin:0;font-size:1rem">⏱️ Timecodes par session × catégorie</h3>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="text-muted" style="font-size:0.78rem">Vidéo par défaut :</span>
          <select class="form-select" id="vid-bulk-video" style="width:140px">
            <option value="">—</option>
            ${videos.map(v => `<option value="${escHtml(v.id)}">${escHtml(v.label || truncate(v.url, 18))}</option>`).join('')}
          </select>
          <button class="btn btn-secondary btn-sm" id="vid-bulk-apply">Appliquer aux vides</button>
        </div>
      </div>
      <div class="text-muted" style="font-size:0.78rem;margin-bottom:var(--sp-sm)">
        Format timecode : <code>h:mm:ss</code>, <code>m:ss</code> ou <code>s</code>. Ex : <code>1:23:45</code>, <code>42:15</code>, <code>90</code>.
      </div>
      <div class="table-wrap" style="max-height:50vh;overflow:auto">
        <table style="min-width:600px">
          <thead style="position:sticky;top:0;background:var(--clr-bg-2);z-index:1">
            <tr>
              <th style="min-width:120px">Catégorie</th>
              ${sessions.map(s => `<th class="center" style="min-width:120px">${escHtml(s.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${cats.map(cat => renderCatRow(cat, sessions, videos, timecodes)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderCatRow(cat, sessions, videos, timecodes) {
  return `
    <tr>
      <td><strong>${escHtml(cat)}</strong></td>
      ${sessions.map(s => renderCell(s, cat, videos, timecodes)).join('')}
    </tr>
  `;
}

function renderCell(session, category, videos, timecodes) {
  const key = timecodeKey(session.type, session.num, category);
  const tc = timecodes[key] || {};
  const tcDisplay = tc.seconds != null ? formatTimecode(tc.seconds) : '';
  return `
    <td class="center" style="padding:4px">
      <div style="display:flex;flex-direction:column;gap:3px;align-items:stretch">
        <select class="form-select tc-video" data-key="${escHtml(key)}"
          style="font-size:0.75rem;padding:2px 4px">
          <option value="">—</option>
          ${videos.map(v => `
            <option value="${escHtml(v.id)}" ${tc.videoId === v.id ? 'selected' : ''}>
              ${escHtml(v.label || truncate(v.url, 15))}
            </option>
          `).join('')}
        </select>
        <input class="form-input tc-time" data-key="${escHtml(key)}"
          placeholder="0:00"
          style="font-size:0.78rem;padding:2px 4px;text-align:center;width:100%"
          value="${escHtml(tcDisplay)}">
      </div>
    </td>
  `;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('vid-add-video')?.addEventListener('click', () => {
    _state.videos.push({ id: uid(), label: '', url: '' });
    _state.dirty = true;
    render();
  });

  document.querySelectorAll('.vid-label').forEach(el => {
    el.addEventListener('change', () => {
      const idx = parseInt(el.dataset.idx, 10);
      _state.videos[idx].label = el.value.trim();
      _state.dirty = true;
      render();
    });
  });

  document.querySelectorAll('.vid-url').forEach(el => {
    el.addEventListener('change', () => {
      const idx = parseInt(el.dataset.idx, 10);
      _state.videos[idx].url = el.value.trim();
      _state.dirty = true;
      render();
    });
  });

  document.querySelectorAll('.vid-delete').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (!window.confirm('Supprimer cette vidéo ?\n(Les timecodes associés seront perdus.)')) return;
      const removedId = _state.videos[idx].id;
      _state.videos.splice(idx, 1);
      for (const k of Object.keys(_state.timecodes)) {
        if (_state.timecodes[k].videoId === removedId) delete _state.timecodes[k];
      }
      _state.dirty = true;
      render();
    });
  });

  document.querySelectorAll('.tc-video').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.key;
      const videoId = el.value;
      if (!videoId) {
        delete _state.timecodes[key];
      } else {
        _state.timecodes[key] = { ...(_state.timecodes[key] || {}), videoId };
      }
      _state.dirty = true;
    });
  });

  document.querySelectorAll('.tc-time').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.key;
      const raw = el.value.trim();
      if (raw === '') {
        if (_state.timecodes[key]) {
          delete _state.timecodes[key].seconds;
          if (!_state.timecodes[key].videoId) delete _state.timecodes[key];
        }
        _state.dirty = true;
        return;
      }
      const seconds = parseTimecode(raw);
      if (seconds == null) {
        toast(`Timecode invalide : « ${raw} »`, 'error');
        el.value = _state.timecodes[key]?.seconds != null
          ? formatTimecode(_state.timecodes[key].seconds)
          : '';
        return;
      }
      _state.timecodes[key] = { ...(_state.timecodes[key] || {}), seconds };
      // Reformater proprement dans le champ
      el.value = formatTimecode(seconds);
      _state.dirty = true;
    });
  });

  document.getElementById('vid-bulk-apply')?.addEventListener('click', () => {
    const videoId = document.getElementById('vid-bulk-video')?.value;
    if (!videoId) { toast('Choisissez une vidéo par défaut d\'abord', 'warning'); return; }
    let count = 0;
    document.querySelectorAll('.tc-video').forEach(el => {
      if (!el.value) {
        el.value = videoId;
        const key = el.dataset.key;
        _state.timecodes[key] = { ...(_state.timecodes[key] || {}), videoId };
        count++;
      }
    });
    if (count > 0) {
      _state.dirty = true;
      toast(`Vidéo appliquée à ${count} case(s) vide(s)`, 'success');
    } else {
      toast('Toutes les cases ont déjà une vidéo', 'info');
    }
  });

  document.getElementById('vid-cancel')?.addEventListener('click', tryClose);
  document.getElementById('vid-save')?.addEventListener('click', saveAll);
}

// ─────────────────────────────────────────────────────────
// SAUVEGARDE
// ─────────────────────────────────────────────────────────

async function saveAll() {
  if (!_state) return;

  // Valider les URLs YouTube
  for (const v of _state.videos) {
    if (v.url && !extractYoutubeId(v.url)) {
      toast(`URL YouTube non reconnue : « ${v.url} »`, 'error');
      return;
    }
  }

  // Ne garder que les vidéos qui ont au moins un label ou une URL
  const videos = _state.videos
    .filter(v => v.label || v.url)
    .map(v => ({ id: v.id, label: v.label || '', url: v.url || '' }));

  // Nettoyer les timecodes : ne garder que ceux qui ont videoId + seconds valides
  const validVideoIds = new Set(videos.map(v => v.id));
  const timecodes = {};
  for (const [k, v] of Object.entries(_state.timecodes)) {
    if (v?.videoId && v.seconds != null && validVideoIds.has(v.videoId)) {
      timecodes[k] = { videoId: v.videoId, seconds: v.seconds };
    }
  }

  const { doc, updateDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  try {
    await updateDoc(doc(db, 'meetings', _state.meeting.id), {
      videos,
      videoTimecodes: timecodes,
    });
    logAudit('update', 'meeting', _state.meeting.id, {
      label: `Vidéos & timecodes — ${_state.meeting.location || _state.meeting.id}`,
      nbVideos: videos.length,
      nbTimecodes: Object.keys(timecodes).length,
    });
    toast('Vidéos & timecodes enregistrés ✓', 'success');
    _state.dirty = false;
    closeModal();
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la sauvegarde', 'error');
  }
}
