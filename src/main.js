// src/main.js
import { state, getCurrentUid } from './state.js';
import { on, normalizeRoomCode, getRoomFromQuery, STORAGE_KEYS } from './utils.js';
import { bindDom, els, showScreen, toast, disableLobbyButtons, renderHistoryList, showHistoryLoading } from './ui.js';
import {
  loadFirebaseConfig,
  initFirebase,
  loadSoundPreference,
  toggleSound,
  signInGuest,
  signInWithGoogle,
} from './infra.js';
import {
  hydrateLobbyInputs,
  handleCreate,
  handleJoin,
  handleStartPause,
  handleSkip,
  leaveRoom,
  toggleVoice,
  toggleMute,
  handleTaskUpdate,
  saveSettings,
} from './app.js';
import { loadWorkHistory, deleteHistoryEntry } from './history.js';

function makeGuestName() {
  return `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
}

// ----- History Modal -----
let currentHistory = [];

async function openHistoryModal() {
  if (!state.roomId || !els.historyModal) return;

  showHistoryLoading();
  els.historyModal.classList.remove('hidden');
  els.historyModal.setAttribute('aria-hidden', 'false');

  await refreshHistory();
}

function closeHistoryModal() {
  if (!els.historyModal) return;
  els.historyModal.classList.add('hidden');
  els.historyModal.setAttribute('aria-hidden', 'true');
}

async function refreshHistory() {
  try {
    showHistoryLoading();
    currentHistory = await loadWorkHistory();
    renderHistoryList(currentHistory, handleDeleteHistory);
  } catch (err) {
    console.error('Failed to load history:', err);
    toast('履歴の読み込みに失敗しました', true);
  }
}

async function handleDeleteHistory(sessionId) {
  if (!confirm('この履歴を削除しますか?')) return;

  try {
    await deleteHistoryEntry(sessionId);
    toast('履歴を削除しました');
    await refreshHistory();
  } catch (err) {
    console.error('Failed to delete history:', err);
    toast('履歴の削除に失敗しました', true);
  }
}

async function handleClearAllHistory() {
  if (!confirm('すべての履歴を削除しますか? この操作は取り消せません。')) return;

  try {
    const me = getCurrentUid();
    if (!me || !state.roomRef) return;

    await state.roomRef.child(`participants/${me}/history`).remove();
    toast('すべての履歴を削除しました');
    await refreshHistory();
  } catch (err) {
    console.error('Failed to clear history:', err);
    toast('履歴の削除に失敗しました', true);
  }
}

// ----- init guard -----
let bootStarted = false;
let bootFinished = false;

function syncWindowConfigToLocalStorage() {
  const cfg = window.STUDY_TOGETHER_FIREBASE_CONFIG;
  if (!cfg) return;
  try {
    localStorage.setItem(STORAGE_KEYS.firebaseConfig, JSON.stringify(cfg));
  } catch {
    // no-op
  }
}

// 旧setup画面互換（要素が無ければ何もしない）
function handleSaveConfig() {
  if (!els.firebaseConfigInput) return;
  const raw = els.firebaseConfigInput.value.trim();
  if (!raw) return toast('firebaseConfig が空です。', true);
  try {
    const cfg = JSON.parse(raw);
    localStorage.setItem(STORAGE_KEYS.firebaseConfig, JSON.stringify(cfg));
    location.reload();
  } catch {
    toast('JSONが壊れてる。カンマとカッコを見直して。', true);
  }
}

function handleResetConfig() {
  localStorage.removeItem(STORAGE_KEYS.firebaseConfig);
  toast('Firebase設定を削除しました。ページを再読み込みします。');
  setTimeout(() => location.reload(), 500);
}

function openSettingsModal() {
  if (!state.roomId || !els.settingsModal) return;
  if (els.workMinInput) els.workMinInput.value = Math.round(state.settings.workSec / 60);
  if (els.breakMinInput) els.breakMinInput.value = Math.round(state.settings.breakSec / 60);
  els.settingsModal.classList.remove('hidden');
  els.settingsModal.setAttribute('aria-hidden', 'false');
}

function closeSettingsModal() {
  if (!els.settingsModal) return;
  els.settingsModal.classList.add('hidden');
  els.settingsModal.setAttribute('aria-hidden', 'true');
}

async function copyRoomCode() {
  if (!state.roomId) return;
  try {
    await navigator.clipboard.writeText(state.roomId);
    toast('ルームコードをコピー。');
  } catch {
    toast('コピー失敗。ブラウザ権限を確認して。', true);
  }
}

async function copyInviteLink() {
  if (!state.roomId) return;
  const url = `${location.origin}${location.pathname}?room=${state.roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('招待リンクをコピー。');
  } catch {
    toast('コピー失敗。', true);
  }
}

function initCounter() {
  const counterEl = document.getElementById('counterValue');
  const counterBtn = document.getElementById('counterBtn');
  if (!counterEl || !counterBtn) return;

  let count = 0;
  const clickSound = new Audio('./sounds/野獣「ヌッ！」.mp3');
  clickSound.preload = 'auto';

  counterBtn.addEventListener('click', () => {
    count += 1;
    counterEl.textContent = String(count);
    try {
      clickSound.currentTime = 0;
      clickSound.play().catch(() => {});
    } catch {
      // no-op
    }
  });
}

async function handleAuthGuest() {
  try {
    const user = await signInGuest();
    state.auth = {
      mode: 'guest',
      uid: user.uid,
      displayName: makeGuestName(),
      isAnonymous: true,
      email: '',
    };
    state.nickname = state.auth.displayName;
    if (els.nicknameInput) els.nicknameInput.value = state.auth.displayName;
    showScreen('lobby');
    toast('ゲストでログインしました。');
  } catch (e) {
    console.error(e);
    toast('ゲスト認証に失敗。Firebase Auth設定を確認して。', true);
  }
}

