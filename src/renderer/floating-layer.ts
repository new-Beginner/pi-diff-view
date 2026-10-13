import type { RendererLayer, RendererUi } from './host-contract';

/** Prefer the host-owned style/safety layer. Never fall back after a public API error. */
export function openFloatingLayer(ui: Pick<RendererUi, 'openLayer'>, document: Document): RendererLayer {
  if (typeof ui.openLayer === 'function') return ui.openLayer();
  // Older hosts lack openLayer. Own only this plugin node, never alter host controls.
  const element = document.createElement('div');
  element.dataset.piPlugin = 'local.diff-view';
  element.dataset.diffViewLayer = 'compat';
  // Keep scoped plugin sheets effective without a full-screen click-intercepting surface.
  Object.assign(element.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0' });
  document.body.append(element);
  return { element, close: () => element.remove() };
}
