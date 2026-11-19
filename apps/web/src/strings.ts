// The page's words, in the language it speaks: Korean (strings/ko.ts) or
// English (strings/en.ts). Which one is settled when the page loads, before
// anything is drawn: the language chosen in this browser before, else the
// browser's own. Modules read `t` as they load, so another choice reads the
// page again; the sessions go on meanwhile.
import { en } from './strings/en';
import { ko, type Strings } from './strings/ko';

export type { Strings } from './strings/ko';

export type Lang = 'ko' | 'en';
export const LANGS: readonly Lang[] = ['ko', 'en'];
/** Each language in its own words, and the mark of it on the button that changes it. */
export const LANG_NAMES: Record<Lang, string> = { ko: '한국어', en: 'English' };
export const LANG_MARKS: Record<Lang, string> = { ko: '한', en: 'EN' };

const LANG_KEY = 'ah-lang';
const CATALOGS: Record<Lang, Strings> = { ko, en };

/** The language to speak: the one chosen before, else the browser's (Korean for Korean, English for any other); Korean where there is no browser. */
export function pickLang(chosen: string | null | undefined, browser: string | null | undefined): Lang {
  if (chosen === 'ko' || chosen === 'en') return chosen;
  if (!browser) return 'ko';
  return browser.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function chosenBefore(): string | null {
  try {
    return globalThis.localStorage?.getItem(LANG_KEY) ?? null;
  } catch {
    // private windows and blocked storage: the browser's language, each time
    return null;
  }
}

// A test has no page: it reads the Korean words, whatever the machine it runs on speaks.
export const lang: Lang = pickLang(chosenBefore(), typeof document === 'undefined' ? null : globalThis.navigator?.language);
export const t: Strings = CATALOGS[lang];

/** The user's choice: kept for this browser, and the page is read again in it. */
export function chooseLang(next: Lang): void {
  try {
    globalThis.localStorage?.setItem(LANG_KEY, next);
  } catch {
    // nowhere to keep it: the page comes back in the browser's language
  }
  if (next !== lang) globalThis.location?.reload();
}
