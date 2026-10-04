import { describe, expect, it } from 'vitest';
import { commandIdentity, decimalToMicrounits, formatMicrounits, requiredLines } from './task-state.js';

describe('task command boundaries', () => {
  it('does not lose precision when converting money across the safe-number boundary', () => {
    const amount = '9223372036854.775807';
    expect(decimalToMicrounits(amount)).toBe('9223372036854775807');
    expect(formatMicrounits(decimalToMicrounits(amount))).toBe(amount);
    expect(decimalToMicrounits('0.000001')).toBe('1');
    expect(() => decimalToMicrounits('9223372036854.775808')).toThrow();
    expect(() => decimalToMicrounits('0.0000001')).toThrow();
    expect(() => decimalToMicrounits('-1')).toThrow();
  });
  it('retries the same terms/version under the same key and changes it on deliberate rebase', () => {
    const first = commandIdentity(null, { decision: 'accept' }, '9007199254740993', () => 'first');
    expect(commandIdentity(first, { decision: 'accept' }, '9007199254740993', () => 'unused')).toBe(first);
    expect(commandIdentity(first, { decision: 'accept' }, '9007199254740994', () => 'rebased').key).toBe('rebased');
    expect(commandIdentity(first, { decision: 'reject' }, '9007199254740993', () => 'changed').key).toBe('changed');
  });
  it('requires explicit nonempty acceptance criteria and bounds their count', () => {
    expect(requiredLines('验证登录\n\n 验证撤权 ')).toEqual(['验证登录', '验证撤权']);
    expect(() => requiredLines(' \n')).toThrow();
    expect(() => requiredLines(Array.from({ length: 21 }, () => '条件').join('\n'))).toThrow();
  });
});
