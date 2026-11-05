const CONSENT_KEY = 'zhijian-online-speech-consent-v1';

/** Consent belongs to one service address and can be revoked in listening settings. */
export function onlineConsent(endpoint, storage = globalThis.localStorage) {
  let accepted = false;
  try { accepted = Boolean(endpoint) && storage?.getItem(CONSENT_KEY) === endpoint; } catch {}
  return {
    get accepted() { return accepted; },
    allow() { accepted = true; try { storage?.setItem(CONSENT_KEY, endpoint); } catch {} },
    revoke() { accepted = false; try { storage?.removeItem(CONSENT_KEY); } catch {} },
  };
}
