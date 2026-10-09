// Language detection for selections and pages (pure → unit-tested).
//
// Picks the script with the most characters instead of the first one that
// appears at all: a single "・" bullet or "ー" in a Vietnamese/English text
// used to make the whole selection "Japanese", and the model then skipped
// the parts that were not Japanese.

export function detectLanguage(text: string): string {
  const count = (re: RegExp) => (text.match(re) || []).length;
  // U+30FB "・" and U+30FC "ー" are also used as plain symbols → not counted as kana.
  const kana = count(/[぀-ゟ゠-ヺヽ-ヿ]/g);
  const han = count(/[一-鿿]/g);
  // One CJK/Hangul character carries roughly as much text as ~3 Latin letters.
  const CJK_WEIGHT = 3;
  const scores: Record<string, number> = {
    japanese: kana > 0 ? (kana + han) * CJK_WEIGHT : 0,
    chinese: kana > 0 ? 0 : han * CJK_WEIGHT,
    korean: count(/[가-힯]/g) * CJK_WEIGHT,
    thai: count(/[฀-๿]/g),
    hindi: count(/[ऀ-ॿ]/g),
    arabic: count(/[؀-ۿ]/g),
    russian: count(/[Ѐ-ӿ]/g),
    latin: count(/[A-Za-zÀ-ɏḀ-ỿ]/g),
  };
  let best = 'latin';
  for (const [lang, score] of Object.entries(scores)) {
    if (score > scores[best]!) best = lang;
  }
  if (best !== 'latin') return best;

  if (/[ạảầấậẩẫăằắặẳẵẹẻềếệểễịỉĩọỏồốộổỗơờớợởỡụủưừứựửữỵỷỹđ]/i.test(text)) return 'vietnamese';
  if (/[æœïÿ]/i.test(text)) return 'french';
  if (/[äöüß]/i.test(text)) return 'german';
  if (/[ñ¿¡]/i.test(text)) return 'spanish';
  if (/[ãõ]/i.test(text) && !/[ạảậẩẫăằắặẳẵẹẻệểễịỉĩọỏộổỗơờớợởỡụủưừứựửữỵỷỹđ]/i.test(text)) return 'portuguese';
  return 'english';
}
