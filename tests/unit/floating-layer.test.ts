import { expect, it, vi } from 'vitest';
import { openFloatingLayer } from '../../src/renderer/floating-layer';
import type { RendererLayer } from '../../src/renderer/host-contract';

function documentFixture() {
  const nodes: unknown[] = [];
  const element = { dataset: {} as Record<string, string>, style: {}, remove: vi.fn(() => { nodes.splice(nodes.indexOf(element), 1); }) };
  const document = { createElement: vi.fn(() => element), body: { append: vi.fn((node: unknown) => nodes.push(node)) } };
  return { document: document as unknown as Document, element, nodes, create: document.createElement };
}
it('uses the public host layer without creating or mutating a local DOM target', () => {
  const f = documentFixture();
  const publicLayer = { element: {} as HTMLElement, close: vi.fn() };
  const ui = { openLayer: vi.fn(function (this: unknown) { expect(this).toBe(ui); return publicLayer; }) };
  const layer = openFloatingLayer(ui, f.document);
  expect(layer).toBe(publicLayer); expect(ui.openLayer).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
  layer.close(); expect(publicLayer.close).toHaveBeenCalledOnce();
});
it('owns a zero-size, scoped compatibility layer only when the API is absent', () => {
  const f = documentFixture(), layer = openFloatingLayer({}, f.document);
  expect(f.create).toHaveBeenCalledWith('div'); expect(f.nodes).toEqual([f.element]);
  expect(f.element.dataset).toEqual({ piPlugin: 'local.diff-view', diffViewLayer: 'compat' });
  expect(f.element.style).toMatchObject({ position: 'fixed', width: '0', height: '0' });
  layer.close(); expect(f.nodes).toEqual([]);
});
it('propagates an official API refusal without bypassing it through local DOM', () => {
  const f = documentFixture(), error = Object.assign(new Error('Host unloaded'), { code: 'PLUGIN_UNLOADED' });
  expect(() => openFloatingLayer({ openLayer() { throw error; } }, f.document)).toThrow(error);
  expect(f.create).not.toHaveBeenCalled(); expect(f.nodes).toEqual([]);
});
it('has the same target/close contract for official and compatibility paths', () => {
  const f = documentFixture();
  const layer: RendererLayer = openFloatingLayer({}, f.document);
  expect(layer.element).toBe(f.element); expect(typeof layer.close).toBe('function');
  layer.close();
});
