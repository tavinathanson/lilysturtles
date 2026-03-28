const sharp = require('sharp');

// Reuse the same lazy OpenCV init from processImage
const { initCV } = require('./processImage');

const SPECIES_MAP = { 1: 'trex', 2: 'triceratops', 3: 'brachiosaurus' };

/**
 * Process an uploaded dinosaur coloring page.
 *
 * 1. Detects species by counting filled dots in upper-right corner.
 * 2. Extracts the dinosaur silhouette via largest contour detection.
 * 3. Masks background to transparent and crops to bounding rect.
 *
 * @param {Buffer} buffer - Raw image buffer
 * @returns {Promise<{ imageData: string, species: string, dinoDetected: boolean, hint: string|null }>}
 */
async function processDinoImage(buffer) {
  const cv = await initCV();

  const { data, info } = await sharp(buffer)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;

  // --- Step 1: Detect species from dot count in upper-right corner ---
  const species = detectSpeciesDots(cv, data, width, height);

  // --- Step 2: Find the dinosaur silhouette via contour detection ---
  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(data);

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Threshold: dark pixels (outline + coloring) become white in the mask
  const binary = new cv.Mat();
  cv.threshold(gray, binary, 200, 255, cv.THRESH_BINARY_INV);

  // Light morphological close to bridge small gaps in the outline
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
  kernel.delete();

  // Find contours
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // Find the largest contour that isn't the page border
  let bestIdx = -1;
  let bestArea = 0;
  const imgArea = width * height;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    const rect = cv.boundingRect(contour);

    // Skip contours that span >90% of image dimensions (likely page border)
    if (rect.width > width * 0.9 && rect.height > height * 0.9) continue;

    // Skip tiny contours (< 1% of image area)
    if (area < imgArea * 0.01) continue;

    if (area > bestArea) {
      bestArea = area;
      bestIdx = i;
    }
  }

  let dinoDetected = false;
  let outData = data;
  let outWidth = width;
  let outHeight = height;

  if (bestIdx >= 0) {
    dinoDetected = true;
    const bestContour = contours.get(bestIdx);
    const rect = cv.boundingRect(bestContour);

    // Create filled mask from the contour
    const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
    const drawContours = new cv.MatVector();
    drawContours.push_back(bestContour);
    cv.drawContours(mask, drawContours, 0, new cv.Scalar(255), cv.FILLED);
    drawContours.delete();

    // Apply mask to original image — pixels outside contour become transparent
    const cropW = rect.width;
    const cropH = rect.height;
    const cropped = Buffer.alloc(cropW * cropH * 4);

    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const srcX = rect.x + x;
        const srcY = rect.y + y;
        const srcIdx = (srcY * width + srcX) * 4;
        const dstIdx = (y * cropW + x) * 4;

        if (mask.ucharAt(srcY, srcX) > 0) {
          cropped[dstIdx] = data[srcIdx];
          cropped[dstIdx + 1] = data[srcIdx + 1];
          cropped[dstIdx + 2] = data[srcIdx + 2];
          cropped[dstIdx + 3] = data[srcIdx + 3];
        } else {
          cropped[dstIdx + 3] = 0; // transparent
        }
      }
    }

    mask.delete();
    outData = cropped;
    outWidth = cropW;
    outHeight = cropH;
  }

  // Cleanup
  src.delete();
  gray.delete();
  binary.delete();
  contours.delete();
  hierarchy.delete();

  const pngBuffer = await sharp(outData, {
    raw: { width: outWidth, height: outHeight, channels: 4 }
  }).png().toBuffer();

  return {
    imageData: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    species,
    dinoDetected,
    hint: null,
  };
}

/**
 * Count filled dots in the upper-right corner of the image to determine species.
 * Each coloring page has 1-4 dots: 1=trex, 2=triceratops, 3=stegosaurus, 4=brachiosaurus.
 */
function detectSpeciesDots(cv, data, width, height) {
  // Crop upper-right 15% region
  const roiX = Math.floor(width * 0.75);
  const roiY = 0;
  const roiW = width - roiX;
  const roiH = Math.floor(height * 0.15);

  // Extract the ROI into a grayscale buffer
  const roiBuf = Buffer.alloc(roiW * roiH);
  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      const srcIdx = ((roiY + y) * width + (roiX + x)) * 4;
      // Grayscale from RGB
      roiBuf[y * roiW + x] = Math.round(
        data[srcIdx] * 0.299 + data[srcIdx + 1] * 0.587 + data[srcIdx + 2] * 0.114
      );
    }
  }

  const roiMat = new cv.Mat(roiH, roiW, cv.CV_8UC1);
  roiMat.data.set(roiBuf);

  // Threshold to find dark dots
  const roiBinary = new cv.Mat();
  cv.threshold(roiMat, roiBinary, 100, 255, cv.THRESH_BINARY_INV);

  // Find contours (each dot = one contour)
  const roiContours = new cv.MatVector();
  const roiHierarchy = new cv.Mat();
  cv.findContours(roiBinary, roiContours, roiHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // Count contours that are roughly dot-sized (circular, reasonable area)
  const minDotArea = roiW * roiH * 0.005;  // at least 0.5% of ROI
  const maxDotArea = roiW * roiH * 0.15;   // at most 15% of ROI
  let dotCount = 0;

  for (let i = 0; i < roiContours.size(); i++) {
    const area = cv.contourArea(roiContours.get(i));
    if (area >= minDotArea && area <= maxDotArea) {
      dotCount++;
    }
  }

  roiMat.delete();
  roiBinary.delete();
  roiContours.delete();
  roiHierarchy.delete();

  return SPECIES_MAP[dotCount] || 'trex';
}

module.exports = processDinoImage;
