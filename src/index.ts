import { parser } from './parser';
import {
  continuedIndent,
  indentNodeProp,
  delimitedIndent,
  foldNodeProp,
  foldInside,
  LRLanguage,
  LanguageSupport,
} from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { autocompletion } from '@codemirror/autocomplete';
import { opelCompletions } from './opel-autocomplete';
import { linter, lintGutter } from '@codemirror/lint';
import { opelLinter } from './linter';
export { opelLinter } from './linter';

export interface OpelOptions {}

export interface OpelExtensionsOptions extends OpelOptions {
  enableLinter?: boolean;
  includeLintGutter?: boolean;
}

/// A language provider based on the OPEL
/// parser, extended with highlighting and indentation information.
/// OPEL is used for writing expressions in configuration and templating contexts.
export const opelLanguage = LRLanguage.define({
  name: 'opel',
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        // OPEL-specific indentation rules
        IfExpression: continuedIndent({ except: /^\s*(else\b)/ }),
        FunctionInstantiation: continuedIndent(),
        BlockExpression: delimitedIndent({ closing: '}' }),
        MapInstantiation: delimitedIndent({ closing: '}' }),
        ListInstantiation: delimitedIndent({ closing: ']' }),
        FunctionCall: continuedIndent(),
        MethodCall: continuedIndent(),
        Declaration: continuedIndent({ except: /^\s*(val\b)/ }),
        Train: continuedIndent(),
        // Add indentation for complex expressions
        OrExpression: continuedIndent(),
        AndExpression: continuedIndent(),
        AdditiveExpression: continuedIndent(),
        MultiplyExpression: continuedIndent(),
      }),
      foldNodeProp.add({
        // OPEL structures that can be folded
        ['BlockExpression MapInstantiation ListInstantiation FunctionInstantiation']:
          foldInside,
        // Allow folding of complex if expressions
        IfExpression: foldInside,
      }),
    ],
  }),
  languageData: {
    // Indent trigger patterns
    indentOnInput: /^\s*(?:else\b|val\b|\}|\]|\)|;)$/,
    // Auto-close brackets, braces, and quotes
    closeBrackets: {
      brackets: ['(', '[', '{', "'", '"'],
      // Don't auto-close before certain characters
      before: ')]};\n\t ',
    },
    // Word characters for OPEL identifiers (includes $ and _)
    wordChars: '$_',
    // Autocomplete configuration
    autocomplete: {
      // Complete keywords
      keywords: ['val', 'if', 'else', 'true', 'false', 'null', 'and', 'or'],
    },
  },
});

/// OPEL language support with optional configuration.
export function opel(options: OpelOptions = {}) {
  return new LanguageSupport(opelLanguage, [
    autocompletion({
      override: [opelCompletions()],
    }),
  ]);
}

/// OPEL language and lint extensions configured from one shared options object.
export function opelExtensions(
  options: OpelExtensionsOptions = {}
): Extension[] {
  const { enableLinter = true, includeLintGutter = true } = options;

  const extensions: Extension[] = [opel()];

  if (enableLinter) {
    if (includeLintGutter) {
      extensions.push(lintGutter());
    }

    extensions.push(linter(opelLinter()));
  }

  return extensions;
}
