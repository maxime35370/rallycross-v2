/* ═══════════════════════════════════════════════
   CHAMPIONSHIPTITLE.JS — Scénarios de titre à partir des meetings restants

   Module PUR (ni Firebase, ni DOM) : il reçoit le classement saison déjà
   calculé par championship.js, la liste des meetings de la saison et le
   règlement actif, et en déduit ce qui reste mathématiquement possible :

     • combien de points sont encore en jeu (meetings restants × maximum
       qu'un pilote peut marquer sur un meeting, lu dans le barème) ;
     • si le leader est déjà sacré, ou ne peut plus être qu'égalé ;
     • ce que le leader doit reprendre à chaque poursuivant lors du prochain
       meeting pour être sacré à son issue, et le score qui le sacre quoi
       qu'il arrive ;
     • le premier meeting où le titre peut se décider ;
     • pour chaque pilote, son total maximal atteignable et sa situation
       (encore en course, ne peut plus qu'égaler, éliminé).

   Le raisonnement ne fait AUCUNE hypothèse sur la forme des pilotes : un
   scénario n'est affirmé que s'il tient dans le pire des cas (le poursuivant
   marque le maximum, le leader ne marque rien). Il ignore le décompte du
   plus mauvais résultat (worstResultDrop), comme le classement lui-même.

   Les résultats de deux pilotes ne sont pas indépendants : dans une phase
   COUPLÉE (classement intermédiaire, finale — une seule course pour tout le
   monde), si le leader est premier, son rival est au mieux deuxième. Les
   ½ finales (et ¼ de finale) sont au contraire indépendantes : chacun peut
   gagner la sienne. Les « garanties » du leader (ce que ses propres
   résultats lui assurent, quoi que fasse le rival) en tiennent compte : en
   gagnant tout, un leader FFSA ne reprend que (16−15) + (15−12) = 4 points
   garantis, alors qu'un rival peut lui en reprendre 41 s'il ne marque rien.
═══════════════════════════════════════════════ */

import { escHtml } from './utils.js';
import { interimPoints, qfPoints, dfPoints, finPoints } from './calc.js';
import { weekendPhases, PHASE_DEFS, meetingShortLabel } from './championshipChart.js';

/** Positions explorées pour trouver le maximum d'un barème (formule libre). */
const SCAN_POSITIONS = 40;

// ─────────────────────────────────────────────────────────
// MAXIMUM PAR MEETING
// ─────────────────────────────────────────────────────────

/** Points maximaux d'un barème : le max sur les 40 premières positions. */
function scaleMax(fn) {
  let best = 0;
  for (let pos = 1; pos <= SCAN_POSITIONS; pos++) best = Math.max(best, Number(fn(pos)) || 0);
  return best;
}

/**
 * Maximum de points qu'un pilote peut marquer sur UN meeting, phase par phase.
 *
 * Les phases retenues sont celles du règlement (FFSA : intermédiaire, ½
 * finale, finale ; FIA : ¼ de finale, ½ finale, finale), complétées par
 * toute phase où quelqu'un a déjà marqué cette saison — même logique que le
 * graphique d'évolution. Un pilote ne dispute qu'une ½ finale : le maximum
 * de la phase est donc celui d'une seule course.
 *
 * @param {object|null} regulation
 * @param {Array} [meetingRows] — détails { interim, qf, df, fin } observés
 * @returns {{ total:number, phases:Array<{key:string,label:string,max:number}> }}
 */
export function maxMeetingPoints(regulation, meetingRows = []) {
  const fns = {
    interim: p => interimPoints(p, regulation),
    qf:      p => qfPoints(p, regulation),
    df:      p => dfPoints(p, regulation),
    fin:     p => finPoints(p, regulation),
  };
  // Nombre de courses de la phase : autant de « premières places »
  // disponibles. Le classement intermédiaire et la finale n'en ont qu'une ;
  // les ¼ et ½ finales en ont plusieurs (chacun peut gagner la sienne).
  const cfg = regulation?.sessionConfig || {};
  const racesOf = {
    interim: 1,
    fin:     1,
    qf:      Math.max(1, Number(cfg.QF?.count) || 4),
    df:      Math.max(1, Number(cfg.DF?.count) || 2),
  };
  // Qualifiés par course vers la phase suivante : seuls les `qualifiedPerRace`
  // premiers d'une ½ finale disputent la finale (et marquent ses points).
  const qualifiedOf = {
    qf: Math.max(1, Number(cfg.QF?.qualifiedPerQF) || 3),
    df: Math.max(1, Number(cfg.DF?.qualifiedPerDF) || 4),
  };
  // Phase dont il faut sortir qualifié pour disputer celle-ci.
  const feederOf = { df: 'qf', fin: 'df' };
  const phases = weekendPhases(regulation, meetingRows)
    .map(key => {
      const max = scaleMax(fns[key]);
      const races = racesOf[key];
      // Phase couplée : leader et rival y disputent la même course.
      const coupled = races === 1;
      // Gain garanti sur le rival si le leader gagne la phase : le rival est
      // alors au mieux deuxième.
      const delta = coupled ? Math.max(0, max - (Number(fns[key](2)) || 0)) : 0;
      return {
        key, label: PHASE_DEFS[key].short, max, races, coupled, delta, fn: fns[key],
        qualifiedPerRace: qualifiedOf[key] ?? null, feeder: feederOf[key] ?? null,
      };
    })
    .filter(ph => ph.max > 0);
  return {
    total: phases.reduce((s, ph) => s + ph.max, 0),
    phases,
    // Gain maximal que le leader peut GARANTIR sur un rival en un meeting
    // (en gagnant toutes les phases couplées).
    guaranteedSwing: phases.reduce((s, ph) => s + ph.delta, 0),
  };
}

