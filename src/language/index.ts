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
import { OPEL_NODE_NAMES as NODE } from '../syntax/nodes';

/// A language provider based on the OPEL
/// parser, extended with highlighting and indentation information.
/// OPEL is used for writing expressions in configuration and templating contexts.
export const opelLanguage = LRLanguage.define({
  name: 'opel',
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        // OPEL-specific indentation rules
        [NODE.IfExpression]: continuedIndent({ except: /^\s*(else\b)/ }),
        [NODE.FunctionInstantiation]: continuedIndent(),
        [NODE.BlockExpression]: delimitedIndent({ closing: '}' }),
        [NODE.MapInstantiation]: delimitedIndent({ closing: '}' }),
        [NODE.ListInstantiation]: delimitedIndent({ closing: ']' }),
        [NODE.FunctionCall]: continuedIndent(),
        [NODE.MethodCall]: continuedIndent(),
        [NODE.Declaration]: continuedIndent({ except: /^\s*(val\b)/ }),
        [NODE.PostfixExpression]: continuedIndent(),
        // Add indentation for complex expressions
        [NODE.OrExpression]: continuedIndent(),
        [NODE.AndExpression]: continuedIndent(),
        [NODE.AdditiveExpression]: continuedIndent(),
        [NODE.MultiplyExpression]: continuedIndent(),
      }),
      foldNodeProp.add({
        // OPEL structures that can be folded
        [`${NODE.BlockExpression} ${NODE.MapInstantiation} ${NODE.ListInstantiation} ${NODE.FunctionInstantiation}`]:
          foldInside,
        // Allow folding of complex if expressions
        [NODE.IfExpression]: foldInside,
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
export function opel(_options: OpelOptions = {}) {
  return new LanguageSupport(opelLanguage, [
    autocompletion({
      override: [opelCompletions()],
    }),
  ]);
}
