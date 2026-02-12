// src/app.js
import { state, nowServerMs, getCurrentUid, getCurrentParticipantKey } from './state.js';
import {
  STORAGE_KEYS, DEFAULT_SETTINGS, HEARTBEAT_MS, STALE_MS,
  sanitizeNickname, normalizeRoomCode, clampInt,
  updateUrlWithRoom, clearRoomFromUrl, getRoomFromQuery
} from './utils.js';
import { els, toast, showScreen, disableLobbyButtons, renderParticipants, updateTimerUiOnly } from './ui.js';
import {
  onDb, createRoomWithRetries, roomExists, writeTimer,
  initPeerIfNeeded, connectToVoicePeers, syncParticipantVoiceState, disableVoice,
  playNotificationSound
} from './infra.js';

const PARTICIPANT_SELF_CHECK_GRACE_MS = 2_500;
const HOST_MISSING_GRACE_MS = 5_000;

export function hydrateLobbyInputs() {
  const savedNick = localStorage.getItem(STORAGE_KEYS.nickname) || '';
  if (savedNick && els.nicknameInput) els.nicknameInput.value = savedNick;
}

export function phaseDurationSec(phase = state.timer.phase) {
  return phase === 'break' ? state.settings.breakSec : state.settings.workSec;
}

export function calcRemainingSec() {
  const duration = phaseDurationSec(state.timer.phase);
  if (state.timer.paused) return clampInt(state.timer.pausedRemaining, 0, duration, duration);
  const elapsed = (nowServerMs() - Number(state.timer.phaseStartAt)) / 1000;
  return Math.max(0, Math.ceil(duration - elapsed));
}

export function canUseVoiceNow() {
  return state.timer.phase === 'break';
}

export async function handleCreate() {
  const nickname = sanitizeNickname(els.nicknameInput?.value || '');
  if (!nickname) return toast('ニックネームは2文字以上で頼む。', true);

  disableLobbyButtons(true);
  try {
    const roomId = await createRoomWithRetries();
    await enterRoom(roomId, nickname, { justCreated: true });
  } catch (err) {
    console.error(err);
    toast('ルーム作成に失敗。通信か設定を見直して。', true);
  } finally {
    disableLobbyButtons(false);
  }
}

export async function handleJoin() {
  const nickname = sanitizeNickname(els.nicknameInput?.value || '');
  const roomId = normalizeRoomCode((els.roomCodeInput?.value || getRoomFromQuery() || ''));

  if (!nickname) return toast('ニックネームは2文字以上で頼む。', true);
  if (!roomId) return toast('ルームコードが必要。超能力参加は未実装。', true);

  disableLobbyButtons(true);
  try {
    const exists = await roomExists(roomId);
    if (!exists) return toast(`ルーム ${roomId} は見つかりません。`, true);
    await enterRoom(roomId, nickname, { justCreated: false });
  } catch (err) {
    console.error(err);
    toast('ルーム参加に失敗。通信を見直して。', true);
  } finally {
    disableLobbyButtons(false);
  }
}

export async function enterRoom(roomId, nickname, { justCreated }) {
  const meUid = getCurrentUid();
  const meKey = getCurrentParticipantKey();
  if (!meUid || !meKey) {
    toast('認証状態が見つかりません。先にログインして。', true);
    showScreen('auth');
    return;
  }

  // 既存状態を安全に掃除
  cleanupRoomOnly();

  state.roomId = roomId;
  state.nickname = nickname;
  state.roomRef = state.db.ref(`rooms/${roomId}`);
  localStorage.setItem(STORAGE_KEYS.nickname, nickname);

  state.participantRef = state.roomRef.child(`participants/${meKey}`);
  await state.participantRef.set({
    nickname,
    joinedAt: nowServerMs(),
    lastSeen: nowServerMs(),
    authUid: meUid,
    peerId: meKey,
    voiceEnabled: false,
    muted: false,
    task: '',
  });
  state.participantRef.onDisconnect().remove();
  state.participantsLoaded = false;
  state.metaLoaded = false;
  state.hostClaimInFlight = false;
  state.hostClaimDisabled = false;
  state.hostMissingSince = 0;
  state.joinedRoomAt = Date.now();
  state.isLeaving = false;

  attachRoomListeners();

  // NOTE:
  // Peer接続失敗でルーム参加そのものが失敗しないように、
  // 通話サーバ接続は toggleVoice 時に遅延初期化する。

  state.heartbeatTicker = setInterval(() => {
    if (state.participantRef) {
      state.participantRef.update({
        lastSeen: nowServerMs(),
        muted: state.isMuted,
        voiceEnabled: state.voiceEnabled,
        task: state.currentTask,
      });
    }
  }, HEARTBEAT_MS);

  state.staleTicker = setInterval(pruneStaleParticipantsIfHost, 15_000);
  state.uiTicker = setInterval(tickUI, 250);

  showScreen('room');
  updateUrlWithRoom(roomId);
  if (els.roomTitle) els.roomTitle.textContent = `Room ${roomId}`;
  if (els.workMinInput) els.workMinInput.value = Math.round(state.settings.workSec / 60);
  if (els.breakMinInput) els.breakMinInput.value = Math.round(state.settings.breakSec / 60);

  toast(justCreated ? `ルーム ${roomId} を作成` : `ルーム ${roomId} に参加`);
}

