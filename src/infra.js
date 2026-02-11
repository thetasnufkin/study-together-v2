// src/infra.js
import { state, nowServerMs, getCurrentUid } from './state.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS, generateRoomCode, HEARTBEAT_MS, STALE_MS } from './utils.js';
import { updateSoundButtonUI, toast } from './ui.js';

// =========================
// Firebase bootstrap helpers
// =========================
function ensureFirebaseLoaded() {
  if (!window.firebase || typeof window.firebase.initializeApp !== 'function') {
    throw new Error('firebase-app-compat is not loaded');
  }
  if (typeof window.firebase.auth !== 'function') {
    throw new Error('firebase-auth-compat is not loaded');
  }
  if (!window.firebase.database || typeof window.firebase.database !== 'function') {
    throw new Error('firebase-database-compat is not loaded');
  }
}

function norm(v) {
  return (v ?? '').toString().trim();
}

/**
 * 同一プロジェクト判定:
 * - projectId を最優先
 * - databaseURL は補助（どちらか欠けてる環境があるため）
 */
function isSameFirebaseProject(a, b) {
  const aProject = norm(a?.projectId);
  const bProject = norm(b?.projectId);
  if (aProject && bProject && aProject !== bProject) return false;

  const aDb = norm(a?.databaseURL);
  const bDb = norm(b?.databaseURL);
  if (aDb && bDb && aDb !== bDb) return false;

  return true;
}

/**
 * 設定をどこから読むかを一元化
 * 優先順位:
 * 1) window.STUDY_TOGETHER_FIREBASE_CONFIG
 * 2) 既存 app.options
 * 3) localStorage(STORAGE_KEYS.firebaseConfig)
 */
