import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { opelCompletions } from '../../src/autocomplete';
import { opelLanguage } from '../../src/language';

function complete(doc: string, pos = doc.length) {
  const state = EditorState.create({
    doc,
    extensions: [opelLanguage],
  });
  const context = new CompletionContext(state, pos, true);
  return opelCompletions()(context);
}

describe('autocomplete context awareness', () => {
  it('suggests keywords and declared variables in normal expression context', () => {
    const result = complete(`val user = 'alice';
us`);

    expect(result).not.toBeNull();
    expect(result?.options.some((option) => option.label === 'if')).toBe(true);
    expect(result?.options.some((option) => option.label === 'user')).toBe(
      true
    );
  });

  it('does not suggest global completions after dot access', () => {
    const result = complete(`val user = 'alice';
user.`);

    expect(result).not.toBeNull();
    expect(result?.options).toHaveLength(0);
  });

  it('does not suggest global completions while typing after dot access', () => {
    const result = complete(`val user = 'alice';
user.na`);

    expect(result).not.toBeNull();
    expect(result?.options).toHaveLength(0);
  });
});
