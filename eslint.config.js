import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

/**
 * The bridge's ways to call a native method by its name. In either app, a
 * call to a method the app lacks is dropped and never settles.
 */
const callsByName = ['nativePromise', 'nativeCallback', 'toNative', 'withPlugin'].map(
  (property) => ({
    property,
    message:
      'Call it through its plugin in lib/server.ts: a call by name to a method the app lacks never settles.',
  })
)

const pluginsOutsideServer = {
  property: 'Plugins',
  message: 'Reach a native plugin through its accessor in lib/server.ts, which declares it.',
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/dev-dist/',
      '**/build/',
      '**/data/',
      // Generated native platform projects (Phase 5 owns these).
      'native/android/',
      'native/ios/',
      'playwright-report/',
      'test-results/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  { ...reactRefresh.configs.vite, files: ['web/src/**/*.{ts,tsx}'] },
  {
    // The screens reach the apps' native code only through the plugins
    // web/src/lib/server.ts declares (web/src/lib/nativeApi.ts says why).
    files: ['web/src/**/*.{ts,tsx}'],
    ignores: ['web/src/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-properties': ['error', ...callsByName, pluginsOutsideServer] },
  },
  {
    files: ['web/src/lib/server.ts'],
    rules: { 'no-restricted-properties': ['error', ...callsByName] },
  },
  {
    files: [
      'deploy/**/*.mjs',
      'scripts/**/*.mjs',
      'web/scripts/**/*.mjs',
      'site/**/*.mjs',
      'server/test/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        WebSocket: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    // The docs pages' client script runs in the browser, not Node.
    files: ['site/docs/docs.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  prettier
)
