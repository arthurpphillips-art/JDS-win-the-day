// ServiceTitan OAuth 2.0 Authentication
let cachedToken = null;
let tokenExpiry = null;

export async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }
  const response = await fetch('https://auth.servicetitan.io/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SERVICETITAN_CLIENT_ID,
      client_secret: process.env.SERVICETITAN_CLIENT_SECRET,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ServiceTitan auth failed: ${response.status} - ${error}`);
  }
  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

export function getHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'ST-App-Key': process.env.SERVICETITAN_APP_KEY,
    'Content-Type': 'application/json',
  };
}

export function getTenantId() {
  return process.env.SERVICETITAN_TENANT_ID;
}
