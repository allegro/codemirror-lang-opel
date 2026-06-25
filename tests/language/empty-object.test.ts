import { describe, it, expect } from 'vitest';
import { hasParseError, lint } from '../support/test-utils';

describe('empty object syntax', () => {
  it('parses {:} as a valid empty object', () => {
    expect(hasParseError('{:}')).toBe(false);
  });

  it('parses non-empty objects', () => {
    expect(hasParseError('{a: 1, b: 2}')).toBe(false);
  });

  it('does not parse a bare {} (runtime-compatible)', () => {
    expect(hasParseError('{}')).toBe(true);
  });

  it('does not flag {:} in the linter', () => {
    const diagnostics = lint('{:}');
    expect(diagnostics).toHaveLength(0);
  });

  it('flags a bare {} as invalid syntax', () => {
    const diagnostics = lint('{}');
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(diagnostics.some((d) => d.message.includes('"{:}"'))).toBe(true);
  });

  it('flags {} inside surrounding code with the same hint', () => {
    const diagnostics = lint('val empty = {};\nempty');
    expect(diagnostics.some((d) => d.message.includes('"{:}"'))).toBe(true);
  });

  it('does not flag non-empty objects', () => {
    const diagnostics = lint('{a: 1}');
    expect(
      diagnostics.filter((d) => d.message.includes('Empty object'))
    ).toHaveLength(0);
  });
});
