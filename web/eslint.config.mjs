import next from 'eslint-config-next'

export default [
  ...next,
  {
    rules: {
      '@next/next/no-img-element': 'off',
      'react/no-children-prop': 'off',
      'react/no-unescaped-entities': 'off', // marketing copy is full of quotes
      // legacy patterns — keep visible as warnings, not build-breakers
      '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn', // load-from-storage-on-mount pattern
      'react-hooks/purity': 'warn',              // genId uses Math.random by design
      'react-hooks/immutability': 'warn',
      'react/display-name': 'warn',
    },
  },
  { ignores: ['.next/**', 'node_modules/**', 'chatgpt-plugin-tinyai/**'] },
]
