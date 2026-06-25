import type { UnsupportedLogicalKeyword } from '../syntax/constants';

export type OpeningDelimiter = '(' | '[' | '{';
export type ClosingDelimiter = ')' | ']' | '}';

export type UnclosedDelimiter = { open: OpeningDelimiter; pos: number };
export type UnexpectedClose = {
  close: ClosingDelimiter;
  pos: number;
  expected?: ClosingDelimiter;
};

export type DelimiterAnalysis = {
  unclosed: UnclosedDelimiter[];
  unexpectedClose: UnexpectedClose | null;
};

export type { UnsupportedLogicalKeyword };
