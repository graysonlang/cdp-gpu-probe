// Tiny environment-agnostic helpers. Deliberately free of node:* and browser
// globals so the capture/analysis core can import from here without dragging a
// runtime-specific dependency (e.g. cdp.mjs's node:child_process) into a browser
// or extension bundle.

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
