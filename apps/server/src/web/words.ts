// What the web server tells the user through the page, in the two languages
// the page speaks. The page says which it speaks with each request
// (`Accept-Language`); whoever does not say so is told in Korean, as a terminal
// is: what AgentHouse prints there is not said here.
export type Lang = 'ko' | 'en';

/** A sentence for the user, in both languages. */
export interface Words {
  ko: string;
  en: string;
}

export const words = (ko: string, en: string): Words => ({ ko, en });

/** The language a request asks for: English when it says so first, else Korean. */
export function langOf(accept: string | string[] | undefined): Lang {
  const first = Array.isArray(accept) ? accept[0] : accept;
  return /^\s*en\b/i.test(first ?? '') ? 'en' : 'ko';
}

/**
 * An error whose message is for the user. Its message is the Korean sentence,
 * which is what a log or a terminal gets; the English one is kept beside it.
 * A plain string is the same in both (a name, a path).
 */
export class Told extends Error {
  readonly en: string;

  constructor(said: Words | string) {
    super(typeof said === 'string' ? said : said.ko);
    this.en = typeof said === 'string' ? said : said.en;
  }

  /** The sentence in that language. */
  in(lang: Lang): string {
    return lang === 'en' ? this.en : this.message;
  }
}
