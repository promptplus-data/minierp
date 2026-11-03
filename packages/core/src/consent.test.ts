import { describe, expect, it } from 'vitest';
import { TERMS_CONSENTS, missingConsents } from './consent';

describe('M02 consents', () => {
  it('requires every required consent ticked', () => {
    expect(missingConsents({})).toEqual(['terms']);
    expect(missingConsents({ terms: false, shareData: true })).toEqual(['terms']);
    expect(missingConsents({ terms: true })).toEqual([]);
  });
  it('optional consents may stay unticked and at least one consent is required', () => {
    expect(TERMS_CONSENTS.filter((c) => c.required).length).toBeGreaterThan(0);
    expect(missingConsents({ terms: true, shareData: false, customerData: false })).toEqual([]);
  });
});
