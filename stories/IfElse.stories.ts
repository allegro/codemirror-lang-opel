import type { Meta, StoryObj } from '@storybook/html';
import { createEditorStory } from './editor';

const meta: Meta = {
  title: 'OPEL/If Else',
  tags: ['autodocs'],
};
export default meta;

export const SimpleIfElse: StoryObj = {
  name: 'Simple If / Else',
  ...createEditorStory({
    doc: `val score = 85;
if (score >= 60) "pass" else "fail"`,
  }),
};

export const NestedIfElse: StoryObj = {
  name: 'Nested If / Else',
  ...createEditorStory({
    doc: `val score = 85;
if (score >= 90)
  "A"
else if (score >= 75)
  "B"
else
  "C"`,
  }),
};

export const BooleanCondition: StoryObj = {
  name: 'Boolean Condition',
  ...createEditorStory({
    doc: `val active = true;
val verified = true;
if (active && verified) "allowed" else "denied"`,
  }),
};

export const NullGuard: StoryObj = {
  name: 'Null Guard',
  ...createEditorStory({
    doc: `val input = null;
if (input == null) "default" else input`,
  }),
};
