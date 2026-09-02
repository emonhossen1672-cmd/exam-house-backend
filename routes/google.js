// services/google.js — verifies "Sign in with Google" ID tokens sent up from
// the frontend (Google Identity Services). Configure via env var:
//   GOOGLE_CLIENT_ID   OAuth 2.0 Client ID from Google Cloud Console
//                      (Credentials → OAuth client ID → Web application)
//
// If it isn't set, isConfigured is false and routes/auth.routes.js returns a
// clear "not set up yet" error instead of crashing — same pattern as sms.js.
const { OAuth2Client } = require('google-auth-library');
const { GOOGLE_CLIENT_ID } = require('../config');

const isConfigured = Boolean(GOOGLE_CLIENT_ID);
const client = isConfigured ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Verifies the ID token's signature, audience and expiry against Google's
// public keys and returns the decoded payload ({ sub, email, name, picture }).
// Throws if the token is missing, expired, or was issued for a different
// client ID — callers should catch and treat that as a failed sign-in.
async function verifyGoogleToken(idToken) {
  if (!isConfigured) throw new Error('GOOGLE_CLIENT_ID not configured');
  const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  return ticket.getPayload();
}

module.exports = { verifyGoogleToken, isConfigured };