/**
 * Un pilote sort-il qualifié d'une phase (ex. ½ finale) d'après ses points ?
 * Le barème étant décroissant, il est qualifié s'il a au moins les points de
 * la dernière place qualificative — et en a marqué (un DNF sans points ne
 * se qualifie pas).
 */
export function qualifiesFrom(feederPhase, feederPts) {
  const pts = Number(feederPts) || 0;
  if (pts <= 0 || !feederPhase?.qualifiedPerRace) return false;
  return pts >= (Number(feederPhase.fn(feederPhase.qualifiedPerRace)) || 0);
}

/**
 * Conditions suffisantes, sur les seuls résultats du leader, pour reprendre
 * au moins `need` points à un rival sur un meeting (need peut être négatif :
 * le leader peut alors en céder). Le rival est supposé faire le maximum
 * compatible avec les résultats du leader.
 *
 * Chaque palier ajoute une phase couplée gagnée (la plus rentable d'abord)
 * et donne le score total minimal à marquer. Un palier n'est retenu que s'il
 * abaisse le score exigé par rapport au précédent.
 *
 * Le leader et le rival peuvent avoir des phases différentes (meeting en
 * cours : l'un qualifié pour la finale, l'autre non). Seules les phases
 * couplées communes créent une garantie.
 *
 * @param {number} need
 * @param {{ total:number, phases:Array }} leaderScale — phases où le leader peut encore marquer
 * @param {{ total:number, phases:Array }} [rivalScale] — idem pour le rival (défaut : les mêmes)
 * @returns {Array<{ wins:string[], score:number, winsSuffice:boolean }>}
 */
export function guaranteeTiers(need, leaderScale, rivalScale = leaderScale) {
  const L = leaderScale.total;
  const rivalKeys = new Set(rivalScale.phases.map(ph => ph.key));
  const coupled = leaderScale.phases
    .filter(ph => ph.delta > 0 && rivalKeys.has(ph.key))
    .sort((a, b) => b.delta - a.delta);
  const tiers = [];
  let rivalMax = rivalScale.total, winsPts = 0, lastScore = Infinity;
  for (let j = 0; j <= coupled.length; j++) {
    if (j > 0) { rivalMax -= coupled[j - 1].delta; winsPts += coupled[j - 1].max; }
    const raw   = need + rivalMax;
    const score = Math.max(raw, winsPts, 0);
    if (score > L || score >= lastScore) continue;
    tiers.push({ wins: coupled.slice(0, j).map(ph => ph.key), score, winsSuffice: raw <= winsPts });
    lastScore = score;
  }
  return tiers;
}

// ─────────────────────────────────────────────────────────
// SCÉNARIO IDÉAL D'UN PRÉTENDANT (places partagées entre prétendants)
// ─────────────────────────────────────────────────────────

/**
 * Position obtenue par le k-ième pilote (k à partir de 0) d'une phase qui
 * compte `races` courses : les premières places de chaque course partent
 * d'abord, puis les deuxièmes, etc. Deux ½ finales → les deux premiers
 * pilotes gagnent chacun la leur, les deux suivants sont deuxièmes.
 */
export function slotPosition(k, races) {
  return Math.floor(k / Math.max(1, races)) + 1;
}

