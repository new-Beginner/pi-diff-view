/** Pure wire protocol shared with browser entries; no host or Node dependencies. */
export interface SurfaceRequest {
  role: 'renderer' | 'view'; id: string; seq: number; release?: boolean;
  sessionId?: string | null; nonce?: string; selectionRevision?: number; ack?: string;
  after?: string; waitMs?: number; locating?: boolean; sessionEpoch?: number;
}
export interface SurfaceReply {
  state: 'ready' | 'waiting' | 'ambiguous' | 'stale'; sessionId: string | null;
  key?: string; nonce?: string; selectionRevision?: number; confirmed?: boolean; locating?: boolean;
}
export const surfaceStamp = (value: SurfaceReply) => JSON.stringify(value);
