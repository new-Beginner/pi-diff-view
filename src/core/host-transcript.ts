import { safeTaskDetails } from './delegation-lifecycle';
import { isImagePath } from './review-file-policy';
import { assertPublicPath, assertSessionScratchPath } from './public-path';
// Pure DTO normalization shared with the renderer; never retains conversational prose.
export interface HostEvidenceMessage {
  type: 'message'; id: string; role: string; createdAt: string | number;
  meta: Record<string, unknown>; blocks: Record<string, any>[];
}
export function hostEvidenceMessages(messages: unknown[], sessionId?: string, projectRoot?: string): HostEvidenceMessage[] {
  return messages.flatMap((value: any) => {
    if (!value || typeof value.id !== 'string' || typeof value.role !== 'string') return [];
    const meta = { status: value.status ?? value.meta?.status, parentMessageId: value.parentToolCallId ?? value.meta?.parentMessageId, userMessageId: value.meta?.userMessageId, steering: value.steering ?? value.meta?.steering };
    const blocks: Record<string, any>[] = [];
    if (value.role === 'assistant' && ((typeof value.content === 'string' && value.content.trim()) || value.blocks?.some((b: any) => b.type === 'text'))) blocks.push({ type: 'text' });
    const candidates = value.toolCallId ? [{ type: 'tool_call', callId: value.toolCallId, name: value.toolName, args: value.toolArgs, status: value.toolStatus, result: value.toolResult, isError: value.isError }] : value.blocks ?? [];
    for (const b of candidates) {
      if (b.type !== 'tool_call' || typeof b.callId !== 'string') continue;
      const name = String(b.name).split('.').pop()!.toLowerCase();
      const args = b.args ?? {}, result = b.result ?? {}, review = result.details?.review;
      if (isImagePath(String(review?.path ?? args.path ?? args.file_path ?? ''))) continue;
      try {
        const check = (value: string) => { assertPublicPath(value); if (sessionId) assertSessionScratchPath(value, sessionId, projectRoot); };
        if (args.path !== undefined || args.file_path !== undefined) check(args.path ?? args.file_path);
        if (review?.path !== undefined) check(review.path);
        if (review?.oldPath !== undefined) check(review.oldPath);
        if (name === 'edit' && typeof args.ops === 'string') for (const line of args.ops.split('\n')) if (line.startsWith('MV ')) check(line.slice(3).trim());
      } catch { continue; } // Do not send credential/private file content to the main process.
      const safeReview = review && typeof review === 'object' ? Object.fromEntries(['version', 'sessionId', 'messageId', 'path', 'oldPath', 'operation', 'status', 'state', 'beforeExists', 'afterExists', 'beforeHash', 'afterHash', 'hunks'].filter(key => review[key] !== undefined).map(key => [key, review[key]])) : undefined;
      const editArgs = name === 'edit' ? Object.fromEntries(['ops', 'old_string', 'new_string', ...(typeof args.tag === 'string' && /^[a-fA-F0-9]{4}$/.test(args.tag) ? ['tag'] : [])].filter(key => typeof args[key] === 'string').map(key => [key, args[key]])) : {};
      const lifecycle = safeTaskDetails(name, result.details);
      const details = { ...(safeReview ? { review: safeReview } : {}), ...lifecycle };
      blocks.push({ type: 'tool_call', callId: b.callId, name, status: b.status, args: ['write', 'edit'].includes(name) ? { path: args.path ?? args.file_path, ...editArgs, ...(name === 'write' && typeof args.content === 'string' ? { content: args.content } : {}) } : {}, result: { isError: b.isError ?? result.isError, ...(Object.keys(details).length ? { details } : {}) } });
    }
    return [{ type: 'message' as const, id: value.id, role: value.role, createdAt: value.createdAt, meta, blocks }];
  });
}
export function transcriptEvidence(messages: unknown[]): string {
  return JSON.stringify(hostEvidenceMessages(messages));
}
// Bound the *encoded RPC* size, including escaping and multibyte Unicode.
export function evidenceChunks(text: string): string[] {
  const chunks: string[] = [], encoder = new TextEncoder();
  for (let offset = 0; offset < text.length;) {
    let length = Math.min(24000, text.length - offset);
    while (encoder.encode(JSON.stringify(text.slice(offset, offset + length))).length > 28000) length = Math.floor(length / 2);
    chunks.push(text.slice(offset, offset + length)); offset += length;
  }
  return chunks;
}
export function evidenceRevision(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}-${hash >>> 0}`;
}