/**
 * Scénario idéal d'un prétendant : il gagne toutes les phases, et les AUTRES
 * prétendants prennent les places suivantes disponibles, dans l'ordre du
 * classement actuel (le plus menaçant d'abord). Une place n'est prise que
 * par un seul pilote : quatre prétendants ne peuvent pas tous gagner la
 * finale. Les pilotes hors liste ne marquent pas.
 *
 * Le scénario est projeté sur le prochain pas (le prochain meeting entier,
 * ou les phases restantes du meeting en cours), puis répété à l'identique
 * sur tous les meetings complets qui suivent : si un pilote n'est pas
 * champion même ainsi, aucun scénario où il gagne tout ne le sacre.
 *
 * @param {number} focusIndex — index du prétendant dans `contenders`
 * @param {Array}  contenders — [{ driverId, points, … }] triés par points décroissants
 * @param {{ phases:Array, total:number }} perMeeting — sortie de maxMeetingPoints()
 * Une place n'est attribuée que si le pilote peut la disputer : seuls les
 * qualifiés d'une ½ finale (les `qualifiedPerRace` premiers) courent la
 * finale, les autres n'y marquent rien. Sur un meeting en cours, un pilote
 * peut porter `stepKeys` : les phases où il peut encore marquer (déjà
 * éliminé en ½ finale → pas de finale ; non engagé → rien).
 *
 * @param {number} meetingsAfter — meetings complets restant APRÈS le prochain pas
 * @param {Array}  [nextPhases] — phases du prochain pas (défaut : meeting entier)
 */
export function idealScenario(focusIndex, contenders, perMeeting, meetingsAfter, nextPhases = perMeeting.phases) {
  const focus = contenders[focusIndex];
  const order = [focus, ...contenders.filter((_, i) => i !== focusIndex)];

  /**
   * Attribue les places d'un pas à tous les pilotes de `order`, phase après
   * phase : chaque phase distribue ses places aux seuls pilotes éligibles,
   * dans l'ordre. Retourne, par pilote, la liste des places.
   */
  const assign = (phases, useStepKeys) => {
    const byDriver = order.map(() => []);
    phases.forEach(ph => {
      const feeder = ph.feeder ? phases.find(p => p.key === ph.feeder) : null;
      let k = 0;
      order.forEach((d, i) => {
        let eligible = !useStepKeys || !d.stepKeys || d.stepKeys.includes(ph.key);
        if (eligible && feeder) {
          const prev = byDriver[i].find(pl => pl.key === feeder.key);
          eligible = prev?.pos != null && prev.pos <= feeder.qualifiedPerRace;
        }
        const pos = eligible ? slotPosition(k++, ph.races) : null;
        byDriver[i].push({ key: ph.key, label: ph.label, pos, pts: pos ? (Number(ph.fn(pos)) || 0) : 0 });
      });
    });
    return byDriver;
  };
  const sum = places => places.reduce((s, pl) => s + pl.pts, 0);
  const nextPlaces = assign(nextPhases, true);
  const fullPlaces = meetingsAfter > 0 ? assign(perMeeting.phases, false) : null;

  const rows = order.map((d, i) => {
    const places = nextPlaces[i];
    const meetingPts = sum(places);
    const fullPts = fullPlaces ? sum(fullPlaces[i]) : 0;
    return {
      driverId: d.driverId, firstName: d.firstName, lastName: d.lastName,
      places, meetingPts,
      afterNext:   d.points + meetingPts,
      afterSeason: d.points + meetingPts + fullPts * meetingsAfter,
    };
  });
  const me = rows[0], others = rows.slice(1);
  const leftAfterNext = meetingsAfter * perMeeting.total;
  const bestOther = key => others.length ? Math.max(...others.map(r => r[key])) : -Infinity;
  const rankOf = key => 1 + others.filter(r => r[key] > me[key]).length;
  const gapNext   = others.length ? me.afterNext   - bestOther('afterNext')   : null;
  const gapSeason = others.length ? me.afterSeason - bestOther('afterSeason') : null;
  return {
    rows,
    next: {
      total: me.afterNext, rank: rankOf('afterNext'), gap: gapNext,
      // Sacré à l'issue du prochain meeting dans ce scénario.
      clinched: gapNext == null ? true : gapNext > leftAfterNext,
    },
    season: {
      total: me.afterSeason, rank: rankOf('afterSeason'), gap: gapSeason,
      champion: gapSeason == null ? true : gapSeason > 0,
      tie: gapSeason === 0,
    },
  };
}

// ─────────────────────────────────────────────────────────
// MEETINGS RESTANTS
// ─────────────────────────────────────────────────────────

/**
 * Sépare les meetings de la saison selon les points déjà attribués :
 *   • restants   : aucun pilote n'y a marqué (pas encore couru) ;
 *   • en cours   : des points existent mais aucune finale n'a marqué ;
 *   • terminés   : au moins un pilote y a des points de finale.
 *
 * Un meeting en cours est compté avec ses points actuels, et porte la liste
 * des phases où quelqu'un a déjà marqué (`scoredPhases`) : les autres phases
 * restent à distribuer et comptent dans les points en jeu. C'est ce qui
 * permet de dire, après les manches et le classement intermédiaire, si un
 * champion peut déjà être déclaré : il reste alors ½ finale et finale.
 *
 * @param {Array} standings — sortie de calcChampionship()
 * @param {Array} meetings  — meetings de la saison, ordre chronologique
 */
