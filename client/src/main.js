import AgoraRTC from 'agora-rtc-sdk-ng';

// Point this at your backend. If you're tunneling the backend with ngrok for
// Agora to reach it, the browser can usually still talk to it directly over
// localhost during development — only Agora's cloud needs the public URL.
const BACKEND_URL = 'http://localhost:8787';
const WS_URL = BACKEND_URL.replace(/^http/, 'ws') + '/ws';

let rtcClient = null;
let localAudioTrack = null;
let myUid = null;
let myChannel = null;
let agentId = null;
let ws = null;

const $ = (id) => document.getElementById(id);

function setConnStatus(text) {
  $('connStatus').textContent = text;
}

// ---- Join flow -------------------------------------------------------

$('joinBtn').addEventListener('click', async () => {
  const channel = $('channelInput').value.trim();
  const name = $('nameInput').value.trim();
  const role = $('roleInput').value;
  if (!channel || !name) {
    alert('Enter a channel and your name.');
    return;
  }

  myUid = Math.floor(Math.random() * 1_000_000) + 1; // demo UID; use a stable id tied to your auth in production
  myChannel = channel;

  try {
    setConnStatus('connecting…');

    await fetch(`${BACKEND_URL}/api/participants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: myUid, name, role }),
    });

    const tokenRes = await fetch(`${BACKEND_URL}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, uid: myUid }),
    });
    const { token, appId } = await tokenRes.json();
    if (!token) throw new Error('No token returned — check server logs / .env.');

    rtcClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

    rtcClient.on('user-published', async (user, mediaType) => {
      await rtcClient.subscribe(user, mediaType);
      if (mediaType === 'audio') {
        user.audioTrack.play(); // this is how you actually hear SignalForge speak
      }
    });

    await rtcClient.join(appId, channel, token, myUid);
    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
    await rtcClient.publish([localAudioTrack]);

    connectWebSocket();

    $('joinScreen').style.display = 'none';
    $('roomScreen').style.display = 'block';
    setConnStatus(`connected · ${channel} · uid ${myUid}`);
  } catch (err) {
    console.error(err);
    setConnStatus('connection failed');
    alert('Failed to join: ' + err.message);
  }
});

// ---- Agent lifecycle -------------------------------------------------

$('startAgentBtn').addEventListener('click', async () => {
  $('startAgentBtn').disabled = true;
  $('agentState').textContent = 'agent: starting…';
  try {
    const res = await fetch(`${BACKEND_URL}/api/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: myChannel, remoteUids: [String(myUid)] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start agent');
    agentId = data.agentId;
    $('agentState').textContent = 'agent: live';
    $('stopAgentBtn').disabled = false;
  } catch (err) {
    console.error(err);
    $('agentState').textContent = 'agent: failed to start';
    $('startAgentBtn').disabled = false;
    alert(err.message);
  }
});

$('stopAgentBtn').addEventListener('click', async () => {
  try {
    await fetch(`${BACKEND_URL}/api/agent/stop`, { method: 'POST' });
    $('agentState').textContent = 'agent: stopped';
    $('stopAgentBtn').disabled = true;
    $('startAgentBtn').disabled = false;
  } catch (err) {
    alert(err.message);
  }
});

$('muteBtn').addEventListener('click', () => {
  if (!localAudioTrack) return;
  const enabled = localAudioTrack.enabled;
  localAudioTrack.setEnabled(!enabled);
  $('muteBtn').textContent = enabled ? 'Unmute mic' : 'Mute mic';
});

// ---- Live feed from the backend (transcript + ledger + contracts) --------

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'line') addTranscriptLine(msg.speakerLabel, msg.text, msg.role);
    else if (msg.type === 'evidence') addLedgerCard(msg.item);
    else if (msg.type === 'contract') renderContract(msg.contract);
  };
  ws.onclose = () => console.warn('[ws] disconnected — reload to reconnect.');
}

function addTranscriptLine(speakerLabel, text, role) {
  const el = document.createElement('div');
  el.className = `line ${role === 'agent' ? 'agent' : 'human'}`;
  el.innerHTML = `<span class="who">${speakerLabel}</span><div>${escapeHtml(text)}</div>`;
  const t = $('transcript');
  t.appendChild(el);
  t.scrollTop = t.scrollHeight;
}

const KIND_LABEL = { fact: 'Confirmed fact', hypothesis: 'Hypothesis', contradiction: 'Contradiction', risk: 'Unresolved risk' };
const counts = { fact: 0, hypothesis: 0, contradiction: 0, risk: 0 };

function addLedgerCard(item) {
  const ledgerEl = $('ledger');
  const empty = ledgerEl.querySelector('.ledger-empty');
  if (empty) empty.remove();

  counts[item.kind] = (counts[item.kind] || 0) + 1;
  $('ledgerCounts').textContent = Object.entries(counts)
    .map(([k, v]) => `${KIND_LABEL[k].toUpperCase()} · ${v}`)
    .join('   ');

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <span class="tag ${item.kind}">${KIND_LABEL[item.kind]}</span>
    <div class="card-claim">${escapeHtml(item.text)}</div>
    <div class="card-src">${escapeHtml(item.source)} — ${escapeHtml(item.receipt)}</div>
  `;
  ledgerEl.prepend(card);
}

function renderContract(contract) {
  $('contractWrap').style.display = 'block';
  $('cAction').textContent = contract.action;
  $('cBy').textContent = contract.requestedBy;
  $('cSuccess').textContent = contract.successCriteria;
  $('cReversal').textContent = contract.reversalCondition;
  $('contractState').textContent = contract.status.toUpperCase().replace('_', ' ');

  const approveBtn = $('approveBtn');
  approveBtn.style.display = contract.status === 'proposed' ? 'inline-block' : 'none';
  approveBtn.onclick = async () => {
    approveBtn.disabled = true;
    try {
      await fetch(`${BACKEND_URL}/api/contract/${contract.id}/approve`, { method: 'POST' });
    } catch (err) {
      alert(err.message);
    }
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
