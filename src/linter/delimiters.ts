import type {
  ClosingDelimiter,
  DelimiterAnalysis,
  OpeningDelimiter,
  UnsupportedLogicalKeyword,
  UnclosedDelimiter,
} from './types';
import { UNSUPPORTED_LOGICAL_KEYWORD_REPLACEMENTS } from '../syntax/constants';

export const OPEN_TO_CLOSE: Record<OpeningDelimiter, ClosingDelimiter> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

const CLOSE_TO_OPEN: Record<ClosingDelimiter, OpeningDelimiter> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

export const DELIMITER_NAME: Record<OpeningDelimiter, string> = {
  '(': 'parenthesis',
  '[': 'bracket',
  '{': 'brace',
};

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function identifierAt(source: string, pos: number): string | null {
  if (pos < 0 || pos >= source.length) {
    return null;
  }
  if (!isIdentifierChar(source[pos])) {
    return null;
  }

  let start = pos;
  while (start > 0 && isIdentifierChar(source[start - 1])) {
    start--;
  }

  let end = pos + 1;
  while (end < source.length && isIdentifierChar(source[end])) {
    end++;
  }

  return source.slice(start, end);
}

export function unsupportedLogicalKeywordNear(
  source: string,
  from: number,
  to: number
): UnsupportedLogicalKeyword | null {
  const positions = [from - 1, from, to - 1, to, from + 1];
  for (const pos of positions) {
    const word = identifierAt(source, pos);
    if (
      word &&
      Object.prototype.hasOwnProperty.call(
        UNSUPPORTED_LOGICAL_KEYWORD_REPLACEMENTS,
        word
      )
    ) {
      return word as UnsupportedLogicalKeyword;
    }
  }
  return null;
}

export function analyzeDelimiters(source: string): DelimiterAnalysis {
  const stack: UnclosedDelimiter[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ open: ch, pos: i });
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack[stack.length - 1];
      const expectedOpen = CLOSE_TO_OPEN[ch];
      if (!top || top.open !== expectedOpen) {
        return {
          unclosed: stack,
          unexpectedClose: {
            close: ch,
            pos: i,
            expected: top ? OPEN_TO_CLOSE[top.open] : undefined,
          },
        };
      }
      stack.pop();
    }
  }

  return { unclosed: stack, unexpectedClose: null };
}
