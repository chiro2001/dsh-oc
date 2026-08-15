/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { DSH, OC } from "./art"

const GAP = "   "
const SUBTITLE = "DeepSeek Harness × OpenCode TUI"

function HomeLogo(props: { theme: TuiThemeCurrent }) {
  const dshColor = props.theme.info
  const ocColor = props.theme.text
  const muted = props.theme.textMuted

  return (
    <box flexDirection="column" alignItems="center">
      <box flexDirection="row">
        <box flexDirection="column">
          {DSH.map((line) => (
            <text fg={dshColor}>{line}</text>
          ))}
        </box>
        <box flexDirection="column">
          {DSH.map(() => (
            <text fg={muted}>{GAP}</text>
          ))}
        </box>
        <box flexDirection="column">
          {OC.map((line) => (
            <text fg={ocColor} bold>{line}</text>
          ))}
        </box>
      </box>
      <text fg={muted}>{SUBTITLE}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    mode: "replace",
    slots: {
      home_logo(ctx) {
        return <HomeLogo theme={ctx.theme.current} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "dsh-oc-logo",
  tui,
}

export default plugin
