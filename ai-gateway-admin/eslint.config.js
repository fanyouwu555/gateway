import js from '@eslint/js'
import ts from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
