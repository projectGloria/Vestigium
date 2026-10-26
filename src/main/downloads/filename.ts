import { extname } from 'node:path';

// File names for downloads: picked from Content-Disposition, then the URL, then the page title (plan §11), and made
// safe for Windows. Pure functions; the queue decides the directory and asks `uniqueName` to avoid overwriting.

// NTFS allows 255 UTF-16 units per name, but the whole path must stay under MAX_PATH (260) for tools that are not
// long-path aware (Explorer, many unpackers). 150 leaves room for a reasonably deep download folder.
export const MAX_NAME_LENGTH = 150;

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Bidi controls can make "invoice<RLO>fdp.exe" display as "invoiceexe.pdf"; they never belong in a file name.
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

const MIME_EXTENSIONS: Record<string, string> = {
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip', 'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar', 'application/x-7z-compressed': '.7z', 'application/pdf': '.pdf',
  'application/gzip': '.gz', 'application/x-tar': '.tar', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4', 'text/plain': '.txt', 'application/epub+zip': '.epub',
};

export function extensionFor(mimeType: string | null): string {
  if (!mimeType) return '';
  return MIME_EXTENSIONS[mimeType.split(';')[0].trim().toLowerCase()] ?? '';
}

// RFC 6266: `filename*` (RFC 5987, percent-encoded with a charset) wins over `filename`.
export function nameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    const charset = extended[1].trim().toLowerCase();
    const raw = extended[2].trim().replace(/^"(.*)"$/, '$1');
    try {
      if (charset === 'utf-8' || charset === '') return decodeURIComponent(raw);
      // ISO-8859-1: every percent-escape is one byte, one code point.
      return raw.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    } catch { /* malformed escapes: fall back to the plain parameter */ }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const token = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return token ? token[1] : null;
}

export function nameFromUrl(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    if (!segment) return null;
    const name = decodeURIComponent(segment);
    // A bare path word ("download", "file") says nothing about the file; only a name with an extension counts.
    return extname(name) ? name : null;
  } catch {
    return null;
  }
}

// Makes any string a valid, unsurprising Windows file name. Never returns an empty string.
export function sanitizeName(input: string, maxLength = MAX_NAME_LENGTH): string {
  let name = input.normalize('NFC').replace(BIDI_CONTROLS, '').replace(INVALID, '_').replace(/\s+/g, ' ').trim();
  // Windows silently drops trailing dots and spaces, so "notes." and "notes" would collide.
  name = name.replace(/[. ]+$/, '');
  if (!name || /^\.+$/.test(name)) name = 'download';
  let extension = extname(name);
  // A long "extension" is not one ("Long title … .zip" is fine, "a.b-really-long-tail" is not).
  if (extension.length > 16) extension = '';
  let stem = extension ? name.slice(0, -extension.length) : name;
  if (RESERVED.test(stem.split('.')[0])) stem = `_${stem}`;
  // Trim by code points so a surrogate pair (emoji, rare CJK) is never cut in half.
  const room = Math.max(1, maxLength - extension.length);
  const points = [...stem];
  if (points.length > room) stem = points.slice(0, room).join('').replace(/[. ]+$/, '') || 'download';
  return `${stem}${extension}`;
}

// The plan's order: Content-Disposition, then the URL, then the page title (with an extension from the MIME type).
export function chooseName(options: {
  contentDisposition: string | null; url: string; title: string | null; mimeType: string | null; suggested?: string | null;
}): string {
  const fromHeader = nameFromContentDisposition(options.contentDisposition);
  if (fromHeader) return sanitizeName(fromHeader);
  const fromUrl = nameFromUrl(options.url);
  if (fromUrl) return sanitizeName(fromUrl);
  // Chromium's own guess (it saw the original response) beats a page title when it has an extension.
  if (options.suggested && extname(options.suggested)) return sanitizeName(options.suggested);
  const title = options.title?.trim();
  return sanitizeName(`${title || 'download'}${extensionFor(options.mimeType)}`);
}

// "notes.zip" → "notes (2).zip" → "notes (3).zip": the first name `taken` does not claim. Case-insensitive, like NTFS.
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const extension = extname(name).length <= 16 ? extname(name) : '';
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 2; index < 10_000; index++) {
    const suffix = ` (${index})`;
    const candidate = sanitizeName(`${[...stem].slice(0, MAX_NAME_LENGTH - extension.length - suffix.length).join('')}${suffix}${extension}`);
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`Too many files named "${name}".`);
}

// ---------- templates (plan §5: "{site}/{tag}/{title}.{ext}") ----------

export const DEFAULT_TEMPLATE = '{site}/{filename}';

// "Unzip password" → "unzip_password": how a metadata label is written as a {token}.
export const tokenOf = (label: string) => label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Values for a template: {site} {title} {filename} {name} {ext} {tag} {date}, plus every metadata label as a token.
export function templateValues(options: { site: string; filename: string; title: string; metadata: Record<string, string> }): Record<string, string> {
  const extension = extname(options.filename).length <= 16 ? extname(options.filename) : '';
  const values: Record<string, string> = {};
  for (const [label, value] of Object.entries(options.metadata)) {
    const token = tokenOf(label);
    if (token && !(token in values)) values[token] = value;
  }
  const tags = values.tags ?? values.tag ?? '';
  return {
    ...values, site: options.site, title: options.metadata.Title || options.title || '', filename: options.filename,
    name: extension ? options.filename.slice(0, -extension.length) : options.filename, ext: extension.replace(/^\./, ''),
    tag: tags.split(/[,;|]/)[0]?.trim() ?? '', date: values.date ?? values.published ?? '',
  };
}

// Resolves a template into folders and a file name. Every part is sanitized on its own, so a value can never add
// folders ("a/b" in a title becomes "a_b"). Empty folder parts are dropped; an empty file part falls back to the
// file's own name. The real extension is always kept, so a template cannot turn a ZIP into "x.exe".
export function applyTemplate(template: string, values: Record<string, string>): { folders: string[]; name: string } {
  const parts = template.split('/').map(part => part.replace(/\{([a-z0-9_]+)\}/g, (_match, token: string) => (values[token] ?? '').replace(/[/\\]/g, '_')).trim());
  const folders = parts.slice(0, -1).filter(part => part.replace(/[. ]/g, '') !== '').map(part => sanitizeName(part, 80));
  const extension = values.ext ? `.${values.ext}` : '';
  let name = parts.at(-1) ?? '';
  if (name.replace(/[. ]/g, '') === '') name = values.filename;
  if (extension && !name.toLowerCase().endsWith(extension.toLowerCase())) name = `${name}${extension}`;
  return { folders, name: sanitizeName(name) };
}
