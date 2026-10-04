import { describe, expect, it } from 'vitest';
import { visibleReadSequence } from './read-state.js';

const viewport = { tabVisible: true, unobscured: true, viewportTop: 100, viewportBottom: 400 };
describe('human read cursor', () => {
  it('does not treat fetched or offscreen messages as read', () => {
    expect(
      visibleReadSequence({
        ...viewport,
        messages: [
          { seq: '1', top: 0, bottom: 90 },
          { seq: '2', top: 150, bottom: 200 },
          { seq: '3', top: 450, bottom: 500 },
        ],
      }),
    ).toBe('2');
  });
  it('does not advance in a hidden tab or behind a dialog', () => {
    const messages = [{ seq: '100', top: 150, bottom: 200 }];
    expect(visibleReadSequence({ ...viewport, tabVisible: false, messages })).toBeNull();
    expect(visibleReadSequence({ ...viewport, unobscured: false, messages })).toBeNull();
  });
  it('requires an actual visible part and preserves bigint message sequence precision', () => {
    expect(
      visibleReadSequence({
        ...viewport,
        messages: [
          { seq: '9007199254740993', top: 150, bottom: 200 },
          { seq: '9007199254740994', top: 250, bottom: 300 },
          { seq: '9007199254740995', top: 399, bottom: 500 },
        ],
      }),
    ).toBe('9007199254740994');
  });
});
