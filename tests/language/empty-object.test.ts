import { describe, it, expect } from 'vitest';
import { hasParseError, lint } from '../support/test-utils';

describe('empty object syntax', () => {
  it('parses {:} as a valid empty object', () => {
    expect(hasParseError('{:}')).toBe(false);
  });

  it('parses non-empty objects', () => {
    expect(hasParseError('{a: 1, b: 2}')).toBe(false);
  });

  it('parses a bare {} without a parse error (handled by the linter)', () => {
    expect(hasParseError('{}')).toBe(false);
  });

  it('does not flag {:} in the linter', () => {
    const diagnostics = lint('{:}');
    expect(diagnostics).toHaveLength(0);
  });

  it('flags a bare {} with a hint to use {:}', () => {
    const diagnostics = lint('{}');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].message).toContain('{:}');
  });

  it('does not flag non-empty objects', () => {
    const diagnostics = lint('{a: 1}');
    expect(
      diagnostics.filter((d) => d.message.includes('Empty object'))
    ).toHaveLength(0);
  });
});
