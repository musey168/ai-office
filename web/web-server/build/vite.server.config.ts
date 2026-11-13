import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Bundles the web server into a single file.
 *
 * The deployment runs the server in a container on a machine whose glibc is
 * too old for the Node binaries — so the container carries a Node runtime and
 * nothing else. One file with no runtime dependencies is the simplest thing
 * that can be copied over the network.
 */
export default defineConfig({
  build: {
    outDir: resolve(__dirname, '../dist-server'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: {
      input: resolve(__dirname, '../src/main.ts'),
      output: {
        format: 'es',
        entryFileNames: 'server.mjs',
      },
    },
  },
  ssr: {
    // The workspace-store and the rpc-bridge are TypeScript sources reached
    // through file: dependencies — they have to be bundled, not externalized.
    noExternal: true,
  },
})
