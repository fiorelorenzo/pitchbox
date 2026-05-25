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
  decide(_req: PermissionRequest): PermissionDecision {
    return 'allow';
  }
}
