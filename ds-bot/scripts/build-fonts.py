#!/usr/bin/env python3
"""Make the reply fonts in assets/fonts/ (see src/shared/reply-fonts.js).

Sources, from google/fonts (SIL Open Font License 1.1), at the commits the
shipped files were made from:
  ofl/sourceserif4/SourceSerif4[opsz,wght].ttf          b1748ccf964b
  ofl/sourceserif4/SourceSerif4-Italic[opsz,wght].ttf   b1748ccf964b
  ofl/notoserifsc/NotoSerifSC[wght].ttf                 8b0a1d0f5983

Needs fontTools and brotli (pip install fonttools brotli). Usage:
  python3 scripts/build-fonts.py <folder with the three .ttf files>

The subsets are modified versions under the OFL and carry their own names,
DS Bot Serif Latin and DS Bot Serif SC, so they never pass for the full fonts
a user may have installed. Source Serif 4 stays variable (weight and optical
size) with Latin, Latin Extended and punctuation. Noto Serif SC becomes two
static weights, 500 and 700, with every GB2312 Hanzi, the common Traditional
Hanzi of Big5 level 1, CJK punctuation and full-width forms; a character outside the subset falls through to the next
font in the stack.
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'fonts'
LATIN = [*range(0x20, 0x7F), *range(0xA0, 0x250), 0x259, *range(0x2B0, 0x370), *range(0x1E00, 0x1F00),
         *range(0x2000, 0x2070), *range(0x20A0, 0x20D0), *range(0x2100, 0x2150), *range(0x2190, 0x2200),
         0x2212, 0x2215, 0xFEFF, 0xFFFD]


def decoded(codec, highs, lows):
    chars = set()
    for high in highs:
        for low in lows:
            try:
                chars.add(ord(bytes([high, low]).decode(codec)))
            except UnicodeDecodeError:
                pass
    return chars


GB2312 = decoded('gb2312', range(0xB0, 0xF8), range(0xA1, 0xFF))
BIG5_COMMON = {c for c in decoded('big5', range(0xA4, 0xC7), [*range(0x40, 0x7F), *range(0xA1, 0xFF)]) if 0x4E00 <= c <= 0x9FFF}
CJK = sorted(GB2312 | BIG5_COMMON | set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFFF0)))


def rename(font, family, style):
    # A subset is a modified version: give it its own name (see the docstring).
    table = font['name']
    for record in list(table.names):
        if record.nameID in (16, 17, 21, 22, 25):
            table.removeNames(nameID=record.nameID)
    postscript = f"{family.replace(' ', '')}-{style}"
    for name_id, value in [(1, family), (2, style), (3, f'{postscript};ds-bot'), (4, f'{family} {style}'), (6, postscript)]:
        table.setName(value, name_id, 3, 1, 0x409)
        table.setName(value, name_id, 1, 0, 0)


def save(font, unicodes, name, family, style, hinting):
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    options.name_IDs = ['*']
    options.notdef_outline = True
    options.hinting = hinting
    options.desubroutinize = True
    sub = subset.Subsetter(options)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    rename(font, family, style)
    path = OUT / name
    font.flavor = 'woff2'
    font.save(path)
    cmap = font.getBestCmap()
    missing = [u for u in unicodes if u not in cmap]
    print(f'{name}: {path.stat().st_size / 1024:.0f} KiB, {len(cmap)} characters, {len(missing)} not in the source')


def main(src):
    src = Path(src)
    OUT.mkdir(parents=True, exist_ok=True)
    save(TTFont(src / 'SourceSerif4[opsz,wght].ttf'), LATIN, 'ds-bot-serif-latin.woff2', 'DS Bot Serif Latin', 'Regular', True)
    save(TTFont(src / 'SourceSerif4-Italic[opsz,wght].ttf'), LATIN, 'ds-bot-serif-latin-italic.woff2', 'DS Bot Serif Latin', 'Italic', True)
    for weight, name, style in [(500, 'ds-bot-serif-sc-medium.woff2', 'Medium'), (700, 'ds-bot-serif-sc-bold.woff2', 'Bold')]:
        font = instancer.instantiateVariableFont(TTFont(src / 'NotoSerifSC[wght].ttf'), {'wght': weight})
        save(font, CJK, name, 'DS Bot Serif SC', style, False)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
