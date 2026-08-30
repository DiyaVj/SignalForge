// This file implements the "custom LLM" contract Agora requires:
//   https://docs.agora.io/en/ai/build/custom-model-integration/custom-llm
//
// Agora's Conversational AI Engine POSTs an OpenAI-format chat-completions
// request here on every conversation turn (ASR already ran; the last message
// is what the human just said). We reason over it with Claude — including a
// tool-use loop that updates the incident ledger — and return the final
// spoken reply in OpenAI's response format. Agora then runs TTS on our text
// and speaks it back into the call.

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { TOOLS, executeTool } from './tools.js';
import * as ledger from './ledgerStore.js';
import { broadcast } from './wsHub.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are SignalForge, a self-verifying incident commander joining a live \
operational incident call as a voice participant. Your job is to manage uncertainty and evidence \
— you do NOT independently declare root cause, and you never let an assumption quietly become a fact.

Rules you always follow:
1. Classify every substantive claim you hear using the log_evidence tool: "fact" only when a named \
   source directly confirms it, "hypothesis" for anything asserted but unconfirmed, "contradiction" \
   when new evidence conflicts with something already logged, "risk" for a concern that should stay \
   visible even once the main thread moves on.
2. Before any critical or hard-to-reverse action is executed (rollback, failover, scaling change, \
   customer communication, etc), call propose_contract and require a human to approve it. Do not \
   describe an action as approved or executing until it actually has been.
3. Once an action executes, call update_contract_state with "needs_verification" if you don't yet \
   have confirmation it worked — running successfully is not the same as fixing the problem. Only \
   move a contract to "resolved" once its success criteria are actually met.
4. Speak only when you have something that changes what the room knows: a conflict, a missing \
   owner, a contract that needs approval, or a verification result. Keep spoken replies short — \
   one or two sentences — since this is a live voice call, not a chat window.
5. Never state a root cause as settled. You can say a hypothesis is "weakened" or "strengthened" by \
   new evidence, but the room decides when something is truly root-caused.
6. If you don't have enough information to classify something, ask one short clarifying question \
   instead of guessing.

You have tools to log evidence and manage decision contracts. Use them proactively — the room is \
listening to your voice reply, not reading your tool calls, so make sure anything important is also \
said in your reply.`;

function mapOpenAiMessagesToAnthropic(messages) {
  // OpenAI-format messages: [{role: 'system'|'user'|'assistant', content, name?, metadata?}, ...]
  // We fold any system messages Agora sends into our own system prompt (kept
  // authoritative here) and translate the rest into Anthropic's format.
  const anthropicMessages = [];
  let lastUserSpeakerLabel = null;
  let lastUserText = null;

  for (const m of messages) {
    if (m.role === 'system') continue; // superseded by SYSTEM_PROMPT above
    if (m.role !== 'user' && m.role !== 'assistant') continue;

    let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

    if (m.role === 'user') {
      // Agora's docs note that llm.vendor="custom" causes additional metadata
      // (e.g. turn_id, timestamp, and speaker identity via vpids) to be sent
      // alongside each message. Field names aren't fully pinned down publicly
      // as of this writing, so we read defensively and fall back gracefully.
      const uid = m.metadata?.uid ?? m.metadata?.vpids?.[0] ?? m.name ?? null;
      const label = uid ? ledger.speakerLabel(uid) : 'Unknown speaker';
      lastUserSpeakerLabel = label;
      lastUserText = text;
      text = `[${label}]: ${text}`;
    }

    anthropicMessages.push({ role: m.role, content: text });
  }

  return { anthropicMessages, lastUserSpeakerLabel, lastUserText };
}

async function runTruthEngineTurn(openAiMessages) {
  const { anthropicMessages, lastUserSpeakerLabel, lastUserText } =
    mapOpenAiMessagesToAnthropic(openAiMessages);

  if (lastUserText) {
    broadcast({ type: 'line', speakerLabel: lastUserSpeakerLabel, text: lastUserText, role: 'human' });
  }

  let working = [...anthropicMessages];
  let finalText = '';
  const MAX_TOOL_ITERATIONS = 4;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: working,
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const textBlocks = response.content.filter((b) => b.type === 'text').map((b) => b.text);

    if (toolUses.length === 0) {
      finalText = textBlocks.join(' ').trim();
      break;
    }

    // Execute each requested tool and feed results back for the next turn.
    working.push({ role: 'assistant', content: response.content });
    const toolResults = toolUses.map((tu) => {
      let result;
      try {
        result = executeTool(tu.name, tu.input);
      } catch (err) {
        result = { ok: false, error: String(err) };
      }
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      };
    });
    working.push({ role: 'user', content: toolResults });

    if (response.stop_reason !== 'tool_use') {
      finalText = textBlocks.join(' ').trim();
      break;
    }
  }

  if (!finalText) {
    finalText = "Go ahead — I'm listening.";
  }

  broadcast({ type: 'line', speakerLabel: 'SignalForge', text: finalText, role: 'agent' });
  return finalText;
}

/** Express handler for POST /llm/chat/completions */
export async function chatCompletionsHandler(req, res) {
  try {
    const { messages = [], stream = false } = req.body || {};
    const finalText = await runTruthEngineTurn(messages);

    if (!stream) {
      res.json({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'signalforge-truth-engine',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: finalText },
            finish_reason: 'stop',
          },
        ],
      });
      return;
    }

    // Simplified SSE stream: we already have the full text (the tool loop
    // above has to complete before we know what to say), so we chunk it into
    // a few deltas rather than truly streaming token-by-token. This is still
    // spec-compliant OpenAI streaming format, which is what Agora requires.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const id = `chatcmpl-${randomUUID()}`;
    const words = finalText.split(' ');
    const chunkSize = 4;

    for (let i = 0; i < words.length; i += chunkSize) {
      const delta = words.slice(i, i + chunkSize).join(' ') + (i + chunkSize < words.length ? ' ' : '');
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'signalforge-truth-engine',
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'signalforge-truth-engine',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[truthEngine] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: String(err?.message || err) } });
    } else {
      res.end();
    }
  }
}
