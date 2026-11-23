// Does this device need the Promise polyfill it ships, and what does it cost? The native Promise against
// a polyfill loaded over the native one. `checks` ask the engine whether its Promise is native;
// `chainMs` is the measure's own number; `scriptsMs`, `heapDeltaKB` and `loadMs` come from the
// profile every run gets.
//
//   npx tlpt q trial examples/trials/promise-polyfill.mjs
//
// Everything below the laptop's `export default` runs on the device, so it is ES5.
export default {
  name: 'promise polyfill',
  runs: 7,
  checks: {
    nativePromise: "typeof Promise==='function'&&/\\[native code\\]/.test(Function.prototype.toString.call(Promise))",
    microtasks: "typeof queueMicrotask==='function'",
  },
  variants: [
    { name: 'native' },
    {
      name: 'polyfill',
      // Remove the native one first, as a polyfill that checks for it would otherwise do nothing.
      before: 'try{delete window.Promise}catch(e){}window.Promise=undefined',
      scripts: ['https://cdn.jsdelivr.net/npm/promise-polyfill@8.3.0/dist/polyfill.min.js'],
    },
  ],
  measure: function (T) {
    var t0 = T.now();
    var n = 0;
    function step() {
      if (++n < 2000) Promise.resolve().then(step);
      else T.done({ chainMs: T.now() - t0 });
    }
    step();
  },
  better: { chainMs: 'lower' },
};
