// shared/src/agents/acp/permission.ts

export type PermissionDecision = 'allow' | 'reject';

export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PermissionPolicy {
  decide(req: PermissionRequest): PermissionDecision;
}

export class AutoAllowPolicy implements PermissionPolicy {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  decide(req: PermissionRequest): PermissionDecision {
    return 'allow';
  }
}

/** One of the permission choices an ACP agent offers in `session/request_permission`. */
export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

/**
 * Map a policy decision onto one of the options the agent offered. ACP expects
 * the client to reply with a selected `optionId` (e.g. `allow_always`), not a
 * bare verdict, and the available optionIds vary per request, so we match on the
 * option `kind` and fall back to the id. Returns null when no suitable option is
 * offered (the caller then cancels the request).
 */
export function selectPermissionOption(
  options: PermissionOption[],
  decision: PermissionDecision,
): PermissionOption | null {
  if (decision === 'allow') {
    return (
      options.find((o) => o.kind === 'allow_always') ??
      options.find((o) => o.kind === 'allow_once') ??
      options.find((o) => /allow/i.test(o.optionId)) ??
      null
    );
  }
  return (
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always') ??
    options.find((o) => /reject|deny/i.test(o.optionId)) ??
    null
  );
}
