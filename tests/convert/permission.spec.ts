import { describe, expect, it } from 'vitest'
import {
  permissionActionFromTool,
  toPermissionRequest,
  toPermissionV2,
  type PermissionEntry,
} from '../../src/bridge/convert/permission.js'

const entry: PermissionEntry = {
  opencodeId: 'perm-1',
  rpcId: 'rpc-1',
  sessionId: 's1',
  approvalId: 'approval-1',
  toolName: 'bash',
  callId: 'call-1',
  reason: 'run ls',
}

describe('convert/permission', () => {
  it('maps tool names to permission categories', () => {
    expect(permissionActionFromTool('bash')).toBe('bash')
    expect(permissionActionFromTool('fs_write')).toBe('edit')
    expect(permissionActionFromTool('fs_read')).toBe('edit')
    expect(permissionActionFromTool('read')).toBe('read')
    expect(permissionActionFromTool('webfetch')).toBe('webfetch')
    expect(permissionActionFromTool('anything_else')).toBe('anything_else')
  })

  it('builds the legacy PermissionRequest', () => {
    const request = toPermissionRequest(entry)
    expect(request.id).toBe('perm-1')
    expect(request.sessionID).toBe('s1')
    expect(request.permission).toBe('bash')
    expect(request.patterns).toEqual([])
    expect(request.always).toEqual([])
    expect(request.metadata).toMatchObject({ toolName: 'bash', callId: 'call-1', reason: 'run ls' })
    expect(request.tool).toEqual({ messageID: '', callID: 'call-1' })
  })

  it('builds the v2 PermissionV2Request', () => {
    const request = toPermissionV2(entry)
    expect(request.id).toBe('perm-1')
    expect(request.action).toBe('bash')
    expect(request.resources).toEqual([])
    expect(request.source).toEqual({ type: 'tool', messageID: '', callID: 'call-1' })
  })

  it('omits optional tool/source fields when absent', () => {
    const bare: PermissionEntry = { ...entry, callId: undefined, reason: undefined }
    expect(toPermissionRequest(bare).tool).toBeUndefined()
    expect(toPermissionV2(bare).source).toBeUndefined()
  })
})
