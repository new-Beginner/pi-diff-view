// Shared, prose-free Task lifecycle DTOs. A Task result acknowledges launch;
// only its exact delegation execution (ID + startedAt) can settle that launch.
export type DelegationStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'stopped';
export interface DelegationLifecycle { callId: string; owner: string; delegationId?: string; startedAt?: number; completedAt?: number; status: DelegationStatus }
interface Message { id: string; role: string; meta: Record<string, any>; blocks: Record<string, any>[] }
const name = (value: unknown) => String(value).split('.').pop()!.toLowerCase();
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
export function safeDelegation(value: any): Record<string, any> | undefined {
  if (!value || !id(value.delegationId) || !['running', 'completed', 'failed', 'aborted', 'stopped'].includes(value.status) || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) return undefined;
  return { delegationId: value.delegationId, status: value.status, startedAt: value.startedAt, ...(Number.isSafeInteger(value.completedAt) && value.completedAt >= value.startedAt ? { completedAt: value.completedAt } : {}) };
}
export function safeTaskDetails(tool: string, details: any): Record<string, any> | undefined {
  if (!details || typeof details !== 'object') return undefined;
  if (name(tool) === 'task') return safeDelegation(details);
  if (!['taskwait', 'task_wait', 'tasklist', 'taskstop'].includes(name(tool))) return undefined;
  const output: Record<string, any> = {};
  for (const key of ['delegations', 'stopped', 'stopPending', 'settled']) if (Array.isArray(details[key])) output[key] = details[key].slice(0, 256).map(safeDelegation).filter(Boolean);
  return Object.keys(output).length ? output : undefined;
}
/** Resolve parent call chains, never the latest visible user for child messages. */
export function messageOwners(messages: Message[]): Map<string, string> {
  const aliases = new Map<string, Message>(), sequential = new Map<string, string>(); let current: string | undefined;
  for (const message of messages) {
    if (message.role === 'user' && !message.meta.parentMessageId && !message.meta.steering) current = message.id;
    if (current && !message.meta.parentMessageId) sequential.set(message.id, current);
    aliases.set(message.id, message);
    for (const block of message.blocks) if (block.type === 'tool_call' && id(block.callId)) aliases.set(block.callId, message);
  }
  const owner = (message: Message, seen = new Set<string>()): string | undefined => {
    if (seen.has(message.id)) return undefined; seen.add(message.id);
    if (message.meta.userMessageId !== undefined) { const user = aliases.get(message.meta.userMessageId); return user?.role === 'user' && !user.meta.parentMessageId ? user.id : undefined; }
    if (message.meta.parentMessageId) { const parent = aliases.get(message.meta.parentMessageId); return parent ? owner(parent, seen) : undefined; }
    return sequential.get(message.id);
  };
  const owners = new Map<string, string>();
  for (const message of messages) { const user = owner(message); if (user) owners.set(message.id, user); }
  return owners;
}
export function collectDelegations(messages: Message[], ownerOf?: (message: Message) => string | undefined): DelegationLifecycle[] {
  const owners = ownerOf ? undefined : messageOwners(messages);
  const resolveOwner = ownerOf ?? ((message: Message) => owners!.get(message.id));
  const launches = new Map<string, DelegationLifecycle>();
  for (const message of messages) for (const block of message.blocks) {
    if (block.type !== 'tool_call' || name(block.name) !== 'task' || !id(block.callId)) continue;
    const owner = resolveOwner(message); if (!owner) continue;
    const summary = safeDelegation(block.result?.details);
    launches.set(block.callId, { callId: block.callId, owner, status: block.status === 'error' || block.result?.isError ? 'failed' : 'running', ...summary });
  }
  // Samples may belong to a later user, but only update an already bound launch.
  for (const message of messages) for (const block of message.blocks) {
    const details = safeTaskDetails(block.name, block.result?.details);
    if (!details || name(block.name) === 'task' || block.result?.isError) continue;
    for (const sample of Object.values(details).flat() as Record<string, any>[]) {
      const targets = [...launches.values()].filter(launch => launch.delegationId === sample.delegationId && launch.startedAt === sample.startedAt);
      if (targets.length !== 1) continue;
      const target = targets[0];
      if (target.status !== 'running') continue; // A stale heartbeat cannot undo settlement.
      Object.assign(target, sample);
    }
  }
  return [...launches.values()];
}
