import { describe, expect, it } from 'vitest';
import { extractText } from '../src/integrations/web/extractor.js';

describe('extractText', () => {
  it('extracts title and strips chrome', () => {
    const html = `<!doctype html>
      <html><head><title>  Linen 101  </title></head>
      <body>
        <header>SITE NAV</header>
        <nav>menu</nav>
        <article>
          <h1>How to wash linen</h1>
          <p>Cold water and gentle cycle.</p>
        </article>
        <footer>copyright 2026</footer>
        <script>console.log('tracker')</script>
      </body></html>`;
    const result = extractText(html);
    expect(result.title).toBe('Linen 101');
    expect(result.text).toContain('How to wash linen');
    expect(result.text).toContain('Cold water and gentle cycle.');
    expect(result.text).not.toContain('SITE NAV');
    expect(result.text).not.toContain('menu');
    expect(result.text).not.toContain('copyright 2026');
    expect(result.text).not.toContain('tracker');
  });

  it('prefers <main> over <body> when both exist', () => {
    const html = `<html><body>
      <p>body-only paragraph that should be skipped</p>
      <main><p>real main content</p></main>
    </body></html>`;
    const result = extractText(html);
    expect(result.text).toContain('real main content');
    expect(result.text).not.toContain('body-only paragraph');
  });

  it('falls back to <body> when no main region exists', () => {
    const html = `<html><body><p>only paragraph</p></body></html>`;
    expect(extractText(html).text).toBe('only paragraph');
  });

  it('collapses whitespace runs', () => {
    const html = `<html><body><article>foo\n\n   bar\t\tbaz</article></body></html>`;
    expect(extractText(html).text).toBe('foo bar baz');
  });

  it('returns no title when <title> is missing or empty', () => {
    const html = `<html><body><article>x</article></body></html>`;
    expect(extractText(html).title).toBeUndefined();
  });
});
