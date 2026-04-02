// Inner runtime-api shim for the src/rocketchat/ sub-directory.
// Mirrors the pattern used by extensions/mattermost/src/mattermost/runtime-api.ts
// so that files inside src/rocketchat/ can import from "./runtime-api.js"
// and resolve to the outer src/runtime-api.ts barrel.
export * from "../../runtime-api.js";
