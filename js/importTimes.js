/* ═══════════════════════════════════════════════
   IMPORTTIMES.JS — Import des temps depuis un
   fournisseur de chronométrage externe (ITS Live, …)
   Affiche une modal avec :
   1. Configuration du provider (mémorisée par championnat
      et par meeting dans Firestore).
   2. Sélection de la session distante correspondant à la
      session RXChrono active.
   3. Aperçu du classement, mappage par numéro de voiture,
      validation et import via saveResult().
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';
import { escHtml, msToDisplay } from './utils.js';
import { getProvider, listProviders, getDefaultProviderId } from './providers/index.js';

// ─────────────────────────────────────────────────────────
// CONFIG STOCKAGE
//
// La config provider est éclatée en deux niveaux :
//  - championship.timingProvider = { id, ...championshipFields }
//  - meeting.timingProviderEvent = { ...meetingFields }
//
// Cette séparation permet de réutiliser la config championnat
// (cs_id, identifiants globaux) et de ne configurer que
// l'événement spécifique au niveau du meeting.
// ─────────────────────────────────────────────────────────

async function loadChampionshipConfig(championshipId) {
  if (!db || !championshipId) return null;
  const { doc, getDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDoc(doc(db, 'championships', championshipId));
  return snap.exists() ? (snap.data().timingProvider || null) : null;
}

async function saveChampionshipConfig(championshipId, providerId, fields) {
  if (!db || !championshipId) return;
  const { doc, updateDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await updateDoc(doc(db, 'championships', championshipId), {
    timingProvider: { id: providerId, ...fields },
  });
}

async function loadMeetingConfig(meetingId) {
  if (!db || !meetingId) return null;
  const { doc, getDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDoc(doc(db, 'meetings', meetingId));
  return snap.exists() ? (snap.data().timingProviderEvent || null) : null;
}

async function saveMeetingConfig(meetingId, fields) {
  if (!db || !meetingId) return;
  const { doc, updateDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await updateDoc(doc(db, 'meetings', meetingId), {
    timingProviderEvent: fields,
  });
}

// ─────────────────────────────────────────────────────────
// MODAL — UTILITAIRES
// ─────────────────────────────────────────────────────────

function ensureModal() {
  let modal = document.getElementById('imp-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'imp-modal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" style="max-width:640px">
      <div class="modal-header">
        <span class="modal-title" id="imp-modal-title">Import des temps</span>
        <button class="modal-close" id="imp-modal-close">✕</button>
      </div>
      <div class="modal-body" id="imp-modal-body"></div>
      <div class="modal-footer" id="imp-modal-footer"></div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('imp-modal-close').addEventListener('click', () => closeModal());
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  return modal;
}

function openModal() { ensureModal().classList.add('is-open'); }
function closeModal() {
  const modal = document.getElementById('imp-modal');
  if (modal) modal.classList.remove('is-open');
}
function setTitle(text) {
  const el = document.getElementById('imp-modal-title');
  if (el) el.textContent = text;
}
function setBody(html) {
  const el = document.getElementById('imp-modal-body');
  if (el) el.innerHTML = html;
}
function setFooter(html) {
  const el = document.getElementById('imp-modal-footer');
  if (el) el.innerHTML = html;
}

function loadingHtml(label) {
  return `<div class="loading-state"><div class="spinner"></div><span>${escHtml(label || 'Chargement…')}</span></div>`;
}
function errorHtml(msg) {
  return `<div class="config-test-error"><span>❌</span><span>${escHtml(msg)}</span></div>`;
}

// ─────────────────────────────────────────────────────────
// FLOW PRINCIPAL
// Appelé depuis timing.js — reçoit le contexte session +
// participants + callback de sauvegarde.
// ─────────────────────────────────────────────────────────

/**
 * Lance le flow d'import des temps.
 * @param {object} ctx
 * @param {object} ctx.session       — session RXChrono active
 * @param {Array}  ctx.participants  — liste des participants ({ driverId, carNumber, … })
 * @param {string} ctx.meetingId
 * @param {string} ctx.championshipId
 * @param {string} ctx.category
 * @param {Function} ctx.saveResult  — async (driverId, ms, status) => void
 */
