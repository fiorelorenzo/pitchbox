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
