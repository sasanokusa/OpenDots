import { afterEach, expect, it } from 'vitest';
import {
  getLocale,
  setLocale,
  t,
  tMessage,
} from '../../src/client/selfhost/i18n/index.js';
import { entries } from '../../src/client/selfhost/i18n/ja-app.js';

afterEach(() => setLocale('en'));

it('renders English in tests and falls back to the source text', () => {
  expect(getLocale()).toBe('en');
  expect(t('Delete {name}?', { name: 'Notes' })).toBe('Delete Notes?');
  setLocale('ja');
  expect(t('A string nobody translated')).toBe('A string nobody translated');
  expect(tMessage('Unknown server error')).toBe('Unknown server error');
});

it('fills placeholders in the translated text', () => {
  entries['Delete {name}?'] = '{name}を削除しますか？';
  setLocale('ja');
  expect(t('Delete {name}?', { name: 'メモ' })).toBe('メモを削除しますか？');
  expect(t('Delete {name}?')).toBe('{name}を削除しますか？');
});
