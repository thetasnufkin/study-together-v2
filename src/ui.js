// src/ui.js
import { state } from './state.js';
import { secToMMSS } from './utils.js';

const $ = (id) => document.getElementById(id);

export const els = {
  // screens
  setupScreen: null, // 旧互換（使わないなら将来削除可）
  authScreen: null,
  lobbyScreen: null,
  roomScreen: null,

  // auth
  enterAsGuestBtn: null,
  loginGoogleBtn: null,

  // setup/config（旧互換）
  firebaseConfigInput: null,
  saveConfigBtn: null,
  resetConfigBtn: null,

  // connection
  connDot: null,
  connText: null,

  // lobby
  nicknameInput: null,
  roomCodeInput: null,
  joinBtn: null,
  createBtn: null,

  // room/timer
  phaseBadge: null,
  roomTitle: null,
  timerDisplay: null,
  timerLabel: null,
  cycleText: null,
  ring: null,

  startPauseBtn: null,
  skipBtn: null,
  leaveBtn: null,

  copyCodeBtn: null,
  copyInviteBtn: null,

  // voice
  voiceToggleBtn: null,
  muteBtn: null,
  voiceHelp: null,
  voiceStatePill: null,
  micBars: null,

  // participants
  participantCount: null,
  participantList: null,

  // task
  taskInput: null,
  taskUpdateBtn: null,

  // optional counter
  counterValue: null,
  counterBtn: null,

  // header/settings
  soundToggleBtn: null,
  openSettingsBtn: null,
  settingsModal: null,
  closeSettingsBtn: null,
  saveSettingsBtn: null,
  workMinInput: null,
  breakMinInput: null,

  // toast
  toast: null,
};

export function bindDom() {
  Object.keys(els).forEach((key) => {
    els[key] = $(key);
  });
}

export function disableLobbyButtons(disabled) {
  if (els.joinBtn) els.joinBtn.disabled = disabled;
  if (els.createBtn) els.createBtn.disabled = disabled;
}

export function showScreen(which) {
  // 全部隠す
  if (els.setupScreen) els.setupScreen.classList.add('hidden');
  if (els.authScreen) els.authScreen.classList.add('hidden');
  if (els.lobbyScreen) els.lobbyScreen.classList.add('hidden');
  if (els.roomScreen) els.roomScreen.classList.add('hidden');

  // 指定画面だけ表示
  if (which === 'setup' && els.setupScreen) els.setupScreen.classList.remove('hidden');
  if (which === 'auth' && els.authScreen) els.authScreen.classList.remove('hidden');
  if (which === 'lobby' && els.lobbyScreen) els.lobbyScreen.classList.remove('hidden');
  if (which === 'room' && els.roomScreen) els.roomScreen.classList.remove('hidden');
}

export function toast(msg, isError = false) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.style.borderColor = isError
    ? 'rgba(248, 113, 113, 0.6)'
    : 'rgba(94, 234, 212, 0.35)';
  els.toast.style.color = isError ? '#fecaca' : '#d1fae5';
  els.toast.classList.add('show');

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    if (els.toast) els.toast.classList.remove('show');
  }, 2200);
}

export function tag(text, cls = '') {
  const s = document.createElement('span');
  s.className = `tag ${cls}`.trim();
  s.textContent = text;
  return s;
}

function getCurrentUid() {
  // 認証導入後は auth.uid 優先、なければ旧 uid をフォールバック
  return state?.auth?.uid || state.uid || null;
}

