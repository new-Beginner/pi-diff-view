/** Exact adapters only: a path argument on an arbitrary tool is not mutation evidence. */
export const explicitToolName = (name: unknown): string => String(name).split('.').pop()!.toLowerCase();
export function isReplacementTool(name: unknown): boolean {
  return ['mcp_fastctx_replace', 'mcp__fastctx__replace'].includes(explicitToolName(name));
}
export function isExplicitFileTool(name: unknown): boolean {
  return ['write', 'edit'].includes(explicitToolName(name)) || isReplacementTool(name);
}
export function isExplicitEvidence(ref: string): boolean {
  const separator = ref.indexOf(':');
  return separator > 0 && isExplicitFileTool(ref.slice(0, separator));
}
