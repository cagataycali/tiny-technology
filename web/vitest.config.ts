import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    // Only this repo's suite — tiny-tech/ has its own node:test .mjs tests
    // (run via its package), and careless/agi-diy are reference clones.
    // .tsx = the jsdom component lane (c13): each such file declares
    // `// @vitest-environment jsdom` itself; .ts tests stay node-env.
    include: ['tests/**/*.test.{ts,tsx}'],
  },
  resolve: {
    // Mirror tsconfig's paths: "@/chain/*" → the sibling chain/ directory,
    // "@/*" → this web root. Array form — the object form does not guarantee
    // the more specific alias wins.
    alias: [
      { find: /^@\/chain\//, replacement: path.resolve(__dirname, '../chain') + '/' },
      { find: /^@\//, replacement: path.resolve(__dirname) + '/' },
    ],
  },
})
