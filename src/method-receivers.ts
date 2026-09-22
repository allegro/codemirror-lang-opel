export const PRIMITIVE_METHOD_RECEIVERS = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
] as const;

export type OpelPrimitiveMethodReceiver =
  (typeof PRIMITIVE_METHOD_RECEIVERS)[number];
