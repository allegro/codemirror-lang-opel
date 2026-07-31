import type { Meta, StoryObj } from '@storybook/html';
import { createEditorStory } from './editor';

const meta: Meta = {
  title: 'OPEL/Variable Declarations',
  tags: ['autodocs'],
};
export default meta;

export const SingleVariable: StoryObj = {
  name: 'Single Variable',
  ...createEditorStory({
    doc: `val name = "Alice";
name`,
  }),
};

export const MultipleVariables: StoryObj = {
  name: 'Multiple Variables',
  ...createEditorStory({
    doc: `val price = 9.99;
val quantity = 3;
price * quantity`,
  }),
};

export const VariableReuse: StoryObj = {
  name: 'Variable Reuse in Expression',
  ...createEditorStory({
    doc: `val base = 100;
val discount = 0.2;
base - base * discount`,
  }),
};

export const UnusedVariable: StoryObj = {
  name: 'Unused Variable (lint warning)',
  ...createEditorStory({
    doc: `val unused = 42;
val used = 10;
used`,
  }),
};

export const DuplicateDeclaration: StoryObj = {
  name: 'Duplicate Declaration (lint error)',
  ...createEditorStory({
    doc: `val x = 1;
val x = 2;
x`,
  }),
};
