import { describe, expect, it } from 'vitest';
import {
  analyzeDelimiters,
  unsupportedLogicalKeywordNear,
} from '../../src/linter/delimiters';

describe('analyzeDelimiters', () => {
  it('ignores delimiters inside string literals', () => {
    const result = analyzeDelimiters("fn(')') && (a");
    expect(result.unexpectedClose).toBeNull();
    expect(result.unclosed).toHaveLength(1);
    expect(result.unclosed[0].open).toBe('(');
  });

  it('reports unexpected closing delimiter', () => {
    const result = analyzeDelimiters('1 + ]2');
    expect(result.unexpectedClose?.close).toBe(']');
  });
});

describe('unsupportedLogicalKeywordNear', () => {
  it('detects word logical operator near parse error position', () => {
    const source = "fn('arg') == null or fn('arg') == '1'";
    const from = source.indexOf('or');
    const to = from + 2;
    expect(unsupportedLogicalKeywordNear(source, from, to)).toBe('or');
  });

  it('does not match longer identifiers', () => {
    const source = 'order == 1';
    const from = source.indexOf('order');
    const to = from + 5;
    expect(unsupportedLogicalKeywordNear(source, from, to)).toBeNull();
  });
});
