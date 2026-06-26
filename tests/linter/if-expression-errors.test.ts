import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';

describe('if expression parse errors', () => {
  it('reports a missing else branch at the end of an if expression', () => {
    const diagnostics = lint(`val status = 'draft';
if (status == 'published') 'live'`);

    expect(
      diagnostics.some((d) =>
        d.message.includes('If expression requires an else branch')
      )
    ).toBe(true);
  });
});
