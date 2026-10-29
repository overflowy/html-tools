"""Build src/shell/fonts/mona-sans-latin-wght-{normal,italic}.woff2.

Source: MonaSansVF[opsz,wght].woff2 (upright) and MonaSansVF-Italic[opsz,wght].woff2
(italic) from GitHub's official Mona Sans release (v2.0.27,
fonts/webfonts/variable in mona-sans-webfonts-v2.0.27.zip). The
Google Fonts / fontsource build is not usable: its underlineThickness is 320/1000,
which draws a slab through the glyphs that skip-ink chops into blocks.

Changes on top of the release:
- opsz is pinned to 0 (closest to the design the app was tuned against), wght
  stays variable.
- Tabular 0 and 1 are rebuilt from the plain proportional outlines. The release
  ships a slashed 0 and a footed typewriter 1 in tnum, so the same screen showed
  two kinds of zero, and its tabular 0 was 11 units narrower than the other
  tabular digits. Both now take two.tf's advance and its weight variation.
- Subset to Latin, Latin Extended, punctuation, currency, arrows and math.

The italic ships two glyphs (superscript 6 and 9) with no gvar entry at all,
which the subsetter cannot handle; they get an empty one (no variation, as
before).

Usage (needs fonttools and brotli):
    python scripts/build-mona-sans.py "MonaSansVF[opsz,wght].woff2" src/shell/fonts/mona-sans-latin-wght-normal.woff2
    python scripts/build-mona-sans.py "MonaSansVF-Italic[opsz,wght].woff2" src/shell/fonts/mona-sans-latin-wght-italic.woff2
"""

import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent
from fontTools.ttLib.tables.TupleVariation import TupleVariation
from fontTools.varLib.instancer import instantiateVariableFont

UNICODES = (
    "U+0000-024F,U+0259,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-036F,U+1E00-1EFF,"
    "U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+FEFF,U+FFFD"
)
WIDTH_REF = "two.tf"
ARGS_ARE_XY_VALUES = 0x2
ROUND_XY_TO_GRID = 0x4


def only_tuple(gvar, name):
    (tv,) = gvar.variations[name]  # this font varies along a single wght region
    return tv


def plain_tabular_digits(font):
    glyf, gvar, hmtx = font["glyf"], font["gvar"], font["hmtx"]
    ref_tv = only_tuple(gvar, WIDTH_REF)
    ref_adv = hmtx[WIDTH_REF][0]
    ref_adv_delta = ref_tv.coordinates[-3][0]  # phantom point 1 is the advance

    for tabular, plain in [("zero.tf", "zero"), ("one.tf", "one")]:
        plain_tv = only_tuple(gvar, plain)
        assert plain_tv.axes == ref_tv.axes
        plain_adv = hmtx[plain][0]
        plain_adv_delta = plain_tv.coordinates[-3][0]
        # Centre by advance, so the 1 centres its stem rather than its flag.
        dx = round((ref_adv - plain_adv) / 2)
        dx_at_max = (ref_adv + ref_adv_delta - plain_adv - plain_adv_delta) / 2

        component = GlyphComponent()
        component.glyphName = plain
        component.x, component.y = dx, 0
        component.flags = ARGS_ARE_XY_VALUES | ROUND_XY_TO_GRID
        glyph = Glyph()
        glyph.numberOfContours = -1
        glyph.components = [component]
        glyf[tabular] = glyph
        glyph.recalcBounds(glyf)
        hmtx[tabular] = (ref_adv, glyph.xMin)
        # A composite varies one point per component offset, then 4 phantom points.
        gvar.variations[tabular] = [
            TupleVariation(
                dict(ref_tv.axes),
                [(round(dx_at_max - dx), 0), (0, 0), (ref_adv_delta, 0), (0, 0), (0, 0)],
            )
        ]


def main(src, out):
    font = instantiateVariableFont(TTFont(src), {"opsz": 0})
    gvar = font["gvar"]
    for name in font.getGlyphOrder():
        if name not in gvar.variations:
            gvar.variations[name] = []
    plain_tabular_digits(font)

    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
