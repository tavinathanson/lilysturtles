const sharp = require('sharp');
const { initCV } = require('./processImage');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const SPECIES_LIST = ['trex', 'triceratops', 'brachiosaurus'];

const SPECIES_PNGS = {
  trex: path.join(__dirname, '..', 'public', 'trex.png'),
  triceratops: path.join(__dirname, '..', 'public', 'tric.png'),
  brachiosaurus: path.join(__dirname, '..', 'public', 'brach.png'),
};

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

/**
 * Ask Haiku to identify species and bounding box of the dino drawing.
 * Returns { species, bbox: { x, y, w, h } } as fractions 0-1 of image dims.
 */
async function analyzeWithHaiku(pngBuffer) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // No API key — return defaults (for tests / offline)
    return { species: 'trex', bbox: { x: 0, y: 0, w: 1, h: 1 } };
  }

  const client = getClient();
  const base64 = pngBuffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: base64 },
        },
        {
          type: 'text',
          text: `This is a photo of a kids dinosaur coloring page. There may be a dot grid pattern in the background.

1. What species of dinosaur is drawn? Answer exactly one of: trex, triceratops, brachiosaurus
2. Give the bounding box of JUST the dinosaur drawing (outline + any coloring inside it), excluding any dot grid, text, or empty space around it. Return as fractions of image width/height.

Respond ONLY with JSON, no other text:
{"species":"trex or triceratops or brachiosaurus","bbox":{"x":0.1,"y":0.2,"w":0.6,"h":0.7}}`
        }
      ]
    }]
  });

  try {
    const text = response.content[0].text.trim();
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const species = SPECIES_LIST.includes(parsed.species) ? parsed.species : 'trex';
      const bbox = parsed.bbox || { x: 0, y: 0, w: 1, h: 1 };
      // Clamp values
      bbox.x = Math.max(0, Math.min(1, bbox.x));
      bbox.y = Math.max(0, Math.min(1, bbox.y));
      bbox.w = Math.max(0.1, Math.min(1 - bbox.x, bbox.w));
      bbox.h = Math.max(0.1, Math.min(1 - bbox.y, bbox.h));
      return { species, bbox };
    }
  } catch (e) {
    console.error('Haiku parse error:', e.message);
  }
  return { species: 'trex', bbox: { x: 0, y: 0, w: 1, h: 1 } };
}

/**
 * Process an uploaded dinosaur coloring page.
 *
 * 1. Detect dot grid → angle, spacing, 4 corners.
 * 2. Perspective-warp the grid rectangle to a clean axis-aligned image.
 * 3. Erase grid dots (small circular blobs).
 * 4. Ask Haiku for species + dino bounding box.
 * 5. Crop to bounding box, resize to species texture dimensions.
 */
