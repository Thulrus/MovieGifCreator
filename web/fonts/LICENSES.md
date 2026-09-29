# Caption font licenses

These fonts are bundled so captions look the same in the browser preview,
the in-browser export and the local server's export. All of them may be
redistributed; the files are unmodified.

| File | Font | License |
| --- | --- | --- |
| `DejaVuSans-Bold.ttf` | DejaVu Sans Bold | [DejaVu Fonts License](https://dejavu-fonts.github.io/License.html) (Bitstream Vera derivative, free to redistribute) |
| `LeagueGothic-Regular.ttf` | League Gothic, from The League of Moveable Type (via Google Fonts) | [SIL Open Font License 1.1](https://openfontlicense.org) |
| `LiberationSans-Bold.ttf` | Liberation Sans Bold | [SIL Open Font License 1.1](https://openfontlicense.org) |
| `OpenSans-Bold.ttf` | Open Sans Bold (static instance via Google Fonts) | [SIL Open Font License 1.1](https://openfontlicense.org) |
| `Ubuntu-Bold.ttf` | Ubuntu Bold (via Google Fonts) | [Ubuntu Font Licence 1.0](https://ubuntu.com/legal/font-licence) |

`fonts.json` lists them for the app. `em` is each font's
(usWinAscent + usWinDescent) / unitsPerEm. libass sizes text by that
height, while browsers size it by the em square, so the live preview uses
the ratio to match the burned-in captions.
