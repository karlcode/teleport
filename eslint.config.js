import esx from 'eslint-plugin-es-x';

// The agent and the inspector must run on Chromium-38-era engines: ES5 syntax and built-ins only. Typed arrays
// and DataView exist there (Chrome 7+/9+), but ES2015 additions to them (fill, from, of, ...) do not.
export default [
  {
    files: ['packages/agent/src/**/*.js', 'packages/inspector/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        require: 'readonly', exports: 'writable', module: 'writable',
        window: 'readonly', self: 'readonly', document: 'readonly', location: 'readonly', performance: 'readonly',
        WebSocket: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        ArrayBuffer: 'readonly', DataView: 'readonly', Uint8Array: 'readonly', Uint16Array: 'readonly',
        Uint32Array: 'readonly', Float32Array: 'readonly', Float64Array: 'readonly',
        console: 'readonly', XMLHttpRequest: 'readonly', getComputedStyle: 'readonly',
        PerformanceObserver: 'readonly',
        // Put in by the agent's build (packages/agent/build.mjs).
        TELEPORT_VERSION: 'readonly',
      },
    },
    plugins: { 'es-x': esx },
    rules: {
      ...esx.configs['flat/restrict-to-es5'].rules,
      'es-x/no-typed-arrays': 'off',
      'es-x/no-array-prototype-fill': ['error', { aggressive: true }],
      'es-x/no-array-from': 'error',
      'es-x/no-array-of': 'error',
      'no-undef': 'error',
      // ES5 has function scope only: `var x = x()` inside a function makes x undefined before the call.
      'no-shadow': ['error', { builtinGlobals: false, hoist: 'all' }],
      'no-restricted-properties': ['error',
        { property: 'fill', message: 'TypedArray#fill is ES2015 (missing on Chrome 38).' },
        { object: 'Object', property: 'assign', message: 'ES2015.' },
      ],
    },
  },
  { ignores: ['**/dist/**', 'packages/agent/src/generated/**'] },
];
