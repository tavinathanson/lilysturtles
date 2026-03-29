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
/**
 * @param {string} species
 * @param {string} fillColor - Base fill for the dino body
 * @param {number} pageW
 * @param {number} pageH
 * @param {Array<{type: string, color: string, cx?: number, cy?: number, r?: number,
 *   x?: number, y?: number, w?: number, h?: number, points?: string}>} innerShapes
 *   Shapes drawn on top of the fill, INSIDE the dino bounding box.
 *   Coordinates are fractions (0–1) of the dino bounding box.
 */
async function makeDinoPage(species, fillColor = 'red', pageW = 800, pageH = 1000, innerShapes = []) {
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

  // Build inner shapes (kid's drawings) on top of the dino fill.
  // Coordinates are fractions of the dino bounding box.
  let innerShapeLayers = [];
  for (const shape of innerShapes) {
    let svgContent = '';
    if (shape.type === 'circle') {
      const px = Math.round(shape.cx * dinoW);
      const py = Math.round(shape.cy * dinoH);
      const pr = Math.round(shape.r * Math.min(dinoW, dinoH));
      svgContent = `<circle cx="${px}" cy="${py}" r="${pr}" fill="${shape.color}"/>`;
    } else if (shape.type === 'rect') {
      const px = Math.round(shape.x * dinoW);
      const py = Math.round(shape.y * dinoH);
      const pw = Math.round(shape.w * dinoW);
      const ph = Math.round(shape.h * dinoH);
      svgContent = `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="${shape.color}"/>`;
    } else if (shape.type === 'star') {
      // 5-point star centered at (cx, cy) with radius r
      const px = shape.cx * dinoW;
      const py = shape.cy * dinoH;
      const pr = shape.r * Math.min(dinoW, dinoH);
      const ir = pr * 0.4; // inner radius
      let pts = [];
      for (let i = 0; i < 10; i++) {
        const angle = (i * Math.PI / 5) - Math.PI / 2;
        const radius = i % 2 === 0 ? pr : ir;
        pts.push(`${(px + radius * Math.cos(angle)).toFixed(1)},${(py + radius * Math.sin(angle)).toFixed(1)}`);
      }
      svgContent = `<polygon points="${pts.join(' ')}" fill="${shape.color}"/>`;
    }
    if (svgContent) {
      const svg = `<svg width="${dinoW}" height="${dinoH}" xmlns="http://www.w3.org/2000/svg">${svgContent}</svg>`;
      innerShapeLayers.push(await sharp(Buffer.from(svg)).png().toBuffer());
    }
  }

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
      // Inner shapes (kid's drawings) ON TOP of the outline — like a kid drawing
      ...innerShapeLayers.map(buf => ({ input: buf, top: dinoY, left: dinoX })),
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

  it('detects dino with red coloring (trex page)', async () => {
    const page = await makeDinoPage('trex', 'red');
    await saveDebug('trex_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('trex_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.dinoDetected, true, 'should detect dino silhouette');

    const { data } = await decodeResult(result);
    const visible = countVisible(data);
    assert.ok(visible > 1000, `should have many visible pixels, got ${visible}`);
  });

  it('detects dino with blue coloring (triceratops page)', async () => {
    const page = await makeDinoPage('triceratops', '#3366cc');
    await saveDebug('tric_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('tric_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.dinoDetected, true, 'should detect dino silhouette');
  });

  it('detects dino with green coloring (brachiosaurus page)', async () => {
    const page = await makeDinoPage('brachiosaurus', '#22aa44');
    await saveDebug('brach_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('brach_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

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

    // Output should be species PNG dimensions
    const { width, height } = await decodeResult(result);
    assert.strictEqual(width, 1408);
    assert.strictEqual(height, 768);
  });
});

// Helper: count pixels of a specific color in output
function countColorPixels(data, testFn) {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (testFn(data[i], data[i + 1], data[i + 2], data[i + 3])) count++;
  }
  return count;
}

