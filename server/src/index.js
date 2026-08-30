import express from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config.js';
import { buildToken } from './tokens.js';
import { startAgent, stopAgent, sendCustomInstruction } from './agoraAgent.js';
import { chatCompletionsHandler } from './truthEngine.js';
import { attachWebSocketServer } from './wsHub.js';
import * as ledger from './ledgerStore.js';

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session pointer so the demo's "stop" button and the approval
// endpoint know which running agent to talk to. Fine for a single concurrent
// incident; key this by channel/session id for anything more than a demo.
let activeSession = null; // { agentId, channel, agentUid }

// --- Client bootstrap ------------------------------------------------------

app.post('/api/token', (req, res) => {
  const { channel = config.defaultChannel, uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid is required' });
  try {
    const token = buildToken(channel, uid);
    res.json({ token, channel, uid, appId: config.agoraAppId });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/participants/register', (req, res) => {
  const { uid, name, role } = req.body || {};
  if (!uid || !name) return res.status(400).json({ error: 'uid and name are required' });
  ledger.setParticipant(uid, name, role || 'Participant');
  res.json({ ok: true });
});

// --- Agent lifecycle ---------------------------------------------------

app.post('/api/agent/start', async (req, res) => {
  const { channel = config.defaultChannel, remoteUids } = req.body || {};
  try {
    const { agentId } = await startAgent({ channel, remoteUids });
    activeSession = { agentId, channel, agentUid: '0' };
    res.json({ agentId, channel });
  } catch (err) {
    console.error('[api/agent/start]', err?.response?.data || err);
    res.status(500).json({ error: String(err?.response?.data?.reason || err.message || err) });
  }
});

app.post('/api/agent/stop', async (req, res) => {
  if (!activeSession) return res.status(400).json({ error: 'No active agent session.' });
  try {
    await stopAgent(activeSession.agentId, activeSession);
    activeSession = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err?.response?.data?.reason || err.message || err) });
  }
});

// --- Ledger / contracts ---------------------------------------------------

app.get('/api/ledger', (req, res) => {
  res.json(ledger.getSnapshot());
});

app.post('/api/contract/:id/approve', async (req, res) => {
  try {
    const contract = ledger.updateContract(
      req.params.id,
      { status: 'approved' },
      'Approved by Incident Commander via UI.',
    );

    // Let the agent speak proactively about the approval instead of waiting
    // for someone to say something. See the caveat in agoraAgent.js —
    // confirm this endpoint's exact contract against Agora's docs before
    // depending on it for a real demo; if it doesn't behave as expected,
    // the approval still works, the agent just won't announce it unprompted.
    if (activeSession) {
      try {
        await sendCustomInstruction(
          activeSession.agentId,
          `[System event] The Incident Commander just approved this contract: "${contract.action}". ` +
            `Success criteria: ${contract.successCriteria}. Reversal condition: ${contract.reversalCondition}. ` +
            `Acknowledge the approval out loud and say you are executing it now, then call update_contract_state.`,
          activeSession,
        );
      } catch (err) {
        console.warn('[contract/approve] custom instruction failed, continuing without it:', err?.response?.data || err.message);
      }
    }

    res.json({ ok: true, contract });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- The custom LLM endpoint Agora calls every turn ------------------------

app.post('/llm/chat/completions', chatCompletionsHandler);

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(config.port, () => {
  console.log(`[signalforge] server listening on http://localhost:${config.port}`);
  if (!config.publicServerUrl) {
    console.warn(
      '[signalforge] PUBLIC_SERVER_URL is not set — starting an agent will fail until you set it ' +
      '(run a tunnel like `ngrok http ' + config.port + '` and put the https URL in .env).',
    );
  }
});