function attachRoomListeners() {
  onDb(state.roomRef.child('participants'), 'value', (snap) => {
  if (state.isLeaving) return;

  const map = new Map();
  snap.forEach((child) => map.set(child.key, child.val()));
  state.participants = map;
  state.participantsLoaded = true;

  renderParticipants({ canUseVoiceNow, connectToVoicePeers });
  void claimHostIfNeeded();
});

onDb(state.roomRef.child('meta'), 'value', (snap) => {
  if (state.isLeaving) return;

  const meta = snap.val() || {};
  const meKey = getCurrentParticipantKey();

  state.hostId = meta.hostId || null;
  state.isHost = !!meKey && state.hostId === meKey;
  state.metaLoaded = true;

  updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow });
  void claimHostIfNeeded();
});


  onDb(state.roomRef.child('settings'), 'value', (snap) => {
    if (state.isLeaving) return;

    const s = snap.val();
    if (!s) return;
    state.settings.workSec = clampInt(s.workSec, 5 * 60, 90 * 60, DEFAULT_SETTINGS.workSec);
    state.settings.breakSec = clampInt(s.breakSec, 60, 30 * 60, DEFAULT_SETTINGS.breakSec);
    if (els.workMinInput) els.workMinInput.value = Math.round(state.settings.workSec / 60);
    if (els.breakMinInput) els.breakMinInput.value = Math.round(state.settings.breakSec / 60);
    updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow });
  });

  onDb(state.roomRef.child('timer'), 'value', (snap) => {
    if (state.isLeaving) return;

    const t = snap.val();
    if (!t) return;

    const prevPhase = state.timer.phase;
    state.timer = {
      phase: t.phase === 'break' ? 'break' : 'work',
      paused: !!t.paused,
      pausedRemaining: Number(t.pausedRemaining ?? phaseDurationSec(t.phase || 'work')),
      phaseStartAt: Number(t.phaseStartAt || nowServerMs()),
      cycle: Number(t.cycle || 0),
      version: Number(t.version || 0),
    };

    updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow });

    if (prevPhase !== state.timer.phase) {
      if (state.timer.phase === 'break') {
        toast('☕ 休憩開始。話すなら今。');
        playNotificationSound('break');
      } else {
        toast('🎯 作業開始。口より手を動かす時間。');
        playNotificationSound('work');
        if (state.voiceEnabled) disableVoice(false);
      }
    }
  });

  onDb(state.roomRef, 'value', (snap) => {
    const meKey = getCurrentParticipantKey();

    if (!snap.exists()) {
      if (!state.isLeaving) {
        toast('ルームが閉じられました。', true);
        void leaveRoom();
      }
      return;
    }

    // 参加直後は listeners の順序差で participants が未反映なことがある。
    // ローカルMapではなく room snapshot 側で自分の存在を確認する。
    const inGrace = Date.now() - Number(state.joinedRoomAt || 0) < PARTICIPANT_SELF_CHECK_GRACE_MS;
    const meExistsInRoom = !!meKey && snap.child(`participants/${meKey}`).exists();

    if (state.roomId && meKey && state.participantsLoaded && !inGrace && !meExistsInRoom) {
      if (!state.isLeaving) {
        toast('ルームから切断されました。', true);
        void leaveRoom();
      }
    }
  });
}

