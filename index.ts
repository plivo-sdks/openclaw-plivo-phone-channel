/** Plugin entry. The channel itself lives in the adapter, as it does in the Hermes plugin. */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { plugin, register } from "./src/adapter.js";
import { CHANNEL_ID } from "./src/utils.js";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Plivo Phone",
  description:
    "Real-time voice conversations over Plivo Audio Streaming, inbound and outbound",
  plugin,
  registerFull: register,
});
