// Stub for @aws-sdk/client-bedrock-runtime on edge runtime.
// The strands SDK root export pulls in BedrockModel -> AWS SDK -> node:http,
// which breaks the edge build. We only use OpenAIModel.
module.exports = new Proxy({}, {
  get: () => function BedrockStub() {
    throw new Error('Bedrock is not available on edge runtime')
  },
})
