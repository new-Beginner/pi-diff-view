import { describe, it, expect } from 'vitest';
import { isImagePath } from '../../src/core/review-file-policy';

describe('review image-path policy', () => {
  it('matches common image extensions case-insensitively across path separators', () => {
    for (const value of ['screen.PNG', 'images/photo.JpEg', 'icon.SVG', 'vector.svgz', 'asset.HEIC', 'plot.avif'])
      expect(isImagePath(value)).toBe(true);
  });
  it('does not classify ordinary text, logs, or non-image binary files by content', () => {
    for (const value of ['src/app.ts', 'README.md', 'access.log', 'archive.dat', 'image.png.txt', '.gitignore', 'no-extension'])
      expect(isImagePath(value)).toBe(false);
  });
});