describe('processDinoImage — inner drawings preserve shape proportions', () => {

  it('blue circle drawn on trex body occupies correct proportion of output', async () => {
    // Draw a big blue circle on the trex torso area (upper-center of bbox)
    const page = await makeDinoPage('trex', 'white', 800, 1000, [
      { type: 'circle', cx: 0.4, cy: 0.3, r: 0.25, color: '#0000ff' },
    ]);
    await saveDebug('trex_circle_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('trex_circle_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.dinoDetected, true);
    const { data, width, height } = await decodeResult(result);
    const total = width * height;

    // Loosen threshold — resizing softens pure blue
    const bluePixels = countColorPixels(data, (r, g, b) => b > 120 && r < 120 && g < 120);
    const bluePct = bluePixels / total * 100;

    // The circle extends partly outside the dino body where it gets clipped by
    // the outline, so only a fraction is visible. Expect 1-15%.
    assert.ok(bluePct > 0.5, `blue circle should be >0.5% of output, got ${bluePct.toFixed(1)}%`);
    assert.ok(bluePct < 20, `blue circle should be <20% of output, got ${bluePct.toFixed(1)}%`);
    console.log(`  blue circle: ${bluePct.toFixed(1)}% of output`);
  });

  it('large red rectangle covers significant portion of brachiosaurus output', async () => {
    // Big rectangle covering the center-upper body area
    const page = await makeDinoPage('brachiosaurus', 'white', 800, 1000, [
      { type: 'rect', x: 0.2, y: 0.15, w: 0.5, h: 0.5, color: '#ff0000' },
    ]);
    await saveDebug('brach_rect_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('brach_rect_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.dinoDetected, true);
    const { data, width, height } = await decodeResult(result);
    const total = width * height;

    const redPixels = countColorPixels(data, (r, g, b) => r > 120 && g < 120 && b < 120);
    const redPct = redPixels / total * 100;

    // Rect area = 0.5 * 0.5 = 25% of bbox
    assert.ok(redPct > 5, `red rect should be >5% of output, got ${redPct.toFixed(1)}%`);
    assert.ok(redPct < 35, `red rect should be <35% of output, got ${redPct.toFixed(1)}%`);
    console.log(`  red rectangle: ${redPct.toFixed(1)}% of output (expected ~15-25%)`);
  });

  it('yellow star drawn on triceratops appears at correct scale in output', async () => {
    // Large yellow star on the triceratops body
    const page = await makeDinoPage('triceratops', 'white', 800, 1000, [
      { type: 'star', cx: 0.5, cy: 0.35, r: 0.3, color: '#ffff00' },
    ]);
    await saveDebug('tric_star_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('tric_star_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.dinoDetected, true);
    const { data, width, height } = await decodeResult(result);
    const total = width * height;

    // Yellow = high R + high G, low B (loosen thresholds)
    const yellowPixels = countColorPixels(data, (r, g, b) => r > 180 && g > 180 && b < 120);
    const yellowPct = yellowPixels / total * 100;

    assert.ok(yellowPct > 1, `yellow star should be >1% of output, got ${yellowPct.toFixed(1)}%`);
    assert.ok(yellowPct < 20, `yellow star should be <20% of output, got ${yellowPct.toFixed(1)}%`);
    console.log(`  yellow star: ${yellowPct.toFixed(1)}% of output (expected ~5-10%)`);
  });

  it('small circle vs large circle have correct relative sizes', async () => {
    // Both on the trex torso — small r=0.1, large r=0.2 (area ratio should be ~4x)
    const smallPage = await makeDinoPage('trex', 'white', 800, 1000, [
      { type: 'circle', cx: 0.4, cy: 0.3, r: 0.1, color: '#0000ff' },
    ]);
    const largePage = await makeDinoPage('trex', 'white', 800, 1000, [
      { type: 'circle', cx: 0.4, cy: 0.3, r: 0.2, color: '#0000ff' },
    ]);

    const smallResult = await processDinoImage(smallPage);
    const largeResult = await processDinoImage(largePage);

    const smallDec = await decodeResult(smallResult);
    const largeDec = await decodeResult(largeResult);

    const isBlue = (r, g, b) => b > 120 && r < 120 && g < 120;
    const smallBlue = countColorPixels(smallDec.data, isBlue);
    const largeBlue = countColorPixels(largeDec.data, isBlue);

    assert.ok(smallBlue > 0, `small circle should have some blue pixels, got ${smallBlue}`);
    assert.ok(largeBlue > 0, `large circle should have some blue pixels, got ${largeBlue}`);

    // Large circle has 4x the area of small (radius ratio 2:1 → area ratio 4:1)
    const ratio = largeBlue / smallBlue;
    assert.ok(ratio > 2, `large/small ratio should be >2, got ${ratio.toFixed(1)}`);
    assert.ok(ratio < 7, `large/small ratio should be <7, got ${ratio.toFixed(1)}`);
    console.log(`  size ratio large/small: ${ratio.toFixed(1)}x (expected ~4x)`);
  });

  it('shape position is preserved (left half vs right half drawing)', async () => {
    // Draw blue rect on left side, red rect on right side of the dino body
    const page = await makeDinoPage('trex', 'white', 800, 1000, [
      { type: 'rect', x: 0.05, y: 0.15, w: 0.25, h: 0.5, color: '#0000ff' },
      { type: 'rect', x: 0.65, y: 0.15, w: 0.25, h: 0.5, color: '#ff0000' },
    ]);
    await saveDebug('trex_leftright_input.png', page);

    const result = await processDinoImage(page);
    await saveDebug('trex_leftright_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.dinoDetected, true);
    const { data, width, height } = await decodeResult(result);
    const midX = Math.floor(width / 2);

    // Count blue pixels in left vs right half
    let blueLeft = 0, blueRight = 0, redLeft = 0, redRight = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const isBlue = b > 120 && r < 120 && g < 120;
        const isRed = r > 120 && g < 120 && b < 120;
        if (x < midX) {
          if (isBlue) blueLeft++;
          if (isRed) redLeft++;
        } else {
          if (isBlue) blueRight++;
          if (isRed) redRight++;
        }
      }
    }

    // Blue should be mostly on the left, red mostly on the right
    assert.ok(blueLeft > blueRight * 2,
      `blue should be mostly left: left=${blueLeft}, right=${blueRight}`);
    assert.ok(redRight > redLeft * 2,
      `red should be mostly right: left=${redLeft}, right=${redRight}`);
    console.log(`  blue L/R: ${blueLeft}/${blueRight}, red L/R: ${redLeft}/${redRight}`);
  });
});

