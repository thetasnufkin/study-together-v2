// src/state.js
import { DEFAULT_SETTINGS, getOrCreateUid } from './utils.js';

export const state = {
  db: null,
  app: null,
  globalDbListeners: [],
  roomDbListeners: [],

  // ローカル端末ID（匿名利用時のフォールバックやデバッグ用）
  uid: getOrCreateUid(),
  nickname: '',

  roomId: null,
  roomRef: null,
  participantRef: null,

  participants: new Map(),
  hostId: null,
  isHost: false,

  settings: { ...DEFAULT_SETTINGS },
  timer: {
    phase: 'work',
    paused: true,
    pausedRemaining: DEFAULT_SETTINGS.workSec,
    phaseStartAt: Date.now(),
    cycle: 0,
    version: 0,
  },

  // 認証状態
  auth: {
    mode: null,          // 'guest' | 'account'
    uid: null,           // Firebase Auth UID
    displayName: '',     // 画面表示用
    isAnonymous: true,
    email: '',           // account時に使う（任意）
  },

  serverOffsetMs: 0,
  uiTicker: null,
  heartbeatTicker: null,
  staleTicker: null,
  isSwitchingPhase: false,

  // Voice
  peer: null,
  peerReady: false,
  localStream: null,
  remoteCalls: new Map(),
  voiceEnabled: false,
  isMuted: false,
  audioCtx: null,
  analyser: null,
  micAnimationFrame: null,

  // Task
  currentTask: '',

  // Work session tracking
  workSession: {
    startedAt: null,
    startTask: '',
    isActive: false,
  },

  // Sound
  soundEnabled: true,
};

export function nowServerMs() {
  return Date.now() + state.serverOffsetMs;
}

/**
 * 参加者キーや権限判定に使うUID。
 * Auth UIDを最優先し、無い場合のみローカルUIDへフォールバック。
 */
export function getCurrentUid() {
  return state.auth?.uid || state.uid;
}

/**
 * 現在ユーザーの表示名（未設定時は空文字）
 */
export function getCurrentDisplayName() {
  return state.auth?.displayName || state.nickname || '';
}

/**
 * 認証済みかどうか
 */
export function isAuthed() {
  return !!state.auth?.uid;
}
