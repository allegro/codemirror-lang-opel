export const OPEL_KEYWORDS = [
  'val',
  'if',
  'else',
  'true',
  'false',
  'null',
] as const;

export const OPEL_KEYWORD_COMPLETIONS = [
  { label: 'val', type: 'keyword', detail: 'variable declaration' },
  { label: 'if', type: 'keyword', detail: 'conditional expression' },
  { label: 'else', type: 'keyword', detail: 'alternative branch' },
  { label: 'true', type: 'keyword', detail: 'boolean literal' },
  { label: 'false', type: 'keyword', detail: 'boolean literal' },
  { label: 'null', type: 'keyword', detail: 'null literal' },
] as const;

export const UNSUPPORTED_LOGICAL_KEYWORD_REPLACEMENTS = {
  and: '&&',
  or: '||',
} as const;

export type UnsupportedLogicalKeyword =
  keyof typeof UNSUPPORTED_LOGICAL_KEYWORD_REPLACEMENTS;
