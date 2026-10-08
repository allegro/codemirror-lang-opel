import type { Meta, StoryObj } from '@storybook/html';
import type { OpelRuntime } from '../../../src';
import { createEditorStory } from './editor';

const meta: Meta = {
  title: 'OPEL/Runtime configurations',
  tags: ['autodocs'],
};
export default meta;

const userRuntime: OpelRuntime = {
  globals: {
    user: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

export const GlobalObject: StoryObj = {
  name: 'Global object schema',
  ...createEditorStory({
    doc: 'user.name',
    runtime: userRuntime,
  }),
};

export const ClosedObject: StoryObj = {
  name: 'Closed object member error',
  ...createEditorStory({
    doc: 'user.email',
    runtime: userRuntime,
  }),
};

export const FunctionSignature: StoryObj = {
  name: 'Function signature mismatch',
  ...createEditorStory({
    doc: 'lookup(\'id\')',
    runtime: {
      functions: {
        lookup: {
          signatures: [
            {
              parameters: [{ name: 'id', schema: { type: 'integer' } }],
              returns: { type: 'string' },
            },
          ],
        },
      },
    },
  }),
};

export const Methods: StoryObj = {
  name: 'Configured methods',
  ...createEditorStory({
    doc: "'hello'.length()",
    runtime: {
      methods: {
        string: {
          length: {
            signatures: [{ parameters: [], returns: { type: 'integer' } }],
          },
        },
      },
    },
  }),
};

export const ExternalSchema: StoryObj = {
  name: 'External schema reference',
  ...createEditorStory({
    doc: 'user.name',
    runtime: {
      schemas: {
        'catalog/user/1.0': {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
      globals: {
        user: { $ref: 'catalog/user/1.0' },
      },
    },
  }),
};

export const UnionMemberWarning: StoryObj = {
  name: 'Union member warning',
  ...createEditorStory({
    doc: 'choice.id',
    runtime: {
      globals: {
        choice: {
          oneOf: [
            { type: 'object', properties: { id: { type: 'integer' } } },
            { type: 'object', properties: { name: { type: 'string' } } },
          ],
        },
      },
    },
  }),
};
