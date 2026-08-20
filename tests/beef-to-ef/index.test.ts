import { describe, it, expect } from 'vitest';
import { BEEFToEFConverter } from '../../src/converters/beef-to-ef.js';
import { beefHex, expectedEF } from './fixtures.js';

describe('BEEFToEFConverter', () => {
  it('converts BEEF to EF offline', () => {
    expect(new BEEFToEFConverter().execute(beefHex)).toBe(expectedEF);
  });
});
