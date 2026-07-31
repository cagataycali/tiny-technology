const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
    async headers() {
        return [
            {
                // Apple's CDN requires the AASA file as application/json; the
                // file is extension-less in public/.well-known so the static
                // server would otherwise guess a generic type.
                source: '/.well-known/apple-app-site-association',
                headers: [{ key: 'Content-Type', value: 'application/json' }],
            },
        ]
    },
    experimental: {
        nextScriptWorkers: true,
    },
    turbopack: {
        // The repo root, not web/: app routes import the chain guards from the
        // sibling chain/ directory (tsconfig "@/chain/*" → "../chain/*"), and
        // Turbopack refuses to resolve outside its project root.
        root: path.join(__dirname, '..'),
        resolveAlias: {
            '@aws-sdk/client-bedrock-runtime': './lib/empty-module.js',
            '@aws-sdk/client-s3': './lib/empty-module.js',
            // Strands SDK LocalFileStorage / context-offloader dynamically import
            // node:fs & node:path — never called on edge, but Vercel's edge
            // validator rejects any reference. Stub them out.
            'node:fs/promises': './lib/empty-module.js',
            'node:fs': './lib/empty-module.js',
            'node:path': './lib/empty-module.js',
            // Optional native addons for 'ws' (via openai/@google/genai).
            // node-gyp-build references __non_webpack_require__ which is
            // undefined when bundled — stub them out.
            'bufferutil': './lib/empty-module.js',
            'utf-8-validate': './lib/empty-module.js',
        },
    },
    webpack: (config, { nextRuntime }) => {
        config.resolve.alias['@aws-sdk/client-bedrock-runtime'] = false;
        config.resolve.alias['@aws-sdk/client-s3'] = false;
        config.resolve.alias['bufferutil'] = false;
        config.resolve.alias['utf-8-validate'] = false;
        if (nextRuntime === 'edge') {
            config.resolve.alias['node:fs/promises'] = false;
            config.resolve.alias['node:fs'] = false;
            config.resolve.alias['node:path'] = false;
        }
        return config;
    },
}

module.exports = nextConfig
