import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Quote } from './message-interactions.js';
describe('fixed message references', () => {
  it('never renders an unavailable source body even if a malformed response still includes it', () => {
    const markup = renderToStaticMarkup(
      <Quote
        quote={{
          source_id: 'source',
          source_version: '9007199254740993',
          body: 'revoked private content',
          unavailable: true,
        }}
      />,
    );
    expect(markup).not.toContain('revoked private content');
    expect(markup).toContain('原消息不可用或无权查看');
    expect(markup).toContain('9007199254740993');
  });
  it('renders visible fixed content as text, without activating markup', () => {
    const markup = renderToStaticMarkup(
      <Quote
        quote={{
          source_id: 'source',
          source_version: '1',
          body: '<img src=x onerror=alert(1)>',
          unavailable: false,
        }}
      />,
    );
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });
});
