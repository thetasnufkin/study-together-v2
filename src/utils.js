// src/utils.js
export const STORAGE_KEYS = {
  firebaseConfig: 'st_firebase_config_v2',
  nickname: 'st_nickname_v2',
  uid: 'st_uid_v2',
  soundEnabled: 'st_sound_enabled',
};

export const DEFAULT_SETTINGS = {
  workSec: 25 * 60,
  breakSec: 5 * 60,
};

export const ROOM_CODE_LEN = 6;
export const NICKNAME_MIN_LEN = 2;
export const NICKNAME_MAX_LEN = 16;

export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 35_000;

export function on(el, event, handler) {
  if (el) el.addEventListener(event, handler);
}

export function sanitizeNickname(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (s.length < NICKNAME_MIN_LEN) return '';
  return s.slice(0, NICKNAME_MAX_LEN);
}

export function normalizeRoomCode(v) {
  return String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LEN);
}

export function generateRoomCode() {
  // 見間違いを減らす文字セット（I, O, 0, 1 系を除外）
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function secToMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  return Math.min(max, Math.max(min, i));
}

export function getOrCreateUid() {
  const existing = localStorage.getItem(STORAGE_KEYS.uid);
  if (existing) return existing;

  let uid = '';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    uid = `u_${crypto.randomUUID().replace(/-/g, '')}`;
  } else {
    uid = `u_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }

  localStorage.setItem(STORAGE_KEYS.uid, uid);
  return uid;
}

export function updateUrlWithRoom(roomId) {
  const url = new URL(location.href);
  url.searchParams.set('room', normalizeRoomCode(roomId));
  history.replaceState({}, '', url.toString());
}

export function clearRoomFromUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState({}, '', url.toString());
}

export function getRoomFromQuery() {
  const url = new URL(location.href);
  return normalizeRoomCode(url.searchParams.get('room') || '');
}
