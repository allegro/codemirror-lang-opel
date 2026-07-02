import { describe, expect, it } from 'vitest';
import { lint } from '../support/test-utils';

describe('lambda definition warnings', () => {
  it('warns about lambda definitions by default', () => {
    const diagnostics = lint('val square = (x) -> x * x; square(5)');
    const lambdaWarnings = diagnostics.filter(
      (d) => d.severity === 'warning' && d.message.includes('Lambda definition')
    );

    expect(lambdaWarnings).toHaveLength(1);
  });

  it('can disable lambda definition warnings', () => {
    const diagnostics = lint('val square = (x) -> x * x; square(5)', {
      warnOnLambdaDefinitions: false,
    });
    const lambdaWarnings = diagnostics.filter(
      (d) => d.severity === 'warning' && d.message.includes('Lambda definition')
    );

    expect(lambdaWarnings).toHaveLength(0);
  });
});
