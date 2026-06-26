import { EditorState } from '@codemirror/state';
import { opel, opelLanguage, opelExtensions, opelLinter } from '@allegro/codemirror-lang-opel';

if (typeof opel !== 'function') {
  throw new Error('opel export is not callable');
}

if (typeof opelLanguage !== 'object') {
  throw new Error('opelLanguage export is not available');
}

if (typeof opelExtensions !== 'function') {
  throw new Error('opelExtensions export is not callable');
}

if (typeof opelLinter !== 'function') {
  throw new Error('opelLinter export is not callable');
}

const extensions = opelExtensions();
if (!Array.isArray(extensions) || extensions.length === 0) {
  throw new Error('opelExtensions did not return any extensions');
}

const state = EditorState.create({
  doc: "val x = 1; x + 1",
  extensions: [opelLanguage, ...extensions],
});

const tree = opelLanguage.parser.parse(state.doc.toString());
if (tree.length === 0) {
  throw new Error('parser did not produce a syntax tree');
}

const diagnostics = opelLinter()({
  state,
});

if (!Array.isArray(diagnostics)) {
  throw new Error('opelLinter did not return diagnostics');
}

if (diagnostics.length !== 0) {
  throw new Error('expected no diagnostics for valid code');
}