async function claimHostIfNeeded() {
  if (state.isLeaving) return;
  if (!state.roomRef) return;
  if (state.hostClaimDisabled) return;
  if (state.hostClaimInFlight) return;

  // ここ重要: 両方ロードされるまで絶対に claim しない
  if (!state.participantsLoaded || !state.metaLoaded) return;

  const meKey = getCurrentParticipantKey();
  if (!meKey) return;

  // 自分がparticipantsにまだいないなら claim しない
  if (!state.participants.has(meKey)) return;

  // 既存ホストがparticipants上で生存なら何もしない
  const hostAlive = !!(state.hostId && state.participants.has(state.hostId));
  if (hostAlive) {
    state.hostMissingSince = 0;
    return;
  }

  // listener同期直後の瞬間的な不一致でclaimしない
  if (!state.hostMissingSince) state.hostMissingSince = Date.now();
  if (Date.now() - state.hostMissingSince < HOST_MISSING_GRACE_MS) return;

  // 最古参加者のみclaim
  let oldestId = null;
  let oldestJoinedAt = Number.POSITIVE_INFINITY;
  state.participants.forEach((p, id) => {
    const joinedAt = Number(p?.joinedAt || nowServerMs());
    if (joinedAt < oldestJoinedAt) {
      oldestJoinedAt = joinedAt;
      oldestId = id;
    }
  });
  if (oldestId !== meKey) return;

  state.hostClaimInFlight = true;
  try {
    await state.roomRef.child('meta/hostId').transaction(
      (current) => {
        // 既存ホストが生存してるなら transaction中止（undefined返し）
        if (current && state.participants.has(current)) return;
        return meKey;
      },
      undefined,
      false // applyLocally
    );
  } catch (err) {
    const msg = String(err?.message || err || '');
    // permission_denied が出るルール構成では、以後の自動claimを止める。
    if (msg.includes('permission_denied')) {
      state.hostClaimDisabled = true;
      console.warn('auto host-claim disabled due to permission_denied');
    } else {
      console.error('host claim failed', err);
    }
  } finally {
    state.hostClaimInFlight = false;
  }
}


async function pruneStaleParticipantsIfHost() {
  if (state.isLeaving) return;
  if (!state.isHost || !state.roomRef) return;

  const now = nowServerMs();
  const meKey = getCurrentParticipantKey();

  const updates = {};
  state.participants.forEach((p, id) => {
    if (id === meKey) return;
    const lastSeen = Number(p?.lastSeen || 0);
    if (now - lastSeen > STALE_MS) updates[`participants/${id}`] = null;
  });

  if (Object.keys(updates).length > 0) {
    try {
      await state.roomRef.update(updates);
    } catch (err) {
      console.error('stale prune failed', err);
    }
  }
}

export function tickUI() {
  if (state.isLeaving) return;

  updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow });
  if (state.isHost && !state.timer.paused && !state.isSwitchingPhase) {
    if (calcRemainingSec() <= 0) void advancePhase();
  }
}

export async function handleStartPause() {
  if (!state.isHost || !state.roomRef) return toast('ホストだけが開始/停止できます。', true);

  const duration = phaseDurationSec(state.timer.phase);
  if (state.timer.paused) {
    const remaining = clampInt(state.timer.pausedRemaining, 1, duration, duration);
    const startAt = nowServerMs() - (duration - remaining) * 1000;
    await writeTimer({ paused: false, phaseStartAt: startAt, version: (state.timer.version || 0) + 1 });
  } else {
    const remaining = calcRemainingSec();
    await writeTimer({ paused: true, pausedRemaining: remaining, version: (state.timer.version || 0) + 1 });
  }
}

export async function handleSkip() {
  if (!state.isHost) return toast('次へ進めるのはホストだけ。', true);
  await advancePhase();
}

async function advancePhase() {
  if (state.isLeaving) return;
  if (state.isSwitchingPhase) return;

  state.isSwitchingPhase = true;
  try {
    const currentPhase = state.timer.phase;
    const nextPhase = currentPhase === 'work' ? 'break' : 'work';
    const nextDuration = phaseDurationSec(nextPhase);
    const nextCycle = currentPhase === 'work'
      ? Number(state.timer.cycle || 0) + 1
      : Number(state.timer.cycle || 0);

    await writeTimer({
      phase: nextPhase,
      paused: false,
      pausedRemaining: nextDuration,
      phaseStartAt: nowServerMs(),
      cycle: nextCycle,
      version: (state.timer.version || 0) + 1,
    });
  } finally {
    state.isSwitchingPhase = false;
  }
}

