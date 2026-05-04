import { parse } from 'node-html-parser';

export interface ExtractedPage {
  title?: string;
  text: string;
}

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'nav',
  'footer',
  'header',
  'aside',
  'iframe',
  'form',
  'svg',
];

const MAIN_CANDIDATES = ['article', 'main', '[role="main"]', '#content', '.content', '.post', '.article'];

/**
 * Strip chrome (nav/footer/etc.) and pull the main content region. Falls back
 * to the body when no obvious main region exists. Returns whitespace-collapsed
 * plain text — the LLM consumer doesn't care about HTML structure, just words.
 */
export function extractText(html: string): ExtractedPage {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });

  const titleEl = root.querySelector('title');
  const title = titleEl?.text.trim() || undefined;

  for (const sel of NOISE_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) {
      el.remove();
    }
  }

  let main = null;
  for (const sel of MAIN_CANDIDATES) {
    main = root.querySelector(sel);
    if (main) break;
  }
  const region = main ?? root.querySelector('body') ?? root;

  const text = region.text.replace(/\s+/g, ' ').trim();
  return title ? { title, text } : { text };
}
