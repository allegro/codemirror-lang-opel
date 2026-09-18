export type OpelPrimitive =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null';

export type OpelSchema =
  | boolean
  | {
      readonly type?: OpelPrimitive | readonly OpelPrimitive[];
      readonly nullable?: boolean;
      readonly properties?: Readonly<Record<string, OpelSchema>>;
      readonly required?: readonly string[];
      readonly items?: OpelSchema;
      readonly additionalProperties?: boolean | OpelSchema;
      readonly patternProperties?: Readonly<Record<string, OpelSchema>>;
      readonly const?: unknown;
      readonly enum?: readonly unknown[];
      readonly oneOf?: readonly OpelSchema[];
      readonly anyOf?: readonly OpelSchema[];
      readonly allOf?: readonly OpelSchema[];
      readonly definitions?: Readonly<Record<string, OpelSchema>>;
      readonly $defs?: Readonly<Record<string, OpelSchema>>;
      readonly $ref?: string;
      readonly deprecated?: boolean | string;
      readonly callable?: OpelCallable;
      readonly title?: string;
      readonly description?: string;
      readonly [keyword: string]: unknown;
    };

export interface OpelParameter {
  readonly name?: string;
  readonly schema: OpelSchema;
  readonly optional?: boolean;
}

export interface OpelSignature {
  readonly parameters: readonly OpelParameter[];
  readonly returns: OpelSchema;
  readonly deprecated?: boolean | string;
}

export interface OpelCallable {
  readonly signatures: readonly OpelSignature[];
  readonly deprecated?: boolean | string;
}

export type OpelMethodReceiver =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

export interface OpelRuntime {
  readonly globals?: Readonly<Record<string, OpelSchema>>;
  readonly functions?: Readonly<Record<string, OpelCallable>>;
  readonly methods?: Readonly<
    Partial<Record<OpelMethodReceiver, Readonly<Record<string, OpelCallable>>>>
  >;
  readonly schemas?: Readonly<Record<string, OpelSchema>>;
}

export type OpelRuntimeIssueCode =
  | 'invalid-runtime-entry'
  | 'duplicate-symbol'
  | 'invalid-schema'
  | 'unresolved-reference'
  | 'invalid-pattern'
  | 'invalid-signature'
  | 'invalid-metadata';

export interface OpelRuntimeIssue {
  readonly code: OpelRuntimeIssueCode;
  readonly path: string;
  readonly message: string;
  readonly severity: 'warning' | 'error';
}

export interface OpelOptions {
  warnOnLambdaDefinitions?: boolean;
  runtime?: OpelRuntime;
  onRuntimeIssues?: (issues: readonly OpelRuntimeIssue[]) => void;
}

export interface OpelExtensionsOptions extends OpelOptions {
  enableLinter?: boolean;
  includeLintGutter?: boolean;
}
