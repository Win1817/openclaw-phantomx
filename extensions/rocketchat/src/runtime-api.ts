// Private runtime barrel for the bundled Rocket.Chat extension.
// Re-exports the shared plugin-sdk surface used by all channel plugins.
// Mirrors the pattern used by the Mattermost extension:
//   extensions/mattermost/runtime-api.ts → "openclaw/plugin-sdk/mattermost"
// No rocketchat-specific SDK module exists; we re-export the generic surfaces
// that our source files actually consume from this barrel.

export * from "openclaw/plugin-sdk/core";
export * from "openclaw/plugin-sdk/account-helpers";
export * from "openclaw/plugin-sdk/account-id";
export * from "openclaw/plugin-sdk/account-resolution";
export * from "openclaw/plugin-sdk/allow-from";
export * from "openclaw/plugin-sdk/channel-config-helpers";
export * from "openclaw/plugin-sdk/channel-config-primitives";
export * from "openclaw/plugin-sdk/channel-contract";
export * from "openclaw/plugin-sdk/routing";
export * from "openclaw/plugin-sdk/runtime-store";
export * from "openclaw/plugin-sdk/status-helpers";
export * from "openclaw/plugin-sdk/extension-shared";
