import { describe, it, expect } from 'vitest';
import { BEEFPackager } from '../../src/converters/beef-packager.js';
import { childRawTx, parents, expectedBEEF } from './fixtures.js';

describe('BEEFPackager', () => {
  it('builds BEEF from RAW tx with offline parents', async () => {
    expect(await new BEEFPackager().execute(childRawTx, { parents })).toBe(expectedBEEF);
  });
});
