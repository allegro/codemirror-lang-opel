import type { Meta, StoryObj } from '@storybook/html';
import type { OpelRuntime, OpelSchema } from '../../../src';
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
  name: 'Property defined in some variants',
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

const complexSettingsSchema: OpelSchema = {
  type: 'object',
  properties: {
              banner: {
                type: 'object',
                properties: {
                  headline: { type: 'string' },
                  summary: { type: 'string' },
                  image: {
                    type: 'object',
                    properties: {
                      desktopPath: { type: 'string' },
                      mobilePath: { type: 'string' },
                      alternativeText: { type: 'string' },
                    },
                  },
                  action: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      destination: { type: 'string' },
                      trackingKey: { type: 'string' },
                    },
                  },
                },
              },
              navigation: {
                type: 'object',
                properties: {
                  logoPath: { type: 'string' },
                  links: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        destination: { type: 'string' },
                        visible: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              cards: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    image: {
                      type: 'object',
                      properties: {
                        path: { type: 'string' },
                        altText: { type: 'string' },
                        aspectRatio: { type: 'number' },
                      },
                    },
                    labels: { type: 'array', items: { type: 'string' } },
                    action: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        destination: { type: 'string' },
                        openInNewTab: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              theme: {
                type: 'object',
                properties: {
                  colors: {
                    type: 'object',
                    properties: {
                      background: { type: 'string' },
                      foreground: { type: 'string' },
                      accent: { type: 'string' },
                      muted: { type: 'string' },
                    },
                  },
                  typography: {
                    type: 'object',
                    properties: {
                      fontFamily: { type: 'string' },
                      baseSize: { type: 'number' },
                      headingScale: { type: 'number' },
                      lineHeight: { type: 'number' },
                    },
                  },
                },
              },
              layout: {
                type: 'object',
                properties: {
                  contentWidth: { type: 'number' },
                  columnCount: { type: 'integer' },
                  gutterSize: { type: 'number' },
                  stickyHeader: { type: 'boolean' },
                },
              },
              accessibility: {
                type: 'object',
                properties: {
                  skipLinkLabel: { type: 'string' },
                  highContrast: { type: 'boolean' },
                  reducedMotion: { type: 'boolean' },
                  focusOutline: {
                    type: 'object',
                    properties: {
                      color: { type: 'string' },
                      width: { type: 'number' },
                      offset: { type: 'number' },
                    },
                  },
                },
              },
              localization: {
                type: 'object',
                properties: {
                  locale: { type: 'string' },
                  dateFormat: { type: 'string' },
                  direction: { type: 'string' },
                  translations: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                  },
                },
              },
              telemetry: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  namespace: { type: 'string' },
                  events: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        category: { type: 'string' },
                        includePagePath: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              experiments: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    active: { type: 'boolean' },
                    variant: { type: 'string' },
                    allocation: { type: 'number' },
                  },
                },
              },
              responsive: {
                type: 'object',
                properties: {
                  breakpoints: {
                    type: 'object',
                    properties: {
                      compact: { type: 'number' },
                      regular: { type: 'number' },
                      wide: { type: 'number' },
                    },
                  },
                  imageQuality: { type: 'integer' },
                  hideDecorativeImages: { type: 'boolean' },
                },
              },
              footer: {
                type: 'object',
                properties: {
                  sections: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        heading: { type: 'string' },
                        links: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              label: { type: 'string' },
                              destination: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                  },
                  legalNotice: { type: 'string' },
                },
              },
              search: {
                type: 'object',
                properties: {
                  placeholder: { type: 'string' },
                  suggestionsEnabled: { type: 'boolean' },
                  maximumSuggestions: { type: 'integer' },
                  filters: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        key: { type: 'string' },
                        label: { type: 'string' },
                        defaultValue: { type: 'string' },
                      },
                    },
                  },
                },
              },
              account: {
                type: 'object',
                properties: {
                  signInLabel: { type: 'string' },
                  profilePath: { type: 'string' },
                  menuItems: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        destination: { type: 'string' },
                        requiresSession: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              legal: {
                type: 'object',
                properties: {
                  privacyPath: { type: 'string' },
                  termsPath: { type: 'string' },
                  consent: {
                    type: 'object',
                    properties: {
                      required: { type: 'boolean' },
                      rememberChoice: { type: 'boolean' },
                      categories: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                  },
                },
              },
              featureFlags: {
                type: 'object',
                additionalProperties: { type: 'boolean' },
              },
              assets: {
                type: 'object',
                properties: {
                  basePath: { type: 'string' },
                  preload: { type: 'array', items: { type: 'string' } },
                  fonts: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        family: { type: 'string' },
                        source: { type: 'string' },
                        weight: { type: 'integer' },
                      },
                    },
                  },
                },
              },
  },
};

const complexSettingsRuntime: OpelRuntime = {
  schemas: {
    'page-settings': complexSettingsSchema,
  },
  functions: {
    pageSettings: {
      signatures: [
        {
          parameters: [],
          returns: { $ref: 'page-settings' },
        },
      ],
    },
  },
};

export const SimilarPropertySuggestion: StoryObj = {
  name: 'Large schema typo: property not defined',
  ...createEditorStory({
    doc: 'pageSettings().banners',
    runtime: complexSettingsRuntime,
  }),
};
