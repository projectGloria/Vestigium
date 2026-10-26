import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { isPasswordLabel } from '../learn/metadata.js';

// The `<name>_info.txt` file next to a download (plan §5): where it came from, its checksum, and every detail captured
// from the item page, the password first. Plain UTF-8 with a BOM, so Notepad shows non-Latin text correctly.

export interface SidecarFacts {
  file: string; folder: string; title: string; page: string | null; url: string; bytes: number; sha256: string;
  savedAt: string; metadata: Record<string, string>; extractedTo?: string | null;
}

export function sidecarName(file: string): string {
  const extension = extname(file).length <= 16 ? extname(file) : '';
  return `${extension ? file.slice(0, -extension.length) : file}_info.txt`;
}

export function sidecarText(facts: SidecarFacts): string {
  const details = Object.entries(facts.metadata).filter(([label]) => label !== 'Title');
  // The password is what someone opens this file for; it goes first.
  details.sort(([a], [b]) => Number(isPasswordLabel(b)) - Number(isPasswordLabel(a)));
  const lines = [
    `Title: ${facts.metadata.Title || facts.title || facts.file}`,
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    `File: ${facts.file}`,
    `Size: ${facts.bytes} bytes`,
    `SHA-256: ${facts.sha256}`,
    ...(facts.page ? [`Page: ${facts.page}`] : []),
    `Downloaded from: ${facts.url}`,
    `Saved: ${facts.savedAt}`,
    ...(facts.extractedTo ? [`Unpacked to: ${facts.extractedTo}`] : []),
    '',
    'Written by Vestigium.',
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function writeSidecar(facts: SidecarFacts): Promise<string> {
  const path = join(facts.folder, sidecarName(facts.file));
  await writeFile(path, sidecarText(facts), 'utf8');
  return path;
}
