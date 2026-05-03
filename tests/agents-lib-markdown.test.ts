import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../src/agents/lib/markdown.js';

describe('markdownToHtml', () => {
  it('converts headings', () => {
    expect(markdownToHtml('# Hello')).toContain('<h1>Hello</h1>');
  });

  it('converts unordered lists', () => {
    const html = markdownToHtml('- a\n- b');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
  });

  it('converts paragraphs', () => {
    expect(markdownToHtml('hello\n\nworld')).toContain('<p>hello</p>');
  });

  it('preserves inline links', () => {
    expect(markdownToHtml('[x](https://e.com)')).toContain('<a href="https://e.com">x</a>');
  });

  it('preserves images', () => {
    expect(markdownToHtml('![alt](https://e.com/a.png)')).toContain(
      '<img src="https://e.com/a.png" alt="alt"',
    );
  });

  it('returns empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });

  it('handles fenced code blocks', () => {
    const html = markdownToHtml('```\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
  });

  it('passes through unsanitized HTML — sanitization is publisher responsibility', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toContain('<script>alert(1)</script>');
  });

  it('renders GFM tables', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    const html = markdownToHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });
});
