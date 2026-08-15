import type { ModelProviderGroup } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  Model as V1Model,
  Provider as V1Provider,
  ProviderListResponse,
} from '@opencode-ai/sdk/client'
import type {
  ModelV2Info,
  ProviderV2Info,
} from '@opencode-ai/sdk/v2/types'
import {
  externalProviderId,
  externalProviderName,
} from './common.js'

const DEFAULT_CONTEXT = 128000
const DEFAULT_OUTPUT = 8192

/** Known dsh-official model capacities, matching dsh-llm-deepseek defaults. */
const DEEPSEEK_LIMITS: Record<string, { context: number; output: number }> = {
  'deepseek-v4-flash': { context: 1_000_000, output: 256_000 },
  'deepseek-v4-pro': { context: 1_000_000, output: 256_000 },
}

function limitFor(groupId: string, modelId: string) {
  if (groupId === 'deepseek-official') {
    const known = DEEPSEEK_LIMITS[modelId]
    if (known) return known
  }
  return { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT }
}

/**
 * Match opencode's DeepSeek naming for the official dsh route:
 * `DeepSeek-V4-Flash` → `DeepSeek V4 Flash`.
 */
function modelNameFor(groupId: string, modelId: string, modelName?: string) {
  if (groupId === 'deepseek-official') return (modelName ?? modelId).replaceAll('-', ' ')
  return modelName ?? modelId
}

function v1Model(group: ModelProviderGroup, modelId: string, modelName?: string): V1Model {
  const providerId = externalProviderId(group.id)
  const limit = limitFor(group.id, modelId)
  return {
    id: modelId,
    providerID: providerId,
    api: { id: providerId, url: '', npm: '@deepseek-ai/dsh' },
    name: modelNameFor(group.id, modelId, modelName),
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: limit,
    status: 'active',
    options: {},
    headers: {},
  }
}

/** `GET /config/providers` → `providers` array (v1 `Provider[]`). */
export function convertToV1Providers(groups: readonly ModelProviderGroup[]): V1Provider[] {
  return groups.map((group) => {
    const models: Record<string, V1Model> = {}
    for (const model of group.models) {
      models[model.id] = v1Model(group, model.id, model.name)
    }
    return {
      id: externalProviderId(group.id),
      name: externalProviderName(group.id, group.name),
      source: 'api',
      env: [],
      options: {},
      models,
    }
  })
}

/** `GET /provider` → the `{ all, default, connected }` catalog wrapper. */
export function convertToProviderCatalog(
  groups: readonly ModelProviderGroup[],
): ProviderListResponse {
  return {
    all: groups.map((group) => {
      const providerId = externalProviderId(group.id)
      const models: Record<string, ProviderListResponse['all'][number]['models'][string]> = {}
      for (const model of group.models) {
        const limit = limitFor(group.id, model.id)
        models[model.id] = {
          id: model.id,
          name: modelNameFor(group.id, model.id, model.name),
          release_date: '',
          attachment: false,
          reasoning: true,
          temperature: false,
          tool_call: true,
          limit,
          options: {},
          status: 'active',
          provider: { npm: '@deepseek-ai/dsh' },
        }
      }
      return {
        api: 'dsh',
        name: externalProviderName(group.id, group.name),
        env: [],
        id: providerId,
        npm: '@deepseek-ai/dsh',
        models,
      }
    }),
    default: {},
    connected: groups.map((group) => externalProviderId(group.id)),
  }
}

/** `GET /api/model` → `ModelV2Info[]`. */
export function convertToV2Models(groups: readonly ModelProviderGroup[]): ModelV2Info[] {
  return groups.flatMap((group) => {
    const providerId = externalProviderId(group.id)
    return group.models.map((model) => {
      const limit = limitFor(group.id, model.id)
      return {
        id: model.id,
        providerID: providerId,
        name: modelNameFor(group.id, model.id, model.name),
        api: {
          id: providerId,
          type: 'native',
          url: '',
          settings: {},
        },
        capabilities: {
          tools: true,
          input: ['text'],
          output: ['text'],
        },
        request: { headers: {}, body: {} },
        variants: [],
        time: { released: 0 },
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        status: 'active',
        enabled: true,
        limit,
      }
    })
  })
}

/** `GET /api/provider` → `ProviderV2Info[]`. */
export function convertToV2Providers(groups: readonly ModelProviderGroup[]): ProviderV2Info[] {
  return groups.map((group) => ({
    id: externalProviderId(group.id),
    name: externalProviderName(group.id, group.name),
    api: {
      type: 'native',
      url: '',
      settings: {},
    },
    request: { headers: {}, body: {} },
  }))
}
