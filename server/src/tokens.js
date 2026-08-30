// Token generation for both the human clients and the agent itself.
//
// Agora's own docs (RESTful authentication) show generating a single combined
// RTC + RTM token with `RtcTokenBuilder.buildTokenWithRtm` and using that same
// token both as the `Authorization: agora token=<token>` header on REST calls
// AND as `properties.token` in the join request body. We reuse that pattern
// here for the agent's token, and use the same builder for human clients so
// they can join the RTC channel and (optionally) subscribe to Signaling.
//
// Reference: https://docs.agora.io/en/api-reference/api-ref/conversational-ai/authentication

import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { config } from './config.js';

/**
 * @param {string} channel
 * @param {string|number} uid  Numeric or string UID (string UIDs require
 *   `enable_string_uid: true` wherever this token is used to join).
 * @returns {string} token
 */
export function buildToken(channel, uid) {
  if (!config.agoraAppId || !config.agoraAppCertificate) {
    throw new Error('AGORA_APP_ID / AGORA_APP_CERTIFICATE are not configured.');
  }
  const tokenExpirationInSeconds = config.tokenTtlSeconds;
  const privilegeExpirationInSeconds = config.tokenTtlSeconds;

  return RtcTokenBuilder.buildTokenWithRtm(
    config.agoraAppId,
    config.agoraAppCertificate,
    channel,
    uid,
    RtcRole.PUBLISHER,
    tokenExpirationInSeconds,
    privilegeExpirationInSeconds,
  );
}
