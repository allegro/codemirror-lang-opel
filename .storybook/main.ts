import type { StorybookConfig } from '@storybook/html-vite';

const config: StorybookConfig = {
  stories: ['../examples/storybook/stories/**/*.stories.ts'],
  addons: ['@storybook/addon-docs'],
  docs: {
    autodocs: 'tag',
  },
  framework: {
    name: '@storybook/html-vite',
    options: {},
  },
};

export default config;
