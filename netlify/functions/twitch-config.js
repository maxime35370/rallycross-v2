/* ═══════════════════════════════════════════════
   TWITCH-CONFIG.JS — Sert le Client ID Twitch (PUBLIC, pas un secret) au
   navigateur, pour que celui-ci construise l'URL d'autorisation Twitch sans
   avoir à coder cet identifiant en dur dans le JS du site. Le Client Secret,
   lui, ne quitte jamais netlify/functions/twitch-auth.js.
═══════════════════════════════════════════════ */

export default async () => {
  return new Response(JSON.stringify({ clientId: process.env.TWITCH_CLIENT_ID || '' }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
};
