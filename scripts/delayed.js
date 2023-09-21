// eslint-disable-next-line import/no-cycle
import { fetchPlaceholders, toCamelCase, sampleRUM } from './lib-franklin.js';

// Core Web Vitals RUM collection
sampleRUM.cwv();

// add more delayed functionality here

// CMP consent
try {
  await fetchPlaceholders();
} catch (e) { /* ignore */ }

// also check consent stored in localstorage used while developing
const analyticsConsent = localStorage.getItem('consent_status_ANALYTICS');
if (analyticsConsent) {
  sampleRUM('consent', { 'ANALYTICS': analyticsConsent === 'ALLOW'});
}
