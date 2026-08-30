// Calls Agora's Conversational AI Engine REST API to start and stop the
// voice agent. Schema verified against:
//   https://docs.agora.io/en/ai/build/start-stop-agent
//   https://docs.agora.io/en/api-reference/api-ref/conversational-ai/authentication
//
// The core idea: the agent's "LLM" is OUR OWN server (llm.vendor = "custom"),
// pointed at PUBLIC_SERVER_URL + /llm/chat/completions. Agora's engine does
// ASR (speech-to-text) and TTS (text-to-speech) for us; every turn it POSTs
// an OpenAI-format chat-completion request to our endpoint and speaks back
// whatever text we return. That's where all of SignalForge's reasoning
// (evidence classification, contracts, verification) actually lives.

import axios from 'axios';
import { config } from './config.js';
import { buildToken } from './tokens.js';

const BASE_URL = () =>
  `https://api.agora.io/api/conversational-ai-agent/v2/projects/${config.agoraAppId}`;

/**
 * @param {object} opts
 * @param {string} opts.channel
 * @param {string} opts.agentUid   Numeric-looking string UID for the agent, e.g. "0"
 * @param {string[]} opts.remoteUids  UIDs of human participants the agent should listen to
 * @returns {Promise<{agentId: string, raw: object}>}
 */
export async function startAgent({ channel, agentUid = '0', remoteUids }) {
  if (!config.publicServerUrl) {
    throw new Error(
      'PUBLIC_SERVER_URL is not set. Agora must be able to reach your /llm/chat/completions ' +
      'endpoint over the public internet — run a tunnel (e.g. `ngrok http ' + config.port + '`) ' +
      'and set PUBLIC_SERVER_URL to the https URL it gives you.',
    );
  }

  const token = buildToken(channel, agentUid);

  const body = {
    name: `signalforge-${Date.now()}`,
    properties: {
      channel,
      token,
      agent_rtc_uid: agentUid,
      remote_rtc_uids: remoteUids && remoteUids.length ? remoteUids : ['*'],
      enable_string_uid: false,
      idle_timeout: 120,

      // ASR / TTS run in Agora-managed mode so we don't need our own
      // Deepgram/ElevenLabs keys for the prototype. Swap credential_mode to
      // "byok" plus your own vendor + params to use your own providers.
      asr: {
        credential_mode: 'managed',
        vendor: 'deepgram',
        params: { url: 'wss://api.deepgram.com/v1/listen', model: 'nova-3', language: 'en-US' },
      },
      tts: {
        credential_mode: 'managed',
        vendor: 'minimax',
        params: {
          url: 'wss://api.minimax.io/ws/v1/t2a_v2',
          model: 'speech-2.6-turbo',
          voice_setting: { voice_id: 'English_captivating_female1' },
        },
      },

      // This is the important part: our own backend stands in as the LLM.
      llm: {
        vendor: 'custom',
        style: 'openai',
        url: `${config.publicServerUrl}/llm/chat/completions`,
        // If you want to require a shared secret, check it inside
        // /llm/chat/completions against this same value.
        api_key: process.env.LLM_SHARED_SECRET || undefined,
        system_messages: [], // SignalForge's system prompt lives server-side in truthEngine.js
        greeting_message: "SignalForge is on the call. I'll track facts, flag conflicts, and hold critical actions for approval.",
        failure_message: "I hit an error reasoning about that — please repeat the last update.",
        max_history: 20,
        params: { model: 'signalforge-truth-engine' },
      },

      advanced_features: {
        enable_rtm: true, // needed for Signaling-based events/transcripts if you add the client toolkit later
      },
      parameters: {
        data_channel: 'rtm',
        enable_metrics: true,
        enable_error_message: true,
      },
    },
  };

  const { data } = await axios.post(`${BASE_URL()}/join`, body, {
    headers: {
      Authorization: `agora token=${token}`,
      'Content-Type': 'application/json',
    },
  });

  return { agentId: data.agent_id, raw: data };
}

export async function stopAgent(agentId, { channel, agentUid = '0' } = {}) {
  // The leave call is authenticated the same way as join. Any valid token
  // for this App ID works here; reusing a fresh one for the same channel/uid
  // keeps this simple.
  const token = channel ? buildToken(channel, agentUid) : buildToken(config.defaultChannel, agentUid);

  const { data } = await axios.post(
    `${BASE_URL()}/agents/${agentId}/leave`,
    {},
    { headers: { Authorization: `agora token=${token}` } },
  );
  return data;
}

/**
 * Inject a system-style instruction into the agent's live pipeline so it can
 * speak proactively (e.g. right after a human clicks "Approve" in the UI,
 * rather than waiting for someone to say something).
 *
 * NOTE: verify the exact request path and body against Agora's current
 * "Send a custom instruction" reference before relying on this in production —
 * https://docs.agora.io/en/api-reference/api-ref/conversational-ai/think
 * The shape below matches the documented parameters (on_listening_action,
 * on_thinking_action, on_speaking_action, interruptable) as of this writing,
 * but Agora has changed defaults on this endpoint before (see release notes).
 */
export async function sendCustomInstruction(agentId, text, { channel, agentUid = '0' } = {}) {
  const token = channel ? buildToken(channel, agentUid) : buildToken(config.defaultChannel, agentUid);

  const { data } = await axios.post(
    `${BASE_URL()}/agents/${agentId}/think`,
    {
      text,
      on_listening_action: 'inject',
      on_thinking_action: 'interrupt',
      on_speaking_action: 'ignore',
      interruptable: true,
    },
    { headers: { Authorization: `agora token=${token}`, 'Content-Type': 'application/json' } },
  );
  return data;
}
