import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lang, pickLang, t } from '../src/strings';
import { en } from '../src/strings/en';
import { ko } from '../src/strings/ko';

const KOREAN = /[ㄱ-ㆎ가-힣]/;

/** Every word of a catalog, by its name: a function is called with something of each kind it may be given. */
function wordsOf(catalog: unknown, name = ''): Array<[string, string]> {
  if (typeof catalog === 'string') return [[name, catalog]];
  if (typeof catalog === 'function') {
    const said = [1, 2, 7, 'name'].map((given) => String((catalog as (...args: unknown[]) => string)(given, given)));
    return said.map((word) => [name, word]);
  }
  if (catalog && typeof catalog === 'object') return Object.entries(catalog).flatMap(([key, value]) => wordsOf(value, name ? `${name}.${key}` : key));
  return [];
}

const namesOf = (catalog: unknown) => [...new Set(wordsOf(catalog).map(([name]) => name))].sort();

test('the language is the one chosen before, else the browser\'s: Korean for Korean, English for any other', () => {
  assert.equal(pickLang('en', 'ko-KR'), 'en');
  assert.equal(pickLang('ko', 'en-US'), 'ko');
  assert.equal(pickLang(null, 'ko-KR'), 'ko');
  assert.equal(pickLang(null, 'KO'), 'ko');
  assert.equal(pickLang(null, 'en-US'), 'en');
  assert.equal(pickLang(null, 'ja-JP'), 'en', 'English for a language there is no catalog for');
  assert.equal(pickLang('fr', 'ko-KR'), 'ko', 'a choice that is no language of the page is no choice');
  assert.equal(pickLang(null, null), 'ko', 'no browser to ask: Korean');
  assert.equal(pickLang(undefined, undefined), 'ko');
});

test('without a page (a test) the words are the Korean ones, whatever the machine speaks', () => {
  assert.equal(lang, 'ko');
  assert.equal(t, ko);
});

test('the English catalog has a word for every name of the Korean one, and no Korean in it', () => {
  assert.deepEqual(namesOf(en), namesOf(ko));
  const korean = wordsOf(en).filter(([, word]) => KOREAN.test(word));
  assert.deepEqual(korean, [], 'English words with Korean in them');
  const empty = wordsOf(en).filter(([, word]) => !word.trim());
  assert.deepEqual(empty, [], 'names without a word');
});

test('English puts times, counts and dates its own way', () => {
  assert.equal(en.later('37m'), 'in 37m');
  assert.equal(en.before('1h 4m'), '1h 4m ago');
  assert.equal(en.resetsAt('2:54 PM'), 'resets 2:54 PM');
  assert.equal(ko.resetsAt('오후 2:54'), '오후 2:54 초기화');
  assert.equal(en.monthDay(11, 17), 'Nov 17');
  assert.equal(ko.monthDay(11, 17), '11월 17일');
  assert.equal(en.hourlyAt(5), 'hourly at :05');
  assert.equal(en.earlierTurns(1), '1 earlier turn');
  assert.equal(en.earlierTurns(3), '3 earlier turns');
  assert.equal(en.removeEnded(1), 'Remove 1 ended session');
  assert.equal(en.sentTo(2), 'Sent to 2 sessions');
  assert.deepEqual([en.unit.day, en.unit.hour, en.unit.minute, en.unit.second], ['d', 'h', 'm', 's']);
  assert.deepEqual([en.locale, ko.locale], ['en-US', 'ko-KR']);
  // A date written by the catalog's locale reads as that language writes it.
  const noon = new Date(2026, 10, 21, 9, 28);
  assert.equal(noon.toLocaleTimeString(en.locale, { hour: 'numeric', minute: '2-digit' }), '9:28 AM');
  assert.equal(noon.toLocaleTimeString(ko.locale, { hour: 'numeric', minute: '2-digit' }), '오전 9:28');
});
