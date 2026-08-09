// Phone cameras routinely produce 8-15MB photos, well past the server's 5MB
// upload cap (route.ts's IMAGE_UPLOAD/SLIP_UPLOAD/PHOTO_UPLOAD rules). Rather
// than reject those uploads, downscale and re-encode them in the browser
// before they're ever sent. Never used for anything but a raster image: SVG
// is vector (drawImage would rasterize it, losing what makes it a good file)
// and PDF is not a bitmap at all.
const MAX_DIMENSION = 1920;
const TARGET_BYTES = 1.5 * 1024 * 1024;
const MIN_QUALITY = 0.5;
const QUALITY_STEP = 0.1;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Downscale + re-encode an image file client-side before upload. Falls back
 * to the original file untouched on any failure, on a non-image, on SVG (a
 * vector format `drawImage` would only rasterize), or if the "compressed"
 * result would not actually be smaller than what came in.
 */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;
  if (file.size <= TARGET_BYTES) return file;

  try {
    const objectUrl = URL.createObjectURL(file);
    let img: HTMLImageElement;
    try {
      img = await loadImage(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }

    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    // PNGs with transparency stay PNG (JPEG has no alpha channel and would
    // flatten it to black); everything else re-encodes as JPEG, which is
    // smaller than PNG for a photo.
    const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';

    let blob: Blob | null = null;
    for (let quality = 0.85; quality >= MIN_QUALITY; quality -= QUALITY_STEP) {
      blob = await canvasToBlob(canvas, outType, quality);
      if (blob && (blob.size <= TARGET_BYTES || outType === 'image/png')) break;
    }
    if (!blob || blob.size >= file.size) return file;

    const ext = outType === 'image/png' ? 'png' : 'jpg';
    const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${name}.${ext}`, { type: outType, lastModified: Date.now() });
  } catch {
    return file;
  }
}
