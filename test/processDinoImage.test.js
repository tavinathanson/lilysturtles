const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const processDinoImage = require('../lib/processDinoImage');
const { initCV } = require('../lib/processImage');

// Warm up OpenCV WASM once
before(async () => {
  await initCV();
});

// --- Helpers ---

async function decodeResult(result) {
  const base64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function countVisible(data) {
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) count++;
  }
  return count;
}

/**
 * Build a synthetic coloring page image that simulates a printed+photographed page:
 * - White background
 * - Dot grid (#888, 2.5px dots, 14px spacing) everywhere EXCEPT inside the dino
 * - Dino outline (from the actual PNG) composited on top
 * - Fake coloring (solid color) inside the dino silhouette
 * - Species dots (1-3 black circles) in the upper-right corner
 *
 * @param {string} species - 'trex', 'triceratops', or 'brachiosaurus'
 * @param {string} fillColor - Color to "color in" the dino with (e.g. 'red', '#44aa22')
 * @param {number} pageW - Output image width
 * @param {number} pageH - Output image height
 */
async function makeDinoPage(species, fillColor = 'red', pageW = 800, pageH = 1000) {
  const DOTS = { trex: 1, triceratops: 2, brachiosaurus: 3 };
  const PNG_FILES = {
    trex: 'trex.png',
    triceratops: 'tric.png',
    brachiosaurus: 'brach.png',
  };

  const dotCount = DOTS[species];
  const pngPath = path.join(__dirname, '..', 'public', PNG_FILES[species]);

  // Load the dino PNG and get its alpha mask (silhouette)
  const dinoPng = sharp(pngPath);
  const dinoMeta = await dinoPng.metadata();

  // Scale dino to fit within 70% of the page, centered
  const maxW = Math.floor(pageW * 0.7);
  const maxH = Math.floor(pageH * 0.6);
  const scale = Math.min(maxW / dinoMeta.width, maxH / dinoMeta.height);
  const dinoW = Math.round(dinoMeta.width * scale);
  const dinoH = Math.round(dinoMeta.height * scale);
  const dinoX = Math.round((pageW - dinoW) / 2);
  const dinoY = Math.round((pageH - dinoH) / 2);

  // Get the dino alpha channel as a mask
  const dinoResized = await sharp(pngPath)
    .resize(dinoW, dinoH)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Create a silhouette mask: white where dino is opaque
  const maskBuf = Buffer.alloc(dinoW * dinoH);
  for (let i = 0; i < dinoW * dinoH; i++) {
    maskBuf[i] = dinoResized.data[i * 4 + 3] > 128 ? 255 : 0;
  }
  const silhouetteMask = await sharp(maskBuf, { raw: { width: dinoW, height: dinoH, channels: 1 } })
    .png().toBuffer();

  // Build the colored dino fill (solid color masked to silhouette)
  const coloredDino = await sharp({
    create: { width: dinoW, height: dinoH, channels: 4, background: fillColor }
  }).composite([
    // Use the silhouette as alpha mask — only show color inside dino
    { input: silhouetteMask, blend: 'dest-in' }
  ]).png().toBuffer();

  // Build the dino outline (original PNG resized, black lines on transparent)
  const dinoOutline = await sharp(pngPath)
    .resize(dinoW, dinoH)
    .png().toBuffer();

  // Build dot grid pattern as SVG — tile across the full page
  const dotSpacing = 14;
  const dotR = 2.5;
  let dotsSvg = `<svg width="${pageW}" height="${pageH}" xmlns="http://www.w3.org/2000/svg">`;
  for (let y = dotR; y < pageH; y += dotSpacing) {
    for (let x = dotR; x < pageW; x += dotSpacing) {
      dotsSvg += `<circle cx="${x}" cy="${y}" r="${dotR}" fill="#888888"/>`;
    }
  }
  dotsSvg += '</svg>';
  const dotsLayer = await sharp(Buffer.from(dotsSvg)).png().toBuffer();

  // Build species indicator dots in upper-right corner
  const indicatorW = dotCount * 30 + 20;
  const indicatorH = 40;
  let indicatorSvg = `<svg width="${indicatorW}" height="${indicatorH}" xmlns="http://www.w3.org/2000/svg">`;
  for (let i = 0; i < dotCount; i++) {
    indicatorSvg += `<circle cx="${18 + i * 30}" cy="20" r="8" fill="black"/>`;
  }
  indicatorSvg += '</svg>';
  const indicatorLayer = await sharp(Buffer.from(indicatorSvg)).png().toBuffer();

  // Compose the full page
  const page = await sharp({
    create: { width: pageW, height: pageH, channels: 3, background: '#ffffff' }
  })
    .composite([
      // Dot grid across full background
      { input: dotsLayer, top: 0, left: 0 },
      // Colored dino fill (covers dots inside dino)
      { input: coloredDino, top: dinoY, left: dinoX },
      // Dino outline on top
      { input: dinoOutline, top: dinoY, left: dinoX },
      // Species dots in upper-right
      { input: indicatorLayer, top: 20, left: pageW - indicatorW - 20 },
    ])
    .png()
    .toBuffer();

  return page;
}

