import { createHash } from 'node:crypto'

export const OPENCODE_VERSION = '1.18.18'
export const DEFAULT_AGENT = 'build'

/**
 * External provider identity. dsh calls its official route
 * `deepseek-official`; opencode expects `deepseek` with display name
 * `DeepSeek`. Every other provider id passes through unchanged.
 */
export function externalProviderId(providerId: string): string {
  return providerId === 'deepseek-official' ? 'deepseek' : providerId
}

export function externalProviderName(providerId: string, displayName?: string): string {
  if (providerId === 'deepseek-official') return 'DeepSeek'
  return displayName ?? providerId
}

/** Stable short hash used as the opencode project id. */
export function projectIdFor(directory: string): string {
  return createHash('sha256').update(directory).digest('hex').slice(0, 16)
}

export function stableId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

export function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function textFromBlocks(content: readonly { type: string; text?: unknown }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
