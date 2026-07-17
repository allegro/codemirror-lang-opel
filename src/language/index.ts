import { parser } from '../generated/parser';
import {
  continuedIndent,
  indentNodeProp,
  delimitedIndent,
  foldNodeProp,
  foldInside,
  LRLanguage,
  LanguageSupport,
} from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';
import { opelCompletions } from '../autocomplete';
import type { OpelOptions } from '../types';
import { OPEL_KEYWORDS } from '../syntax/constants';

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
      keywords: [...OPEL_KEYWORDS],
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
