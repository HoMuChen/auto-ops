import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

interface ParsedPack {
  key: string;
  name: string;
  version: string | number;
  body: string;
}

async function readPack(filePath: string): Promise<ParsedPack | null> {
  const raw = await readFile(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const fmRaw = match[1] ?? '';
  const body = (match[2] ?? '').trim();
  const fm: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) fm[k] = v;
  }
  if (!fm.key || !fm.name || !fm.version) return null;
  return { key: fm.key, name: fm.name, version: fm.version, body };
}

/**
 * Load and concatenate enabled packs from `dir/*.md`. Each pack file must have
 * frontmatter with `key`, `name`, `version`. Packs whose `key` is not in
 * `enabled` (or set to false) are skipped. Output order is alphabetical.
 */
export async function loadPacks(dir: string, enabled: Record<string, boolean>): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const sections: string[] = [];
  for (const file of files) {
    const parsed = await readPack(path.join(dir, file));
    if (!parsed) continue;
    if (!enabled[parsed.key]) continue;
    sections.push(`## Skill: ${parsed.name} (v${parsed.version})\n\n${parsed.body}`);
  }
  return sections.join('\n\n');
}
