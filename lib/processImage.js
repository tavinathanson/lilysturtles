const sharp = require('sharp');

/**
 * Process an uploaded turtle image.
 *
 * If the image contains a thick black circular border (from the coloring page),
 * flood-fills from the center to extract only the shell interior.
 * Otherwise falls back to simple white-background removal.
 *
 * @param {Buffer} buffer - Raw image buffer
 * @returns {Promise<{ imageData: string, shellDetected: boolean, hint: string|null }>}
 */
async function processImage(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const totalPixels = width * height;

  // --- Build dark-pixel mask (flood fill barrier) ---
  const dark = new Uint8Array(totalPixels);
  let darkCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    const pi = i * 4;
    if (data[pi] < 60 && data[pi + 1] < 60 && data[pi + 2] < 60) {
      dark[i] = 1;
      darkCount++;
    }
  }

  // --- Find a non-dark starting pixel near image center ---
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const maxSearch = Math.floor(Math.min(width, height) * 0.15);
  let startIdx = -1;
  for (let r = 0; r <= maxSearch && startIdx < 0; r++) {
    for (let dy = -r; dy <= r && startIdx < 0; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) < r && Math.abs(dy) < r) continue;
        const sx = cx + dx, sy = cy + dy;
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        if (!dark[sy * width + sx]) {
          startIdx = sy * width + sx;
          break;
        }
      }
    }
  }

  // --- Flood fill from center, stopping at dark pixels ---
  let useShellMask = false;
  let touchesEdge = false;
  let fillCount = 0;
  let edgeTouchPixels = 0;
  const mask = new Uint8Array(totalPixels);

  if (startIdx >= 0) {
    const visited = new Uint8Array(totalPixels);
    visited[startIdx] = 1;
    mask[startIdx] = 1;
    const stack = [startIdx];

    while (stack.length > 0) {
      const idx = stack.pop();
      fillCount++;
      const x = idx % width;
      const y = (idx - x) / width;

      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        touchesEdge = true;
        edgeTouchPixels++;
        continue; // Treat image edges as barriers — don't expand further
      }

      if (fillCount > totalPixels * 0.7) {
        touchesEdge = true;
        break;
      }

      // Expand to 4-connected neighbors (bounds-checked to prevent row wrapping)
      const nb = [];
      if (x > 0)          nb.push(idx - 1);
      if (x < width - 1)  nb.push(idx + 1);
      if (y > 0)          nb.push(idx - width);
      if (y < height - 1) nb.push(idx + width);
      for (const ni of nb) {
        if (visited[ni]) continue;
        visited[ni] = 1;
        if (dark[ni]) continue; // hit the border — stop
        mask[ni] = 1;
        stack.push(ni);
      }
    }

    const fillRatio = fillCount / totalPixels;
    // Accept barely-cut-off circles (few edge pixels) but reject significantly
    // cut-off ones (many edge pixels relative to expected perimeter)
    const maxEdge = 0.53 * Math.sqrt(fillCount);
    useShellMask = fillRatio > 0.03 && fillRatio < 0.7 && edgeTouchPixels < maxEdge;
  }

  // --- Erode mask to remove anti-aliased border fringe ---
  if (useShellMask) {
    const erodeSteps = 3;
    for (let step = 0; step < erodeSteps; step++) {
      const toErase = [];
      for (let i = 0; i < totalPixels; i++) {
        if (!mask[i]) continue;
        const x = i % width;
        const y = (i - x) / width;
        if (
          (x > 0 && !mask[i - 1]) ||
          (x < width - 1 && !mask[i + 1]) ||
          (y > 0 && !mask[i - width]) ||
          (y < height - 1 && !mask[i + width]) ||
          x === 0 || x === width - 1 || y === 0 || y === height - 1
        ) {
          toErase.push(i);
        }
      }
      for (const i of toErase) mask[i] = 0;
    }
  }

  // --- Determine hint for partial coloring pages ---
  const darkRatio = darkCount / totalPixels;
  let hint = null;
  if (!useShellMask && touchesEdge && darkRatio > 0.05) {
    // Looks like a coloring page (significant black ink) but the circle
    // isn't fully enclosed — probably cropped or at an angle
    hint = 'Make sure the entire turtle circle is in the photo!';
  }

  // --- Apply mask ---
  if (useShellMask) {
    // Detect the paper color adaptively. The paper is always the dominant
    // fill inside the circle — kids draw patterns/shapes, never a uniform
    // light fill — so the median color reliably captures it regardless of
    // lighting, camera white balance, or paper tone.
    const rVals = [], gVals = [], bVals = [];
    for (let i = 0; i < totalPixels; i++) {
      if (mask[i]) {
        const pi = i * 4;
        rVals.push(data[pi]);
        gVals.push(data[pi + 1]);
        bVals.push(data[pi + 2]);
      }
    }
    rVals.sort((a, b) => a - b);
    gVals.sort((a, b) => a - b);
    bVals.sort((a, b) => a - b);
    const mid = Math.floor(rVals.length / 2);
    const paperR = rVals[mid], paperG = gVals[mid], paperB = bVals[mid];
    const paperBright = (paperR + paperG + paperB) / 3;
    const paperSpread = Math.max(paperR, paperG, paperB) - Math.min(paperR, paperG, paperB);
    // Paper is bright AND grayish (low spread). If the median looks like an
    // actual color (high spread, e.g. yellow), the circle is heavily colored
    // and we shouldn't strip that color as "paper".
    const hasPaperColor = paperBright > 160 && paperSpread < 50;

    const distSq = 22 * 22; // color-distance threshold from paper color
    for (let i = 0; i < totalPixels; i++) {
      const pi = i * 4;
      if (!mask[i]) {
        data[pi + 3] = 0;
      } else if (hasPaperColor) {
        // Paper is light — remove pixels close to the detected paper color
        const dr = data[pi] - paperR;
        const dg = data[pi + 1] - paperG;
        const db = data[pi + 2] - paperB;
        if (dr * dr + dg * dg + db * db < distSq) {
          data[pi + 3] = 0;
        }
      } else {
        // Paper is dark (unusual, e.g. colored construction paper) — only
        // strip pure white
        if (data[pi] > 230 && data[pi + 1] > 230 && data[pi + 2] > 230) {
          data[pi + 3] = 0;
        }
      }
    }

    // Boost contrast of surviving drawing pixels so light pencil marks
    // are clearly visible on the turtle shell.  Adaptive: faint marks
    // (close to paper color) get a stronger boost than bold ones.
    if (hasPaperColor) {
      const minBoost = 1.5;   // for bold colors far from paper
      const maxBoost = 5.5;   // for faint colors near paper
      const capDist = 150;    // distance at which boost levels off to minBoost
      for (let i = 0; i < totalPixels; i++) {
        const pi = i * 4;
        if (data[pi + 3] > 0 && mask[i]) {
          const dr = data[pi] - paperR;
          const dg = data[pi + 1] - paperG;
          const db = data[pi + 2] - paperB;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          const boost = minBoost + (maxBoost - minBoost) * Math.max(0, 1 - dist / capDist);
          data[pi]     = Math.max(0, Math.min(255, Math.round(paperR + dr * boost)));
          data[pi + 1] = Math.max(0, Math.min(255, Math.round(paperG + dg * boost)));
          data[pi + 2] = Math.max(0, Math.min(255, Math.round(paperB + db * boost)));
        }
      }
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 230) {
        data[i + 3] = 0;
      }
    }
  }

  // --- Crop to circle bounding box so the drawing fills the entire shell ---
  let outData = data;
  let outWidth = width;
  let outHeight = height;

  if (useShellMask) {
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let i = 0; i < totalPixels; i++) {
      if (mask[i]) {
        const x = i % width;
        const y = (i - x) / width;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const cropped = Buffer.alloc(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      const srcOff = ((minY + y) * width + minX) * 4;
      const dstOff = y * cropW * 4;
      data.copy(cropped, dstOff, srcOff, srcOff + cropW * 4);
    }

    outData = cropped;
    outWidth = cropW;
    outHeight = cropH;
  }

  const pngBuffer = await sharp(outData, {
    raw: { width: outWidth, height: outHeight, channels: 4 }
  }).png().toBuffer();

  return {
    imageData: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    shellDetected: useShellMask,
    hint,
  };
}

module.exports = processImage;
