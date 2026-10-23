#!/usr/bin/env node
// VoltHub demo — assembler.
//
// Takes the per-segment recordings from out/seg/*.webm and the narration from
// out/audio/*.mp3, and produces one 1080p30 film:
//
//   1. normalise every segment to exactly its narration length (trim, then freeze-pad the
//      last frame if the recording came up short — never the reverse, or audio drifts)
//   2. concat the normalised segments and the narration in the same order
//   3. burn captions generated from narration.json, timed by character weight inside each
//      segment (the voice reads at a near-constant rate, so this tracks speech closely
//      without needing word boundaries)
//
// Output: out/volthub-demo.mp4 (+ out/volthub-demo.srt, out/captions.ass)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const SEG = path.join(OUT, 'seg');
const BUILD = path.join(OUT, 'build');
const FPS = 30;
const W = 1920;
const H = 1080;

const ff = (args, label) => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  } catch (e) {
    console.error(`\nffmpeg failed (${label})`);
    throw e;
  }
};

const argv = process.argv.slice(2);
// --only <id,id> builds a partial cut (handy while iterating on one segment's look);
// the default builds the whole film.
const onlyArg = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
const ONLY = onlyArg.split(',').filter(Boolean);
const ALL = JSON.parse(fs.readFileSync(path.join(OUT, 'timing.json'), 'utf8'));
const timing = ONLY.length ? ALL.filter((s) => ONLY.includes(s.id)) : ALL;
const total = timing.reduce((a, s) => a + s.duration, 0);

const ts = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};
const assTime = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

fs.mkdirSync(BUILD, { recursive: true });

// ---- 1. normalise -------------------------------------------------------------
console.log(`normalising ${timing.length} segments (${total.toFixed(1)} s @ ${W}x${H}${FPS})`);
const parts = [];
let cursor = 0;
const cues = [];

for (const [i, seg] of timing.entries()) {
  const src = path.join(SEG, `${seg.id}.webm`);
  if (!fs.existsSync(src)) throw new Error(`missing recording for ${seg.id} — run video/record.mjs first`);
  const dst = path.join(BUILD, `${String(i).padStart(2, '0')}-${seg.id}.mp4`);
  // 0.35 s of lead-in is dropped: Playwright's encoder starts a beat before the first
  // painted frame. tpad clones the last frame if the clip is a hair short.
  ff(
    [
      '-ss',
      '0.35',
      '-i',
      src,
      '-t',
      String(seg.duration),
      '-vf',
      `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0e11,setsar=1,` +
        `tpad=stop_mode=clone:stop_duration=3`,
      '-t',
      String(seg.duration),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '19',
      '-pix_fmt',
      'yuv420p',
      dst,
    ],
    `normalise ${seg.id}`
  );
  parts.push(dst);

  // Captions for this segment: split its duration by character weight.
  const caps = seg.captions || [];
  const weights = caps.map((c) => Math.max(12, c.length));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let t = cursor;
  caps.forEach((text, k) => {
    const span = (weights[k] / sum) * seg.duration;
    cues.push({ start: t + 0.12, end: t + span - 0.06, text });
    t += span;
  });
  cursor += seg.duration;
  console.log(`  ${seg.id.padEnd(12)} ${seg.duration.toFixed(2)}s`);
}

// ---- 2. concat video + narration ---------------------------------------------
const list = path.join(BUILD, 'video.txt');
fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
const silent = path.join(BUILD, 'video.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent], 'concat video');

const alist = path.join(BUILD, 'audio.txt');
fs.writeFileSync(alist, timing.map((s) => `file '${s.audio.replace(/\\/g, '/')}'`).join('\n'));
const voice = path.join(BUILD, 'voice.m4a');
ff(['-f', 'concat', '-safe', '0', '-i', alist, '-c:a', 'aac', '-b:a', '192k', voice], 'concat audio');

// ---- 3. captions --------------------------------------------------------------
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');
const ass = [
  '[Script Info]',
  'ScriptType: v4.00+',
  `PlayResX: ${W}`,
  `PlayResY: ${H}`,
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  // cream on a heavy near-black outline: legible over both the dark stage and light UI
  'Style: Cap,Inter,46,&H00E8EAED,&H00FFFFFF,&H140B0E11,&H96000000,0,0,0,0,100,100,0.4,0,1,7,2,2,180,180,128,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${esc(c.text)}`),
].join('\n');
const assPath = path.join(OUT, 'captions.ass');
fs.writeFileSync(assPath, ass, 'utf8');

// SRT has no escape syntax — strip backslashes and control characters before writing
// cue text (CodeQL js/incomplete-string-escaping: ASS escapes above, SRT sanitizes).
const plain = (s) => String(s).replace(/[\\{}\r\n]+/g, ' ');
const srt = cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${plain(c.text)}\n`).join('\n');
fs.writeFileSync(path.join(OUT, 'volthub-demo.srt'), srt, 'utf8');

// ---- 4. mux -------------------------------------------------------------------
const out = path.join(OUT, 'volthub-demo.mp4');
// ffmpeg filter paths: escape the escape character FIRST, then the filter's special
// characters (':' and "'") — a partial chain reads as incomplete escaping
// (CodeQL js/incomplete-string-escaping).
const ffFilterPath = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\\\'");
const assFilter = `ass='${ffFilterPath(assPath)}'`;
ff(
  [
    '-i',
    silent,
    '-i',
    voice,
    '-vf',
    `${assFilter},fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 1).toFixed(2)}:d=1`,
    '-af',
    `afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2`,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '19',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-movflags',
    '+faststart',
    out,
  ],
  'mux'
);

const size = fs.statSync(out).size;
console.log(`\n✔ ${path.relative(process.cwd(), out)}  ${(size / 1e6).toFixed(1)} MB  ${total.toFixed(1)} s`);
console.log(`  captions: ${path.relative(process.cwd(), path.join(OUT, 'volthub-demo.srt'))} (${cues.length} cues)`);
