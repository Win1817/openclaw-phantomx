/**
 * setup-entry.ts
 *
 * Setup wizard entry point for the Rocket.Chat plugin.
 * Used by the OpenClaw CLI during `openclaw channel setup rocketchat`.
 */

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(rocketchatPlugin);
