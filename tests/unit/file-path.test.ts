import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import FilePath from '../../src/view/FilePath';

it.each(['D:\\notes\\nested\\capture-check.mjs', '/tmp/nested/capture-check.mjs'])('shortens external path %s to ellipsis and basename', path => {
  const html = renderToStaticMarkup(React.createElement(FilePath, { path, external: true }));
  expect(html).toBe('<span class="dv-path-directory">…/</span><span class="dv-path-basename">capture-check.mjs</span>');
});

it('keeps workspace relative paths unchanged', () => {
  const html = renderToStaticMarkup(React.createElement(FilePath, { path: 'src/core/host-history.ts' }));
  expect(html).toBe('<span class="dv-path-directory">src/core/</span><span class="dv-path-basename">host-history.ts</span>');
});