// Save a result image for visual inspection
async function saveDebug(name, buffer) {
  const outDir = path.join(__dirname, 'dino_debug');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, name), buffer);
}

// =====================================================================

describe('processDinoImage — synthetic coloring pages with dot grid', () => {

  it('detects T-Rex (1 dot) with red coloring', async () => {
    const page = await makeDinoPage('trex', 'red');
    await saveDebug('trex_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('trex_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.species, 'trex', `expected trex, got ${result.species}`);
    assert.strictEqual(result.dinoDetected, true, 'should detect dino silhouette');

    const { data } = await decodeResult(result);
    const visible = countVisible(data);
    assert.ok(visible > 1000, `should have many visible pixels, got ${visible}`);
  });

  it('detects Triceratops (2 dots) with blue coloring', async () => {
    const page = await makeDinoPage('triceratops', '#3366cc');
    await saveDebug('tric_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('tric_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.species, 'triceratops', `expected triceratops, got ${result.species}`);
    assert.strictEqual(result.dinoDetected, true, 'should detect dino silhouette');
  });

  it('detects Brachiosaurus (3 dots) with green coloring', async () => {
    const page = await makeDinoPage('brachiosaurus', '#22aa44');
    await saveDebug('brach_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('brach_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.species, 'brachiosaurus', `expected brachiosaurus, got ${result.species}`);
    assert.strictEqual(result.dinoDetected, true, 'should detect dino silhouette');
  });

  it('output matches species PNG dimensions (fills UV space, no dino-inside-dino)', async () => {
    const page = await makeDinoPage('trex', 'orange');
    const result = await processDinoImage(page);
    const { data, width, height } = await decodeResult(result);
    await saveDebug('trex_fill_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    // Output should match the original species PNG dimensions (1408x768)
    assert.strictEqual(width, 1408, `expected width 1408, got ${width}`);
    assert.strictEqual(height, 768, `expected height 768, got ${height}`);

    // The output should be fully opaque (coloring fills the entire texture).
    // No dino-shaped transparency — the 3D model's shape provides the outline.
    const corners = [
      [5, 5],
      [width - 6, 5],
      [5, height - 6],
      [width - 6, height - 6],
    ];
    for (const [x, y] of corners) {
      const idx = (y * width + x) * 4;
      assert.strictEqual(data[idx + 3], 255,
        `pixel at (${x},${y}) should be opaque, got alpha=${data[idx + 3]}`);
    }
  });

  it('extracted coloring contains the fill color, not just white/dots', async () => {
    // Use trex since its body fills the bounding box more uniformly
    const page = await makeDinoPage('trex', '#ff0000');
    const result = await processDinoImage(page);
    const { data, width, height } = await decodeResult(result);

    // Count red-ish pixels across the output — a significant portion should
    // contain the fill color since the dino body dominates the bounding box
    let redPixels = 0;
    const total = width * height;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 150 && data[i] > data[i + 1] + 50) redPixels++;
    }
    const redRatio = redPixels / total;
    assert.ok(redRatio > 0.1,
      `expected >10% red pixels in output, got ${(redRatio * 100).toFixed(1)}%`);
  });

  it('handles multicolor "kid coloring" (patches of different colors)', async () => {
    const page = await makeDinoPage('triceratops', '#ff00ff');
    const result = await processDinoImage(page);
    assert.strictEqual(result.dinoDetected, true);
    assert.strictEqual(result.species, 'triceratops');

    // Output should be species PNG dimensions
    const { width, height } = await decodeResult(result);
    assert.strictEqual(width, 1408);
    assert.strictEqual(height, 768);
  });
});
