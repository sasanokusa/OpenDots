import { entries as appEntries, patterns as appPatterns } from './ja-app';
import { entries as chatEntries, patterns as chatPatterns } from './ja-chat';
import { entries as pageEntries, patterns as pagePatterns } from './ja-pages';
import {
  entries as serverEntries,
  patterns as serverPatterns,
} from './ja-server';

export type Locale = 'ja' | 'en';
export type Vars = Record<string, string | number>;
/** A server message shape and its translation; `$1`… refer to capture groups. */
export type Pattern = readonly [RegExp, string];

// English is the source language. Upstream tests assert English text, so
// tests render in English; the fork's app renders in Japanese.
let locale: Locale = import.meta.env?.MODE === 'test' ? 'en' : 'ja';

// Looked up in order, so a screen-specific entry wins over a server one.
const catalogs = [pageEntries, chatEntries, appEntries, serverEntries];
const lookup = (text: string) => {
  for (const entries of catalogs)
    if (Object.hasOwn(entries, text)) return entries[text];
  return undefined;
};
const patterns: Pattern[] = [
  ...appPatterns,
  ...chatPatterns,
  ...pagePatterns,
  ...serverPatterns,
];

export function setLocale(next: Locale) {
  locale = next;
}

export function getLocale(): Locale {
  return locale;
}

/** BCP 47 tag for Intl and toLocale* calls. */
export function intlLocale() {
  return locale === 'ja' ? 'ja-JP' : 'en-US';
}

function fill(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Translate a UI string written in English. Placeholders use `{name}` and are
 * filled from `vars` in either language. Missing entries fall back to English.
 */
export function t(text: string, vars?: Vars): string {
  return fill(locale === 'ja' ? (lookup(text) ?? text) : text, vars);
}

/**
 * Translate a message that came from the server or a library (error text),
 * trying exact entries first and then patterns. Unknown text is returned as is.
 */
export function tMessage(message: string): string {
  if (locale !== 'ja') return message;
  const exact = lookup(message);
  if (exact) return exact;
  for (const [pattern, replacement] of patterns)
    if (pattern.test(message)) return message.replace(pattern, replacement);
  return message;
}
