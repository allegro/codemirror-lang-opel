import { linter, lintGutter } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { opel } from '../language';
import { opelLinter } from '../linter';
import type { OpelExtensionsOptions } from '../types';

/// OPEL language and lint extensions configured from one shared options object.
export function opelExtensions(
  options: OpelExtensionsOptions = {}
): Extension[] {
  const { enableLinter = true, includeLintGutter = true } = options;

  const extensions: Extension[] = [opel(options)];

  if (enableLinter) {
    if (includeLintGutter) {
      extensions.push(lintGutter());
    }

    extensions.push(linter(opelLinter(options)));
  }

  return extensions;
}
