// Caption helpers for the in-browser engine: turning Whisper's words into
// caption-sized chunks, and writing the .ass subtitle file libass burns in.
// These mirror split_segment() and write_ass() in app.py so both engines
// produce the same captions and the same look.

// Must match the live preview (ASS_RES_X/Y and ASS_MARGIN in app.js).
export const PLAY_RES_X = 480, PLAY_RES_Y = 270, MARGIN = 20;

const round2 = t => Math.round(t * 100) / 100;

// Whisper (in the browser) gives back words, not sentences. Group them into
// phrases first — a new phrase starts after a sentence ends or at a pause —
// then split any phrase that's too long into chunks of at most maxChars,
// on word boundaries.
export function wordsToCaptions(words, maxChars) {
  const tokens = words
    .map(w => ({ text: w.text.trim(), start: w.start, end: w.end }))
    .filter(w => w.text);
  const phrases = [];
  let cur = [];
  tokens.forEach((w, i) => {
    const prev = tokens[i - 1];
    // A pause, or the end of a sentence (a "- " starts a new speaker, too).
    if (cur.length && prev && (w.start - prev.end > 0.8 || /[.?!…]["')\]]*$/.test(prev.text) || /^[-–—]\s/.test(w.text))) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(w);
  });
  if (cur.length) phrases.push(cur);

  const captions = [];
  for (const phrase of phrases) {
    let chunk = [], len = 0;
    for (const w of phrase) {
      let add = w.text.length + (chunk.length ? 1 : 0);
      if (chunk.length && len + add > maxChars) {
        captions.push(chunk);
        chunk = [];
        len = 0;
        add = w.text.length;
      }
      chunk.push(w);
      len += add;
    }
    if (chunk.length) captions.push(chunk);
  }
  return captions.map(c => ({
    start: round2(c[0].start),
    end: round2(Math.max(c[c.length - 1].end, c[0].start + 0.1)),
    // Whisper marks a change of speaker with "- ", which looks odd on a GIF.
    text: c.map(w => w.text).join(' ').replace(/^[-–—]\s+/, ''),
  }));
}

function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// '#rrggbb' -> ASS's &HAABBGGRR (opaque).
function assColor(hex) {
  const h = hex.replace('#', '');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

export function buildAss(captions, style) {
  const alignment = style.position === 'top' ? 8 : 2;
  const shadow = style.outline ? 1 : 0;
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // Outlines scale with the video like the text does.
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.font},${style.fontsize},${assColor(style.color)},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${style.outline},${shadow},${alignment},${MARGIN},${MARGIN},${MARGIN},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of captions) {
    let text = String(c.text);
    if (style.uppercase) text = text.toUpperCase();
    // Braces would otherwise start an ASS override block and vanish.
    text = text.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${text}`);
  }
  return lines.join('\n') + '\n';
}
