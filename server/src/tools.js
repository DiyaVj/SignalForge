import * as ledger from './ledgerStore.js';

// These are Anthropic Messages API tool definitions. The model calls them
// when it wants to change the state of the incident record; we execute them
// server-side and feed the results back before asking for the model's final
// spoken reply. This keeps ALL state mutation inside our server — Agora only
// ever sees plain text in and plain text out, so no changes are needed on
// the Agora side to support tool use.

export const TOOLS = [
  {
    name: 'log_evidence',
    description:
      'Record a claim in the incident evidence ledger. Use "fact" only for claims confirmed by ' +
      'a named source (monitoring, a person with direct knowledge, a system of record). Use ' +
      '"hypothesis" for anything asserted but not yet confirmed. Use "contradiction" when a new ' +
      'claim conflicts with something already logged. Use "risk" for a concern that should stay ' +
      'visible even if nobody is actively working it right now.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['fact', 'hypothesis', 'contradiction', 'risk'] },
        text: { type: 'string', description: 'The claim itself, written plainly.' },
        source: { type: 'string', description: 'Who or what this came from, e.g. "Marcus · SRE" or "Monitoring dashboard".' },
        receipt: { type: 'string', description: 'One or two sentences on why this is classified this way, and what would change it.' },
      },
      required: ['kind', 'text', 'source', 'receipt'],
    },
  },
  {
    name: 'propose_contract',
    description:
      'Propose a decision contract before executing any critical or hard-to-reverse action ' +
      '(rollback, failover, scaling change, customer communication, etc). This does NOT execute ' +
      'the action — it only records the proposal and blocks on human approval. Always call this ' +
      'before treating an action as approved, even if someone in the room sounds confident.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The specific action being proposed.' },
        requestedBy: { type: 'string', description: 'Who asked for this action, e.g. "Jordan · Incident Commander".' },
        successCriteria: { type: 'string', description: 'The measurable condition that means this action worked.' },
        reversalCondition: { type: 'string', description: 'The measurable condition that means this action should be reversed or escalated.' },
      },
      required: ['action', 'requestedBy', 'successCriteria', 'reversalCondition'],
    },
  },
  {
    name: 'update_contract_state',
    description:
      'Move a decision contract forward once you have new information about it — e.g. it started ' +
      'executing, it ran but did not meet its success criteria yet ("needs_verification"), or its ' +
      'success criteria have now been met over the required window ("resolved"). Never mark a ' +
      'contract resolved just because the action ran — only when its success criteria are actually met.',
    input_schema: {
      type: 'object',
      properties: {
        contractId: { type: 'string' },
        status: { type: 'string', enum: ['executing', 'needs_verification', 'resolved'] },
        note: { type: 'string', description: 'What happened, in plain terms.' },
      },
      required: ['contractId', 'status', 'note'],
    },
  },
];

export function executeTool(name, input) {
  switch (name) {
    case 'log_evidence': {
      const item = ledger.addEvidence(input);
      return { ok: true, id: item.id };
    }
    case 'propose_contract': {
      const contract = ledger.proposeContract(input);
      return { ok: true, contractId: contract.id, status: contract.status };
    }
    case 'update_contract_state': {
      const contract = ledger.updateContract(input.contractId, { status: input.status }, input.note);
      return { ok: true, contractId: contract.id, status: contract.status };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