export function loadFirebaseConfig() {
  // 1) デプロイ環境の埋め込み設定を最優先
  if (window.STUDY_TOGETHER_FIREBASE_CONFIG) {
    return window.STUDY_TOGETHER_FIREBASE_CONFIG;
  }

  // 2) 既に初期化済みならその options
  if (window.firebase?.apps?.length) {
    return window.firebase.app().options || null;
  }

  // 3) ローカル保存
  const raw = localStorage.getItem(STORAGE_KEYS.firebaseConfig);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 開発中に残骸localStorageが混ざる事故が多いので、
 * window側設定がある場合はlocalStorageを同期しておく。
 */
function syncConfigCacheFromWindowConfig() {
  const cfg = window.STUDY_TOGETHER_FIREBASE_CONFIG;
  if (!cfg) return;
  try {
    localStorage.setItem(STORAGE_KEYS.firebaseConfig, JSON.stringify(cfg));
  } catch {
    // ignore quota / private mode weirdness
  }
}

export async function initFirebase(config) {
  ensureFirebaseLoaded();

  // 引数未指定なら内部で拾う
  const incoming = config || loadFirebaseConfig();
  if (!incoming) throw new Error('Firebase config is missing');

  // デプロイ設定を最優先にキャッシュ同期（残骸対策）
  syncConfigCacheFromWindowConfig();

  const apps = window.firebase.apps || [];

  if (apps.length === 0) {
    state.app = window.firebase.initializeApp(incoming);
  } else {
    state.app = window.firebase.app();
    const existing = state.app.options || {};

    // 同一プロジェクトかだけ厳密に見る（全キー一致は厳しすぎる）
    if (!isSameFirebaseProject(existing, incoming)) {
      console.warn('Firebase config mismatch detected.', {
        current: {
          projectId: existing.projectId,
          databaseURL: existing.databaseURL,
          appId: existing.appId,
        },
        incoming: {
          projectId: incoming.projectId,
          databaseURL: incoming.databaseURL,
          appId: incoming.appId,
        },
      });

      // localStorage由来の古い設定が犯人なことが多いので消す
      try {
        localStorage.removeItem(STORAGE_KEYS.firebaseConfig);
      } catch {
        // ignore
      }

      throw new Error('Firebase already initialized with different config.');
    }
  }

  state.db = state.app.database();

  // NOTE:
  // ここで匿名ログインを強制しない。
  // 認証方式は authScreen でユーザーが選ぶ。
}

export function onDb(ref, event, handler, scope = 'room') {
  ref.on(event, handler);
  const off = () => ref.off(event, handler);
  if (scope === 'global') state.globalDbListeners.push(off);
  else state.roomDbListeners.push(off);
}

// ===== Auth =====
export async function signInGuest() {
  ensureFirebaseLoaded();
  const auth = window.firebase.auth();
  if (!auth.currentUser) await auth.signInAnonymously();
  const user = auth.currentUser;
  if (!user) throw new Error('Anonymous sign-in failed');
  return user;
}

export async function signInWithGoogle() {
  ensureFirebaseLoaded();
  const auth = window.firebase.auth();
  const provider = new window.firebase.auth.GoogleAuthProvider();
  const result = await auth.signInWithPopup(provider);
  if (!result?.user) throw new Error('Google sign-in failed');
  return result.user;
}

export function onAuthChanged(cb) {
  ensureFirebaseLoaded();
  return window.firebase.auth().onAuthStateChanged(cb);
}

export function getCurrentUser() {
  ensureFirebaseLoaded();
  return window.firebase.auth().currentUser;
}

// ===== Room =====
export async function createRoomWithRetries(maxTry = 8) {
  for (let i = 0; i < maxTry; i += 1) {
    const roomId = generateRoomCode();
    const ref = state.db.ref(`rooms/${roomId}`);
    const now = nowServerMs();
    const me = getCurrentUid();

    const result = await ref.transaction((current) => {
      if (current !== null) return; // occupied
      return {
        meta: { createdAt: now, hostId: me },
        settings: { ...DEFAULT_SETTINGS },
        timer: {
          phase: 'work',
          paused: true,
          pausedRemaining: DEFAULT_SETTINGS.workSec,
          phaseStartAt: now,
          cycle: 0,
          version: 1,
        },
        participants: {},
      };
    });

    if (result.committed) return roomId;
  }
  throw new Error('Failed to create unique room id');
}

export async function roomExists(roomId) {
  const snap = await state.db.ref(`rooms/${roomId}`).once('value');
  return snap.exists();
}

export async function writeTimer(patch) {
  if (!state.roomRef) return;
  await state.roomRef.child('timer').update(patch);
}

// ===== Voice =====
export async function initPeerIfNeeded() {
  if (state.peer) return;

  const me = getCurrentUid();
  if (!me) throw new Error('UID is missing. Authenticate first.');

  await new Promise((resolve, reject) => {
    const peer = new Peer(me, { debug: 1 });
    state.peer = peer;

    peer.on('open', () => {
      state.peerReady = true;
      resolve();
    });

    peer.on('call', (call) => {
      if (!state.localStream) {
        try { call.close(); } catch {}
        return;
      }
      call.answer(state.localStream);
      attachRemoteCall(call);
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      toast('通話接続でエラー。通信環境が暴れてる。', true);
      reject(err);
    });
  });
}

export function connectToVoicePeers() {
  if (!state.peer || !state.peerReady || !state.localStream || !state.voiceEnabled) return;

  const me = getCurrentUid();
  state.participants.forEach((p, id) => {
    if (id === me || state.remoteCalls.has(id)) return;
    const call = state.peer.call(id, state.localStream, { metadata: { roomId: state.roomId } });
    if (call) attachRemoteCall(call);
  });
}

function attachRemoteCall(call) {
  const peerId = call.peer;
  state.remoteCalls.set(peerId, call);

  call.on('stream', (remoteStream) => {
    const audioId = `remote-audio-${peerId}`;
    let audioEl = document.getElementById(audioId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = audioId;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = remoteStream;
  });

  const onCloseOrError = () => {
    const el = document.getElementById(`remote-audio-${peerId}`);
    if (el) el.remove();
    state.remoteCalls.delete(peerId);
  };

  call.on('close', onCloseOrError);
  call.on('error', onCloseOrError);
}

export async function syncParticipantVoiceState() {
  if (!state.participantRef) return;
  await state.participantRef.update({
    voiceEnabled: state.voiceEnabled,
    muted: state.isMuted,
    lastSeen: nowServerMs(),
  });
}

export async function disableVoice(showToast = false) {
  state.voiceEnabled = false;
  state.isMuted = false;

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }

  state.remoteCalls.forEach((call, peerId) => {
    try { call.close(); } catch {}
    const el = document.getElementById(`remote-audio-${peerId}`);
    if (el) el.remove();
  });
  state.remoteCalls.clear();

  await syncParticipantVoiceState();
  if (showToast) toast('マイクをOFFにしました。');
}

// ===== Sound =====
export function playNotificationSound(type) {
  if (!state.soundEnabled) return;
  try {
    const soundFile = type === 'break'
      ? './sounds/野獣「ぬわああああああああん疲れたもおおおおおおおおおおおん(ﾁｶﾚﾀ…)」.wav'
      : './sounds/野獣「オッスお願いしま～す」.wav';
    const audio = new Audio(soundFile);
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch {
    // no-op
  }
}

export function toggleSound() {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem(STORAGE_KEYS.soundEnabled, state.soundEnabled ? '1' : '0');
  updateSoundButtonUI();
  toast(state.soundEnabled ? '🔔 通知音ON' : '🔕 通知音OFF');
}

export function loadSoundPreference() {
  const saved = localStorage.getItem(STORAGE_KEYS.soundEnabled);
  state.soundEnabled = saved !== '0';
  updateSoundButtonUI();
}

export { HEARTBEAT_MS, STALE_MS };
