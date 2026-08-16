import { DSH, OC } from '../../tui-branding/art.js'

const GAP = '   '
const SUBTITLE = 'DeepSeek Harness × OpenCode TUI'

/**
 * Plain-text DSH OC brand banner for `--mini` launches. The official mini
 * interface does not load TUI plugins (its entry splash is hard-coded), so
 * dsh-oc prints the brand itself before spawning the child.
 */
export function renderMiniBrand(): string {
  const rows = DSH.map((line, index) => `${line}${GAP}${OC[index] ?? ''}`)
  return `${rows.join('\n')}\n${SUBTITLE}\n`
}
