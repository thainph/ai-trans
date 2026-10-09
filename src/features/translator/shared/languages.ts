// Languages the translator supports (ids are stored in `targetLang`).

export const LANGUAGES = {
  english: { label: 'EN', name: 'English' },
  japanese: { label: 'JP', name: 'Japanese' },
  vietnamese: { label: 'VI', name: 'Vietnamese' },
  chinese: { label: 'ZH', name: 'Chinese' },
  korean: { label: 'KO', name: 'Korean' },
  french: { label: 'FR', name: 'French' },
  german: { label: 'DE', name: 'German' },
  spanish: { label: 'ES', name: 'Spanish' },
  portuguese: { label: 'PT', name: 'Portuguese' },
  russian: { label: 'RU', name: 'Russian' },
  thai: { label: 'TH', name: 'Thai' },
  indonesian: { label: 'ID', name: 'Indonesian' },
  italian: { label: 'IT', name: 'Italian' },
  dutch: { label: 'NL', name: 'Dutch' },
  arabic: { label: 'AR', name: 'Arabic' },
  hindi: { label: 'HI', name: 'Hindi' },
} as const satisfies Record<string, { label: string; name: string }>;

export type LanguageId = keyof typeof LANGUAGES;

export function isLanguageId(v: string): v is LanguageId {
  return Object.hasOwn(LANGUAGES, v);
}

/** English name of a language id (the id itself when unknown). */
export function languageName(id: string): string {
  return isLanguageId(id) ? LANGUAGES[id].name : id;
}

/** Another target when the detected source already is the target language. */
export function otherTarget(source: string): LanguageId {
  return source === 'english' ? 'vietnamese' : 'english';
}
