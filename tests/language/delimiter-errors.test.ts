import { describe, it, expect } from 'vitest';
import { lint } from '../support/test-utils';

describe('delimiter parse errors', () => {
  it('reports unclosed parenthesis', () => {
    const diagnostics = lint('(1 + 2');
    expect(
      diagnostics.some((d) => d.message.includes('Unclosed parenthesis'))
    ).toBe(true);
  });

  it('reports unclosed bracket', () => {
    const diagnostics = lint('[1, 2');
    expect(diagnostics.some((d) => d.message.includes('Unclosed bracket'))).toBe(
      true
    );
  });

  it('reports unclosed brace', () => {
    const diagnostics = lint('{a: 1');
    expect(diagnostics.some((d) => d.message.includes('Unclosed brace'))).toBe(
      true
    );
  });

  it('reports unexpected closing delimiter', () => {
    const diagnostics = lint('1 + )2');
    expect(diagnostics.some((d) => d.message.includes('Unexpected ")"'))).toBe(
      true
    );
  });
});
