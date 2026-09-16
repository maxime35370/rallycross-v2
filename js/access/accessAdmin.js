/* ═══════════════════════════════════════════════
   ACCESSADMIN.JS — Vue « Accès team » (régie uniquement).

   UN SEUL ÉCRAN, trois sections en cascade :
       Team  →  Membres  →  Licences

   Fonctionnel avant d'être joli, comme demandé : pas de filtre avancé, pas
   de tri, pas d'invitation par e-mail. Le parcours visé tient en trois
   clics, parce qu'il sera fait devant un team, en bord de piste.

   ── LA CONTRAINTE D'INTERFACE À NE PAS PERDRE DE VUE ───────────────────
   Lohéac 2026-08-30 existe en DEUX meetings : un en Championnat FFSA, un en
   Euro RX. Un sélecteur qui n'afficherait que « 30/08 Lohéac » rendrait les
   deux indiscernables, et on vendrait le mauvais droit sans jamais s'en
   apercevoir. Le championnat est donc affiché PARTOUT où un meeting
   apparaît : dans le sélecteur, dans la liste des licences, dans la
   confirmation.
═══════════════════════════════════════════════ */

import { db } from '../firebase.js';
import { toast } from '../app.js';
import { escHtml } from '../utils.js';
import { isAdmin } from '../auth.js';
import { logAudit } from '../audit.js';
import {
  listTeams, listAllUsers, listMembers, listLicensesOfTeam,
  createTeam, addMember, removeMember,
  grantLicense, setLicenseStatus, deleteLicense,
} from './licenses.js';
import { licenseValidity, scopeLabel, toMillis } from './licenseCalc.js';

const FS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────
// ÉTAT
// ─────────────────────────────────────────────────────────

let _initialised = false;
let loading = false;
let error = null;

let teams = [];
let users = [];
let persons = [];
let championships = [];
let meetings = [];

let selectedTeamId = '';
let members = [];
let licenses = [];

let personFilter = '';
let userFilter = '';
const form = {
  personId: '', championshipId: '', scope: 'meeting', meetingId: '',
  validFrom: '', validUntil: '', note: '',
};

const byId = (list) => Object.fromEntries(list.map(x => [x.id, x]));

// ─────────────────────────────────────────────────────────
// CHARGEMENT
// ─────────────────────────────────────────────────────────

