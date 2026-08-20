import { describe, it, expect } from 'vitest';
import { EFPackager } from '../../src/converters/ef-packager.js';
import { childRawTx, parentRaws, expectedEF } from './fixtures.js';

describe('EFPackager', () => {
  it('builds EF from RAW tx with offline parent map', async () => {
    expect(await new EFPackager().execute(childRawTx, parentRaws)).toBe(expectedEF);
  });
});
