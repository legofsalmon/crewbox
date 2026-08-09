import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

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
    files: ['deploy/**/*.mjs', 'scripts/**/*.mjs', 'web/scripts/**/*.mjs', 'site/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
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
