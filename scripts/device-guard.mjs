// The last resort around each script teleport serves to the device as a <script> (teleport.js,
// teleport.debug.js, the inspector): if anything at all throws while it loads, the script ends there,
// quietly, and the app's window.onerror and error reporting never hear of it. The code inside guards
// its own callbacks (agent/src/safe.js, inspector/src/cx.js); this catches what runs as it loads.
// Both bundles are strict and are one IIFE, so the try block holds no function declaration and
// "use strict" stays the script's first statement. @tlpt/agent's agent.cjs is the app's own module,
// built into the app's bundle, so it isn't wrapped: its entry (agent/src/entry.cjs) guards its load.
export const deviceGuard = {
  banner: { js: '"use strict";try{' },
  footer: { js: '}catch(e){}' },
};
