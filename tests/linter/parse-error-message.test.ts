import { describe, expect, it } from 'vitest';
import { resolveParseErrorMessage } from '../../src/linter/parse-error-message';
import type { DelimiterAnalysis } from '../../src/linter/types';

const noDelimiterIssues: DelimiterAnalysis = {
  unclosed: [],
  unexpectedClose: null,
};

describe('resolveParseErrorMessage', () => {
  it('returns specific message for unsupported "or" keyword', () => {
    const message = resolveParseErrorMessage({
      errorText: 'or',
      context: "null or '1'",
      isNearEnd: false,
      isEmptyOrWhitespace: false,
      delimiterAnalysis: noDelimiterIssues,
      logicalKeyword: 'or',
      nodeFrom: 8,
      nodeTo: 10,
    });

    expect(message).toContain('Logical keyword "or" is not supported');
    expect(message).toContain('Use "||" instead');
  });

  it('returns unclosed delimiter message near end of input', () => {
    const message = resolveParseErrorMessage({
      errorText: '',
      context: '(a + 1',
      isNearEnd: true,
      isEmptyOrWhitespace: true,
      delimiterAnalysis: {
        unclosed: [{ open: '(', pos: 0 }],
        unexpectedClose: null,
      },
      logicalKeyword: null,
      nodeFrom: 6,
      nodeTo: 6,
    });

    expect(message).toContain('Unclosed parenthesis');
    expect(message).toContain('Missing ")"');
  });
});
