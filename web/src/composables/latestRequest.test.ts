import { describe, expect, it } from 'vitest';
import { createLatestRequest } from './latestRequest.js';
describe('request generation/cancellation', () => {
  it('aborts old requests and rejects their late responses', () => {
    const requests = createLatestRequest(), a = requests.start(), b = requests.start();
    expect(a.signal.aborted).toBe(true); expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(true); requests.cancel();
    expect(b.signal.aborted).toBe(true); expect(b.isCurrent()).toBe(false);
  });
});
