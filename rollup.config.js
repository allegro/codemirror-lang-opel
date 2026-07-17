import path from 'node:path';
import typescript from '@rollup/plugin-typescript';
import { lezer } from '@lezer/generator/rollup';

export default {
  input: 'src/index.ts',
  external: (id) =>
    id !== 'tslib' &&
    !id.startsWith('\0') &&
    !id.startsWith('.') &&
    !path.isAbsolute(id),
  output: [
    { file: 'dist/index.cjs', format: 'cjs' },
    { dir: './dist', format: 'es' },
  ],
  plugins: [lezer(), typescript()],
};
