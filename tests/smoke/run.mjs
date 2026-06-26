import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'codemirror-lang-opel-smoke-'));
const verifyScript = fileURLToPath(new URL('./verify-package.mjs', import.meta.url));
const repoRoot = path.resolve(path.dirname(verifyScript), '..', '..');
const tarball = path.join(tmpdir, 'package.tgz');

try {
  const packedName = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--silent', '--pack-destination', tmpdir],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .pop();

  if (!packedName) {
    throw new Error('npm pack did not produce a tarball.');
  }

  renameSync(path.join(tmpdir, packedName), tarball);

  execFileSync('npm', ['init', '-y'], { cwd: tmpdir, stdio: 'ignore' });

  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-save',
      tarball,
      '@codemirror/autocomplete@^6.20.3',
      '@codemirror/language@^6.12.3',
      '@codemirror/lint@^6.9.7',
      '@codemirror/state@^6.6.0',
      '@codemirror/view@^6.43.1',
      '@lezer/highlight@^1.0.0',
      '@lezer/lr@^1.4.10',
    ],
    { cwd: tmpdir, stdio: 'ignore' }
  );

  execFileSync('node', [verifyScript], { cwd: tmpdir, stdio: 'ignore' });
} finally {
  rmSync(tmpdir, { recursive: true, force: true });
}