export function splitMeetings(standings, meetings) {
  const remaining = [], inProgress = [], played = [];
  const PHASES = ['interim', 'qf', 'df', 'fin'];
  for (const m of meetings) {
    const scored = standings.some(d => d.meetingPts?.[m.id] != null);
    if (!scored) { remaining.push(m); continue; }
    const scoredPhases = PHASES.filter(key => standings.some(d => (Number(d.meetingDetail?.[m.id]?.[key]) || 0) > 0));
    if (scoredPhases.includes('fin')) played.push(m);
    else inProgress.push({ ...m, scoredPhases });
  }
  return { remaining, inProgress, played };
}

// ─────────────────────────────────────────────────────────
// SCÉNARIOS
// ─────────────────────────────────────────────────────────

/**
 * Construit les scénarios de titre.
 *
 * @param {object} p
 * @param {Array}  p.standings   — sortie de calcChampionship(), triée par total
 * @param {Array}  p.meetings    — meetings de la saison, ordre chronologique
 * @param {object|null} p.regulation
 * @returns {object|null} null si aucun classement
 */
export function buildTitleScenarios({ standings = [], meetings = [], regulation = null } = {}) {
  if (!standings.length) return null;

  const allRows = standings.flatMap(d => Object.values(d.meetingDetail || {}));
  const perMeeting = maxMeetingPoints(regulation, allRows);
  const M = perMeeting.total;
  const { remaining, inProgress, played } = splitMeetings(standings, meetings);
  const N = remaining.length;

  // Meeting en cours : ses phases non encore courues restent en jeu. S'il y
  // en a plusieurs (saisie incohérente), le plus récent est le « pas » à
  // venir, les autres comptent seulement dans les points en jeu.
  const unscoredOf = m => perMeeting.phases.filter(ph => !m.scoredPhases.includes(ph.key));
  const inProgressLeft = inProgress.reduce((s, m) => s + unscoredOf(m).reduce((t, ph) => t + ph.max, 0), 0);
  const current = [...inProgress].reverse().find(m => unscoredOf(m).length) || null;
  const currentPhases = current ? unscoredOf(current) : [];
  const currentLeft = currentPhases.reduce((s, ph) => s + ph.max, 0);
  const pointsLeft = N * M + inProgressLeft;

  // Phases du meeting en cours où CE pilote peut encore marquer : il doit y
  // être engagé, et sorti qualifié de la phase précédente si elle est déjà
  // courue (seul le top 4 d'une ½ finale marque en finale).
  const currentPhasesFor = d => {
    if (!current) return [];
    const row = d.meetingDetail?.[current.id];
    if (!row) return [];
    return currentPhases.filter(ph => {
      const feeder = ph.feeder ? perMeeting.phases.find(p => p.key === ph.feeder) : null;
      if (!feeder || !current.scoredPhases.includes(feeder.key)) return true;
      return qualifiesFrom(feeder, row[feeder.key]);
    });
  };

  const leader = standings[0];
  const pL = Number(leader.grandTotal) || 0;
  const second = standings[1] || null;
  const gap = second ? pL - (Number(second.grandTotal) || 0) : null;

  // Situation de chaque pilote face au leader.
  const drivers = standings.map((d, i) => {
    const pts = Number(d.grandTotal) || 0;
    const deficit = pL - pts;
    const stepPhases = currentPhasesFor(d);
    const stepStake = stepPhases.reduce((s, ph) => s + ph.max, 0);
    // Ce que ce pilote peut encore marquer d'ici la fin de saison.
    const pointsLeftFor = pointsLeft - currentLeft + stepStake;
    const maxReachable = pts + pointsLeftFor;
    let state;
    if (i === 0)                       state = 'leader';
    else if (maxReachable < pL)        state = 'eliminated';
    else if (maxReachable === pL)      state = 'tie_only';
    else                               state = 'contender';
    return {
      driverId: d.driverId, carNumber: d.carNumber, firstName: d.firstName, lastName: d.lastName,
      position: d.position ?? i + 1, points: pts, deficit, maxReachable, state,
      // Phases du meeting en cours où il peut encore marquer (null : pas de
      // meeting en cours, le prochain pas est un meeting entier).
      stepKeys: current ? stepPhases.map(ph => ph.key) : null,
      stepStake: current ? stepStake : M,
      // Points à reprendre au leader d'ici la fin pour le dépasser.
      toOvertake: i === 0 ? 0 : deficit + 1,
      // Ce que le leader doit reprendre à ce pilote au prochain meeting pour
      // être sacré à son issue (rempli plus bas ; négatif = il peut en céder).
      leaderNeedNext: null,
    };
  });

  // Statut global.
  // Le leader est sacré si aucun poursuivant ne peut plus atteindre son
  // total (chacun avec ses propres phases restantes).
  const rivalMax = drivers.length > 1 ? Math.max(...drivers.slice(1).map(d => d.maxReachable)) : null;
  let status;
  if (pointsLeft === 0)        status = 'season_over';
  else if (rivalMax == null)   status = 'clinched';          // seul pilote classé
  else if (rivalMax < pL)      status = 'clinched';
  else if (rivalMax === pL)    status = 'clinched_tie';
  else                         status = 'open';

  // Prochain pas : la fin du meeting en cours (phases restantes) ou, sinon,
  // le prochain meeting entier. Ensuite restent `meetingsAfter` meetings
  // complets (plus, le cas échéant, d'autres meetings en cours).
  const step = current
    ? { meeting: current, inProgress: true,  phases: currentPhases,     stake: currentLeft, meetingsAfter: N }
    : N > 0
      ? { meeting: remaining[0], inProgress: false, phases: perMeeting.phases, stake: M, meetingsAfter: N - 1 }
      : null;

  // Écart requis à l'issue du prochain pas pour être sacré, et ce que cela
  // demande face à chaque poursuivant encore en course.
  let next = null;
  if (step && status === 'open') {
    const leftAfter = pointsLeft - step.stake;
    const requiredGapAfter = leftAfter + 1;
    drivers.forEach(c => {
      if (c.state === 'leader' || c.state === 'eliminated') return;
      c.leaderNeedNext = requiredGapAfter - c.deficit;
    });
    // Écart à créer sur le 2e pendant ce pas (négatif : marge cessible).
    const need = requiredGapAfter - gap;
    // Phases où leader et 2e peuvent encore marquer sur ce pas.
    const scaleFor = d => {
      const phases = d.stepKeys ? step.phases.filter(ph => d.stepKeys.includes(ph.key)) : step.phases;
      return { total: phases.reduce((s, ph) => s + ph.max, 0), phases };
    };
    const leaderScale = scaleFor(drivers[0]);
    const rivalScale  = scaleFor(drivers[1]);
    const rivalKeys = new Set(rivalScale.phases.map(ph => ph.key));
    next = {
      ...step,
      leftAfter,
      requiredGapAfter,
      need,
      gainVsSecond: Math.max(0, need),
      concedable:   Math.max(0, -need),
      leaderStake: leaderScale.total,
      rivalStake:  rivalScale.total,
      // Possible si le leader marque tout et le 2e rien.
      possible: need <= leaderScale.total,
      // Conditions sur les seuls résultats du leader (vide : son sacre
      // dépend forcément aussi du résultat du 2e).
      tiers: guaranteeTiers(need, leaderScale, rivalScale),
      // Gain maximal garanti sur ce pas en gagnant les phases couplées communes.
      guaranteedSwing: leaderScale.phases.filter(ph => rivalKeys.has(ph.key)).reduce((s, ph) => s + ph.delta, 0),
      // Si le leader marque son maximum, ce que le 2e doit marquer au plus.
      rivalMaxIfLeaderMax: need <= leaderScale.total ? Math.min(rivalScale.total, leaderScale.total - need) : null,
    };
  }

  // Premier pas où le titre peut se décider : après les pas 1..k, l'avance
  // maximale du leader est gap + (points de ces pas) et elle doit dépasser
  // ce qui reste ensuite.
  let earliest = null;
  if (status === 'open' && step) {
    const steps = [step, ...remaining.slice(step.inProgress ? 0 : 1).map(m => ({ meeting: m, inProgress: false, stake: M }))];
    let gained = 0;
    for (let k = 0; k < steps.length; k++) {
      gained += steps[k].stake;
      if (gap + gained > pointsLeft - gained) {
        earliest = { index: k + 1, of: steps.length, meeting: steps[k].meeting, inProgress: steps[k].inProgress };
        break;
      }
    }
  }

  const contenders = drivers.filter(d => d.state === 'contender' || d.state === 'tie_only');
  const eliminated = drivers.filter(d => d.state === 'eliminated');

  // Scénario idéal de chaque pilote encore concerné (leader compris) : les
  // places du meeting sont partagées entre eux, une par pilote.
  const alive = drivers.filter(d => d.state !== 'eliminated');
  if (step) {
    alive.forEach((d, i) => { d.ideal = idealScenario(i, alive, perMeeting, step.meetingsAfter, step.phases); });
  }

  return {
    perMeeting, remaining, inProgress, played, pointsLeft,
    current, currentPhases, currentLeft,
    leader: drivers[0], second: drivers[1] || null, gap, status,
    next, earliest, drivers, contenders, eliminated,
    ignoresDrop: (Number(regulation?.worstResultDrop) || 0) > 0,
  };
}

