import { describe, expect, it } from 'vitest';
import { compareTextVersions } from './version-difference.js';
describe('fixed version text comparison', () => {
  it('keeps shared edges separate and preserves intervening unchanged lines', () => {
    expect(
      compareTextVersions('start\nold\nstable\nold2\nend\n', 'start\nnew\nstable\nnew2\nend\n'),
    ).toMatchObject({
      equal: false,
      prefixLines: 1,
      suffixLines: 1,
      before: 'old\nstable\nold2\n',
      after: 'new\nstable\nnew2\n',
      truncated: false,
    });
    expect(compareTextVersions('a\nb\n', 'a\nnew\nb\n')).toMatchObject({
      before: '',
      after: 'new\n',
      prefixLines: 1,
      suffixLines: 1,
    });
  });
  it('distinguishes empty content, line endings, trailing newline and BOM', () => {
    expect(compareTextVersions('', '')).toMatchObject({ equal: true, before: '', after: '' });
    expect(compareTextVersions('a\r\n', 'a\n')).toMatchObject({
      equal: false,
      before: 'a\r\n',
      after: 'a\n',
    });
    expect(compareTextVersions('a\n', 'a').afterFormat).toContain('结尾无换行');
    expect(compareTextVersions('\uFEFFa', 'a')).toMatchObject({
      equal: false,
      beforeFormat: expect.stringContaining('有 BOM'),
      afterFormat: expect.stringContaining('无 BOM'),
    });
  });
  it('bounds previews by Unicode characters without splitting surrogate pairs or claiming completeness', () => {
    const value = compareTextVersions('😀'.repeat(12001), 'new');
    expect(value.truncated).toBe(true);
    expect([...value.before]).toHaveLength(12000);
    expect(value.before).toBe('😀'.repeat(12000));
    expect(compareTextVersions('same\n', 'same\n')).toMatchObject({
      equal: true,
      before: '',
      after: '',
      prefixLines: 1,
    });
  });
});
