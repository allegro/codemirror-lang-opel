import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { opelLanguage } from '../../src/language';
import { opelLinter } from '../../src/linter';

export function hasParseError(code: string): boolean {
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

export function lint(code: string) {
  const state = EditorState.create({
    doc: code,
    extensions: [opelLanguage],
  });
  // The linter only reads `view.state`, so a minimal stub avoids needing a DOM.
  const view = { state } as unknown as EditorView;
  return opelLinter()(view);
}
