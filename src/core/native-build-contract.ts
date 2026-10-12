/** Deliberately pins ONE inspected 0.17.0 build. No guesses on other versions. */
export const NATIVE_BUILD = {
  version: '0.17.0',
  assets: {
    main: { name: 'index-DKEhNN1e.js', sha256: 'f89d7fd4d428fc8ece04a65a7021af4983aa8ede1349eeddbe743f3865380e6b' },
    transcript: { name: 'use-transcript-view-BZJWhb9_.js', sha256: '92c227ce4c98bdeacc676163d6e1f0065f01c2d03f142122e86017d7c5cb34e4' },
    panel: { name: 'WorkPanel-C3oPGQMI.js', sha256: '6621ca03f19b3ccbf78777e7c05affaf79502facd356e9e77da41013508b8a79' }
  }
} as const;
export interface NativeBuildInfo { version: string; hashes: Record<string, string>; supported: boolean; reason?: string; }
export function matchesNativeBuild(version: string, hashes: Record<string, string>): boolean {
  return version === NATIVE_BUILD.version && Object.values(NATIVE_BUILD.assets).every(asset => hashes[asset.name] === asset.sha256);
}
