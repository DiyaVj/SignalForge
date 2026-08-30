import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.warn(`[config] Warning: ${name} is not set in .env — related endpoints will fail until it is.`);
  }
  return v;
}

export const config = {
  agoraAppId: required('AGORA_APP_ID'),
  agoraAppCertificate: required('AGORA_APP_CERTIFICATE'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  publicServerUrl: required('PUBLIC_SERVER_URL'),
  port: Number(process.env.PORT || 8787),
  defaultChannel: process.env.DEFAULT_CHANNEL || 'signalforge-demo',
  tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS || 3600),
};
