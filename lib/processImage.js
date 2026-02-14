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
 * the coloring page, then crops to the shell interior.
 * The frontend (loadShellTexture) handles contrast boosting.
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

  // --- Detect circle using OpenCV HoughCircles ---
  let useShellMask = false;
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
    height / 8,                                   // minDist
    100,                                          // param1 (Canny high threshold)
    30,                                           // param2 (accumulator threshold)
    Math.floor(Math.min(width, height) * 0.15),   // minRadius
    Math.floor(Math.min(width, height) * 0.49)    // maxRadius
  );

  // Pick the circle with the best dark-border ratio (the printed shell
  // outline).  Spurious circles from flippers/head have low ratios; if a
  // kid draws a circle inside, the printed border's ratio wins or radius
  // breaks the tie.
  if (circles.cols > 0) {
    const candidates = [];
    for (let i = 0; i < circles.cols; i++) {
      candidates.push({
        cx: Math.round(circles.data32F[i * 3]),
        cy: Math.round(circles.data32F[i * 3 + 1]),
        r:  Math.round(circles.data32F[i * 3 + 2]),
      });
    }

    let bestScore = 0, bestR = 0;
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
      if (valid < samples * 0.75 || dark < valid * 0.5) continue;

      // Best dark ratio wins; radius breaks ties
      const score = dark / valid;
      if (score > bestScore || (score === bestScore && c.r > bestR)) {
        bestScore = score;
        bestR = c.r;
        circleCx = c.cx;
        circleCy = c.cy;
        circleR = c.r;
      }
    }

    if (bestScore > 0) {
      useShellMask = true;
    }
  }

  src.delete();
  gray.delete();
  blurred.delete();
  circles.delete();

  let hint = null;

  // --- Mask + crop to circle so only the shell interior reaches the turtle ---
  let outData = data;
  let outWidth = width;
  let outHeight = height;

  if (useShellMask) {
    const insetR = circleR - Math.max(4, Math.round(circleR * 0.05));
    const insetRSq = insetR * insetR;
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
      // Make pixels outside the circle transparent
      for (let x = 0; x < cropW; x++) {
        const dx = (minX + x) - circleCx;
        const dy = (minY + y) - circleCy;
        if (dx * dx + dy * dy > insetRSq) {
          cropped[dstOff + x * 4 + 3] = 0;
        }
      }
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
