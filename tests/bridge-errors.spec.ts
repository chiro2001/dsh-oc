import { describe, expect, it } from 'vitest'
import { rpcErrorToHttp } from '../src/bridge/errors.js'

describe('bridge dsh 0.1.2 error mapping', () => {
  it.each([
    ['session/not-found', 404],
    ['agent-preset/not-found', 404],
    ['session/model-unavailable', 400],
    ['agent-preset/invalid', 400],
    ['gateway/bad-request', 400],
    ['workspace/invalid-path', 400],
    ['settings/rejected', 400],
    ['session/agent-busy', 409],
    ['session/conflict', 409],
    ['session/steer-unavailable', 409],
  ] as const)('maps %s to HTTP %d', (code, status) => {
    const error = rpcErrorToHttp({ code, message: 'boom', details: { code } })
    expect(error.status).toBe(status)
    expect(error.body.data?.code).toBe(code)
  })

  it('keeps the legacy attachment-error public alias', () => {
    const error = rpcErrorToHttp({
      code: 'session/attachment-invalid',
      message: 'images unsupported',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    })
    expect(error.status).toBe(400)
    expect(error.body.data).toEqual({
      message: 'images unsupported',
      code: 'attachment-error',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    })
  })
})
