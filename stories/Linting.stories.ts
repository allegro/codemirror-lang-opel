import type { Meta, StoryObj } from '@storybook/html';
import { createEditorStory } from './editor';

const meta: Meta = {
  title: 'OPEL/Linting',
  tags: ['autodocs'],
};
export default meta;

export const SyntaxError: StoryObj = {
  name: 'Syntax Error',
  ...createEditorStory({
    doc: `val x = ;`,
  }),
};

export const UndeclaredVariable: StoryObj = {
  name: 'Undeclared Variable',
  ...createEditorStory({
    doc: `undeclared + 1`,
  }),
};

export const DuplicateDeclaration: StoryObj = {
  name: 'Duplicate Declaration',
  ...createEditorStory({
    doc: `val x = 1;
val x = 2;
x`,
  }),
};

export const ValidCode: StoryObj = {
  name: 'Valid — No Diagnostics',
  ...createEditorStory({
    doc: `val x = 10;
val y = 20;
x + y`,
  }),
};

export const LinterDisabled: StoryObj = {
  name: 'Linter Disabled',
  ...createEditorStory({
    doc: `undeclared + 1`,
    enableLinter: false,
  }),
};
