# SignalForge — real Agora integration

This is a working (not simulated) version of SignalForge: it actually starts an Agora
Conversational AI voice agent, actually reasons with Claude, and actually updates a live
evidence ledger in the browser via WebSocket. It replaces the scripted demo prototype's
`SCRIPT` array with the real thing.

## How it fits together

```
 Browser (client/)                    Your server (server/)                 Agora cloud
┌───────────────────┐   mic audio    ┌────────────────────────┐   audio    ┌────────────────┐
│ Agora RTC SDK      │──────────────▶│  (no audio flows        │◀──────────▶│ Conversational │
│ joins channel,     │◀───────────────│   through your server — │            │ AI Engine       │
│ plays agent's      │  agent audio   │   Agora handles it)    │            │ (ASR + TTS)     │
│ voice              │                 │                        │            └───────┬────────┘
└─────────┬──────────┘                │  POST /llm/chat/       │                    │
          │ WebSocket (ledger,        │  completions  ◀────────┼────────────────────┘
          │ transcript, contracts)    │  (this is SignalForge's "brain" —  OpenAI-format
          ▼                           │   truthEngine.js calls Claude       request every turn)
   Live evidence panel                │   with tools, then returns
   + contract approval UI             │   the text to speak)
                                       └────────────────────────┘
```

The key idea: Agora's Conversational AI Engine does speech-to-text and text-to-speech for
you. Every conversation turn, it sends the running transcript to whatever "LLM" you configured
— in this project, that's your own `/llm/chat/completions` endpoint, not a vendor like OpenAI
directly. That endpoint is where `truthEngine.js` calls Claude with tools (`log_evidence`,
`propose_contract`, `update_contract_state`), executes them against an in-memory ledger, and
returns the text SignalForge should say. The browser never talks to Agora's REST API directly —
only your server does (App Certificate must never reach the client).

## Setup

### 1. Agora Console
1. Create a project in the [Agora Console](https://console.agora.io) and enable **RTC** and
   **Conversational AI Engine** (enabled by default for new projects).
2. Copy your **App ID** and **App Certificate**.
3. Under your account menu → **RESTful API Keys**, this project's token-based auth doesn't need
   these, but keep them in mind if you later switch to Basic auth.

### 2. Expose your server publicly (required)
Agora's cloud calls your `/llm/chat/completions` endpoint over the public internet, so
`localhost` will not work for that one route. For local dev:
```bash
ngrok http 8787
```
Copy the `https://...ngrok-free.app` URL it gives you — you'll need it in `.env`.

### 3. Server
```bash
cd server
cp .env.example .env
# fill in AGORA_APP_ID, AGORA_APP_CERTIFICATE, ANTHROPIC_API_KEY, PUBLIC_SERVER_URL
npm install
npm run dev
```

### 4. Client
```bash
cd client
npm install
npm run dev
```
Open the printed local URL (usually `http://localhost:5173`), join a channel, then click
**Start SignalForge**. Open a second browser tab (or have a teammate join) so there's someone
for the agent to actually mediate between.

## What's real vs. what to verify before a live demo

**Verified directly against Agora's current docs** (fetched while building this):
- The `join` / `leave` REST request and response shapes (`server/src/agoraAgent.js`)
- The custom-LLM contract: your endpoint must accept OpenAI-format chat completions and can
  return either a single JSON response or an SSE stream (`server/src/truthEngine.js`)
- Token generation and the `Authorization: agora token=<token>` header pattern
  (`server/src/tokens.js`)

**Worth double-checking yourself before you rely on them in front of judges:**
- `sendCustomInstruction` (the "let the agent speak proactively after an approval click" call)
  — I matched the documented parameters for Agora's "Send a custom instruction" endpoint, but
  couldn't fetch its exact request path/body during this session to triple-check. If it 404s,
  the approval still works — the agent just won't announce it unprompted; it'll mention the
  approval next time someone speaks instead. Check
  https://docs.agora.io/en/api-reference/api-ref/conversational-ai/think before the demo.
- **Per-speaker attribution.** Agora's docs mention that `llm.vendor: "custom"` causes extra
  metadata (turn ID, timestamp, and in voiceprint mode, speaker identity) to be included in
  requests to your LLM, but the exact field names for a multi-participant room aren't fully
  pinned down in the current public docs. `truthEngine.js` reads defensively
  (`m.metadata?.uid`, falling back to `m.name`) — test with two real speakers early and adjust
  the field lookup once you see what Agora actually sends in your logs.
- ASR/TTS vendors are set to managed Deepgram + MiniMax in `agoraAgent.js` as a reasonable
  default — swap for whatever's enabled on your Agora project if those aren't available.

## Extending it

- **Multiple concurrent incidents**: `ledgerStore.js` and the `activeSession` pointer in
  `index.js` are single-session, in-memory, for demo clarity. Key everything by channel/session
  ID and move to a real datastore before running more than one incident at a time.
- **Real verification data**: right now `update_contract_state` is only ever called by Claude
  reasoning over what people say. Wire a real webhook (e.g. from your monitoring tool) into a
  new `/webhooks/metrics` route that calls `ledger.updateContract(...)` directly, so
  "recovery not yet verified" can be driven by actual telemetry instead of a person reporting it.
- **True token-level streaming**: `truthEngine.js` currently buffers Claude's full reply (after
  the tool loop finishes) before chunking it into SSE frames. For lower latency, stream
  Anthropic's response directly once you're past the last tool call.
