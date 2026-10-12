// Component-only fixture: deliberately NOT the production Panel or a host entry point.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewApp from '../../src/view/ReviewApp';
import type { UiTransport } from '../../src/core/contracts';
const transport: UiTransport = { invoke: (method, args) => window.pluginBridge!.invoke(`diff.${method}`, args) };
function Harness() {
  const [appearance, setAppearance] = useState<{ locale?: string; base?: 'light' | 'dark' }>({});
  useEffect(() => {
    const dispose = window.pluginBridge?.on?.('appearance:changed', setAppearance);
    window.pluginBridge?.invoke('app.getAppearance').then(value => setAppearance(value as typeof appearance));
    return () => { if (typeof dispose === 'function') dispose(); };
  }, []);
  return <ReviewApp transport={transport} {...appearance} />;
}
createRoot(document.getElementById('root')!).render(<Harness />);
