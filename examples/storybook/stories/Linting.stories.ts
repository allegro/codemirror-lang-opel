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

export const RuntimeGlobals: StoryObj = {
  name: 'Runtime Globals',
  ...createEditorStory({
    doc: `ctx + env`,
    runtimeGlobals: ['ctx', 'env'],
  }),
};

export const UsedBeforeDeclaration: StoryObj = {
  name: 'Used Before Declaration',
  ...createEditorStory({
    doc: `val a = foo;
val foo = 'bar';
a`,
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

export const EmptyObject: StoryObj = {
  name: 'Empty Object (lint hint)',
  ...createEditorStory({
    doc: `val empty = {};
empty`,
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

export const MethodCallOnValue: StoryObj = {
  name: 'Method Call on Value',
  ...createEditorStory({
    doc: `['a', 2, 'c'].size()`,
  }),
};

export const LinterDisabled: StoryObj = {
  name: 'Linter Disabled',
  ...createEditorStory({
    doc: `undeclared + 1`,
    enableLinter: false,
  }),
};