export function renderParticipants({ canUseVoiceNow, connectToVoicePeers }) {
  if (!els.participantList) return;
  els.participantList.innerHTML = '';

  const arr = [...state.participants.entries()].sort((a, b) => {
    const aj = Number(a[1]?.joinedAt || 0);
    const bj = Number(b[1]?.joinedAt || 0);
    return aj - bj;
  });

  const me = getCurrentUid();

  arr.forEach(([id, p]) => {
    const li = document.createElement('li');
    li.className = 'participant';

    const header = document.createElement('div');
    header.className = 'participant-header';

    const left = document.createElement('div');
    left.className = 'name';
    left.textContent = p.nickname || '名無し';

    const right = document.createElement('div');
    right.className = 'meta';

    if (id === state.hostId) right.appendChild(tag('HOST', 'host'));
    if (id === me) right.appendChild(tag('YOU'));
    if (p.voiceEnabled) right.appendChild(tag(p.muted ? 'VOICE:MUTED' : 'VOICE:ON', 'voice'));

    header.appendChild(left);
    header.appendChild(right);
    li.appendChild(header);

    if (p.task) {
      const taskDiv = document.createElement('div');
      taskDiv.className = 'participant-task';
      taskDiv.textContent = `📝 ${p.task}`;
      li.appendChild(taskDiv);
    }

    els.participantList.appendChild(li);
  });

  if (els.participantCount) {
    els.participantCount.textContent = `${arr.length}人`;
  }

  if (canUseVoiceNow() && state.voiceEnabled) {
    connectToVoicePeers();
  }
}

export function updateRoleUI() {
  const hostOnly = !!state.isHost;
  if (els.startPauseBtn) els.startPauseBtn.disabled = !hostOnly;
  if (els.skipBtn) els.skipBtn.disabled = !hostOnly;

  if (els.startPauseBtn) {
    if (state.timer.paused) {
      els.startPauseBtn.textContent = hostOnly ? '開始' : '開始（ホスト専用）';
    } else {
      els.startPauseBtn.textContent = hostOnly ? '一時停止' : '停止（ホスト専用）';
    }
  }
}

export function updateVoiceUiOnly({ canUseVoiceNow }) {
  const breakNow = canUseVoiceNow();
  const enabled = !!state.voiceEnabled;

  if (els.voiceToggleBtn) els.voiceToggleBtn.disabled = !breakNow;
  if (els.muteBtn) els.muteBtn.disabled = !enabled;

  if (!breakNow) {
    if (els.voiceHelp) els.voiceHelp.textContent = '作業中は通話できません。休憩開始で開放されます。';
    if (els.voiceStatePill) els.voiceStatePill.textContent = 'LOCK';
  } else {
    if (els.voiceHelp) els.voiceHelp.textContent = '休憩中です。必要ならマイクをONに。';
    if (els.voiceStatePill) {
      els.voiceStatePill.textContent = enabled ? (state.isMuted ? 'MUTED' : 'LIVE') : 'OFF';
    }
  }

  if (els.voiceToggleBtn) {
    els.voiceToggleBtn.textContent = enabled ? 'マイクOFFだよ' : 'マイクONだよ';
  }
  if (els.muteBtn) {
    els.muteBtn.textContent = state.isMuted ? 'ミュート解除' : 'ミュート';
  }
}

export function updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow }) {
  const remaining = calcRemainingSec();
  const duration = phaseDurationSec(state.timer.phase);
  const progress = duration > 0 ? (duration - remaining) / duration : 0;
  const pct = Math.min(1, Math.max(0, progress)) * 100;

  if (els.timerDisplay) els.timerDisplay.textContent = secToMMSS(remaining);
  if (els.timerLabel) els.timerLabel.textContent = state.timer.phase === 'break' ? '休憩タイム' : '集中タイム';
  if (els.cycleText) els.cycleText.textContent = String(state.timer.cycle || 0);

  if (els.phaseBadge) {
    els.phaseBadge.className = `badge ${state.timer.phase}`;
    els.phaseBadge.textContent = state.timer.phase === 'break' ? '☕ 休憩中' : '🎯 作業中';
  }

  if (els.ring) {
    const ringColor = state.timer.phase === 'break' ? 'var(--break)' : 'var(--work)';
    els.ring.style.background = `conic-gradient(${ringColor} ${pct}%, rgba(159, 176, 207, 0.14) ${pct}%)`;
  }

  updateRoleUI();
  updateVoiceUiOnly({ canUseVoiceNow });
}

export function updateSoundButtonUI() {
  if (!els.soundToggleBtn) return;
  els.soundToggleBtn.textContent = state.soundEnabled ? '🔔' : '🔕';
  els.soundToggleBtn.title = state.soundEnabled ? '通知音OFF' : '通知音ON';
}
