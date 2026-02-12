const { describe, it } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const processImage = require('../lib/processImage');

// --- Helper: create a test image from SVG shapes ---
async function makeImage(svgContent, width = 400, height = 400) {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    ${svgContent}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// --- Helper: decode result and get raw RGBA pixels ---
async function decodeResult(result) {
  const base64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// --- Helper: count non-transparent pixels ---
function countVisible(data) {
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) count++;
  }
  return count;
}

// --- Helper: check if pixel at (x,y) is visible (non-transparent) ---
function isVisible(data, width, x, y) {
  const i = (y * width + x) * 4;
  return data[i + 3] > 0;
}

// --- Helper: get pixel RGBA at (x,y) ---
function getPixel(data, width, x, y) {
  const i = (y * width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

// =====================================================================

describe('processImage — coloring page detection', () => {

  it('detects a full circle and extracts the interior', async () => {
    // Black circle with red fill on white background
    const buf = await makeImage(`
      <circle cx="200" cy="200" r="120" fill="red" stroke="black" stroke-width="14"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);
    assert.strictEqual(result.hint, null);

    // Image is cropped to circle bounding box — center should be visible (red),
    // corner should be transparent (outside circle but inside bounding box)
    const { data, width, height } = await decodeResult(result);
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
    assert.ok(isVisible(data, width, cx, cy), 'center should be visible');
    assert.ok(!isVisible(data, width, 1, 1), 'corner should be transparent');
  });

  it('detects circle with multiple colors inside', async () => {
    const buf = await makeImage(`
      <circle cx="200" cy="200" r="120" fill="white" stroke="black" stroke-width="14"/>
      <rect x="140" y="140" width="50" height="50" fill="red"/>
      <rect x="210" y="140" width="50" height="50" fill="blue"/>
      <rect x="140" y="210" width="50" height="50" fill="green"/>
      <rect x="210" y="210" width="50" height="50" fill="orange"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);

    // Image is cropped to circle bounding box — colored rects should survive
    const { data, width, height } = await decodeResult(result);
    const visible = countVisible(data);
    assert.ok(visible > 1000, `colored squares should produce many visible pixels, got ${visible}`);
    // Corner of cropped image (outside circle) should be transparent
    assert.ok(!isVisible(data, width, 1, 1), 'outside circle is transparent');
  });

  it('preserves dark colors inside the circle (dark blue, dark purple)', async () => {
    // Dark blue (#1a1a80) has one channel above the dark threshold
    const buf = await makeImage(`
      <circle cx="200" cy="200" r="120" fill="#1a1a80" stroke="black" stroke-width="14"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);

    const { data, width, height } = await decodeResult(result);
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
    const center = getPixel(data, width, cx, cy);
    assert.ok(center.a > 0, 'dark blue should be preserved');
    assert.ok(center.b > 80, 'blue channel should be high');
  });

  it('handles an empty (uncolored) shell — everything inside becomes transparent', async () => {
    const buf = await makeImage(`
      <circle cx="200" cy="200" r="120" fill="white" stroke="black" stroke-width="14"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);

    // The interior is all white, which gets removed → mostly transparent
    const { data } = await decodeResult(result);
    const visible = countVisible(data);
    // Some anti-aliased border pixels at the inner edge remain — that's fine
    assert.ok(visible < 2000, `empty shell should be mostly transparent, got ${visible} visible pixels`);
  });

  it('works with the full turtle coloring page (head, flippers, circle)', async () => {
    // Simulate the actual coloring page: turtle parts + black circle + colored interior
    const buf = await makeImage(`
      <!-- Head -->
      <ellipse cx="200" cy="40" rx="30" ry="25" fill="black"/>
      <!-- Front flippers -->
      <ellipse cx="50" cy="150" rx="60" ry="15" fill="black" transform="rotate(-15 50 150)"/>
      <ellipse cx="350" cy="150" rx="60" ry="15" fill="black" transform="rotate(15 350 150)"/>
      <!-- Back flippers -->
      <ellipse cx="130" cy="320" rx="40" ry="12" fill="black" transform="rotate(30 130 320)"/>
      <ellipse cx="270" cy="320" rx="40" ry="12" fill="black" transform="rotate(-30 270 320)"/>
      <!-- Shell with kid's coloring (rainbow!) -->
      <circle cx="200" cy="200" r="120" fill="yellow" stroke="black" stroke-width="14"/>
      <rect x="160" y="160" width="80" height="80" fill="magenta"/>
    `, 400, 400);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);
    assert.strictEqual(result.hint, null);

    // Image is cropped to circle bounding box — head and flippers are excluded
    const { data, width, height } = await decodeResult(result);
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
    // Shell interior visible at center
    assert.ok(isVisible(data, width, cx, cy), 'center colored area visible');
    // Cropped image should be roughly circle-sized (~240px), not full image (~400px)
    assert.ok(width < 300, `should be cropped to circle, got width=${width}`);
    assert.ok(height < 300, `should be cropped to circle, got height=${height}`);
  });
});

describe('processImage — regular photos (no coloring page)', () => {

  it('falls back to white removal when no circle is present', async () => {
    const buf = await makeImage(`
      <rect x="100" y="100" width="200" height="200" fill="blue"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, false);
    assert.strictEqual(result.hint, null);

    const { data, width } = await decodeResult(result);
    // Blue rect should be visible
    assert.ok(isVisible(data, width, 200, 200), 'blue rect visible');
    // White corners should be transparent
    assert.ok(!isVisible(data, width, 10, 10), 'white background removed');
  });

  it('handles an all-white image gracefully', async () => {
    const buf = await makeImage('');
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, false);
    assert.strictEqual(result.hint, null);

    const { data } = await decodeResult(result);
    assert.strictEqual(countVisible(data), 0, 'all-white image → all transparent');
  });

  it('handles a colorful drawing with no black outlines', async () => {
    const buf = await makeImage(`
      <circle cx="200" cy="200" r="100" fill="red"/>
      <circle cx="150" cy="150" r="50" fill="yellow"/>
      <circle cx="250" cy="250" r="50" fill="green"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, false);
    assert.strictEqual(result.hint, null);

    const { data, width } = await decodeResult(result);
    assert.ok(isVisible(data, width, 200, 200), 'colored area visible');
  });
});

describe('processImage — partial/problem photos', () => {

  it('gives a hint when the circle is cut off (lots of dark ink but no enclosure)', async () => {
    // Simulate a coloring page photo where the right side is cropped:
    // partial circle arc + head + flippers = lots of dark ink, but circle is broken
    const buf = await makeImage(`
      <!-- Partial circle (right side cut off) -->
      <circle cx="320" cy="200" r="150" fill="yellow" stroke="black" stroke-width="14"/>
      <!-- Head -->
      <ellipse cx="320" cy="30" rx="40" ry="30" fill="black"/>
      <!-- Flippers -->
      <ellipse cx="100" cy="150" rx="70" ry="20" fill="black" transform="rotate(-15 100 150)"/>
      <ellipse cx="100" cy="300" rx="50" ry="15" fill="black" transform="rotate(20 100 300)"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, false);
    assert.ok(result.hint !== null, 'should give a hint about partial circle');
    assert.ok(result.hint.includes('circle'), `hint should mention circle: "${result.hint}"`);
  });

  it('handles a gap in the border (kid colored over it)', async () => {
    // Circle with a white rectangle breaking the border
    const buf = await makeImage(`
      <circle cx="200" cy="200" r="120" fill="yellow" stroke="black" stroke-width="14"/>
      <rect x="310" y="185" width="20" height="30" fill="white"/>
    `);
    const result = await processImage(buf);
    // The fill leaks through the gap — won't detect as shell
    assert.strictEqual(result.shellDetected, false);
    // Should still get a hint since there's lots of black (circle border is >5%)
    assert.ok(result.hint !== null, 'should warn about the issue');
  });

  it('detects shell when circle border is barely cut off at image edge', async () => {
    // Circle extends slightly past the bottom edge — border is missing at the very bottom
    // but the image edge itself acts as a barrier, keeping the fill enclosed
    const buf = await makeImage(`
      <circle cx="200" cy="260" r="150" fill="red" stroke="black" stroke-width="14"/>
      <rect x="160" y="200" width="80" height="60" fill="blue"/>
    `, 400, 400);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true, 'should detect shell even with border slightly cut off');
    assert.strictEqual(result.hint, null);

    const { data, width, height } = await decodeResult(result);
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
    assert.ok(isVisible(data, width, cx, cy), 'center should be visible');
  });

  it('no hint for a regular dark drawing (not a coloring page)', async () => {
    // A drawing with some dark lines — open shapes, not enclosing the center
    const buf = await makeImage(`
      <line x1="50" y1="50" x2="350" y2="50" stroke="#333" stroke-width="3"/>
      <line x1="50" y1="350" x2="350" y2="350" stroke="#333" stroke-width="3"/>
      <circle cx="200" cy="200" r="30" fill="blue"/>
    `);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, false);
    // Not enough dark pixels to trigger coloring page hint
    assert.strictEqual(result.hint, null, 'small dark area should not trigger hint');
  });
});

describe('processImage — edge cases', () => {

  it('handles a very small image', async () => {
    const buf = await makeImage(`
      <circle cx="50" cy="50" r="30" fill="red" stroke="black" stroke-width="6"/>
    `, 100, 100);
    const result = await processImage(buf);
    // Should process without crashing
    assert.ok(result.imageData.startsWith('data:image/png;base64,'));
  });

  it('handles a large image (gets resized to 800x800 max)', async () => {
    const buf = await makeImage(`
      <circle cx="1000" cy="1000" r="600" fill="red" stroke="black" stroke-width="30"/>
    `, 2000, 2000);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);
    assert.strictEqual(result.hint, null);
  });

  it('handles a non-square image (portrait)', async () => {
    const buf = await makeImage(`
      <circle cx="200" cy="300" r="120" fill="blue" stroke="black" stroke-width="14"/>
    `, 400, 600);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);
  });

  it('handles a non-square image (landscape)', async () => {
    const buf = await makeImage(`
      <circle cx="300" cy="200" r="120" fill="blue" stroke="black" stroke-width="14"/>
    `, 600, 400);
    const result = await processImage(buf);
    assert.strictEqual(result.shellDetected, true);
  });

  it('center of image is dark (kid colored the center black)', async () => {
    // Circle with a black blob in the center — start search should find
    // a non-dark pixel nearby
    const buf = await makeImage(`
      <circle cx="200" cy="200" r="120" fill="yellow" stroke="black" stroke-width="14"/>
      <circle cx="200" cy="200" r="30" fill="black"/>
    `);
    const result = await processImage(buf);
    // Should still detect the shell (search spirals outward from center)
    assert.strictEqual(result.shellDetected, true);

    // After crop, yellow area should be visible (check slightly above center)
    const { data, width, height } = await decodeResult(result);
    const cx = Math.floor(width / 2), topQuarter = Math.floor(height / 4);
    assert.ok(isVisible(data, width, cx, topQuarter), 'yellow area above black blob visible');
  });
});
