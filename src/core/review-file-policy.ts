import type { ReviewFile } from './contracts';

const IMAGE_EXTENSIONS = new Set([
  'png', 'apng', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'bmp', 'dib',
  'ico', 'cur', 'icns', 'tif', 'tiff', 'avif', 'avifs', 'heic', 'heif', 'heics', 'heifs',
  'svg', 'svgz', 'jxl', 'psd', 'raw', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'orf',
  'raf', 'rw2', 'pef', 'srw', 'x3f', 'tga', 'qoi', 'exr', 'hdr', 'jp2', 'j2k', 'jpf',
  'jpx', 'jpm', 'mj2', 'wmf', 'emf',
]);

/** Extension-based image review exclusion; intentionally independent of file contents. */
export function isImagePath(filePath: string): boolean {
  const basename = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = basename.lastIndexOf('.');
  return dot > 0 && dot < basename.length - 1 && IMAGE_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

/** Sidebar visibility only; retain captured evidence and unknown, non-deleted files. */
export function isVisibleReviewFile(file: ReviewFile): boolean {
  if (isImagePath(file.path)) return false;
  const known = file.statsKnown !== false && file.kind === 'text' && !file.segmentCount;
  return known ? file.additions !== 0 || file.deletions !== 0 : file.status !== 'deleted';
}
