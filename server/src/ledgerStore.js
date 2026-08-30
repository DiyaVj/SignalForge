// In-memory state for one incident session. Swap this for a real database
// (Postgres, Redis, etc.) before running more than one incident at a time,
// or before running multiple concurrent incidents.

import { randomUUID } from 'crypto';
import { broadcast } from './wsHub.js';

const state = {
  facts: [],
  hypotheses: [],
  contradictions: [],
  risks: [],
  contracts: {}, // id -> contract object
  participants: {}, // rtcUid (string) -> { name, role }
};

export function getSnapshot() {
  return state;
}

export function setParticipant(uid, name, role) {
  state.participants[String(uid)] = { name, role };
  broadcast({ type: 'participant', uid: String(uid), name, role });
}

export function speakerLabel(uid) {
  const p = state.participants[String(uid)];
  if (!p) return uid ? `Speaker ${uid}` : 'Unknown speaker';
  return `${p.name} · ${p.role}`;
}

/**
 * @param {'fact'|'hypothesis'|'contradiction'|'risk'} kind
 */
export function addEvidence({ kind, text, source, receipt }) {
  const bucketKey = kind === 'fact' ? 'facts'
    : kind === 'hypothesis' ? 'hypotheses'
    : kind === 'contradiction' ? 'contradictions'
    : 'risks';

  const item = {
    id: randomUUID(),
    kind,
    text,
    source,
    receipt,
    createdAt: new Date().toISOString(),
  };
  state[bucketKey].push(item);
  broadcast({ type: 'evidence', item });
  return item;
}

export function proposeContract({ action, requestedBy, successCriteria, reversalCondition }) {
  const id = randomUUID();
  const contract = {
    id,
    action,
    requestedBy,
    successCriteria,
    reversalCondition,
    status: 'proposed', // proposed -> approved -> executing -> needs_verification | resolved
    createdAt: new Date().toISOString(),
    log: [],
  };
  state.contracts[id] = contract;
  broadcast({ type: 'contract', contract });
  return contract;
}

export function updateContract(id, patch, logLine) {
  const contract = state.contracts[id];
  if (!contract) throw new Error(`Unknown contract id: ${id}`);
  Object.assign(contract, patch);
  if (logLine) contract.log.push({ at: new Date().toISOString(), line: logLine });
  broadcast({ type: 'contract', contract });
  return contract;
}

export function getContract(id) {
  return state.contracts[id];
}

export function listOpenContracts() {
  return Object.values(state.contracts).filter(
    (c) => c.status !== 'resolved',
  );
}