// ─────────────────────────────────────────────────────────
// RENDU HTML (chaîne)
// ─────────────────────────────────────────────────────────

const pts = n => `${n} pt${Math.abs(n) > 1 ? 's' : ''}`;
const name = d => `${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong>`;

const signed = n => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** Détail des places du scénario idéal, pour l'infobulle. */
function idealTitle(ideal) {
  return ideal.rows.map(r =>
    `${r.firstName} ${r.lastName} : ${r.places.map(pl => `${pl.label} P${pl.pos}`).join(', ')} = ${r.meetingPts} pts`
  ).join('\n');
}

/** Cellules « scénario idéal » : après le prochain meeting, puis en fin de saison. */
function idealCells(d) {
  if (!d.ideal) return '<td class="center">—</td><td class="center">—</td>';
  const { next, season } = d.ideal;
  const tip = escHtml(idealTitle(d.ideal));
  const nextTag = next.clinched ? ' <span class="chp-title-tag is-leader">sacré</span>' : '';
  const nextGap = next.gap == null ? '' : ` <span class="chp-title-hint">(${signed(next.gap)})</span>`;
  const seasonTag = season.champion
    ? '<span class="chp-title-tag is-alive">champion</span>'
    : season.tie ? '<span class="chp-title-tag is-tie">égalité</span>'
    : `<span class="chp-title-tag is-out">insuffisant</span>`;
  const seasonGap = season.gap == null ? '' : ` <span class="chp-title-hint">(${signed(season.gap)})</span>`;
  return `<td class="center" title="${tip}"><strong>${next.total}</strong> · P${next.rank}${nextGap}${nextTag}</td>`
       + `<td class="center" title="${tip}"><strong>${season.total}</strong>${seasonGap} ${seasonTag}</td>`;
}