export async function startImport(ctx) {
  if (!requireAuth()) return;

  const champConfig   = await loadChampionshipConfig(ctx.championshipId);
  const meetingConfig = await loadMeetingConfig(ctx.meetingId);

  const providerId = champConfig?.id || getDefaultProviderId();
  const provider   = getProvider(providerId);
  if (!provider) {
    toast('Aucun fournisseur de chronométrage configuré', 'error');
    return;
  }

  openModal();
  setTitle(`📡 Import depuis ${provider.name}`);

  // Étape 1 : afficher / éditer la config (championnat + meeting)
  showConfigStep({ ctx, provider, champConfig, meetingConfig });
}

// ─────────────────────────────────────────────────────────
// ÉTAPE 1 — CONFIGURATION DU PROVIDER
// Sélection en cascade : championnat → saison → événement.
// Chaque champ peut être :
//   - text          (input texte simple)
//   - select        (dropdown avec options statiques + option "Autre…")
//   - dynamicSelect (dropdown peuplé via loadOptions(deps))
// ─────────────────────────────────────────────────────────

function showConfigStep({ ctx, provider, champConfig, meetingConfig }) {
  const providers = listProviders();

  const allFields = [
    ...provider.configSchema.championship.map(f => ({ ...f, scope: 'championship' })),
    ...provider.configSchema.meeting.map(f => ({ ...f, scope: 'meeting' })),
  ];

  // État réactif partagé : chaque champ peut lire / écrire dedans.
  const state = {
    values:        { ...(champConfig || {}), ...(meetingConfig || {}) },
    optionsCache:  {},     // { [key]: { depsKey, options } }
    loading:       new Set(),
    errors:        {},
    customMode:    {},     // { [key]: true } quand l'utilisateur a choisi « Autre… »
  };

  // Si une valeur est déjà mémorisée mais pas dans la liste connue,
  // basculer ce champ en mode custom dès l'ouverture.
  for (const f of allFields) {
    if (f.type === 'select' && f.allowCustom) {
      const cur = state.values[f.key];
      const known = (f.options || []).some(o => o.value === cur);
      if (cur && !known) state.customMode[f.key] = true;
    }
  }

  function render() {
    const fieldsHtml = allFields.map(f => renderFieldHtml(f, state)).join('');

    setBody(`
      <div style="display:flex;flex-direction:column;gap:var(--sp-md)">
        <div class="form-group">
          <label class="form-label">Fournisseur</label>
          <select class="form-select" id="imp-provider-select" ${providers.length === 1 ? 'disabled' : ''}>
            ${providers.map(p => `
              <option value="${p.id}" ${p.id === provider.id ? 'selected' : ''}>${escHtml(p.name)}</option>
            `).join('')}
          </select>
          <div class="text-muted" style="font-size:0.78rem;margin-top:4px">${escHtml(provider.description || '')}</div>
        </div>
        ${fieldsHtml}
      </div>
    `);

    setFooter(`
      <button class="btn btn-secondary" id="imp-cancel">Annuler</button>
      <button class="btn btn-primary" id="imp-fetch">Suivant : choisir une session →</button>
    `);

    document.getElementById('imp-cancel').addEventListener('click', closeModal);
    document.getElementById('imp-fetch').addEventListener('click', onSubmit);

    bindFieldEvents(allFields, state, render);
    triggerAsyncLoads(allFields, state, render);
  }

  async function onSubmit() {
    const missing = allFields.filter(f => f.required && !state.values[f.key]).map(f => f.label);
    if (missing.length) {
      toast(`Champ(s) manquant(s) : ${missing.join(', ')}`, 'error');
      return;
    }

    // Séparer la config par scope pour la persistence
    const champFields   = {};
    const meetingFields = {};
    for (const f of allFields) {
      const v = state.values[f.key];
      if (v == null || v === '') continue;
      if (f.scope === 'championship') champFields[f.key] = v;
      else                            meetingFields[f.key] = v;
    }

    try {
      if (ctx.championshipId) {
        await saveChampionshipConfig(ctx.championshipId, provider.id, champFields);
      }
      if (ctx.meetingId) {
        await saveMeetingConfig(ctx.meetingId, meetingFields);
      }
    } catch (err) {
      console.warn('Sauvegarde config provider échouée :', err);
    }

    showSessionsStep({
      ctx,
      provider,
      config: { ...champFields, ...meetingFields },
    });
  }

  render();
}

