import { describe, it, expect } from 'vitest';
import { hasParseError, lint } from '../support/test-utils';

describe('logical operator syntax', () => {
  it('parses symbolic logical operators', () => {
    expect(hasParseError('true && false || true')).toBe(false);
  });

  it('does not parse word logical operators', () => {
    expect(hasParseError('true and false')).toBe(true);
    expect(hasParseError('true or false')).toBe(true);
  });

  it('suggests symbolic operator when using "or"', () => {
    const diagnostics = lint("fn('arg') == null or fn('arg') == '1'");
    expect(
      diagnostics.some((d) =>
        d.message.includes('Logical keyword "or" is not supported')
      )
    ).toBe(true);
    expect(
      diagnostics.some((d) => d.message.includes('Use "||" instead'))
    ).toBe(true);
  });

  it('suggests symbolic operator when using "and"', () => {
    const diagnostics = lint("fn('arg') == null and fn('arg') == '1'");
    expect(
      diagnostics.some((d) =>
        d.message.includes('Logical keyword "and" is not supported')
      )
    ).toBe(true);
    expect(
      diagnostics.some((d) => d.message.includes('Use "&&" instead'))
    ).toBe(true);
  });
});
