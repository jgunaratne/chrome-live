/**
 * @fileoverview OAuth access tokens for the Vertex AI Live API.
 *
 * Browsers cannot set an Authorization header on a WebSocket handshake, but
 * the Live API also accepts the token as an `access_token` query parameter.
 * The user pastes either:
 *   - an access token (`gcloud auth print-access-token`, valid ~1 hour), or
 *   - their Application Default Credentials JSON
 *     (~/.config/gcloud/application_default_credentials.json, created by
 *     `gcloud auth application-default login`), from which fresh access
 *     tokens are minted with its refresh token, like google-auth does.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CACHE_KEY = 'tokenCache';
/** Refresh this long before a cached token expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export class CredentialsError extends Error {}

/**
 * @param {string} credentials The saved credentials setting.
 * @param {{forceRefresh: (boolean|undefined)}=} options
 * @return {!Promise<string>} An access token.
 */
export async function getAccessToken(credentials, {forceRefresh = false} = {}) {
  const raw = String(credentials || '').trim();
  if (!raw) {
    throw new CredentialsError(
      'No credentials yet: open the extension options and paste an access token or your ADC JSON.',
    );
  }
  if (!raw.startsWith('{')) return raw;

  let adc;
  try {
    adc = JSON.parse(raw);
  } catch {
    throw new CredentialsError('The credentials look like JSON but could not be parsed.');
  }
  if (adc.type === 'authorized_user' && adc.refresh_token) {
    return refreshAdcToken(adc, forceRefresh);
  }
  if (typeof adc.access_token === 'string') return adc.access_token;
  throw new CredentialsError(
    'Unsupported credentials JSON: expected an "authorized_user" ADC file from `gcloud auth application-default login`.',
  );
}

async function refreshAdcToken(adc, forceRefresh) {
  const fingerprint = `${adc.client_id}:${adc.refresh_token.slice(-16)}`;
  const {[CACHE_KEY]: cached} = await chrome.storage.session.get(CACHE_KEY);
  if (
    !forceRefresh &&
    cached?.fingerprint === fingerprint &&
    cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  ) {
    return cached.token;
  }
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id: adc.client_id,
        client_secret: adc.client_secret,
        refresh_token: adc.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
  } catch (err) {
    throw new CredentialsError(`Could not reach ${TOKEN_URL}: ${err.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new CredentialsError(
      `Refreshing the ADC token failed (${body.error_description || body.error || response.status}). ` +
        'Re-run `gcloud auth application-default login` and paste the new JSON.',
    );
  }
  await chrome.storage.session.set({
    [CACHE_KEY]: {
      token: body.access_token,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      fingerprint,
    },
  });
  return body.access_token;
}
