/** Plugin entry. The channel itself lives in the adapter. */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { plugin, register } from "./src/adapter.js";
import { CHANNEL_ID } from "./src/utils.js";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Plivo Phone",
  description: "Real-time voice conversations over Plivo Audio Streaming",
  plugin,
  registerFull: register,
});
