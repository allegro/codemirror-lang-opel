import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { opelLanguage } from './index';
import { opelLinter } from './linter';

function hasParseError(code: string): boolean {
  const tree = opelLanguage.parser.parse(code);
  let error = false;
  tree.iterate({
    enter: (node) => {
      if (node.type.isError) {
        error = true;
      }
    },
  });
  return error;
}

function lint(code: string) {
  const state = EditorState.create({
    doc: code,
    extensions: [opelLanguage],
  });
  // The linter only reads `view.state`, so a minimal stub avoids needing a DOM.
  const view = { state } as unknown as EditorView;
  return opelLinter()(view);
}

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

  it('reports duplicate declarations as errors', () => {
    const diagnostics = lint('val x = 1; val x = 2; x');
    const duplicates = diagnostics.filter((d) =>
      d.message.includes('already declared')
    );

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].severity).toBe('error');
  });
});