/** Référentiels publics : personnes, championnats, meetings. */
async function loadReferentials() {
  const { collection, getDocs } = await import(FS);
  const [pSnap, cSnap, mSnap] = await Promise.all([
    getDocs(collection(db, 'persons')),
    getDocs(collection(db, 'championships')),
    getDocs(collection(db, 'meetings')),
  ]);
  persons = pSnap.docs.map(d => ({ ...d.data(), id: d.id }))
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'fr'));
  championships = cSnap.docs.map(d => ({ ...d.data(), id: d.id }))
    .sort((a, b) => (b.year - a.year) || (a.name || '').localeCompare(b.name || ''));
  meetings = mSnap.docs.map(d => ({ ...d.data(), id: d.id }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

async function loadAll() {
  if (!db) { error = 'Firebase non connecté.'; render(); return; }
  loading = true; error = null; render();
  try {
    await loadReferentials();
    teams = await listTeams();
    users = await listAllUsers();
    if (selectedTeamId && !teams.some(t => t.id === selectedTeamId)) selectedTeamId = '';
    if (!selectedTeamId && teams.length) selectedTeamId = teams[0].id;
    await loadTeamDetail();
  } catch (e) {
    console.error('[accessAdmin] chargement', e);
    error = e?.code === 'permission-denied'
      ? "Lecture refusée : ce compte n'est pas administrateur."
      : (e?.message || 'Erreur de chargement.');
  } finally {
    loading = false; render();
  }
}

async function loadTeamDetail() {
  if (!selectedTeamId) { members = []; licenses = []; return; }
  [members, licenses] = await Promise.all([
    listMembers(selectedTeamId),
    listLicensesOfTeam(selectedTeamId),
  ]);
  licenses.sort((a, b) => (toMillis(b.createdAt) ?? 0) - (toMillis(a.createdAt) ?? 0));
}

// ─────────────────────────────────────────────────────────
// LIBELLÉS — le championnat est toujours visible
// ─────────────────────────────────────────────────────────

function championshipName(id) {
  return championships.find(c => c.id === id)?.name || (id ? '(championnat inconnu)' : '—');
}

/** « 30/08/2026 · Lohéac — Championnat FFSA ». Jamais sans le championnat. */
function meetingLabel(m) {
  if (!m) return '—';
  const d = m.date ? m.date.split('-').reverse().join('/') : '?';
  return `${d} · ${m.location || m.id} — ${championshipName(m.championshipId)}`;
}

function personLabel(p) {
  if (!p) return '(fiche inconnue)';
  const flag = p.reviewFlag ? ' ⚠️' : '';
  return `${p.lastName || ''} ${p.firstName || ''}`.trim() + flag;
}

/**
 * Libellés des rôles.
 *
 * Les valeurs STOCKÉES restent `owner` et `member` : les règles Firestore
 * les valident telles quelles, et les renommer imposerait une migration
 * pour un gain nul.
 *
 * ⚠️ À ce stade, le rôle ne change RIEN. Ni les règles ni le contrôle
 * d'accès ne le consultent : `isTeamMember()` vérifie seulement l'existence
 * du rattachement. Responsable et Membre ont donc exactement les mêmes
 * droits — voir le même pilote, le même périmètre. Le champ est là pour le
 * jour où un responsable pourra gérer ses propres membres, ce qui suppose
 * le backend. L'interface le dit, plutôt que de laisser croire à une
 * hiérarchie qui n'existe pas.
 */
const ROLE_LABELS = { owner: 'Responsable', member: 'Membre' };
const roleLabel = (r) => ROLE_LABELS[r] || r || 'Membre';

const REVIEW_LABELS = {
  duplicate_candidate: 'Fiche marquée « doublon à vérifier »',
  test_record: 'Fiche marquée « enregistrement de test »',
};

function userLabel(u) {
  return u ? (u.email || u.id) : '(compte inconnu)';
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function render() {
  const view = document.getElementById('view-access');
  if (!view) return;

  if (!isAdmin()) {
    view.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">🔒</div>
      <div class="placeholder-title">Accès réservé à l'administrateur</div></div>`;
    return;
  }
  if (loading) {
    view.innerHTML = `<div class="loading-state"><div class="spinner"></div> Chargement…</div>`;
    return;
  }

  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🔑 Accès <span>team</span></h2>
    </div>
    ${error ? `<div class="acc-alert acc-alert--err">${escHtml(error)}</div>` : ''}
    ${renderTeamsSection()}
    ${selectedTeamId ? renderMembersSection() + renderLicensesSection() : ''}
  `;
  wire();
}

// ── 1 · TEAMS ───────────────────────────────────────────
function renderTeamsSection() {
  return `
    <div class="card mt-md">
      <div class="card-title">1 · Team</div>
      <div class="toolbar">
        <select class="toolbar-select" id="acc-team" style="flex:1;min-width:220px">
          ${teams.length ? '' : '<option value="">— aucun team —</option>'}
          ${teams.map(t => `<option value="${escHtml(t.id)}" ${t.id === selectedTeamId ? 'selected' : ''}>
            ${escHtml(t.name || t.id)}
          </option>`).join('')}
        </select>
      </div>
      <div class="form-row" style="align-items:flex-end;gap:var(--sp-sm);flex-wrap:wrap">
        <div class="form-group" style="flex:2;min-width:180px;margin:0">
          <label class="form-label" for="acc-new-team">Nouveau team</label>
          <input class="form-input" id="acc-new-team" placeholder="Nom du team">
        </div>
        <div class="form-group" style="flex:2;min-width:180px;margin:0">
          <label class="form-label" for="acc-new-team-mail">Contact (facultatif)</label>
          <input class="form-input" id="acc-new-team-mail" type="email" placeholder="contact@team.fr">
        </div>
        <button class="btn btn-secondary" id="acc-create-team">➕ Créer</button>
      </div>
    </div>`;
}

// ── 2 · MEMBRES ─────────────────────────────────────────
function renderMembersSection() {
  const usersById = byId(users);
  const memberUids = new Set(members.map(m => m.uid));
  const candidates = users.filter(u => !memberUids.has(u.id));

  const needle = userFilter.trim().toLowerCase();
  const proposes = needle
    ? candidates.filter(u => (u.email || '').toLowerCase().includes(needle))
    : [];

  const rows = members.length ? members.map(m => `
    <tr>
      <td>${escHtml(userLabel(usersById[m.uid]))}</td>
      <td>${escHtml(roleLabel(m.role))}</td>
      <td class="text-mono" style="font-size:.78rem">${escHtml(m.uid)}</td>
      <td style="text-align:right">
        <button class="btn btn-sm btn-danger" data-remove-member="${escHtml(m.uid)}">Retirer</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="4" class="table-empty">Aucun membre. Le team ne verra rien tant qu'aucun compte n'y est rattaché.</td></tr>`;

  return `
    <div class="card mt-md">
      <div class="card-title">2 · Membres — ${members.length}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Compte</th><th>Rôle</th><th>UID</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="form-row" style="align-items:flex-end;gap:var(--sp-sm);flex-wrap:wrap;margin-top:var(--sp-md)">
        <div class="form-group" style="flex:2;min-width:200px;margin:0">
          <label class="form-label" for="acc-user-filter">Rattacher un compte — chercher par adresse</label>
          <input class="form-input" id="acc-user-filter" placeholder="adresse e-mail du membre"
                 value="${escHtml(userFilter)}" autocomplete="off">
        </div>
        <div class="form-group" style="flex:2;min-width:200px;margin:0">
          <label class="form-label" for="acc-add-user">Compte trouvé</label>
          <select class="form-select" id="acc-add-user" ${proposes.length ? '' : 'disabled'}>
            <option value="">${needle
              ? (proposes.length ? '— choisir —' : '— aucun compte pour cette adresse —')
              : '— saisissez une adresse —'}</option>
            ${proposes.map(u => `<option value="${escHtml(u.id)}">${escHtml(userLabel(u))}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="flex:1;min-width:130px;margin:0">
          <label class="form-label" for="acc-add-role">Rôle</label>
          <select class="form-select" id="acc-add-role">
            <option value="member">Membre</option>
            <option value="owner">Responsable</option>
          </select>
        </div>
        <button class="btn btn-secondary" id="acc-add-member">➕ Rattacher</button>
      </div>
      <div class="acc-hint">
        <strong>Responsable</strong> et <strong>Membre</strong> ont aujourd'hui
        exactement les mêmes droits : voir le même pilote, sur le même périmètre.
        Le rôle n'est qu'une étiquette, conservée pour un usage futur.
        ${candidates.length ? '' : `<br>Aucun compte à rattacher : le team doit d'abord créer le sien depuis le menu « Connexion team ».`}
      </div>
    </div>`;
}

// ── 3 · LICENCES ────────────────────────────────────────
function renderLicensesSection() {
  const personsById = byId(persons);
  const meetingsById = byId(meetings);

  const rows = licenses.length ? licenses.map(l => {
    const v = licenseValidity(l, Date.now());
    const etat = l.status === 'active'
      ? (v.ok ? '<span class="text-success">active</span>'
              : `<span class="text-warning">${v.reason === 'expired' ? 'expirée' : 'hors période'}</span>`)
      : `<span class="text-danger">${l.status === 'revoked' ? 'révoquée' : 'suspendue'}</span>`;
    const p = personsById[l.personId];
    const until = toMillis(l.validUntil);
    return `
      <tr>
        <td>${escHtml(personLabel(p))}</td>
        <td>${escHtml(scopeLabel(l, {
          championshipLabel: championshipName(l.championshipId),
          meetingLabel: l.meetingId ? meetingLabel(meetingsById[l.meetingId]) : null,
        }))}</td>
        <td>${etat}</td>
        <td style="font-size:.8rem">${until ? new Date(until).toLocaleDateString('fr-FR') : 'sans échéance'}</td>
        <td style="font-size:.8rem">${escHtml(l.origin || '')}</td>
        <td style="text-align:right;white-space:nowrap">
          ${l.status === 'active'
            ? `<button class="btn btn-sm btn-secondary" data-lic-suspend="${escHtml(l.id)}">Suspendre</button>`
            : `<button class="btn btn-sm btn-secondary" data-lic-activate="${escHtml(l.id)}">Réactiver</button>`}
          <button class="btn btn-sm btn-danger" data-lic-revoke="${escHtml(l.id)}">Révoquer</button>
        </td>
      </tr>`;
  }).join('')
    : `<tr><td colspan="6" class="table-empty">Aucune licence pour ce team.</td></tr>`;

  const needle = personFilter.trim().toLowerCase();
  const shown = needle
    ? persons.filter(p => `${p.firstName || ''} ${p.lastName || ''}`.toLowerCase().includes(needle))
    : persons;
  const selectedPerson = persons.find(p => p.id === form.personId);

  // Meetings du championnat choisi : le sélecteur ne propose jamais un
  // meeting d'un autre championnat, ce qui rendrait la licence incohérente.
  const meetingsOfChamp = form.championshipId
    ? meetings.filter(m => m.championshipId === form.championshipId)
    : [];

  return `
    <div class="card mt-md">
      <div class="card-title">3 · Licences — ${licenses.length}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Fiche pilote</th><th>Périmètre</th><th>État</th><th>Échéance</th><th>Origine</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div class="acc-grant">
        <div class="card-title" style="margin-top:0">Attribuer une licence</div>

        <div class="form-row" style="gap:var(--sp-sm);flex-wrap:wrap">
          <div class="form-group" style="flex:1;min-width:200px">
            <label class="form-label" for="acc-person-filter">Chercher une fiche pilote</label>
            <input class="form-input" id="acc-person-filter" placeholder="Nom ou prénom" value="${escHtml(personFilter)}">
          </div>
          <div class="form-group" style="flex:2;min-width:240px">
            <label class="form-label" for="acc-person">Fiche pilote — ${shown.length} sur ${persons.length}</label>
            <select class="form-select" id="acc-person">
              <option value="">— choisir —</option>
              ${shown.map(p => `<option value="${escHtml(p.id)}" ${p.id === form.personId ? 'selected' : ''}>
                ${escHtml(personLabel(p))}
              </option>`).join('')}
            </select>
          </div>
        </div>

        ${selectedPerson?.reviewFlag ? `
          <div class="acc-alert acc-alert--warn">
            ⚠️ ${escHtml(REVIEW_LABELS[selectedPerson.reviewFlag] || 'Fiche marquée à vérifier')}.
            Vérifiez qu'il s'agit bien de la bonne personne avant d'attribuer un accès.
          </div>` : ''}
        ${selectedPerson ? renderPersonScope(selectedPerson) : ''}

        <div class="form-row" style="gap:var(--sp-sm);flex-wrap:wrap">
          <div class="form-group" style="flex:2;min-width:220px">
            <label class="form-label" for="acc-champ">Championnat</label>
            <select class="form-select" id="acc-champ">
              <option value="">— choisir —</option>
              ${championships.map(c => `<option value="${escHtml(c.id)}" ${c.id === form.championshipId ? 'selected' : ''}>
                ${escHtml(c.name || c.id)} · ${escHtml(String(c.year || ''))}
              </option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="flex:1;min-width:170px">
            <label class="form-label" for="acc-scope">Portée</label>
            <select class="form-select" id="acc-scope">
              <option value="meeting" ${form.scope === 'meeting' ? 'selected' : ''}>Pass MEETING</option>
              <option value="season"  ${form.scope === 'season'  ? 'selected' : ''}>Pass SAISON</option>
            </select>
          </div>
        </div>

        ${form.scope === 'meeting' ? `
          <div class="form-group">
            <label class="form-label" for="acc-meeting">Meeting — le championnat est rappelé sur chaque ligne</label>
            <select class="form-select" id="acc-meeting" ${form.championshipId ? '' : 'disabled'}>
              <option value="">${form.championshipId ? '— choisir —' : "— choisissez d'abord un championnat —"}</option>
              ${meetingsOfChamp.map(m => `<option value="${escHtml(m.id)}" ${m.id === form.meetingId ? 'selected' : ''}>
                ${escHtml(meetingLabel(m))}
              </option>`).join('')}
            </select>
          </div>` : `
          <div class="acc-hint">
            Le pass saison couvrira <strong>tous les meetings de ${escHtml(championshipName(form.championshipId))}</strong>
            — et aucun meeting d'un autre championnat, même à la même date.
          </div>`}

        <div class="form-row" style="gap:var(--sp-sm);flex-wrap:wrap">
          <div class="form-group" style="flex:1;min-width:150px">
            <label class="form-label" for="acc-from">Début (facultatif)</label>
            <input class="form-input" type="date" id="acc-from" value="${escHtml(form.validFrom)}">
          </div>
          <div class="form-group" style="flex:1;min-width:150px">
            <label class="form-label" for="acc-until">Échéance (facultatif)</label>
            <input class="form-input" type="date" id="acc-until" value="${escHtml(form.validUntil)}">
          </div>
          <div class="form-group" style="flex:2;min-width:200px">
            <label class="form-label" for="acc-note">Note</label>
            <input class="form-input" id="acc-note" placeholder="démo Lohéac, offert…" value="${escHtml(form.note)}">
          </div>
        </div>

        <div class="acc-summary">${renderSummary()}</div>
        <button class="btn btn-primary" id="acc-grant">🔑 Attribuer la licence</button>
      </div>
    </div>`;
}

/**
 * Rappelle les inscriptions rattachées à la fiche choisie.
 *
 * C'est ce qui rend visible, AU MOMENT DE VENDRE, ce que la licence
 * couvrira réellement — et ce qu'elle ne couvrira pas. Onze des douze
 * pilotes à inscriptions multiples courent dans deux championnats : sans
 * ce rappel, on croit vendre « le pilote » alors qu'on vend « le pilote
 * dans un championnat ».
 */
function renderPersonScope(person) {
  const champById = byId(championships);
  const inscriptions = _driversByPerson.get(person.id) || [];
  if (!inscriptions.length) {
    return `<div class="acc-hint">Aucune inscription sportive rattachée à cette fiche.</div>`;
  }
  return `
    <div class="acc-hint">
      Inscriptions rattachées :
      ${inscriptions.map(d => `<span class="badge">#${escHtml(String(d.carNumber))} ${escHtml(d.category || '')}
        · ${escHtml(champById[d.championshipId]?.name || '?')} ${escHtml(String(d.year || ''))}</span>`).join(' ')}
    </div>`;
}

function renderSummary() {
  const p = persons.find(x => x.id === form.personId);
  if (!p || !form.championshipId) return '<span class="text-muted">Complétez la fiche pilote et le championnat.</span>';
  if (form.scope === 'meeting' && !form.meetingId) return '<span class="text-muted">Choisissez le meeting.</span>';
  const perimetre = form.scope === 'season'
    ? `toute la saison ${escHtml(championshipName(form.championshipId))}`
    : escHtml(meetingLabel(meetings.find(m => m.id === form.meetingId)));
  const team = teams.find(t => t.id === selectedTeamId);
  return `<strong>${escHtml(team?.name || '')}</strong> obtiendra l'accès Stratégie Live
          pour <strong>${escHtml(personLabel(p))}</strong> sur ${perimetre}.`;
}

// ─────────────────────────────────────────────────────────
// INSCRIPTIONS PAR FICHE — chargé une fois
// ─────────────────────────────────────────────────────────

let _driversByPerson = new Map();

async function loadDriversByPerson() {
  const { collection, getDocs } = await import(FS);
  const snap = await getDocs(collection(db, 'drivers'));
  const map = new Map();
  snap.docs.forEach(d => {
    const data = d.data();
    if (!data.personId) return;
    if (!map.has(data.personId)) map.set(data.personId, []);
    map.get(data.personId).push({ id: d.id, ...data });
  });
  _driversByPerson = map;
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function wire() {
  const $ = (id) => document.getElementById(id);

  $('acc-team')?.addEventListener('change', async (e) => {
    selectedTeamId = e.target.value;
    loading = true; render();
    try { await loadTeamDetail(); } catch (err) { console.error(err); }
    loading = false; render();
  });

  $('acc-create-team')?.addEventListener('click', () => guard(async () => {
    const name = $('acc-new-team')?.value?.trim();
    if (!name) { toast('Nom du team requis.', 'error'); return; }
    const id = await createTeam({ name, contactEmail: $('acc-new-team-mail')?.value || '' });
    logAudit('create', 'team', id, { label: name });
    selectedTeamId = id;
    toast('Team créé ✓', 'success');
    await loadAll();
  }));

  $('acc-add-member')?.addEventListener('click', () => guard(async () => {
    const uid = $('acc-add-user')?.value;
    if (!uid) { toast('Choisissez un compte.', 'error'); return; }
    await addMember({ teamId: selectedTeamId, uid, role: $('acc-add-role')?.value || 'member' });
    logAudit('create', 'teamMember', `${selectedTeamId}_${uid}`, { label: uid });
    toast('Membre rattaché ✓', 'success');
    userFilter = '';
    await loadTeamDetail(); render();
  }));

  document.querySelectorAll('[data-remove-member]').forEach(b => {
    b.addEventListener('click', () => guard(async () => {
      const uid = b.dataset.removeMember;
      if (!window.confirm('Retirer ce membre du team ?\n\nIl perdra l\'accès aux licences du team.')) return;
      await removeMember({ teamId: selectedTeamId, uid });
      logAudit('delete', 'teamMember', `${selectedTeamId}_${uid}`, { label: uid });
      toast('Membre retiré ✓', 'success');
      await loadTeamDetail(); render();
    }));
  });

  // ── Formulaire de licence : chaque champ re-rend, pour que le
  //    sélecteur de meeting suive le championnat et que le récapitulatif
  //    reste exact.
  const bind = (id, key, extra) => $(id)?.addEventListener('change', (e) => {
    form[key] = e.target.value;
    extra?.();
    render();
  });
  bind('acc-person', 'personId');
  bind('acc-champ', 'championshipId', () => { form.meetingId = ''; });
  bind('acc-scope', 'scope', () => { if (form.scope === 'season') form.meetingId = ''; });
  bind('acc-meeting', 'meetingId');
  bind('acc-from', 'validFrom');
  bind('acc-until', 'validUntil');
  $('acc-note')?.addEventListener('input', (e) => { form.note = e.target.value; });
  // Les deux champs de recherche reconstruisent la vue : on leur rend le
  // focus et le curseur, sinon on ne peut pas taper deux caractères de suite.
  const bindFiltre = (id, set) => $(id)?.addEventListener('input', (e) => {
    set(e.target.value);
    render();
    const el = document.getElementById(id);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
  bindFiltre('acc-person-filter', v => { personFilter = v; });
  bindFiltre('acc-user-filter',   v => { userFilter = v; });

  $('acc-grant')?.addEventListener('click', () => guard(async () => {
    if (!form.personId || !form.championshipId) { toast('Fiche pilote et championnat requis.', 'error'); return; }
    if (form.scope === 'meeting' && !form.meetingId) { toast('Choisissez le meeting.', 'error'); return; }

    const champ = championships.find(c => c.id === form.championshipId);
    const meeting = meetings.find(m => m.id === form.meetingId);
    // L'année vient du MEETING quand il y en a un, du championnat sinon :
    // c'est le meeting qui fait foi sur la saison réellement couverte.
    const year = Number(meeting?.year ?? champ?.year);
    if (!Number.isInteger(year)) { toast('Année introuvable pour ce périmètre.', 'error'); return; }

    const fiche = persons.find(p => p.id === form.personId);
    const id = await grantLicense({
      teamId: selectedTeamId, personId: form.personId,
      scope: form.scope, championshipId: form.championshipId, year,
      meetingId: form.scope === 'meeting' ? form.meetingId : null,
      validFrom: form.validFrom || null, validUntil: form.validUntil || null,
      note: form.note,
      // Libellés figés à l'attribution : voir la note dans licenses.js.
      personLabel: `${fiche?.firstName || ''} ${fiche?.lastName || ''}`.trim(),
      championshipLabel: championshipName(form.championshipId),
      meetingLabel: form.scope === 'meeting' ? meetingLabel(meeting) : '',
    });
    logAudit('create', 'license', id, {
      label: `${personLabel(persons.find(p => p.id === form.personId))} · ${form.scope} · ${championshipName(form.championshipId)}`,
    });
    toast('Licence attribuée ✓', 'success');
    form.personId = ''; form.meetingId = ''; form.note = '';
    await loadTeamDetail(); render();
  }));

  const changeStatus = (attr, status, question) => {
    document.querySelectorAll(`[${attr}]`).forEach(b => {
      b.addEventListener('click', () => guard(async () => {
        if (question && !window.confirm(question)) return;
        await setLicenseStatus({ licenseId: b.getAttribute(attr), status });
        logAudit('update', 'license', b.getAttribute(attr), { label: status });
        toast(`Licence ${status === 'active' ? 'réactivée' : status === 'revoked' ? 'révoquée' : 'suspendue'} ✓`, 'success');
        await loadTeamDetail(); render();
      }));
    });
  };
  changeStatus('data-lic-suspend', 'suspended');
  changeStatus('data-lic-activate', 'active');
  changeStatus('data-lic-revoke', 'revoked',
    "Révoquer cette licence ?\n\nL'accès est coupé immédiatement pour tous les membres du team.");
}

/** Enveloppe commune : une écriture refusée doit dire pourquoi. */
function guard(fn) {
  return fn().catch(e => {
    console.error('[accessAdmin]', e);
    toast(e?.code === 'permission-denied'
      ? "Écriture refusée par les règles Firestore."
      : (e?.message || 'Erreur.'), 'error');
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

let _dataLoaded = false;
let _visible = false;

async function open() {
  if (!isAdmin()) { _dataLoaded = false; render(); return; }
  await loadAll();
  try { await loadDriversByPerson(); render(); } catch (err) { console.error(err); }
  _dataLoaded = true;
}

export function initAccessAdmin() {
  if (_initialised) return;
  _initialised = true;

  document.addEventListener('viewchange', async (e) => {
    _visible = e.detail?.view === 'access';
    if (!_visible) return;
    await open();
  });

  // ── Le cas qui casse si on l'oublie ──────────────────────────────────
  // Sur un accès DIRECT par lien (#access), la vue s'initialise AVANT que
  // Firebase ait restauré la session : isAdmin() est encore faux, l'écran
  // affiche « réservé à l'administrateur », et il y resterait. Quand la
  // session arrive, il ne suffit pas de re-rendre — il faut charger les
  // données, qui ne l'ont jamais été.
  document.addEventListener('authchange', () => {
    if (!_visible) return;
    if (isAdmin() && !_dataLoaded) { open(); return; }
    if (!isAdmin()) { _dataLoaded = false; }
    render();
  });
}
