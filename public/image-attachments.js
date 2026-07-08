/**
 * Image attachments — shared image processing for the composer.
 *
 * Extracted from app.js so the canvas resize/encode path is reusable by both
 * the browser file input flow and the native image picker payload flow.
 * Behavior is preserved exactly: images larger than MAX_IMAGE_DIM are scaled
 * down; JPEG stays JPEG (quality 0.85); all other supported types output PNG.
 */

// Max dimension — resize images larger than this to reduce token cost & avoid API limits
const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function isSupportedImageMime(mimeType) {
  return VALID_MIME_TYPES.includes(mimeType);
}

/**
 * Decode a loaded Image through the shared canvas resize/encode path.
 * - Images larger than MAX_IMAGE_DIM are scaled down.
 * - JPEG stays JPEG (quality 0.85); all other supported types output PNG.
 * Returns { data: base64, mimeType }.
 */
function encodeLoadedImage(img, mimeType) {
  let { width, height } = img;
  if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
    const scale = MAX_IMAGE_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create image canvas");

  ctx.drawImage(img, 0, 0, width, height);

  // Output as PNG for screenshots/diagrams, JPEG for photos
  const outputMime = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
  const quality = outputMime === "image/jpeg" ? 0.85 : undefined;
  const dataUrl = canvas.toDataURL(outputMime, quality);
  const base64 = dataUrl.split(",")[1];

  if (!base64) throw new Error("Failed to encode image");

  return { data: base64, mimeType: outputMime };
}

/**
 * Process a browser File into { data, mimeType }.
 * Reads via FileReader, decodes through Image, applies the canvas resize path.
 * Preserves the original observable behavior: non-jpeg supported types are
 * re-encoded as PNG (this rasterizes GIF to a single PNG frame).
 */
export function processImageFile(file) {
  return new Promise((resolve, reject) => {
    // Validate mime type
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : "image/png";

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          resolve(encodeLoadedImage(img, mimeType));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error("Failed to decode image"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Process a native picker payload { data, mimeType? } where `data` is raw
 * base64 (no data: prefix). Builds a data URL, decodes through Image, then
 * applies the same canvas resize/encode path as processImageFile.
 *
 * Rejects if `data` is missing or `mimeType` is unsupported.
 */
export async function processImagePayload(payload) {
  const { data, mimeType } = payload || {};
  if (!data) {
    throw new Error("Missing image data");
  }
  if (!isSupportedImageMime(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }

  const dataUrl = `data:${mimeType};base64,${data}`;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        resolve(encodeLoadedImage(img, mimeType));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = dataUrl;
  });
}
