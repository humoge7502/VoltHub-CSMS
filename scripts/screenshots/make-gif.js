// Build docs/screenshots/demo-live.gif from gif-frames/f1..f8.png (pure JS, no canvas).
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const DIR = require('path').join(__dirname, '..', '..', 'docs', 'screenshots');
const W = 960; // output width (frames are 2880 wide @2x)

const frames = [];
for (let i = 1; i <= 8; i++) {
  const png = PNG.sync.read(fs.readFileSync(path.join(DIR, 'gif-frames', `f${i}.png`)));
  const step = Math.round(png.width / W);
  const w = Math.floor(png.width / step);
  const h = Math.floor(png.height / step);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * step * png.width + x * step) * 4;
      const di = (y * w + x) * 4;
      out[di] = png.data[si];
      out[di + 1] = png.data[si + 1];
      out[di + 2] = png.data[si + 2];
      out[di + 3] = png.data[si + 3];
    }
  }
  frames.push({ rgba: out, w, h });
  console.log(`frame ${i}: ${png.width}x${png.height} -> ${w}x${h}`);
}

const gif = GIFEncoder();
const palette = quantize(frames[0].rgba, 256);
for (const f of frames) {
  const index = applyPalette(f.rgba, palette);
  gif.writeFrame(index, f.w, f.h, { palette, delay: 1100, transparent: false });
}
gif.finish();
const outBuf = gif.bytes();
const outPath = path.join(DIR, 'demo-live.gif');
fs.writeFileSync(outPath, outBuf);
console.log(`wrote ${outPath} (${outBuf.length} bytes)`);
