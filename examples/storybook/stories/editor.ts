import type { StoryObj } from '@storybook/html';
import { EditorState, Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { tooltips } from '@codemirror/view';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { opel, opelExtensions } from '../../../src';
import type { OpelRuntime } from '../../../src';

export interface EditorConfig {
  /** Initial document content shown in the editor. */
  doc: string;
  /** Whether to enable the OPEL linter (default: true). */
  enableLinter?: boolean;
  /** Runtime metadata consumed by the linter. */
  runtime?: OpelRuntime;
  /** Extra CodeMirror extensions to layer on top. */
  extraExtensions?: Extension[];
}

function toTemplateLiteral(value: string): string {
  return `\`${value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')}\``;
}

function createStorySource({
  doc,
  enableLinter = true,
  runtime,
}: EditorConfig): string {
  const runtimeDeclaration = runtime
    ? `const runtime = ${JSON.stringify(runtime, null, 2)};\n\n`
    : '';

  if (enableLinter) {
    return `const opelCode = ${toTemplateLiteral(doc)};\n\n${runtimeDeclaration}const extensions = opelExtensions(${runtime ? '{ runtime }' : ''});`;
  }

  return `const opelCode = ${toTemplateLiteral(doc)};\n\n${runtimeDeclaration}const extensions = [\n  opel(${runtime ? '{ runtime }' : ''}),\n];`;
}

/** Creates a self-contained CodeMirror editor element for use in stories. */
export function createEditor({
  doc,
  enableLinter = true,
  runtime,
  extraExtensions = [],
}: EditorConfig): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText =
    'min-height:320px;height:320px;overflow:auto;border:1px solid #d0d7de;border-radius:6px;font-size:14px;';

  const extensions: Extension[] = [
    vscodeDark,
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-scroller': { overflow: 'auto' },
    }),
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    tooltips({ parent: document.body }),
    ...(enableLinter
      ? opelExtensions({ enableLinter, includeLintGutter: true, runtime })
      : [opel()]),
    ...extraExtensions,
  ];

  const state = EditorState.create({ doc, extensions });
  new EditorView({ state, parent: container });

  return container;
}

export function createEditorStory(config: EditorConfig): StoryObj {
  return {
    render: () => createEditor(config),
    parameters: {
      docs: {
        source: {
          code: createStorySource(config),
          language: 'ts',
        },
      },
    },
  };
}
