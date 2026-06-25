import { describe, expect, it } from 'vitest';
import { hasParseError, lint } from '../support/test-utils';

describe('runtime parser compatibility', () => {
  it('parses runtime-supported call chaining forms', () => {
    const expressions = [
      '(x, y) -> {x*x + y*y}(1, 2)',
      'val f = a -> { b -> {a*2+b} }; f(2)(3)',
      "(aMap.get)('get')",
      "({'get': x->x+x}.get)('get')",
      "(if (true) 'a' else 'b').length()",
      "(if (x > 0) foo else bar)(x)",
    ];

    for (const expression of expressions) {
      expect(hasParseError(expression)).toBe(false);
    }
  });

  it('requires else branch in if expression (runtime-compatible)', () => {
    expect(hasParseError("if (2 == 2) 'elo'")).toBe(true);
  });

  it('keeps runtime-compatible empty map linting behavior', () => {
    const diagnostics = lint('{}');
    expect(diagnostics.some((d) => d.message.includes('{:}'))).toBe(true);
  });
});
