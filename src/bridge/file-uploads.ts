import { Service, type Context } from '@deepseek-ai/cordis'

export const name = '@chiro2001/dsh-oc/file-uploads'

/**
 * Headless `fileUploads` provider for the dsh 0.1.5 host tree.
 *
 * dsh 0.1.5 made `fileUploads` a hard dependency of
 * `@deepseek-ai/dsh-api-session-controller` (`static inject`), so mounting the
 * controller without that service leaves the whole oc profile pending:
 * `dsh-api-session-controller` → `@chiro2001/dsh-oc/bridge` → `@chiro2001/dsh-oc/tui`.
 *
 * The official provider (`@deepseek-ai/dsh-client-file-upload`) is a browser
 * transport plugin: it injects `connection` and registers an HTTP fetch route,
 * which the OpenCode-facing bridge does not run. The bridge has no
 * file-receipt surface today (opencode image parts are skipped in
 * `convert/message`), so this service satisfies the contract session-controller
 * activates against and fails loudly the moment a real file receipt reaches it.
 * `bindPrompt` is called on every accepted prompt, including the normal
 * receipt-less one, so its empty-receipts path must stay a no-op.
 */
export class OcFileUploads extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fileUploads')
  }

  /** Session-controller installs its ordinary-Session resolver here at startup. */
  registerAgentResolver(_resolve: (sessionId: string) => Promise<unknown>): () => void {
    return () => {}
  }

  /** Resolve one staged receipt. The bridge never stages uploads. */
  resolve(_agent: unknown, receiptId: string): never {
    throw new Error(
      `dsh-oc: file uploads are unavailable in the headless bridge (receipt "${String(receiptId)}")`,
    )
  }

  /**
   * Bind staged receipts to one submitted prompt. Receipt-less prompts (the
   * only shape oc-bridge produces) get a disposable no-op binding; a prompt
   * that somehow carries receipts is rejected before reaching the Agent.
   *
   * dsh 0.1.5 wraps the returned binding in `using`-style resource
   * management, so it must carry `Symbol.dispose` as well as `commit()`.
   */
  bindPrompt(
    agent: unknown,
    receiptIds: readonly string[],
    _requestId: string,
  ): Disposable & { commit(): void } {
    if (receiptIds.length > 0) this.resolve(agent, receiptIds[0] as string)
    return {
      commit() {},
      [Symbol.dispose]() {},
    }
  }

  /** Retire receipts of a removed queued prompt; nothing was staged. */
  retirePrompt(_agent: unknown, _rpcId: string): void {}

  /** Reject the browser upload entry point so an unexpected caller fails loudly. */
  uploadStream(): never {
    throw new Error('dsh-oc: file uploads are unavailable in the headless bridge')
  }
}

export default OcFileUploads
