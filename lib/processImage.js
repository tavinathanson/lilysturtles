const sharp = require('sharp');

// --- Lazy OpenCV initialization (WASM, cached after first load) ---
// The Emscripten module is a thenable whose .then() must be consumed exactly
// once and then removed — otherwise Promise resolution tries to recursively
// unwrap it, causing an infinite loop.
let cvPromise = null;
function initCV() {
  if (!cvPromise) {
    cvPromise = new Promise(resolve => {
      require('@techstark/opencv-js').then(cv => {
        delete cv.then;
        resolve(cv);
      });
    });
  }
  return cvPromise;
}

/**
 * Process an uploaded turtle image.
 *
 * Uses OpenCV HoughCircles to detect the thick black circular border from
 * the coloring page, then extracts only the shell interior.
 * Falls back to simple white-background removal for regular photos.
 *
 * @param {Buffer} buffer - Raw image buffer
 * @returns {Promise<{ imageData: string, shellDetected: boolean, hint: string|null }>}
 */
async function processImage(buffer) {
  const cv = await initCV();

  const { data, info } = await sharp(buffer)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const totalPixels = width * height;

  // --- Detect circle using OpenCV HoughCircles ---
  let useShellMask = false;
  const mask = new Uint8Array(totalPixels);
  let circleCx, circleCy, circleR;

  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(data);

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 2, 2);

  const circles = new cv.Mat();
  cv.HoughCircles(
    blurred, circles, cv.HOUGH_GRADIENT,
    1,                                            // dp
    height / 4,                                   // minDist
    100,                                          // param1 (Canny high threshold)
    30,                                           // param2 (accumulator threshold)
    Math.floor(Math.min(width, height) * 0.15),   // minRadius
    Math.floor(Math.min(width, height) * 0.49)    // maxRadius
  );

  // Pick the circle with the best dark-border score (darkRatio × radius).
  // This prefers circles with a complete black border AND reasonable size,
  // avoiding false positives from larger non-shell edges in the photo.
  if (circles.cols > 0) {
    const candidates = [];
    for (let i = 0; i < circles.cols; i++) {
      candidates.push({
        cx: Math.round(circles.data32F[i * 3]),
        cy: Math.round(circles.data32F[i * 3 + 1]),
        r:  Math.round(circles.data32F[i * 3 + 2]),
      });
    }

    let bestScore = 0;
    for (const c of candidates) {
      // Sample a band around the detected radius to verify it's a dark (black
      // ink) border.  HoughCircles may land at the inner or outer edge of the
      // thick border, so we search ±band pixels for any dark pixel per angle.
      const samples = 72;
      const band = Math.max(10, Math.round(c.r * 0.08));
      let dark = 0, valid = 0;
      for (let s = 0; s < samples; s++) {
        const angle = (s / samples) * 2 * Math.PI;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        let anyInBounds = false, foundDark = false;
        for (let dr = -band; dr <= band && !foundDark; dr++) {
          const sx = Math.round(c.cx + (c.r + dr) * cosA);
          const sy = Math.round(c.cy + (c.r + dr) * sinA);
          if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
          anyInBounds = true;
          const pi = (sy * width + sx) * 4;
          if (data[pi] < 80 && data[pi + 1] < 80 && data[pi + 2] < 80) {
            foundDark = true;
          }
        }
        if (anyInBounds) valid++;
        if (foundDark) dark++;
      }
      // Reject if too much of the border is out of frame or not dark enough
      if (valid < samples * 0.75 || dark < valid * 0.3) continue;

      const score = (dark / valid) * c.r;
      if (score > bestScore) {
        bestScore = score;
        circleCx = c.cx;
        circleCy = c.cy;
        circleR = c.r;
      }
    }

    if (bestScore > 0) {
      const insetR = circleR - Math.max(8, Math.round(circleR * 0.15));
      const rSq = insetR * insetR;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const dx = x - circleCx;
          const dy = y - circleCy;
          if (dx * dx + dy * dy <= rSq) {
            mask[y * width + x] = 1;
          }
        }
      }
      useShellMask = true;
    }
  }

  src.delete();
  gray.delete();
  blurred.delete();
  circles.delete();

  let hint = null;

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
    const insetR = circleR - Math.max(8, Math.round(circleR * 0.15));
    const minX = Math.max(0, circleCx - insetR);
    const minY = Math.max(0, circleCy - insetR);
    const maxX = Math.min(width - 1, circleCx + insetR);
    const maxY = Math.min(height - 1, circleCy + insetR);

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

processImage.initCV = initCV;
module.exports = processImage;