/** Cellule « À reprendre » : +12 (à reprendre), 0, ou −5 (peut céder). */
function needCell(need) {
  if (need == null) return '—';
  if (need > 0)  return `<span class="chp-title-need is-gain">+${need}</span>`;
  if (need < 0)  return `<span class="chp-title-need is-slack" title="Le leader peut céder jusqu'à ${-need} pt${-need > 1 ? 's' : ''} à ce pilote">−${-need}</span>`;
  return `<span class="chp-title-need">0</span>`;
}

function situationOf(d, s) {
  switch (d.state) {
    case 'leader':     return `<span class="chp-title-tag is-leader">Leader</span>`;
    case 'eliminated': return `<span class="chp-title-tag is-out">Éliminé</span>`;
    case 'tie_only':   return `<span class="chp-title-tag is-tie">Peut seulement égaler le leader</span>`;
    default:
      return `<span class="chp-title-tag is-alive">En course</span>`
           + `<span class="chp-title-hint">doit reprendre ${pts(d.toOvertake)} ${s.current ? 'd\'ici la fin de saison' : `sur ${s.remaining.length} meeting${s.remaining.length > 1 ? 's' : ''}`}</span>`;
  }
}

/**
 * Bloc « Scénarios de titre » à insérer sous le tableau du championnat.
 * @param {object|null} s — sortie de buildTitleScenarios()
 */