// ─────────────────────────────────────────────────────────
// RENDU DES CHAMPS DU FORMULAIRE
// ─────────────────────────────────────────────────────────

function renderFieldHtml(field, state) {
  const value = state.values[field.key] ?? '';
  const help  = field.help
    ? `<div class="text-muted" style="font-size:0.78rem;margin-top:4px">${escHtml(field.help)}</div>`
    : '';
  const error = state.errors[field.key]
    ? `<div class="config-test-error" style="margin-top:6px"><span>⚠️</span><span>${escHtml(state.errors[field.key])}</span></div>`
    : '';
  const labelHtml = `<label class="form-label">${escHtml(field.label)}${field.required ? ' *' : ''}</label>`;

  if (field.type === 'select') {
    const inCustom = !!state.customMode[field.key];
    const options  = field.options || [];

    if (inCustom) {
      return `
        <div class="form-group">
          ${labelHtml}
          <div style="display:flex;gap:6px">
            <input class="form-input" type="text"
              data-key="${escHtml(field.key)}" data-role="custom-input" style="flex:1"
              placeholder="${escHtml(field.customPlaceholder || '')}"
              value="${escHtml(value)}">
            <button type="button" class="btn btn-secondary btn-sm"
              data-key="${escHtml(field.key)}" data-role="cancel-custom">↩︎ Liste</button>
          </div>
          ${help}${error}
        </div>
      `;
    }

    return `
      <div class="form-group">
        ${labelHtml}
        <select class="form-select" data-key="${escHtml(field.key)}" data-role="select">
          <option value="">— Choisir —</option>
          ${options.map(o => `
            <option value="${escHtml(o.value)}" ${value === o.value ? 'selected' : ''}>${escHtml(o.label)}</option>
          `).join('')}
          ${field.allowCustom
            ? `<option value="__custom__">${escHtml(field.customLabel || 'Autre…')}</option>`
            : ''}
        </select>
        ${help}${error}
      </div>
    `;
  }

  if (field.type === 'dynamicSelect') {
    const deps      = field.dependsOn || [];
    const depsReady = deps.every(d => state.values[d]);
    const cached    = state.optionsCache[field.key];
    const isLoading = state.loading.has(field.key);

    if (!depsReady) {
      const missing = deps.filter(d => !state.values[d]).join(', ');
      return `
        <div class="form-group">
          ${labelHtml}
          <select class="form-select" disabled>
            <option>— Renseignez d'abord : ${escHtml(missing)} —</option>
          </select>
          ${help}
        </div>
      `;
    }

    if (isLoading) {
      return `
        <div class="form-group">
          ${labelHtml}
          <select class="form-select" disabled>
            <option>⏳ Chargement…</option>
          </select>
          ${help}
        </div>
      `;
    }

    if (state.errors[field.key]) {
      return `
        <div class="form-group">
          ${labelHtml}
          <select class="form-select" disabled>
            <option>— Erreur —</option>
          </select>
          ${error}
          <button type="button" class="btn btn-secondary btn-sm"
            data-key="${escHtml(field.key)}" data-role="retry-load"
            style="margin-top:6px">↻ Réessayer</button>
        </div>
      `;
    }

    const options = cached?.options || [];
    if (options.length === 0) {
      return `
        <div class="form-group">
          ${labelHtml}
          <select class="form-select" disabled>
            <option>— Aucune option disponible —</option>
          </select>
          ${help}
        </div>
      `;
    }

    return `
      <div class="form-group">
        ${labelHtml}
        <select class="form-select" data-key="${escHtml(field.key)}" data-role="dynamic-select">
          <option value="">${escHtml(field.placeholder || '— Choisir —')}</option>
          ${options.map(o => `
            <option value="${escHtml(o.value)}" ${value === o.value ? 'selected' : ''}>${escHtml(o.label)}</option>
          `).join('')}
        </select>
        ${help}
      </div>
    `;
  }

  return `
    <div class="form-group">
      ${labelHtml}
      <input class="form-input" type="text"
        data-key="${escHtml(field.key)}" data-role="text"
        placeholder="${escHtml(field.placeholder || '')}"
        value="${escHtml(value)}">
      ${help}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS DES CHAMPS
// Quand un champ change, on invalide les options des champs qui en
// dépendent (dependsOn) puis on re-render.
// ─────────────────────────────────────────────────────────

function bindFieldEvents(allFields, state, rerender) {
  const setValue = (key, value) => {
    if (state.values[key] === value) return;
    state.values[key] = value;
    invalidateDependents(key, allFields, state);
    rerender();
  };

  document.querySelectorAll('#imp-modal-body [data-key]').forEach(el => {
    const key  = el.dataset.key;
    const role = el.dataset.role;

    if (role === 'select') {
      el.addEventListener('change', () => {
        if (el.value === '__custom__') {
          state.customMode[key] = true;
          state.values[key] = '';
          invalidateDependents(key, allFields, state);
          rerender();
        } else {
          setValue(key, el.value);
        }
      });
    } else if (role === 'dynamic-select') {
      el.addEventListener('change', () => setValue(key, el.value));
    } else if (role === 'text' || role === 'custom-input') {
      const commit = () => setValue(key, el.value.trim());
      el.addEventListener('change', commit);
      el.addEventListener('blur',   commit);
    } else if (role === 'cancel-custom') {
      el.addEventListener('click', () => {
        state.customMode[key] = false;
        state.values[key] = '';
        invalidateDependents(key, allFields, state);
        rerender();
      });
    } else if (role === 'retry-load') {
      el.addEventListener('click', () => {
        delete state.errors[key];
        delete state.optionsCache[key];
        rerender();
      });
    }
  });
}

function invalidateDependents(changedKey, allFields, state) {
  for (const f of allFields) {
    if (f.type === 'dynamicSelect' && (f.dependsOn || []).includes(changedKey)) {
      delete state.optionsCache[f.key];
      delete state.errors[f.key];
      state.values[f.key] = '';
      // Cascade : tout ce qui dépendait de f doit aussi tomber
      invalidateDependents(f.key, allFields, state);
    }
  }
}

function triggerAsyncLoads(allFields, state, rerender) {
  for (const f of allFields) {
    if (f.type !== 'dynamicSelect') continue;
    const deps = f.dependsOn || [];
    if (!deps.every(d => state.values[d])) continue;

    const depsKey = JSON.stringify(deps.map(d => state.values[d]));
    const cached  = state.optionsCache[f.key];
    if (cached?.depsKey === depsKey)  continue;
    if (state.loading.has(f.key))     continue;
    if (state.errors[f.key])          continue;

    state.loading.add(f.key);
    const depsValues = Object.fromEntries(deps.map(d => [d, state.values[d]]));

    f.loadOptions(depsValues)
      .then(options => {
        state.optionsCache[f.key] = { depsKey, options: options || [] };
        state.loading.delete(f.key);
        rerender();
      })
      .catch(err => {
        state.errors[f.key] = err.message || String(err);
        state.loading.delete(f.key);
        rerender();
      });
  }
}

// ─────────────────────────────────────────────────────────
// ÉTAPE 2 — SÉLECTION DE LA SESSION DISTANTE
// ─────────────────────────────────────────────────────────

async function showSessionsStep({ ctx, provider, config }) {
  setBody(loadingHtml('Récupération des sessions…'));
  setFooter('');

  let sessions;
  try {
    sessions = await provider.listSessions(config);
  } catch (err) {
    setBody(errorHtml(err.message || String(err)));
    setFooter(`<button class="btn btn-secondary" id="imp-back">← Retour</button>`);
    document.getElementById('imp-back')?.addEventListener('click', () =>
      startImport(ctx)
    );
    return;
  }

  if (!sessions.length) {
    const cfgLines = Object.entries(config)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<li><code>${escHtml(k)}</code> = <code>${escHtml(String(v))}</code></li>`)
      .join('');

    const debug = sessions.debug || {};
    const rawJson = (() => {
      try { return JSON.stringify(debug.response ?? null, null, 2); }
      catch { return '[non sérialisable]'; }
    })();

    setBody(`
      <div class="config-test-error">
        <span>⚠️</span>
        <span>Aucune session trouvée pour cet événement.</span>
      </div>
      <div class="text-muted" style="font-size:0.82rem;margin-top:var(--sp-sm)">
        Configuration utilisée :
        <ul style="margin:4px 0 0 18px;padding:0">${cfgLines}</ul>
        <div style="margin-top:6px">
          Causes possibles : événement pas encore commencé,
          identifiants incorrects, ou session non publiée par le chronométreur.
        </div>
      </div>
      <details style="margin-top:var(--sp-sm);font-size:0.78rem">
        <summary style="cursor:pointer;user-select:none">🔧 Détails techniques (à copier en cas de support)</summary>
        ${debug.endpoint ? `<div style="margin-top:6px">Endpoint appelé : <code>${escHtml(debug.endpoint)}</code></div>` : ''}
        <div style="margin-top:6px">Réponse brute :</div>
        <pre style="max-height:240px;overflow:auto;background:rgba(0,0,0,0.2);padding:6px;border-radius:4px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,monospace;font-size:0.72rem">${escHtml(rawJson)}</pre>
        <button class="btn btn-secondary btn-sm" id="imp-copy-debug" type="button">📋 Copier</button>
      </details>
    `);
    setFooter(`<button class="btn btn-secondary" id="imp-back">← Retour</button>`);
    document.getElementById('imp-back')?.addEventListener('click', () => startImport(ctx));
    document.getElementById('imp-copy-debug')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rawJson);
        toast('Réponse copiée dans le presse-papier', 'success');
      } catch {
        toast('Impossible de copier — sélectionnez le texte manuellement', 'error');
      }
    });
    return;
  }

  // Pré-filtrer par catégorie ET (si possible) par type/num pour suggérer
  // automatiquement la bonne session distante.
  const matchingCategory = sessions.filter(s =>
    !s.category || (ctx.category && fuzzyMatch(s.category, ctx.category))
  );
  const matchingFull = matchingCategory.filter(s => {
    if (!s.type || !ctx.session?.type) return false;
    if (s.type !== ctx.session.type) return false;
    if (s.num != null && ctx.session.num != null && s.num !== ctx.session.num) return false;
    return true;
  });

  // Stratégie : si on a une correspondance exacte type+num+catégorie, on
  // affiche cette short-list ; sinon on retombe sur le filtre catégorie ;
  // sinon tout.
  const useFull     = matchingFull.length > 0 && matchingFull.length < sessions.length;
  const useCategory = !useFull && matchingCategory.length > 0 && matchingCategory.length < sessions.length;
  const list = useFull ? matchingFull : useCategory ? matchingCategory : sessions;
  const useFiltered = useFull || useCategory;

  const sessionLabel = ctx.session.type === 'MQ' ? `MQ${ctx.session.num}`
    : ctx.session.type === 'DF' ? `DF${ctx.session.num}`
    : ctx.session.type === 'QF' ? `QF${ctx.session.num}`
    : ctx.session.type;

  setBody(`
    <div style="margin-bottom:var(--sp-sm)" class="text-muted" style="font-size:0.82rem">
      Choisissez la session distante qui correspond à <strong>${escHtml(sessionLabel)} — ${escHtml(ctx.category)}</strong>.
      ${useFiltered ? '<br><span style="font-size:0.78rem">(filtré par catégorie — décochez ci-dessous pour tout voir)</span>' : ''}
    </div>
    ${useFiltered ? `<label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;margin-bottom:var(--sp-sm)">
      <input type="checkbox" id="imp-show-all"> Afficher toutes les sessions (${sessions.length})
    </label>` : ''}
    <div class="form-group">
      <label class="form-label">Session distante</label>
      <select class="form-select" id="imp-session-select" size="8" style="height:auto">
        ${list.map(s => `
          <option value="${escHtml(s.session_id)}">${escHtml(formatSessionLabel(s))}</option>
        `).join('')}
      </select>
    </div>
  `);

  setFooter(`
    <button class="btn btn-secondary" id="imp-back">← Retour</button>
    <button class="btn btn-primary" id="imp-next">Récupérer le classement →</button>
  `);

  document.getElementById('imp-show-all')?.addEventListener('change', e => {
    const sel = document.getElementById('imp-session-select');
    if (!sel) return;
    const newList = e.target.checked ? sessions : matchingCategory;
    sel.innerHTML = newList.map(s => `
      <option value="${escHtml(s.session_id)}">${escHtml(formatSessionLabel(s))}</option>
    `).join('');
  });

  document.getElementById('imp-back').addEventListener('click', () => startImport(ctx));
  document.getElementById('imp-next').addEventListener('click', () => {
    const sel = document.getElementById('imp-session-select');
    const sessionId = sel?.value;
    if (!sessionId) {
      toast('Sélectionnez une session distante', 'error');
      return;
    }
    showRankingStep({ ctx, provider, config, remoteSessionId: sessionId });
  });
}

