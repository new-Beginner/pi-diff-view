import React from 'react';
/** Give basenames visual priority; external directories stay in the row's full-path tooltip. */
export default function FilePath({ path, external = false }: { path: string; external?: boolean }) {
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  return <><span className="dv-path-directory">{external ? '…/' : path.slice(0, split)}</span><span className="dv-path-basename">{path.slice(split)}</span></>;
}
