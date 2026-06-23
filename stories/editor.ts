import type { StoryObj } from '@storybook/html';
import { EditorState, Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { tooltips } from '@codemirror/view';
import { opel, opelExtensions } from '../src/index';

export interface EditorConfig {
  /** Initial document content shown in the editor. */
  doc: string;
  /** Whether to enable the OPEL linter (default: true). */
  enableLinter?: boolean;
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
}: EditorConfig): string {
  if (enableLinter) {
    return `const opelCode = ${toTemplateLiteral(doc)};

const extensions = opelExtensions();`;
  }

  return `const opelCode = ${toTemplateLiteral(doc)};

const extensions = [
  opel(),
];`;
}

/** Creates a self-contained CodeMirror editor element for use in stories. */
export function createEditor({
  doc,
  enableLinter = true,
  extraExtensions = [],
}: EditorConfig): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText =
    'height:320px;overflow:auto;border:1px solid #d0d7de;border-radius:6px;font-size:14px;';

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    syntaxHighlighting(defaultHighlightStyle),
    bracketMatching(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    tooltips({ parent: document.body }),
    ...(enableLinter
      ? opelExtensions({ enableLinter, includeLintGutter: true })
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
