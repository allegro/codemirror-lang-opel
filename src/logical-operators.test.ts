import { describe, it, expect } from 'vitest';
import { hasParseError } from './test-utils';

describe('logical operator syntax', () => {
  it('parses symbolic logical operators', () => {
    expect(hasParseError('true && false || true')).toBe(false);
  });

  it('does not parse word logical operators', () => {
    expect(hasParseError('true and false')).toBe(true);
    expect(hasParseError('true or false')).toBe(true);
  });
});