function formatSessionLabel(s) {
  const parts = [];
  if (s.category) parts.push(s.category);
  if (s.name)     parts.push(s.name);
  else if (s.type) parts.push(s.num != null ? `${s.type}${s.num}` : s.type);
  parts.push(`#${s.session_id}`);
  return parts.join(' — ');
}

function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const norm = x => String(x).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ─────────────────────────────────────────────────────────
// ÉTAPE 3 — APERÇU + IMPORT
// ─────────────────────────────────────────────────────────

async function showRankingStep({ ctx, provider, config, remoteSessionId }) {
  setBody(loadingHtml('Récupération du classement…'));
  setFooter('');

  let rows;
  try {
    rows = await provider.getRanking({ ...config, session_id: remoteSessionId });
  } catch (err) {
    setBody(errorHtml(err.message || String(err)));
    setFooter(`<button class="btn btn-secondary" id="imp-back">← Retour</button>`);
    document.getElementById('imp-back')?.addEventListener('click', () =>
      showSessionsStep({ ctx, provider, config })
    );
    return;
  }

  if (!rows.length) {
    setBody(`
      <div class="config-test-error">
        <span>⚠️</span>
        <span>Le classement est vide pour cette session.</span>
      </div>
    `);
    setFooter(`<button class="btn btn-secondary" id="imp-back">← Retour</button>`);
    document.getElementById('imp-back')?.addEventListener('click', () =>
      showSessionsStep({ ctx, provider, config })
    );
    return;
  }

  // Mappage par numéro de voiture
  const byCarNumber = new Map(ctx.participants.map(p => [Number(p.carNumber), p]));
  const enriched = rows.map(r => {
    const local = byCarNumber.get(Number(r.carNumber));
    const importable = !!local && (r.time_ms || r.status);
    return { ...r, local, importable };
  });

  const matched   = enriched.filter(r => r.local).length;
  const unmatched = enriched.length - matched;

  setBody(`
    <div class="text-muted" style="font-size:0.82rem;margin-bottom:var(--sp-sm)">
      ${rows.length} ligne${rows.length > 1 ? 's' : ''} reçue${rows.length > 1 ? 's' : ''} —
      <strong style="color:var(--clr-success)">${matched}</strong> pilote${matched > 1 ? 's' : ''} reconnu${matched > 1 ? 's' : ''}
      ${unmatched ? ` · <strong style="color:var(--clr-warning)">${unmatched}</strong> non reconnu${unmatched > 1 ? 's' : ''}` : ''}.
      <br>Décochez les lignes que vous ne voulez pas importer. Les temps existants seront écrasés.
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center">Pos.</th>
          <th class="center">N°</th>
          <th>Pilote (RXChrono)</th>
          <th class="right">Temps</th>
          <th class="center">Statut</th>
          <th class="center">Importer</th>
        </tr></thead>
        <tbody>
          ${enriched.map((r, i) => rankingRowHtml(r, i)).join('')}
        </tbody>
      </table>
    </div>
  `);

  setFooter(`
    <button class="btn btn-secondary" id="imp-back">← Retour</button>
    <button class="btn btn-primary" id="imp-confirm">✅ Importer les temps cochés</button>
  `);

  document.getElementById('imp-back').addEventListener('click', () =>
    showSessionsStep({ ctx, provider, config })
  );

  document.getElementById('imp-confirm').addEventListener('click', async () => {
    const checks = [...document.querySelectorAll('.imp-row-check:checked')];
    if (!checks.length) {
      toast('Aucune ligne sélectionnée', 'warning');
      return;
    }

    const btn = document.getElementById('imp-confirm');
    btn.disabled = true;
    btn.textContent = '⏳ Import…';

    let imported = 0;
    let failed   = 0;
    for (const cb of checks) {
      const idx = parseInt(cb.dataset.idx, 10);
      const r = enriched[idx];
      if (!r?.local) continue;
      try {
        await ctx.saveResult(r.local.driverId, r.time_ms || null, r.status || null);
        imported++;
      } catch (err) {
        console.error('Import row failed:', r, err);
        failed++;
      }
    }

    closeModal();
    if (failed) {
      toast(`${imported} temps importé(s), ${failed} échec(s)`, 'warning', 5000);
    } else {
      toast(`${imported} temps importé(s) ✓`, 'success');
    }
    logAudit('import', 'results', ctx.session.id, {
      provider: provider.id,
      remoteSessionId,
      imported,
      failed,
      label: `Import ${provider.name} — ${ctx.session.label} ${ctx.category}`,
    });
  });
}

