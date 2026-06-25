import { describe, it, expect } from 'vitest';
import { lint } from './test-utils';

describe('variable declaration order', () => {
  it('flags variables used before they are declared', () => {
    const diagnostics = lint("val a = foo; val foo = 'bar'; a");
    const beforeDeclaration = diagnostics.filter((d) =>
      d.message.includes('used before declaration')
    );

    expect(beforeDeclaration).toHaveLength(1);
    expect(beforeDeclaration[0].message).toContain('foo');
  });

  it('allows variables after their declaration', () => {
    const diagnostics = lint("val foo = 'bar'; val a = foo; a");
    expect(diagnostics.filter((d) => d.message.includes('is not declared'))).toHaveLength(0);
  });

  it('keeps "not declared" for truly missing variables', () => {
    const diagnostics = lint('missing + 1');
    expect(diagnostics.filter((d) => d.message.includes('is not declared'))).toHaveLength(1);
  });

  it('reports duplicate declarations as errors', () => {
    const diagnostics = lint('val x = 1; val x = 2; x');
    const duplicates = diagnostics.filter((d) =>
      d.message.includes('already declared')
    );

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].severity).toBe('error');
  });
});
