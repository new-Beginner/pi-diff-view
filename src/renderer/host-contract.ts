import type React from 'react';

/** Public SDK subset used here; keep internal store/tab contracts in plugin-review-adapter.
 * Source: PI-Desktop packages/plugin-sdk/src/renderer.ts (a7a98ee).
 * openLayer is optional only for compatibility with hosts predating that capability.
 */
export interface RendererLayer {
  readonly element: HTMLElement;
  readonly close: () => void;
}
export interface RendererUi {
  injectStyle(css: string): () => void;
  openLayer?(): RendererLayer;
}
export interface DraftSnapshot {
  readonly text: string;
  readonly marks: readonly unknown[];
  readonly generation: number;
}
export interface RendererHost {
  dispatch<T = unknown>(action: 'plugin.call', payload: { method: string; args?: unknown }): Promise<T>;
  readonly ui: RendererUi;
  readonly slots: {
    register(options: { slot: 'entryExtra' | 'composerControl'; positions?: ('left' | 'right')[]; component: React.ComponentType<any> }): () => void;
  };
  readonly composer: { subscribeDraft(listener: (draft: DraftSnapshot | null) => void): () => void };
}
