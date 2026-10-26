import type { PageMetadata } from '../../shared/learn.js';

// Turns an item page's facts into the item's metadata (stored with the item, written to the sidecar, used by filename
// templates and to unpack archives). Keys are the user's label spellings, plus "Title", "Tags" and "Date".

// Labels that mean "the archive password", in the languages plan §2 hints at. Matched case-insensitively.
const PASSWORD_LABELS = new Set([
  'password', 'pass', 'pw', 'pwd', 'unzip password', 'archive password', 'zip password', 'rar password', 'extract password', 'decryption password',
  'şifre', 'parola', 'arşiv şifresi', 'contraseña', 'clave', 'mot de passe', 'passwort', 'kennwort', 'senha', 'wachtwoord', 'пароль', '密码', '密碼', 'パスワード',
]);

export const isPasswordLabel = (label: string) => PASSWORD_LABELS.has(label.trim().replace(/[\s:：]+$/u, '').toLowerCase());

export function toItemMetadata(page: PageMetadata): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (page.title) metadata.Title = page.title;
  for (const field of page.fields) metadata[field.label] = field.value;
  // A labelled "Tags"/"Date" on the page wins over rel=tag links and <time> elements.
  if (page.tags.length && !Object.keys(metadata).some(key => /^tags?$/i.test(key))) metadata.Tags = page.tags.join(', ');
  if (page.date && !Object.keys(metadata).some(key => /^(date|published)$/i.test(key))) metadata.Date = page.date;
  return metadata;
}

// The archive password: the first field whose label means "password".
export function passwordOf(metadata: Record<string, string>): string | null {
  const key = Object.keys(metadata).find(isPasswordLabel);
  return key ? metadata[key] : null;
}

// Labels only, for logs and the UI: values may be passwords and are never logged.
export const detailLabels = (metadata: Record<string, string>) => Object.keys(metadata);