function rankingRowHtml(r, idx) {
  const remoteName = [r.firstName, r.lastName].filter(Boolean).join(' ');
  const localName  = r.local
    ? `<strong>${escHtml(r.local.firstName || '')} ${escHtml(r.local.lastName || '')}</strong>`
    : `<span class="text-muted">⚠️ N°${escHtml(r.carNumber)} non engagé${remoteName ? ` — ${escHtml(remoteName)} (provider)` : ''}</span>`;

  const timeCell = r.time_ms
    ? `<span class="tim-time">${escHtml(msToDisplay(r.time_ms))}</span>`
    : '<span class="text-muted">—</span>';

  const statusCell = r.status
    ? `<span class="badge badge-${r.status === 'DNF' ? 'dnf' : r.status === 'DNS' ? 'dns' : 'dsq'}">${escHtml(r.status)}</span>`
    : '<span class="text-muted">—</span>';

  const checkbox = r.importable
    ? `<input type="checkbox" class="imp-row-check" data-idx="${idx}" checked
         style="width:18px;height:18px;accent-color:var(--clr-accent)">`
    : '<span class="text-muted">—</span>';

  return `
    <tr ${!r.local ? 'class="photo-row-notfound"' : ''}>
      <td class="center">${r.position ?? idx + 1}</td>
      <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
      <td>${localName}</td>
      <td class="right">${timeCell}</td>
      <td class="center">${statusCell}</td>
      <td class="center">${checkbox}</td>
    </tr>
  `;
}
