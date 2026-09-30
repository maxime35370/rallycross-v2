/* ═══════════════════════════════════════════════
   OBS-TWITCH-BOT.JS — Connexion du bot de chat Twitch (régie uniquement).
   Distinct de beginTwitchLink (obs-pronostics.js, identité spectateur) :
   ce flux demande le scope `user:write:chat` (poster dans le chat au nom
   du compte régie) et est traité par netlify/functions/twitch-bot-auth.js,
   réservé au compte régie (vérifié côté serveur).

   Le jeton lui-même n'est JAMAIS lisible côté client (cf. firestore.rules,
   twitchBotAuth: write/read false) — seul un statut public-safe
   (twitchBotStatus: connecté ? + pseudo) est exposé, à la régie seule.
═══════════════════════════════════════════════ */

import { getDocById, watchDoc } from './obs-firebase.js';

const BOT_SCOPE = 'user:write:chat';
const BOT_STATUS_COL = 'twitchBotStatus';

/** Statut public-safe du bot (jamais le jeton) : {connected, login, displayName, updatedAt} | null. */
export function getTwitchBotStatus() {
  return getDocById(BOT_STATUS_COL, 'main');
}

/** Abonnement temps réel au statut du bot. */
export function watchTwitchBotStatus(cb, onErr) {
  return watchDoc(BOT_STATUS_COL, 'main', cb, onErr);
}

/**
 * Démarre l'autorisation Twitch du bot (quitte la page). Le retour se fait
 * sur CETTE même page (returnPath = l'URL courante), avec le résultat en
 * sessionStorage (voir consumeTwitchBotLinkResult).
 */
export async function beginTwitchBotLink() {
  const r = await fetch('/.netlify/functions/twitch-config');
  const { clientId } = await r.json();
  if (!clientId) throw new Error('twitch_not_configured');
  const nonce = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  sessionStorage.setItem('rxTwitchBotNonce', nonce);
  sessionStorage.setItem('rxTwitchBotReturnPath', location.pathname);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://rxchrono.netlify.app/.netlify/functions/twitch-bot-auth',
    response_type: 'code',
    scope: BOT_SCOPE,
    state: nonce,
  });
  location.href = `https://id.twitch.tv/oauth2/authorize?${params}`;
}

/**
 * Lit (et efface) le résultat du dernier aller-retour Twitch bot, déposé en
 * sessionStorage par la page pont. 'ok' | 'error:<raison>' | null.
 */
export function consumeTwitchBotLinkResult() {
  const v = sessionStorage.getItem('rxTwitchBotResult');
  if (v != null) sessionStorage.removeItem('rxTwitchBotResult');
  return v;
}