async function processDinoImage(buffer) {
  const cv = await initCV();

  const MAX_DIM = 1200;
  const { data, info } = await sharp(buffer)
    .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const { width, height } = info;

  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(data);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // ── Step 1: Detect grid dots ──
  const thresh = new cv.Mat();
  cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY_INV, 15, 10);

  const allContours = new cv.MatVector();
  const allHierarchy = new cv.Mat();
  cv.findContours(thresh, allContours, allHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const refDotRadius = 2.5 * (width / 800);
  const expectedDotArea = Math.PI * refDotRadius * refDotRadius;
  const minDotArea = expectedDotArea * 0.15;
  const maxDotArea = expectedDotArea * 8;

  const gridDots = [];
  for (let i = 0; i < allContours.size(); i++) {
    const contour = allContours.get(i);
    const area = cv.contourArea(contour);
    const perimeter = cv.arcLength(contour, true);
    if (perimeter === 0) continue;
    const circ = (4 * Math.PI * area) / (perimeter * perimeter);
    if (area >= minDotArea && area <= maxDotArea && circ > 0.4) {
      const rect = cv.boundingRect(contour);
      gridDots.push({ cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 });
    }
  }
  allContours.delete(); allHierarchy.delete(); thresh.delete();

  // ── Step 2: Find grid angle, spacing, filter to true grid dots ──
  let gridAngle = 0;
  let medianSpacing = 0;
  let gridAlignedDots = [];

  if (gridDots.length >= 20) {
    const refSpacing = 14 * (width / 800);
    const maxSpacing = refSpacing * 1.8;
    const minSpacing = refSpacing * 0.5;
    const sorted = [...gridDots].sort((a, b) => a.cx - b.cx);

    const angles = [];
    const spacings = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const dx = sorted[j].cx - sorted[i].cx;
        if (dx > maxSpacing * 1.5) break;
        const dy = sorted[j].cy - sorted[i].cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minSpacing || dist > maxSpacing) continue;
        angles.push(Math.atan2(dy, dx));
        spacings.push(dist);
      }
    }

    if (angles.length >= 10) {
      gridAngle = findDominantGridAngle(angles);
      spacings.sort((a, b) => a - b);
      medianSpacing = spacings[Math.floor(spacings.length / 2)];

      const angleTolerance = 15 * Math.PI / 180;
      const spacingTolerance = medianSpacing * 0.4;
      const gridDirs = [gridAngle, gridAngle + Math.PI / 2, gridAngle + Math.PI, gridAngle + 3 * Math.PI / 2];

      for (let i = 0; i < sorted.length; i++) {
        const dot = sorted[i];
        let gridNeighbors = 0;
        for (let j = 0; j < sorted.length; j++) {
          if (i === j) continue;
          const dx = sorted[j].cx - dot.cx;
          const dy = sorted[j].cy - dot.cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < medianSpacing - spacingTolerance || dist > medianSpacing + spacingTolerance) continue;
          const pairAngle = Math.atan2(dy, dx);
          for (const dir of gridDirs) {
            let diff = Math.abs(pairAngle - dir);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;
            if (diff < angleTolerance) { gridNeighbors++; break; }
          }
        }
        if (gridNeighbors >= 2) gridAlignedDots.push(dot);
      }
    }
  }

  // ── Step 3: Perspective warp using grid corners ──
  let warpedBuf = null;
  let warpedW = 0;
  let warpedH = 0;

  if (gridAlignedDots.length >= 10 && medianSpacing > 0) {
    const cosA = Math.cos(gridAngle);
    const sinA = Math.sin(gridAngle);

    let minProj1 = Infinity, maxProj1 = -Infinity;
    let minProj2 = Infinity, maxProj2 = -Infinity;

    for (const dot of gridAlignedDots) {
      const p1 = dot.cx * cosA + dot.cy * sinA;
      const p2 = -dot.cx * sinA + dot.cy * cosA;
      if (p1 < minProj1) minProj1 = p1;
      if (p1 > maxProj1) maxProj1 = p1;
      if (p2 < minProj2) minProj2 = p2;
      if (p2 > maxProj2) maxProj2 = p2;
    }

    const corners = [
      { x: minProj1 * cosA - minProj2 * sinA, y: minProj1 * sinA + minProj2 * cosA },
      { x: maxProj1 * cosA - minProj2 * sinA, y: maxProj1 * sinA + minProj2 * cosA },
      { x: maxProj1 * cosA - maxProj2 * sinA, y: maxProj1 * sinA + maxProj2 * cosA },
      { x: minProj1 * cosA - maxProj2 * sinA, y: minProj1 * sinA + maxProj2 * cosA },
    ];

    const gridW = maxProj1 - minProj1;
    const gridH = maxProj2 - minProj2;
    warpedW = Math.round(gridW);
    warpedH = Math.round(gridH);

    if (warpedW > 50 && warpedH > 50) {
      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        corners[0].x, corners[0].y, corners[1].x, corners[1].y,
        corners[2].x, corners[2].y, corners[3].x, corners[3].y,
      ]);
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, warpedW, 0, warpedW, warpedH, 0, warpedH,
      ]);

      const M = cv.getPerspectiveTransform(srcPts, dstPts);
      const warped = new cv.Mat();
      cv.warpPerspective(src, warped, M, new cv.Size(warpedW, warpedH),
        cv.INTER_LINEAR, cv.BORDER_REPLICATE);

      warpedBuf = Buffer.from(warped.data);
      srcPts.delete(); dstPts.delete(); M.delete(); warped.delete();
    }
  }

  src.delete(); gray.delete();

  // ── Step 4: Erase grid dots via color filter ──
  // Dots are medium-gray on white paper. Kid's coloring is saturated color.
  // Outlines are very dark (near black). We replace mid-gray, low-saturation
  // pixels with white — this catches all dots regardless of shape/threshold.
  if (warpedBuf) {
    for (let i = 0; i < warpedW * warpedH; i++) {
      const idx = i * 4;
      const r = warpedBuf[idx], g = warpedBuf[idx + 1], b = warpedBuf[idx + 2];
      const maxCh = Math.max(r, g, b);
      const minCh = Math.min(r, g, b);
      const saturation = maxCh > 0 ? (maxCh - minCh) / maxCh : 0;

      // Dot pixels: grayish (low saturation), not black outline, not white paper
      // Gray pencil coloring also gets removed — acceptable tradeoff since
      // the colorful parts (crayon, marker) are what matter on the 3D model
      if (saturation < 0.15 && maxCh >= 80 && maxCh <= 225) {
        warpedBuf[idx] = 255;
        warpedBuf[idx + 1] = 255;
        warpedBuf[idx + 2] = 255;
      }
    }
  }

  // ── Step 5: Use Haiku for species + bounding box ──
  const imageToAnalyze = warpedBuf
    ? await sharp(warpedBuf, { raw: { width: warpedW, height: warpedH, channels: 4 } })
        .resize(800, 800, { fit: 'inside' }).png().toBuffer()
    : await sharp(data, { raw: { width, height, channels: 4 } })
        .resize(800, 800, { fit: 'inside' }).png().toBuffer();

  const { species, bbox } = await analyzeWithHaiku(imageToAnalyze);

  // ── Step 6: Crop to bbox and resize to species texture dims ──
  const cropSrcW = warpedBuf ? warpedW : width;
  const cropSrcH = warpedBuf ? warpedH : height;
  const cropSrcBuf = warpedBuf || data;

  const cx = Math.round(bbox.x * cropSrcW);
  const cy = Math.round(bbox.y * cropSrcH);
  const cw = Math.round(bbox.w * cropSrcW);
  const ch = Math.round(bbox.h * cropSrcH);
  const rx = Math.max(0, cx);
  const ry = Math.max(0, cy);
  const rw = Math.min(cw, cropSrcW - rx);
  const rh = Math.min(ch, cropSrcH - ry);

  const speciesPng = SPECIES_PNGS[species] || SPECIES_PNGS.trex;
  const speciesMeta = await sharp(speciesPng).metadata();

  let pngBuffer;
  if (rw > 10 && rh > 10) {
    const cropBuf = Buffer.alloc(rw * rh * 4);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const srcIdx = ((ry + y) * cropSrcW + (rx + x)) * 4;
        const dstIdx = (y * rw + x) * 4;
        cropBuf[dstIdx] = cropSrcBuf[srcIdx];
        cropBuf[dstIdx + 1] = cropSrcBuf[srcIdx + 1];
        cropBuf[dstIdx + 2] = cropSrcBuf[srcIdx + 2];
        cropBuf[dstIdx + 3] = 255;
      }
    }

    // Auto-trim: find the tightest bounds around non-white content
    // so the drawing fills the full 3D shape with no wasted whitespace.
    let trimTop = rh, trimBottom = 0, trimLeft = rw, trimRight = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const idx = (y * rw + x) * 4;
        const r = cropBuf[idx], g = cropBuf[idx + 1], b = cropBuf[idx + 2];
        // Non-white = has content (threshold at 245 to handle slight off-white)
        if (r < 245 || g < 245 || b < 245) {
          if (y < trimTop) trimTop = y;
          if (y > trimBottom) trimBottom = y;
          if (x < trimLeft) trimLeft = x;
          if (x > trimRight) trimRight = x;
        }
      }
    }

    // Add tiny margin (2%) to avoid clipping right at the edge of strokes
    const marginX = Math.round((trimRight - trimLeft) * 0.02);
    const marginY = Math.round((trimBottom - trimTop) * 0.02);
    trimTop = Math.max(0, trimTop - marginY);
    trimBottom = Math.min(rh - 1, trimBottom + marginY);
    trimLeft = Math.max(0, trimLeft - marginX);
    trimRight = Math.min(rw - 1, trimRight + marginX);

    const tw = trimRight - trimLeft + 1;
    const th = trimBottom - trimTop + 1;

    if (tw > 10 && th > 10) {
      const trimmedBuf = Buffer.alloc(tw * th * 4);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const srcIdx = ((trimTop + y) * rw + (trimLeft + x)) * 4;
          const dstIdx = (y * tw + x) * 4;
          trimmedBuf[dstIdx] = cropBuf[srcIdx];
          trimmedBuf[dstIdx + 1] = cropBuf[srcIdx + 1];
          trimmedBuf[dstIdx + 2] = cropBuf[srcIdx + 2];
          trimmedBuf[dstIdx + 3] = 255;
        }
      }
      pngBuffer = await sharp(trimmedBuf, { raw: { width: tw, height: th, channels: 4 } })
        .resize(speciesMeta.width, speciesMeta.height, { fit: 'fill' })
        .png().toBuffer();
    } else {
      pngBuffer = await sharp(cropBuf, { raw: { width: rw, height: rh, channels: 4 } })
        .resize(speciesMeta.width, speciesMeta.height, { fit: 'fill' })
        .png().toBuffer();
    }
  } else {
    pngBuffer = await sharp(cropSrcBuf, { raw: { width: cropSrcW, height: cropSrcH, channels: 4 } })
      .resize(speciesMeta.width, speciesMeta.height, { fit: 'fill' })
      .png().toBuffer();
  }

  return {
    imageData: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    species,
    dinoDetected: true,
    hint: null,
  };
}

function findDominantGridAngle(angles) {
  const binSize = Math.PI / 180;
  const bins = new Array(180).fill(0);
  for (const angle of angles) {
    let a = ((angle % Math.PI) + Math.PI) % Math.PI;
    const bin = Math.min(179, Math.floor(a / binSize));
    bins[bin]++;
    if (bin > 0) bins[bin - 1] += 0.5;
    if (bin < 179) bins[bin + 1] += 0.5;
  }
  let peakBin = 0, peakVal = 0;
  for (let i = 0; i < 180; i++) {
    if (bins[i] > peakVal) { peakVal = bins[i]; peakBin = i; }
  }
  let angle = peakBin * binSize;
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle > Math.PI / 4) angle -= Math.PI / 2;
  if (angle < -Math.PI / 4) angle += Math.PI / 2;
  return angle;
}

module.exports = processDinoImage;