export function renderTitleScenarios(s) {
  if (!s) return '';
  const N = s.remaining.length;
  const M = s.perMeeting.total;
  const detail = s.perMeeting.phases.map(ph => `${escHtml(ph.label)} ${ph.max}`).join(' + ');
  const remainingLabels = s.remaining.map(m => escHtml(meetingShortLabel(m))).join(', ');
  const phaseList = phases => phases.map(ph => escHtml(ph.label)).join(' + ');
  const currentTxt = s.current
    ? `<strong>${pts(s.currentLeft)}</strong> restants à ${escHtml(meetingShortLabel(s.current))} (${phaseList(s.currentPhases)})`
    : '';
  const fullTxt = `${N} meeting${N > 1 ? 's' : ''} restant${N > 1 ? 's' : ''} × ${M} pts`;
  const stakeTxt = N > 0 && s.current ? `${fullTxt} + ${currentTxt}` : s.current ? currentTxt : fullTxt;

  // ── Verdict ──
  let verdict = '';
  if (s.status === 'season_over') {
    const tied = s.second && s.gap === 0;
    verdict = tied
      ? `<div class="chp-title-verdict is-tie">🏁 Saison terminée — ${name(s.leader)} et ${name(s.second)} à égalité de points en tête.</div>`
      : `<div class="chp-title-verdict is-clinched">🏆 Saison terminée — ${name(s.leader)} est champion${s.second ? ` avec ${pts(s.gap)} d'avance` : ''}.</div>`;
  } else if (s.status === 'clinched') {
    verdict = `<div class="chp-title-verdict is-clinched">🏆 ${name(s.leader)} est mathématiquement champion`
            + (s.second ? ` : ${pts(s.gap)} d'avance sur ${name(s.second)} pour ${pts(s.pointsLeft)} encore en jeu.` : '.')
            + `</div>`;
  } else if (s.status === 'clinched_tie') {
    verdict = `<div class="chp-title-verdict is-tie">🥇 ${name(s.leader)} ne peut plus être dépassé : `
            + `${pts(s.gap)} d'avance pour ${pts(s.pointsLeft)} en jeu. ${name(s.second)} peut au mieux l'égaler.</div>`;
  } else {
    const nb = s.contenders.length;
    verdict = `<div class="chp-title-verdict is-open">⚔️ Titre ouvert — ${name(s.leader)} mène avec ${pts(s.gap)} d'avance sur ${name(s.second)}. `
            + `${nb} poursuivant${nb > 1 ? 's' : ''} encore en course pour ${pts(s.pointsLeft)} en jeu.</div>`;
  }

  // ── Prochain meeting ──
  let nextHtml = '';
  if (s.next) {
    const n = s.next;
    const label = escHtml(meetingShortLabel(n.meeting));
    const S = n.leaderStake;
    const lines = [];
    if (n.inProgress) {
      lines.push(`Meeting en cours : il reste ${phaseList(n.phases).toLowerCase()} à disputer, soit <strong>${pts(n.stake)}</strong> au maximum par pilote qualifié.`);
      if (n.leaderStake < n.stake) lines.push(n.leaderStake === 0
        ? `Le leader ne peut plus marquer sur ce meeting (non qualifié pour la suite, ou non engagé).`
        : `Le leader ne peut plus marquer que ${pts(n.leaderStake)} sur ce meeting.`);
      if (n.rivalStake < n.stake) lines.push(n.rivalStake === 0
        ? `${name(s.second)} ne peut plus marquer sur ce meeting (non qualifié pour la suite, ou non engagé).`
        : `${name(s.second)} ne peut plus marquer que ${pts(n.rivalStake)} sur ce meeting.`);
    }
    lines.push(`Pour être sacré à l'issue de <strong>${label}</strong>, le leader doit en repartir avec au moins `
             + `<strong>${pts(n.requiredGapAfter)}</strong> d'avance (${pts(n.leftAfter)} resteront en jeu).`);
    if (n.possible) {
      if (n.need > 0) {
        lines.push(`Il doit donc reprendre au moins <strong>${pts(n.need)}</strong> à ${name(s.second)} d'ici la fin du meeting — et l'équivalent à chaque poursuivant, voir la colonne « À reprendre ».`);
      } else if (n.need === 0) {
        lines.push(`Face à ${name(s.second)}, il lui suffit de ne pas perdre de terrain d'ici la fin du meeting (colonne « À reprendre » pour les autres poursuivants).`);
      } else {
        lines.push(`Face à ${name(s.second)}, il peut même céder jusqu'à <strong>${pts(n.concedable)}</strong> d'ici la fin du meeting (colonne « À reprendre » pour les autres poursuivants).`);
      }
      if (n.tiers.length) {
        const labelOf = key => PHASE_DEFS[key]?.short || key;
        lines.push(`Sacré quoi que fasse ${name(s.second)} : ` + n.tiers.map(t => {
          if (!t.wins.length) return `en marquant au moins <strong>${pts(t.score)}</strong> sur ${S}`;
          const wins = t.wins.map(k => k === 'interim' ? 'le classement intermédiaire' : `la ${labelOf(k).toLowerCase()}`).join(' et ');
          return t.winsSuffice
            ? `en gagnant ${wins}`
            : `en gagnant ${wins} et en marquant au moins <strong>${pts(t.score)}</strong>`;
        }).join(', ou ') + `.`);
      } else {
        lines.push(`Aucun résultat du leader ne le sacre à lui seul : même en gagnant tout, il ne reprend que ${pts(n.guaranteedSwing)} garantis `
                 + `(le rival est au mieux deuxième derrière lui). Il faut aussi que ${name(s.second)} marque au plus <strong>${pts(n.rivalMaxIfLeaderMax)}</strong> si le leader en marque ${S}.`);
      }
    } else {
      lines.push(`Impossible à ce meeting : il faudrait reprendre ${pts(n.need)} à ${name(s.second)}, pour ${S} point${S > 1 ? 's' : ''} au maximum.`);
    }
    if (s.earliest) {
      lines.push(s.earliest.index === 1
        ? `Le titre peut donc se décider dès ce meeting.`
        : `Au plus tôt, le titre se décide à <strong>${escHtml(meetingShortLabel(s.earliest.meeting))}</strong> (meeting ${s.earliest.index} sur ${s.earliest.of}).`);
    }
    nextHtml = `<div class="chp-title-next"><div class="chp-title-sub">${n.inProgress ? 'Meeting en cours' : 'Prochain meeting'}</div>${lines.map(l => `<p>${l}</p>`).join('')}</div>`;
  }

  // ── Tableau des pilotes encore concernés ──
  const rows = s.drivers.filter(d => d.state !== 'eliminated').map(d => `
    <tr class="chp-title-row is-${d.state}">
      <td class="center"><span class="chp-pos">${d.position}</span></td>
      <td>${name(d)}${d.carNumber ? ` <span class="tim-num">${escHtml(d.carNumber)}</span>` : ''}</td>
      <td class="center"><strong>${d.points}</strong></td>
      <td class="center">${d.state === 'leader' ? '—' : `−${d.deficit}`}</td>
      <td class="center">${d.maxReachable}</td>
      <td class="center">${needCell(d.leaderNeedNext)}</td>
      ${idealCells(d)}
      <td>${situationOf(d, s)}</td>
    </tr>`).join('');

  const tableHtml = `<div class="table-wrap chp-title-table-wrap">
    <table class="chp-title-table">
      <thead><tr>
        <th class="center" style="width:46px">Pos.</th>
        <th>Pilote</th>
        <th class="center">Pts</th>
        <th class="center" title="Retard sur le leader">Retard</th>
        <th class="center" title="Total maximal atteignable en marquant ${M} à chaque meeting restant">Max possible</th>
        <th class="center" title="Points que le leader doit reprendre à ce pilote au prochain meeting pour être sacré à son issue (négatif : marge qu'il peut lui céder)">À reprendre</th>
        <th class="center" title="Le pilote gagne tout ${s.current ? 'd\'ici la fin du meeting en cours' : 'au prochain meeting'}, les autres prétendants prennent les places suivantes dans l'ordre du classement : total, rang et écart sur le meilleur autre">Idéal · ${s.current ? 'fin du meeting' : 'prochain meeting'}</th>
        <th class="center" title="Même scénario répété sur tous les meetings restants : total final et verdict">Idéal · fin de saison</th>
        <th>Situation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  // ── Notes ──
  const notes = [];
  if (s.eliminated.length) notes.push(`${s.eliminated.length} pilote${s.eliminated.length > 1 ? 's' : ''} mathématiquement éliminé${s.eliminated.length > 1 ? 's' : ''} de la course au titre (non listé${s.eliminated.length > 1 ? 's' : ''}).`);
  if (s.current) notes.push(`Meeting en cours (${escHtml(meetingShortLabel(s.current))}) : les phases déjà courues sont comptées dans les totaux ; `
                          + `${phaseList(s.currentPhases).toLowerCase()} (${pts(s.currentLeft)}) restent en jeu, pour les seuls pilotes engagés et qualifiés `
                          + `(top ${s.perMeeting.phases.find(ph => ph.key === 'df')?.qualifiedPerRace ?? 4} d'une ½ finale pour la finale).`);
  if (s.ignoresDrop) notes.push(`Le règlement prévoit un décompte du plus mauvais résultat, non pris en compte ici ni dans le classement.`);
  if (N > 0) notes.push(`Scénario idéal : le pilote gagne le classement intermédiaire, sa ½ finale et la finale ; les autres prétendants prennent les places suivantes `
                     + `dans l'ordre du classement, une seule place par pilote (deux ½ finales : deux vainqueurs possibles). Survolez la cellule pour le détail des places.`);
  notes.push(`Scénarios garantis dans le pire des cas : un poursuivant peut reprendre jusqu'à ${M} pts par meeting si le leader ne marque rien ; `
           + `à l'inverse, le leader ne peut garantir que ${pts(s.perMeeting.guaranteedSwing)} par meeting en gagnant tout, son rival étant alors au mieux deuxième. `
           + `Les égalités de points ne sont pas départagées.`);

  return `<div class="chp-title">
    <div class="chp-title-head">
      <span class="chp-evo-title">🏆 Scénarios de titre</span>
      <span class="chp-title-stake">${stakeTxt} = <strong>${pts(s.pointsLeft)}</strong> en jeu
        <span class="chp-title-hint">(${detail})${N ? ` · ${remainingLabels}` : ''}</span></span>
    </div>
    ${verdict}
    ${nextHtml}
    ${tableHtml}
    <div class="chp-title-notes">${notes.map(n => `<span>${n}</span>`).join('')}</div>
  </div>`;
}
