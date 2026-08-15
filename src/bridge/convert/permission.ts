import type {
  PermissionRequest,
  PermissionV2Request,
} from '@opencode-ai/sdk/v2/types'

export interface PermissionEntry {
  opencodeId: string
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

/** Map a dsh tool name onto the opencode permission category. */
export function permissionActionFromTool(toolName: string): string {
  if (toolName === 'bash' || toolName.endsWith('.bash') || toolName.endsWith('_bash')) return 'bash'
  if (toolName === 'edit' || toolName === 'write' || toolName.endsWith('.edit') || toolName.includes('fs_')) {
    return 'edit'
  }
  if (toolName === 'read' || toolName.endsWith('.read')) return 'read'
  if (toolName === 'webfetch' || toolName.endsWith('.webfetch')) return 'webfetch'
  if (toolName === 'ask_user_question') return 'unknown'
  return toolName
}

/** Legacy `/permission` + `permission.asked` SSE shape. */
export function toPermissionRequest(entry: PermissionEntry): PermissionRequest {
  return {
    id: entry.opencodeId,
    sessionID: entry.sessionId,
    permission: permissionActionFromTool(entry.toolName),
    patterns: [],
    metadata: {
      toolName: entry.toolName,
      ...(entry.callId === undefined ? {} : { callId: entry.callId }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    },
    always: [],
    ...(entry.callId === undefined ? {} : { tool: { messageID: '', callID: entry.callId } }),
  }
}

/** v2 `/api/session/{id}/permission` shape. */
export function toPermissionV2(entry: PermissionEntry): PermissionV2Request {
  return {
    id: entry.opencodeId,
    sessionID: entry.sessionId,
    action: permissionActionFromTool(entry.toolName),
    resources: [],
    metadata: {
      toolName: entry.toolName,
      ...(entry.callId === undefined ? {} : { callId: entry.callId }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    },
    ...(entry.callId === undefined ? {} : { source: { type: 'tool', messageID: '', callID: entry.callId } }),
  }
}
