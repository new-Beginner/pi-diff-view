import type { DelegationLifecycle } from './delegation-lifecycle';
export const PROTOCOL = 1;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export type GitScope = 'unstaged' | 'staged' | 'commit' | 'branch';
export type Scope = GitScope | 'lastTurn' | 'turn';
export type FileKind = 'text' | 'binary' | 'large' | 'symlink' | 'submodule' | 'conflict' | 'unavailable';
export type Action = 'stage' | 'unstage' | 'revert' | 'reapply';
export interface FileSnapshot { exists: boolean; text: string | null; hash: string; size: number; mode: number; kind: FileKind; }
export interface DiffLine { kind: 'context' | 'add' | 'del' | 'notice'; text: string; oldLine: number | null; newLine: number | null; }
export interface DiffHunk { id: string; header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[]; }
export interface ReviewFile { id: string; path: string; origin?: 'workspace' | 'external'; absolutePath?: string; oldPath?: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'mode'; kind: FileKind; additions: number; deletions: number; statsKnown?: boolean; fingerprint: string; actions: Action[]; note?: string; state?: 'active' | 'reverted'; }
export interface InternalFile extends ReviewFile { before: FileSnapshot; after: FileSnapshot; indexFingerprint?: string; }
export interface ReviewRequest { scope: Scope; root?: string; ref?: string; sessionId?: string; runId?: string; focusFileId?: string; }
export interface ReviewSummary { id: string; scope: Scope; root: string; files: ReviewFile[]; nextFileOffset?: number | null; notice?: string; sessionId?: string; runId?: string; run?: RunSummary; }
export interface ReviewFilesPage { reviewId: string; files: ReviewFile[]; offset: number; nextOffset: number | null; }
export interface ReviewDetail { file: ReviewFile; hunks: DiffHunk[]; offset: number; totalRows: number; nextOffset: number | null; }
export interface TurnSummary { runId: string; sessionId: string; fileCount: number; additions: number; deletions: number; unknownFileCount?: number; incomplete: boolean; files: ReviewFile[]; offset: number; nextOffset: number | null; notice?: string; }
export interface RepositoryInfo { root: string; name: string; git: boolean; branch?: string; }
export interface RunSummary { id: string; sessionId: string; root: string; startedAt: number; endedAt?: number; state: 'running' | 'completed' | 'aborted' | 'incomplete' | 'unknown'; fileCount: number; incomplete: boolean; prompt?: string; }
export interface ReplyCard { messageId: string; run: RunSummary; summary: TurnSummary }
export interface ReplyCardsPage { cards: ReplyCard[]; revision: string; unchanged?: boolean; pending: number[]; nextOffset: number | null; locale: string; base: 'light' | 'dark' }
export interface RunningChanges { runId: string; sessionId: string; startedAt: number; fileCount: number; additions: number; deletions: number; unknownFileCount?: number; locale: string; base: 'light' | 'dark' }
export interface CaptureIdentity { id: string; identity: string; path: string; origin: 'workspace' | 'external'; absolutePath: string; }
export interface CapturedChange { before: FileSnapshot; after: FileSnapshot; capture?: CaptureIdentity; note?: string; evidence?: string[]; ambiguous?: boolean; diffStats?: { beforeHash: string; afterHash: string; additions: number; deletions: number }; }
export interface ExecutionEvidence { id: string; revision: number; state: 'running' | 'settled'; }
export interface CaptureRun extends RunSummary { version: 1 | 2; generation: string; execution?: ExecutionEvidence; mainState?: RunSummary['state']; delegations?: DelegationLifecycle[]; contentVersion?: number; boundary?: 'user' | 'uncertain'; userMessageId?: string; replyMessageId?: string; source?: 'host-history'; hostRecovery?: { captureVersion: number; files?: Record<string, string> }; notice?: string; finalReply?: { hash: string; timestamp: number }; changes: Record<string, CapturedChange>; replies: { hash: string; timestamp: number }[]; bindings: Record<string, string>; cardPreview?: { key: string; summary: TurnSummary } }
export interface LineAnchor { path: string; fingerprint: string; scope: Scope; root: string; side: 'old' | 'new'; line: number; text: string; excerpt: string; runId?: string; }
export interface ReviewComment { id: string; sessionId?: string; anchor: LineAnchor; body: string; createdAt: number; updatedAt: number; stale?: boolean; }
export interface Bootstrap { repositories: RepositoryInfo[]; runs: RunSummary[]; locale: string; base: 'light' | 'dark'; settings: { layout: 'unified' | 'split'; wordWrap: boolean; nativePreflight?: boolean }; }
export interface ReviewActionRequest { reviewId: string; fileId: string; action: Action; hunkId?: string; fingerprint: string; confirmed: boolean; }
export interface ActionResult { ok: boolean; message: string; }
export interface UiTransport { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; insertText?: (text: string) => Promise<void>; }
