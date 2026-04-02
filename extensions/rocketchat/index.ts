/**
 * index.ts — Rocket.Chat channel plugin entry point.
 *
 * This is the file referenced by openclaw.plugin.json → extensions[].
 * It exports:
 *   - The plugin object (named + default via defineChannelPluginEntry)
 *   - The runtime setter (consumed by the gateway bootstrap)
 *   - The registerFull hook (wires HTTP routes for slash commands)
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin } from "./src/channel.js";
import { setRocketChatRuntime } from "./src/runtime.js";
import { registerRocketChatSlashCommandRoute } from "./src/rocketchat/slash-commands.js";

export { rocketchatPlugin } from "./src/channel.js";
export { setRocketChatRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "rocketchat",
  name: "Rocket.Chat",
  description:
    "Production-grade Rocket.Chat integration with DDP real-time events, " +
    "slash commands, multi-agent orchestration, and event-bus scaling.",
  plugin: rocketchatPlugin,
  setRuntime: setRocketChatRuntime,
  registerFull(api) {
    // Wire the slash-command HTTP callback endpoint on the gateway.
    // Actual slash commands in Rocket.Chat are configured as Outgoing Webhooks
    // pointing to <gateway-url>/rocketchat/slash/<accountId>.
    registerRocketChatSlashCommandRoute(api);
  },
});
