import { DELIMITER_NAME, OPEN_TO_CLOSE } from './delimiters';
import type { DelimiterAnalysis, UnsupportedLogicalKeyword } from './types';
import { UNSUPPORTED_LOGICAL_KEYWORD_REPLACEMENTS } from '../syntax/constants';

type ParseErrorMessageInput = {
  errorText: string;
  context: string;
  isNearEnd: boolean;
  isEmptyOrWhitespace: boolean;
  delimiterAnalysis: DelimiterAnalysis;
  logicalKeyword: UnsupportedLogicalKeyword | null;
  nodeFrom: number;
  nodeTo: number;
};

function hasUnexpectedCloseAtNode(
  input: ParseErrorMessageInput,
  unexpectedClose: NonNullable<DelimiterAnalysis['unexpectedClose']>
): boolean {
  return (
    unexpectedClose.pos === input.nodeFrom ||
    unexpectedClose.pos === input.nodeTo ||
    input.errorText.includes(unexpectedClose.close)
  );
}

export function resolveParseErrorMessage(input: ParseErrorMessageInput): string {
  const unexpectedClose = input.delimiterAnalysis.unexpectedClose;

  if (unexpectedClose && hasUnexpectedCloseAtNode(input, unexpectedClose)) {
    if (unexpectedClose.expected) {
      return `Unexpected "${unexpectedClose.close}". Expected "${unexpectedClose.expected}" before this token.`;
    }
    return `Unexpected "${unexpectedClose.close}". No matching opening delimiter found.`;
  }

  if (input.isNearEnd && input.delimiterAnalysis.unclosed.length > 0) {
    const lastUnclosed =
      input.delimiterAnalysis.unclosed[input.delimiterAnalysis.unclosed.length - 1];
    const expectedClose = OPEN_TO_CLOSE[lastUnclosed.open];
    const delimiterName = DELIMITER_NAME[lastUnclosed.open];
    return `Unclosed ${delimiterName}. Missing "${expectedClose}".`;
  }

  if (input.logicalKeyword) {
    const replacement =
      UNSUPPORTED_LOGICAL_KEYWORD_REPLACEMENTS[input.logicalKeyword];
    return `Logical keyword "${input.logicalKeyword}" is not supported. Use "${replacement}" instead.`;
  }

  if (
    input.isNearEnd &&
    input.isEmptyOrWhitespace &&
    input.context.includes('val') &&
    input.context.includes(';')
  ) {
    return 'Unexpected end of input, no value-returning expression found';
  }

  if (input.context.includes('val') && !input.context.includes(';')) {
    return 'Variable declaration requires a semicolon at the end. Use: val name = value;';
  }

  return `Unexpected "${input.errorText}". Please check your syntax`;
}