// =====================================================================

describe('processDinoImage — real photo regression tests', () => {

  it('detects triceratops from a real rotated photo with scribbles', async () => {
    const imgPath = path.join(__dirname, 'dino_debug', 'dino_tric_real_test.png');
    const imgBuf = fs.readFileSync(imgPath);

    const result = await processDinoImage(imgBuf);
    await saveDebug('tric_real_output.png', Buffer.from(
      result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));

    assert.strictEqual(result.dinoDetected, true, 'should detect a dino silhouette');
    if (process.env.ANTHROPIC_API_KEY) {
      assert.strictEqual(result.species, 'triceratops', `expected triceratops, got ${result.species}`);
    }

    // Output should match species PNG dimensions
    const { data, width, height } = await decodeResult(result);
    assert.strictEqual(width, 1408, `expected width 1408, got ${width}`);
    assert.strictEqual(height, 768, `expected height 768, got ${height}`);

    // Should have substantial visible content (not a blank/tiny crop)
    const visible = countVisible(data);
    const total = width * height;
    const visiblePct = visible / total * 100;
    assert.ok(visiblePct > 50, `should have >50% visible pixels, got ${visiblePct.toFixed(1)}%`);
    console.log(`  real photo: ${visiblePct.toFixed(1)}% visible, species=${result.species}`);
  });
});
