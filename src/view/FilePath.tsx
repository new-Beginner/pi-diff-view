import React from 'react';
/** Keep the full path selectable while giving the basename visual priority. */
export default function FilePath({ path }: { path: string }) {
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  return <><span className="dv-path-directory">{path.slice(0, split)}</span><span className="dv-path-basename">{path.slice(split)}</span></>;
}
