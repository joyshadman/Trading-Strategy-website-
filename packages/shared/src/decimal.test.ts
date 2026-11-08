import { describe, expect, it } from 'vitest';
import { Money, roundDownToStep, toDecimal, toDecimalString } from './decimal.js';

describe('decimal helpers', () => {
  it('adds without float drift', () => {
    expect(toDecimalString(toDecimal('0.1').plus('0.2'))).toBe('0.3');
  });

  it('rounds half to even', () => {
    expect(new Money('2.5').toDecimalPlaces(0).toString()).toBe('2');
    expect(new Money('3.5').toDecimalPlaces(0).toString()).toBe('4');
  });

  it('rounds order size down to the step', () => {
    expect(roundDownToStep(toDecimal('0.123456'), toDecimal('0.001')).toString()).toBe('0.123');
  });

  it('rejects non decimal strings', () => {
    expect(() => toDecimal('1e5')).toThrow();
  });
});
