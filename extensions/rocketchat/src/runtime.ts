/**
 * runtime.ts
 *
 * Runtime singleton store for the Rocket.Chat plugin.
 * Uses the OpenClaw plugin-sdk pattern for safe runtime access.
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const { setRuntime: setRocketChatRuntime, getRuntime: getRocketChatRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Rocket.Chat runtime not initialized");

export { getRocketChatRuntime, setRocketChatRuntime };
