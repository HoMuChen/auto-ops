import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { listPacksForAgent } from '../skill-packs-repository.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

interface ParsedPack {
  key: string;
  name: string;
  version: string | number;
  body: string;
}

async function readBuiltInPack(filePath: string): Promise<ParsedPack | null> {
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
 * Discriminated form: tenant DB packs require BOTH `tenantId` and `agentId`.
 * Supplying just one is a compile error — prevents a footgun where a
 * half-supplied call silently skips the DB lookup.
 */
export type PackSource =
  | {
      /** Built-in agent dir (e.g. `<agentDir>/packs/`). */
      builtInDir: string;
      /** Built-in pack on/off, keyed by frontmatter `key`. */
      builtInEnabled: Record<string, boolean>;
      /**
       * Omit both `tenantId` and `agentId` to load only built-ins — keeps the
       * function callable from places without a tenant context (e.g.
       * activation form preview).
       */
      tenantId?: undefined;
      agentId?: undefined;
    }
  | {
      builtInDir: string;
      builtInEnabled: Record<string, boolean>;
      tenantId: string;
      agentId: string;
    };

/**
 * Load and concatenate enabled packs.
 *
 * Order: built-in (alphabetical) → tenant DB (alphabetical by name).
 * Built-in headings include a version suffix `(v<n>)`; tenant packs do not —
 * their schema has no version column.
 * Built-ins act as defaults; tenant-supplied packs sit after so they read
 * as "additional house style on top".
 */
export async function loadPacks(src: PackSource): Promise<string> {
  const sections: string[] = [];

  // 1. Built-in fs packs (existing logic).
  const files = (await readdir(src.builtInDir)).filter((f) => f.endsWith('.md')).sort();
  for (const file of files) {
    const parsed = await readBuiltInPack(path.join(src.builtInDir, file));
    if (!parsed) continue;
    if (!src.builtInEnabled[parsed.key]) continue;
    sections.push(`## Skill: ${parsed.name} (v${parsed.version})\n\n${parsed.body}`);
  }

  // 2. Tenant DB packs (new). Only triggers when both tenantId AND agentId are
  // supplied — callers without tenant context (e.g. activation form preview)
  // get just the built-ins.
  if (src.tenantId && src.agentId) {
    const tenantPacks = await listPacksForAgent(src.tenantId, src.agentId);
    for (const p of tenantPacks) {
      sections.push(`## Skill: ${p.name}\n\n${p.body.trim()}`);
    }
  }

  return sections.join('\n\n');
}