async function handleAuthGoogle() {
  try {
    const user = await signInWithGoogle();
    const fallbackName = user.email ? user.email.split('@')[0] : 'User';
    state.auth = {
      mode: 'account',
      uid: user.uid,
      displayName: user.displayName || fallbackName,
      isAnonymous: !!user.isAnonymous,
      email: user.email || '',
    };
    state.nickname = state.auth.displayName;
    if (els.nicknameInput) els.nicknameInput.value = state.auth.displayName;
    showScreen('lobby');
    toast('Googleログインしました。');
  } catch (e) {
    console.error(e);
    toast('Googleログインに失敗。Authプロバイダ設定を確認して。', true);
  }
}

function requireAuthOrToast() {
  if (!state.auth?.uid) {
    toast('先に認証してください。', true);
    showScreen('auth');
    return false;
  }
  return true;
}

function bindUiEvents() {
  // 旧互換（要素があれば有効）
  on(els.saveConfigBtn, 'click', handleSaveConfig);
  on(els.resetConfigBtn, 'click', handleResetConfig);

  // auth
  on(els.enterAsGuestBtn, 'click', handleAuthGuest);
  on(els.loginGoogleBtn, 'click', handleAuthGoogle);

  // lobby
  on(els.joinBtn, 'click', async () => {
    if (!requireAuthOrToast()) return;
    await handleJoin();
  });

  on(els.createBtn, 'click', async () => {
    if (!requireAuthOrToast()) return;
    await handleCreate();
  });

  on(els.roomCodeInput, 'input', () => {
    if (!els.roomCodeInput) return;
    els.roomCodeInput.value = normalizeRoomCode(els.roomCodeInput.value);
  });

  // room controls
  on(els.startPauseBtn, 'click', handleStartPause);
  on(els.skipBtn, 'click', handleSkip);
  on(els.leaveBtn, 'click', leaveRoom);

  on(els.copyCodeBtn, 'click', copyRoomCode);
  on(els.copyInviteBtn, 'click', copyInviteLink);

  // voice
  on(els.voiceToggleBtn, 'click', toggleVoice);
  on(els.muteBtn, 'click', toggleMute);

  // task
  on(els.taskUpdateBtn, 'click', handleTaskUpdate);
  on(els.taskInput, 'keypress', (e) => {
    if (e.key === 'Enter') handleTaskUpdate();
  });

  // settings
  on(els.openSettingsBtn, 'click', openSettingsModal);
  on(els.closeSettingsBtn, 'click', closeSettingsModal);
  on(els.saveSettingsBtn, 'click', async () => {
    await saveSettings();
    closeSettingsModal();
  });

  on(els.settingsModal, 'click', (e) => {
    if (e.target === els.settingsModal) closeSettingsModal();
  });

  // history
  on(els.historyBtn, 'click', openHistoryModal);
  on(els.closeHistoryBtn, 'click', closeHistoryModal);
  on(els.historyRefreshBtn, 'click', refreshHistory);
  on(els.historyClearBtn, 'click', handleClearAllHistory);

  on(els.historyModal, 'click', (e) => {
    if (e.target === els.historyModal) closeHistoryModal();
  });

  // sound
  on(els.soundToggleBtn, 'click', toggleSound);
}

async function bootApp() {
  if (window.STUDY_TOGETHER_FIREBASE_CONFIG) {
    localStorage.setItem(
      STORAGE_KEYS.firebaseConfig,
      JSON.stringify(window.STUDY_TOGETHER_FIREBASE_CONFIG)
    );
  }

  if (bootFinished) return;
  if (bootStarted) return; // 二重起動防止
  bootStarted = true;

  bindDom();
  bindUiEvents();
  loadSoundPreference();
  initCounter();

  // window設定があればlocalStorageへ同期（残骸での mismatch 対策）
  syncWindowConfigToLocalStorage();

  const config = loadFirebaseConfig();

  if (!config) {
    showScreen('auth');
    disableLobbyButtons(true);
    if (els.connDot) els.connDot.style.background = '#f87171';
    if (els.connText) els.connText.textContent = '初期化エラー: Firebase設定が見つかりません';
    toast('Firebase設定が未設定。config.js または Hosting init.js を確認して。', true);
    bootStarted = false;
    return;
  }

  // デバッグ可視化（嫌なら消していい）
  console.log('[boot] config used:', {
    projectId: config.projectId,
    databaseURL: config.databaseURL,
    appId: config.appId,
  });

  try {
    await initFirebase(config);

    // 起動時は必ず認証画面
    showScreen('auth');

    // ロビー入力の復元だけ先にしておく
    hydrateLobbyInputs();

    // URL room は先に入力欄へセットだけしておく
    const roomFromQuery = getRoomFromQuery();
    if (roomFromQuery && els.roomCodeInput) {
      els.roomCodeInput.value = roomFromQuery;
    }

    if (els.connDot) els.connDot.style.background = '#34d399';
    if (els.connText) els.connText.textContent = '接続OK';
    disableLobbyButtons(false);

    bootFinished = true;
  } catch (err) {
    console.error(err);

    showScreen('auth');
    disableLobbyButtons(true);

    if (els.connDot) els.connDot.style.background = '#f87171';
    if (els.connText) {
      els.connText.textContent = '初期化エラー: Firebase設定を確認してください';
    }
    toast('アプリ初期化に失敗。config.js / init.js / localStorage の不一致を確認して。', true);

    // 失敗時は再試行できるようにフラグを戻す
    bootStarted = false;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  bootApp();
});
