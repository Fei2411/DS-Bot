// The serif faces a theme can set on Bot replies. The files are subsets made by
// scripts/build-fonts.py, renamed so they never pass for the full fonts, and ship
// in assets/fonts/; the host serves them under FONT_ROUTE, and the client points
// @font-face at that route.
//   latin  from Source Serif 4: variable weight and optical size, Latin and punctuation
//   cjk    from Noto Serif SC (Source Han Serif): the GB2312 Hanzi. Its 500 face draws
//          text at weight 400 so the strokes hold up at 14px.
export const FONT_ROUTE = 'api/bot/fonts'
export const REPLY_FAMILY = 'DS Bot Serif'
export const FONT_FILES = {
  latin: 'ds-bot-serif-latin.woff2',
  latinItalic: 'ds-bot-serif-latin-italic.woff2',
  cjk: 'ds-bot-serif-sc-medium.woff2',
  cjkBold: 'ds-bot-serif-sc-bold.woff2',
}
// A glyph a subset leaves out falls through to the next family in the stack.
export const FONT_RANGES = {
  latin: 'U+0000-024F,U+0259,U+02B0-02FF,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2212,U+2215,U+FEFF,U+FFFD',
  cjk: 'U+3000-303F,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FF00-FFEF',
}
// The browser picks faces by weight and style first and only then joins faces with the
// same descriptors by unicode-range, so every Latin face has a Chinese partner with the
// same weight range and style. Chinese has no italic: the upright face stands in.
const WEIGHTS = [['100 500', FONT_FILES.cjk], ['600 900', FONT_FILES.cjkBold]]
export const REPLY_FACES = [['normal', FONT_FILES.latin], ['italic', FONT_FILES.latinItalic]].flatMap(([style, latin]) =>
  WEIGHTS.flatMap(([weight, cjk]) => [
    { file: latin, style, weight, range: 'latin' },
    { file: cjk, style, weight, range: 'cjk' },
  ]))
