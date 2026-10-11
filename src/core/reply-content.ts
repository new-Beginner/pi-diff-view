/** entryExtra receives the host's paragraph-joined task transcript, not just its last message. */
export const MAX_REPLY_PAYLOAD = 24000;
const encoder = new TextEncoder();
/** Bound the serialized wire text while retaining the end verbatim. Never truncate a final reply into a match. */
export function replyTail(content: string): string {
  const tail = content.slice(-MAX_REPLY_PAYLOAD);
  let low = 0, high = tail.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (encoder.encode(JSON.stringify(tail.slice(mid))).length <= MAX_REPLY_PAYLOAD) high = mid;
    else low = mid + 1;
  }
  // Do not begin with the low half of a split Unicode surrogate pair.
  if (low > 0 && tail.charCodeAt(low) >= 0xdc00 && tail.charCodeAt(low) <= 0xdfff) low++;
  return tail.slice(low);
}
/** Exact complete paragraph suffixes only; the server still requires one settled task and its final timestamp. */
export function finalReplyCandidates(content: string): string[] {
  if (encoder.encode(JSON.stringify(content)).length > MAX_REPLY_PAYLOAD) return [];
  const candidates = new Set([content.trim()]);
  let end = content.length;
  for (let count = 0; count < 256; count++) {
    const boundary = content.lastIndexOf('\n\n', end - 1);
    if (boundary < 0) break;
    candidates.add(content.slice(boundary + 2).trim());
    end = boundary;
  }
  return [...candidates].filter(Boolean);
}
