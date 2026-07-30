import { describe, it, expect } from 'vitest';
import { lint } from '../support/test-utils';

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
    expect(
      diagnostics.filter((d) => d.message.includes('is not declared'))
    ).toHaveLength(0);
  });

  it('keeps "not declared" for truly missing variables', () => {
    const diagnostics = lint('missing + 1');
    expect(
      diagnostics.filter((d) => d.message.includes('is not declared'))
    ).toHaveLength(1);
  });

  it('allows runtime globals passed in options', () => {
    const diagnostics = lint('runtimeVar + 1', {
      runtimeGlobals: ['runtimeVar'],
    });
    expect(
      diagnostics.filter((d) => d.message.includes('runtimeVar'))
    ).toHaveLength(0);
  });

  it('does not treat function call names as undeclared variables', () => {
    const diagnostics = lint("identity('x')");
    expect(
      diagnostics.filter(
        (d) =>
          d.message.includes('identity') && d.message.includes('not declared')
      )
    ).toHaveLength(0);
  });

  it('does not treat method call names on values as undeclared variables', () => {
    const diagnostics = lint("['a', 2, 'c'].size()");
    expect(
      diagnostics.filter(
        (d) => d.message.includes('size') && d.message.includes('not declared')
      )
    ).toHaveLength(0);
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

describe('unused variable warnings', () => {
  it('warns when a declared variable is never used', () => {
    const diagnostics = lint("val x = 1;");
    const unused = diagnostics.filter((d) => d.message.includes('never used'));

    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe('warning');
    expect(unused[0].message).toContain('x');
  });

  it('does not warn when a declared variable is used', () => {
    const diagnostics = lint("val x = 1; x");
    expect(diagnostics.filter((d) => d.message.includes('never used'))).toHaveLength(0);
  });

  it('warns for each unused variable independently', () => {
    const diagnostics = lint("val x = 1; val y = 2; val z = 3; z");
    const unused = diagnostics.filter((d) => d.message.includes('never used'));

    expect(unused).toHaveLength(2);
    expect(unused[0].message).toContain('x');
    expect(unused[1].message).toContain('y');
  });
});
