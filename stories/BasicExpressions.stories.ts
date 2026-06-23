import type { Meta, StoryObj } from '@storybook/html';
import { createEditorStory } from './editor';

const meta: Meta = {
  title: 'OPEL/Basic Expressions',
  tags: ['autodocs'],
};
export default meta;

export const Arithmetic: StoryObj = {
  name: 'Arithmetic',
  ...createEditorStory({
    doc: '1 + 2 * 3',
  }),
};

export const StringConcatenation: StoryObj = {
  name: 'String Concatenation',
  ...createEditorStory({
    doc: '"Hello, " + "World!"',
  }),
};

export const Comparison: StoryObj = {
  name: 'Comparison',
  ...createEditorStory({
    doc: '10 > 5 and 3 <= 4',
  }),
};

export const BooleanLiterals: StoryObj = {
  name: 'Boolean Literals',
  ...createEditorStory({
    doc: 'true or false',
  }),
};

export const NullCheck: StoryObj = {
  name: 'Null Check',
  ...createEditorStory({
    doc: 'null == null',
  }),
};