export async function toggleVoice() {
  if (state.voiceEnabled) return disableVoice(true);
  if (!canUseVoiceNow()) return toast('休憩中だけ通話できます。', true);

  try {
    // 通話を使う時だけPeerを初期化（失敗してもルーム参加は壊さない）
    await initPeerIfNeeded();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      video: false,
    });
    state.localStream = stream;
    state.voiceEnabled = true;
    state.isMuted = false;

    await syncParticipantVoiceState();
    connectToVoicePeers();
    updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow });
    toast('マイクを有効化。休憩雑談どうぞ。');
  } catch (err) {
    console.error(err);
    toast('マイク取得に失敗。ブラウザ権限を確認して。', true);
  }
}

export async function toggleMute() {
  if (!state.localStream || !state.voiceEnabled) return;
  state.isMuted = !state.isMuted;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.isMuted));
  await syncParticipantVoiceState();
  updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow });
}

export async function handleTaskUpdate() {
  const task = (els.taskInput?.value || '').trim().slice(0, 50);
  state.currentTask = task;
  if (!state.participantRef) return;

  try {
    await state.participantRef.update({ task });
    toast(task ? 'タスクを更新しました' : 'タスクをクリアしました');
  } catch (err) {
    console.error(err);
    toast('タスク更新に失敗', true);
  }
}

export async function saveSettings() {
  if (!state.roomRef || !state.isHost) {
    toast('設定変更はホストのみ。', true);
    return;
  }

  const workMin = clampInt(Number(els.workMinInput?.value), 5, 90, 25);
  const breakMin = clampInt(Number(els.breakMinInput?.value), 1, 30, 5);
  const workSec = workMin * 60;
  const breakSec = breakMin * 60;

  try {
    await state.roomRef.child('settings').update({ workSec, breakSec });
    await writeTimer({
      phase: 'work',
      paused: true,
      pausedRemaining: workSec,
      phaseStartAt: nowServerMs(),
      cycle: 0,
      version: (state.timer.version || 0) + 1,
    });
    toast('設定を保存。タイマーを作業フェーズ先頭にリセット。');
  } catch (err) {
    console.error(err);
    toast('設定保存に失敗。', true);
  }
}

export async function leaveRoom() {
  if (state.isLeaving) return;
  state.isLeaving = true;

  try {
    if (!state.roomId) {
      showScreen('lobby');
      return;
    }

    const meKey = getCurrentParticipantKey();

    try {
      if (state.isHost && state.roomRef) {
        const nextHost = [...state.participants.keys()].find((id) => id !== meKey) || null;
        if (nextHost) await state.roomRef.child('meta/hostId').set(nextHost);
        else await state.roomRef.remove();
      }
    } catch (err) {
      console.error(err);
    }

    cleanupAll();
    clearRoomFromUrl();
    showScreen('lobby');
    toast('ルームを退出しました。');
  } finally {
    state.isLeaving = false;
  }
}

function cleanupAll() {
  cleanupRoomOnly();
  state.roomId = null;
  state.hostId = null;
  state.isHost = false;
  state.participants = new Map();
  renderParticipants({ canUseVoiceNow, connectToVoicePeers });
  updateTimerUiOnly({ calcRemainingSec, phaseDurationSec, canUseVoiceNow });
  state.participantsLoaded = false;
  state.metaLoaded = false;
  state.hostClaimInFlight = false;
  state.hostClaimDisabled = false;
  state.hostMissingSince = 0;
  state.joinedRoomAt = 0;

}

function cleanupRoomOnly() {
  // 1) 先に DB listener を解除（removeより前）
  state.roomDbListeners.forEach((off) => {
    try { off(); } catch {}
  });
  state.roomDbListeners = [];

  // 2) タイマー停止
  if (state.uiTicker) clearInterval(state.uiTicker);
  if (state.heartbeatTicker) clearInterval(state.heartbeatTicker);
  if (state.staleTicker) clearInterval(state.staleTicker);

  state.uiTicker = null;
  state.heartbeatTicker = null;
  state.staleTicker = null;

  // 3) 音声/Peer停止
  disableVoice(false).catch(() => {});
  if (state.peer) {
    try { state.peer.destroy(); } catch {}
    state.peer = null;
    state.peerReady = false;
  }

  // 4) participant cleanup（listener解除後なので再入しにくい）
  if (state.participantRef) {
    try { state.participantRef.onDisconnect().cancel(); } catch {}
    state.participantRef.remove().catch(() => {});
    state.participantRef = null;
  }

  // 5) room ref cleanup
  state.roomRef = null;
}
