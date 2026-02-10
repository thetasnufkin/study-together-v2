
// ここから元のスクリプト
(() => {
  'use strict';
  // ...

  // -----------------------------
  // Constants
  // -----------------------------
  const STORAGE_KEYS = {
    firebaseConfig: 'st_firebase_config_v2',
    nickname: 'st_nickname_v2',
    uid: 'st_uid_v2',
  };

  const DEFAULT_SETTINGS = {
    workSec: 25 * 60,
    breakSec: 5 * 60,
  };

  const ROOM_CODE_LEN = 6;
  const HEARTBEAT_MS = 10_000;
  const STALE_MS = 35_000;

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    db: null,
    app: null,
    globalDbListeners: [],
    roomDbListeners: [],

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
  };

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const els = {
    setupScreen: null,
    lobbyScreen: null,
    roomScreen: null,

    firebaseConfigInput: null,
    saveConfigBtn: null,

    connDot: null,
    connText: null,

    nicknameInput: null,
    roomCodeInput: null,
    joinBtn: null,
    createBtn: null,
    resetConfigBtn: null,

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

    voiceToggleBtn: null,
    muteBtn: null,
    voiceHelp: null,
    voiceStatePill: null,
    micBars: null,

    participantCount: null,
    participantList: null,

    settingsModal: null,
    openSettingsBtn: null,
    closeSettingsBtn: null,
    saveSettingsBtn: null,
    workMinInput: null,
    breakMinInput: null,

    toast: null,
  };

  // -----------------------------
  // Boot
  // -----------------------------
  window.addEventListener('DOMContentLoaded', async () => {
    bindDom();
    bindUiEvents();

    const config = loadFirebaseConfig();

    try {
      await initFirebase(config);
      showScreen('lobby');
      hydrateLobbyInputs();

      const roomFromQuery = getRoomFromQuery();
      if (roomFromQuery && els.roomCodeInput) {
        els.roomCodeInput.value = roomFromQuery;
      }
    } catch (err) {
      console.error(err);
      showScreen('lobby');
      disableLobbyButtons(true);
      if (els.connDot) els.connDot.style.background = '#f87171';
      if (els.connText) {
        els.connText.textContent = '初期化エラー: 管理者がFirebase設定を完了していません';
      }
      toast('アプリ初期化に失敗。運営者に設定不備（config.js または Firebase Hosting init.js）を確認してもらってください。', true);
    }
  });

  function bindDom() {
    Object.keys(els).forEach((key) => {
      els[key] = $(key);
    });
  }

  function bindUiEvents() {
    on(els.saveConfigBtn, 'click', handleSaveConfig);

    on(els.joinBtn, 'click', handleJoin);
    on(els.createBtn, 'click', handleCreate);
    on(els.resetConfigBtn, 'click', handleResetConfig);

    on(els.roomCodeInput, 'input', () => {
      els.roomCodeInput.value = normalizeRoomCode(els.roomCodeInput.value);
    });

    on(els.startPauseBtn, 'click', handleStartPause);
    on(els.skipBtn, 'click', handleSkip);
    on(els.leaveBtn, 'click', leaveRoom);

    on(els.copyCodeBtn, 'click', copyRoomCode);
    on(els.copyInviteBtn, 'click', copyInviteLink);

    on(els.voiceToggleBtn, 'click', toggleVoice);
    on(els.muteBtn, 'click', toggleMute);

    on(els.openSettingsBtn, 'click', openSettingsModal);
    on(els.closeSettingsBtn, 'click', closeSettingsModal);
    on(els.saveSettingsBtn, 'click', saveSettings);
    on(els.settingsModal, 'click', (e) => {
      if (e.target === els.settingsModal) closeSettingsModal();
    });
  }

  // -----------------------------
  // Firebase setup
  // -----------------------------
  function loadFirebaseConfig() {
    // 1) 静的ファイル(config.js)で注入
    if (window.STUDY_TOGETHER_FIREBASE_CONFIG) {
      return window.STUDY_TOGETHER_FIREBASE_CONFIG;
    }

    // 2) Firebase Hosting の自動初期化 (/__/firebase/init.js)
    if (window.firebase?.apps?.length) {
      return window.firebase.app().options || null;
    }

    // 3) レガシー互換（過去バージョンで localStorage に保存済みの場合）
    const raw = localStorage.getItem(STORAGE_KEYS.firebaseConfig);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function initFirebase(config) {
  if (!config) throw new Error("Firebase config is missing");

  if (!window.firebase?.apps?.length) {
    state.app = window.firebase.initializeApp(config);
  } else {
    state.app = window.firebase.app();
  }

  state.db = state.app.database();

  // auth SDKが読めてない場合を即検知
  if (typeof window.firebase.auth !== "function") {
    throw new Error("firebase-auth-compat is not loaded");
  }

  await window.firebase.auth().signInAnonymously();
  return true;
}



  function handleSaveConfig() {
    const raw = els.firebaseConfigInput.value.trim();
    if (!raw) {
      toast('firebaseConfig が空です。人生もたまに空白だけど、ここは埋めよう。', true);
      return;
    }

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

  // -----------------------------
  // Lobby actions
  // -----------------------------
  function hydrateLobbyInputs() {
    const savedNick = localStorage.getItem(STORAGE_KEYS.nickname) || '';
    if (savedNick) els.nicknameInput.value = savedNick;
  }

  async function handleCreate() {
    const nickname = sanitizeNickname(els.nicknameInput.value);
    if (!nickname) {
      toast('ニックネームは2文字以上で頼む。', true);
      return;
    }

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

  async function handleJoin() {
    const nickname = sanitizeNickname(els.nicknameInput.value);
    const roomId = normalizeRoomCode(els.roomCodeInput.value || getRoomFromQuery() || '');

    if (!nickname) {
      toast('ニックネームは2文字以上で頼む。', true);
      return;
    }
    if (!roomId) {
      toast('ルームコードが必要。超能力参加は未実装。', true);
      return;
    }

    disableLobbyButtons(true);
    try {
      const exists = await roomExists(roomId);
      if (!exists) {
        toast(`ルーム ${roomId} は見つかりません。`, true);
        return;
      }

      await enterRoom(roomId, nickname, { justCreated: false });
    } catch (err) {
      console.error(err);
      toast('ルーム参加に失敗。通信を見直して。', true);
    } finally {
      disableLobbyButtons(false);
    }
  }

  async function createRoomWithRetries(maxTry = 8) {
    for (let i = 0; i < maxTry; i += 1) {
      const roomId = generateRoomCode();
      const ref = state.db.ref(`rooms/${roomId}`);
      const now = nowServerMs();

      const result = await ref.transaction((current) => {
        if (current !== null) return undefined;
        return {
          meta: {
            createdAt: now,
            hostId: state.uid,
          },
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

      if (result.committed) {
        return roomId;
      }
    }

    throw new Error('Failed to create unique room id');
  }

  async function roomExists(roomId) {
    const snap = await state.db.ref(`rooms/${roomId}`).once('value');
    return snap.exists();
  }

  async function enterRoom(roomId, nickname, { justCreated }) {
    cleanupRoomOnly();

    state.roomId = roomId;
    state.nickname = nickname;
    state.roomRef = state.db.ref(`rooms/${roomId}`);

    localStorage.setItem(STORAGE_KEYS.nickname, nickname);

    // 参加者登録
    state.participantRef = state.roomRef.child(`participants/${state.uid}`);
    await state.participantRef.set({
      nickname,
      joinedAt: nowServerMs(),
      lastSeen: nowServerMs(),
      peerId: state.uid,
      voiceEnabled: false,
      muted: false,
    });
    state.participantRef.onDisconnect().remove();

    // リスナー
    attachRoomListeners();

    // Peer初期化
    await initPeerIfNeeded();

    // ハートビート
    state.heartbeatTicker = setInterval(() => {
      if (state.participantRef) {
        state.participantRef.update({
          lastSeen: nowServerMs(),
          muted: state.isMuted,
          voiceEnabled: state.voiceEnabled,
        });
      }
    }, HEARTBEAT_MS);

    // ホストのときだけゴミ掃除（死んだ参加者）
    state.staleTicker = setInterval(pruneStaleParticipantsIfHost, 15_000);

    // UI ticker
    state.uiTicker = setInterval(tickUI, 250);

    showScreen('room');
    updateUrlWithRoom(roomId);

    els.roomTitle.textContent = `Room ${roomId}`;
    els.workMinInput.value = Math.round(state.settings.workSec / 60);
    els.breakMinInput.value = Math.round(state.settings.breakSec / 60);

    toast(justCreated ? `ルーム ${roomId} を作成` : `ルーム ${roomId} に参加`);
  }

  function attachRoomListeners() {
    // 参加者
    onDb(state.roomRef.child('participants'), 'value', (snap) => {
      const map = new Map();
      snap.forEach((child) => {
        map.set(child.key, child.val());
      });
      state.participants = map;
      renderParticipants();

      // ホスト不在時の引き継ぎ
      claimHostIfNeeded();
    });

    // メタ情報
    onDb(state.roomRef.child('meta'), 'value', (snap) => {
      const meta = snap.val() || {};
      state.hostId = meta.hostId || null;
      state.isHost = state.hostId === state.uid;
      updateRoleUI();

      // hostIdが消えた場合に備えて
      claimHostIfNeeded();
    });

    // 設定
    onDb(state.roomRef.child('settings'), 'value', (snap) => {
      const s = snap.val();
      if (!s) return;

      state.settings.workSec = clampInt(s.workSec, 5 * 60, 90 * 60, DEFAULT_SETTINGS.workSec);
      state.settings.breakSec = clampInt(s.breakSec, 60, 30 * 60, DEFAULT_SETTINGS.breakSec);

      els.workMinInput.value = Math.round(state.settings.workSec / 60);
      els.breakMinInput.value = Math.round(state.settings.breakSec / 60);

      updateTimerUiOnly();
    });

    // タイマー
    onDb(state.roomRef.child('timer'), 'value', (snap) => {
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

      updateTimerUiOnly();

      if (prevPhase !== state.timer.phase) {
        if (state.timer.phase === 'break') {
          toast('☕ 休憩開始。話すなら今。');
        } else {
          toast('🎯 作業開始。口より手を動かす時間。');
          // 作業フェーズに入ったら通話を切る
          if (state.voiceEnabled) {
            disableVoice(false);
          }
        }
      }
    });

    // ルーム削除や強制退出
    onDb(state.roomRef, 'value', (snap) => {
      if (!snap.exists()) {
        toast('ルームが閉じられました。', true);
        leaveRoom();
        return;
      }

      if (state.roomId && !state.participants.has(state.uid)) {
        // 自分の参加者レコードが消えたら離脱
        toast('ルームから切断されました。', true);
        leaveRoom();
      }
    });
  }

  async function claimHostIfNeeded() {
    if (!state.roomRef || !state.participants.size) return;

    const hostAlive = state.hostId && state.participants.has(state.hostId);
    if (hostAlive) return;

    const oldest = getOldestParticipantId();
    if (oldest !== state.uid) return;

    try {
      await state.roomRef.child('meta/hostId').transaction((current) => {
        if (!current || !state.participants.has(current)) {
          return state.uid;
        }
        return current;
      });
    } catch (err) {
      console.error('host claim failed', err);
    }
  }

  function getOldestParticipantId() {
    let oldestId = null;
    let oldestJoinedAt = Number.POSITIVE_INFINITY;

    state.participants.forEach((p, id) => {
      const joinedAt = Number(p?.joinedAt || nowServerMs());
      if (joinedAt < oldestJoinedAt) {
        oldestJoinedAt = joinedAt;
        oldestId = id;
      }
    });

    return oldestId;
  }

  async function pruneStaleParticipantsIfHost() {
    if (!state.isHost || !state.roomRef) return;

    const now = nowServerMs();
    const updates = {};

    state.participants.forEach((p, id) => {
      if (id === state.uid) return;
      const lastSeen = Number(p?.lastSeen || 0);
      if (now - lastSeen > STALE_MS) {
        updates[`participants/${id}`] = null;
      }
    });

    if (Object.keys(updates).length > 0) {
      try {
        await state.roomRef.update(updates);
      } catch (err) {
        console.error('stale prune failed', err);
      }
    }
  }

  // -----------------------------
  // Timer logic
  // -----------------------------
  function tickUI() {
    updateTimerUiOnly();

    // ホストは残り0でフェーズ切替
    if (state.isHost && !state.timer.paused && !state.isSwitchingPhase) {
      const remaining = calcRemainingSec();
      if (remaining <= 0) {
        advancePhase();
      }
    }
  }

  function phaseDurationSec(phase = state.timer.phase) {
    return phase === 'break' ? state.settings.breakSec : state.settings.workSec;
  }

  function calcRemainingSec() {
    const duration = phaseDurationSec(state.timer.phase);

    if (state.timer.paused) {
      return clampInt(state.timer.pausedRemaining, 0, duration, duration);
    }

    const elapsed = (nowServerMs() - Number(state.timer.phaseStartAt)) / 1000;
    return Math.max(0, Math.ceil(duration - elapsed));
  }

  async function handleStartPause() {
    if (!state.isHost || !state.roomRef) {
      toast('ホストだけが開始/停止できます。民主主義に見えてここは違う。', true);
      return;
    }

    const duration = phaseDurationSec(state.timer.phase);

    if (state.timer.paused) {
      const remaining = clampInt(state.timer.pausedRemaining, 1, duration, duration);
      const startAt = nowServerMs() - (duration - remaining) * 1000;
      await writeTimer({
        paused: false,
        phaseStartAt: startAt,
        version: (state.timer.version || 0) + 1,
      });
    } else {
      const remaining = calcRemainingSec();
      await writeTimer({
        paused: true,
        pausedRemaining: remaining,
        version: (state.timer.version || 0) + 1,
      });
    }
  }

  async function handleSkip() {
    if (!state.isHost) {
      toast('次へ進めるのはホストだけ。さすがに全員が押したら地獄。', true);
      return;
    }
    await advancePhase();
  }

  async function advancePhase() {
    if (state.isSwitchingPhase) return;
    state.isSwitchingPhase = true;

    try {
      const currentPhase = state.timer.phase;
      const nextPhase = currentPhase === 'work' ? 'break' : 'work';
      const nextDuration = phaseDurationSec(nextPhase);
      const nextCycle = currentPhase === 'work' ? Number(state.timer.cycle || 0) + 1 : Number(state.timer.cycle || 0);

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

  async function writeTimer(patch) {
    if (!state.roomRef) return;
    await state.roomRef.child('timer').update(patch);
  }

  // -----------------------------
  // Voice (PeerJS)
  // -----------------------------
  async function initPeerIfNeeded() {
    if (state.peer) return;

    await new Promise((resolve) => {
      const peer = new Peer(state.uid, { debug: 1 });
      state.peer = peer;

      peer.on('open', () => {
        state.peerReady = true;
        resolve();
      });

      peer.on('call', (call) => {
        if (!canUseVoiceNow() || !state.localStream) {
          try {
            call.close();
          } catch {
            // noop
          }
          return;
        }

        call.answer(state.localStream);
        attachRemoteCall(call);
      });

      peer.on('error', (err) => {
        console.error('Peer error:', err);
        toast('通話接続でエラー。通信環境が暴れてる。', true);
      });
    });
  }

  function canUseVoiceNow() {
    return state.timer.phase === 'break';
  }

  async function toggleVoice() {
    if (state.voiceEnabled) {
      disableVoice(true);
      return;
    }

    if (!canUseVoiceNow()) {
      toast('休憩中だけ通話できます。作業中は静かに勉強。', true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
        video: false,
      });

      state.localStream = stream;
      state.voiceEnabled = true;
      state.isMuted = false;

      startMicVisualizer(stream);
      await syncParticipantVoiceState();
      connectToVoicePeers();

      updateVoiceUiOnly();
      toast('マイクを有効化。休憩雑談どうぞ。');
    } catch (err) {
      console.error(err);
      toast('マイク取得に失敗。ブラウザ権限を確認して。', true);
    }
  }

  async function disableVoice(showToast) {
    state.voiceEnabled = false;
    state.isMuted = false;

    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }

    stopMicVisualizer();

    // 接続を全部切る
    state.remoteCalls.forEach((call, peerId) => {
      try {
        call.close();
      } catch {
        // noop
      }
      cleanupRemoteAudio(peerId);
    });
    state.remoteCalls.clear();

    await syncParticipantVoiceState();
    updateVoiceUiOnly();

    if (showToast) toast('マイクをOFFにしました。');
  }

  function connectToVoicePeers() {
    if (!state.peer || !state.peerReady || !state.localStream || !state.voiceEnabled) return;

    state.participants.forEach((p, id) => {
      if (id === state.uid) return;
      if (state.remoteCalls.has(id)) return;

      // 相手がまだvoiceEnabledでなくても、休憩中なら後でincomingで繋がるので問題なし。
      const call = state.peer.call(id, state.localStream, {
        metadata: {
          roomId: state.roomId,
        },
      });

      if (call) {
        attachRemoteCall(call);
      }
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
      cleanupRemoteAudio(peerId);
      state.remoteCalls.delete(peerId);
    };

    call.on('close', onCloseOrError);
    call.on('error', onCloseOrError);
  }

  function cleanupRemoteAudio(peerId) {
    const el = document.getElementById(`remote-audio-${peerId}`);
    if (el) el.remove();
  }

  async function toggleMute() {
    if (!state.localStream || !state.voiceEnabled) return;

    state.isMuted = !state.isMuted;
    state.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !state.isMuted;
    });

    await syncParticipantVoiceState();
    updateVoiceUiOnly();
  }

  async function syncParticipantVoiceState() {
    if (!state.participantRef) return;
    await state.participantRef.update({
      voiceEnabled: state.voiceEnabled,
      muted: state.isMuted,
      lastSeen: nowServerMs(),
    });
  }

  // -----------------------------
  // Mic visualizer
  // -----------------------------
  function startMicVisualizer(stream) {
    stopMicVisualizer();

    if (!window.AudioContext && !window.webkitAudioContext) return;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx();

    const src = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 64;
    src.connect(state.analyser);

    const data = new Uint8Array(state.analyser.frequencyBinCount);
    const bars = [...els.micBars.querySelectorAll('span')];

    const animate = () => {
      if (!state.analyser || !state.voiceEnabled) return;
      state.micAnimationFrame = requestAnimationFrame(animate);
      state.analyser.getByteFrequencyData(data);

      bars.forEach((bar, i) => {
        const v = data[i + 1] || 0;
        const h = Math.max(6, Math.floor(v / 5));
        bar.style.height = `${h}px`;
      });
    };

    animate();
  }

  function stopMicVisualizer() {
    if (state.micAnimationFrame) {
      cancelAnimationFrame(state.micAnimationFrame);
      state.micAnimationFrame = null;
    }

    if (state.audioCtx) {
      state.audioCtx.close().catch(() => {});
      state.audioCtx = null;
      state.analyser = null;
    }

    [...els.micBars.querySelectorAll('span')].forEach((b) => {
      b.style.height = '6px';
    });
  }

  // -----------------------------
  // Settings modal
  // -----------------------------
  function openSettingsModal() {
    if (!state.roomId) return;

    els.workMinInput.value = Math.round(state.settings.workSec / 60);
    els.breakMinInput.value = Math.round(state.settings.breakSec / 60);

    els.settingsModal.classList.remove('hidden');
    els.settingsModal.setAttribute('aria-hidden', 'false');
  }

  function closeSettingsModal() {
    els.settingsModal.classList.add('hidden');
    els.settingsModal.setAttribute('aria-hidden', 'true');
  }

  async function saveSettings() {
    if (!state.roomRef || !state.isHost) {
      toast('設定変更はホストのみ。', true);
      closeSettingsModal();
      return;
    }

    const workMin = clampInt(Number(els.workMinInput.value), 5, 90, 25);
    const breakMin = clampInt(Number(els.breakMinInput.value), 1, 30, 5);

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
      closeSettingsModal();
    } catch (err) {
      console.error(err);
      toast('設定保存に失敗。', true);
    }
  }

  // -----------------------------
  // UI rendering
  // -----------------------------
  function updateRoleUI() {
    const hostOnly = state.isHost;

    els.startPauseBtn.disabled = !hostOnly;
    els.skipBtn.disabled = !hostOnly;

    if (!hostOnly) {
      els.startPauseBtn.textContent = state.timer.paused ? '開始（ホスト専用）' : '停止（ホスト専用）';
    } else {
      els.startPauseBtn.textContent = state.timer.paused ? '開始' : '一時停止';
    }

    if (state.timer.paused) {
      els.startPauseBtn.textContent = hostOnly ? '開始' : '開始（ホスト専用）';
    } else {
      els.startPauseBtn.textContent = hostOnly ? '一時停止' : '停止（ホスト専用）';
    }
  }

  function updateTimerUiOnly() {
    const remaining = calcRemainingSec();
    const duration = phaseDurationSec(state.timer.phase);
    const progress = duration > 0 ? (duration - remaining) / duration : 0;
    const pct = Math.min(1, Math.max(0, progress)) * 100;

    els.timerDisplay.textContent = secToMMSS(remaining);
    els.timerLabel.textContent = state.timer.phase === 'break' ? '休憩タイム' : '集中タイム';
    els.cycleText.textContent = String(state.timer.cycle || 0);

    els.phaseBadge.className = `badge ${state.timer.phase}`;
    els.phaseBadge.textContent = state.timer.phase === 'break' ? '☕ 休憩中' : '🎯 作業中';

    const ringColor = state.timer.phase === 'break' ? 'var(--break)' : 'var(--work)';
    els.ring.style.background = `conic-gradient(${ringColor} ${pct}%, rgba(159, 176, 207, 0.14) ${pct}%)`;

    updateRoleUI();
    updateVoiceUiOnly();
  }

  function updateVoiceUiOnly() {
    const breakNow = canUseVoiceNow();
    const enabled = state.voiceEnabled;

    els.voiceToggleBtn.disabled = !breakNow;
    els.muteBtn.disabled = !enabled;

    if (!breakNow) {
      els.voiceHelp.textContent = '作業中は通話できません。休憩開始で開放されます。';
      els.voiceStatePill.textContent = 'LOCK';
    } else {
      els.voiceHelp.textContent = '休憩中です。必要ならマイクをONに。';
      els.voiceStatePill.textContent = enabled ? (state.isMuted ? 'MUTED' : 'LIVE') : 'OFF';
    }

    els.voiceToggleBtn.textContent = enabled ? 'マイクOFF' : 'マイクON';
    els.muteBtn.textContent = state.isMuted ? 'ミュート解除' : 'ミュート';
  }

  function renderParticipants() {
    els.participantList.innerHTML = '';

    const arr = [...state.participants.entries()].sort((a, b) => {
      const aj = Number(a[1]?.joinedAt || 0);
      const bj = Number(b[1]?.joinedAt || 0);
      return aj - bj;
    });

    arr.forEach(([id, p]) => {
      const li = document.createElement('li');
      li.className = 'participant';

      const left = document.createElement('div');
      left.className = 'name';
      left.textContent = p.nickname || '名無し';

      const right = document.createElement('div');
      right.className = 'meta';

      if (id === state.hostId) {
        right.appendChild(tag('HOST', 'host'));
      }
      if (id === state.uid) {
        right.appendChild(tag('YOU'));
      }
      if (p.voiceEnabled) {
        right.appendChild(tag(p.muted ? 'VOICE:MUTED' : 'VOICE:ON', 'voice'));
      }

      li.appendChild(left);
      li.appendChild(right);
      els.participantList.appendChild(li);
    });

    els.participantCount.textContent = `${arr.length}人`;

    // 休憩中 & 自分がvoice on なら新規参加者へ接続を試みる
    if (canUseVoiceNow() && state.voiceEnabled) {
      connectToVoicePeers();
    }
  }

  function tag(text, cls = '') {
    const s = document.createElement('span');
    s.className = `tag ${cls}`.trim();
    s.textContent = text;
    return s;
  }

  function showScreen(which) {
    if (els.setupScreen) els.setupScreen.classList.add('hidden');
    if (els.lobbyScreen) els.lobbyScreen.classList.add('hidden');
    if (els.roomScreen) els.roomScreen.classList.add('hidden');

    if (which === 'setup' && els.setupScreen) els.setupScreen.classList.remove('hidden');
    if (which === 'lobby' && els.lobbyScreen) els.lobbyScreen.classList.remove('hidden');
    if (which === 'room' && els.roomScreen) els.roomScreen.classList.remove('hidden');
  }

  function toast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.style.borderColor = isError
      ? 'rgba(248, 113, 113, 0.6)'
      : 'rgba(94, 234, 212, 0.35)';
    els.toast.style.color = isError ? '#fecaca' : '#d1fae5';
    els.toast.classList.add('show');

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      els.toast.classList.remove('show');
    }, 2200);
  }

  // -----------------------------
  // Room leave / cleanup
  // -----------------------------
  async function leaveRoom() {
    if (!state.roomId) {
      showScreen('lobby');
      return;
    }

    try {
      // ホストなら次のホストを指名
      if (state.isHost && state.roomRef) {
        const nextHost = [...state.participants.keys()].find((id) => id !== state.uid) || null;
        if (nextHost) {
          await state.roomRef.child('meta/hostId').set(nextHost);
        } else {
          // 自分しかいないならルーム削除
          await state.roomRef.remove();
        }
      }
    } catch (err) {
      console.error(err);
    }

    cleanupAll();
    clearRoomFromUrl();
    showScreen('lobby');
    toast('ルームを退出しました。');
  }

  function cleanupAll() {
    cleanupRoomOnly();

    state.roomId = null;
    state.hostId = null;
    state.isHost = false;
    state.participants = new Map();

    renderParticipants();
    updateRoleUI();
  }

  function cleanupRoomOnly() {
    // voice
    disableVoice(false).catch(() => {});

    if (state.peer) {
      try {
        state.peer.destroy();
      } catch {
        // noop
      }
      state.peer = null;
      state.peerReady = false;
    }

    // participant cleanup
    if (state.participantRef) {
      state.participantRef.remove().catch(() => {});
      state.participantRef = null;
    }

    // timers
    if (state.uiTicker) clearInterval(state.uiTicker);
    if (state.heartbeatTicker) clearInterval(state.heartbeatTicker);
    if (state.staleTicker) clearInterval(state.staleTicker);

    state.uiTicker = null;
    state.heartbeatTicker = null;
    state.staleTicker = null;

    // Room DB listeners only
    state.roomDbListeners.forEach((off) => off());
    state.roomDbListeners = [];

    // Room refs
    state.roomRef = null;
  }

  // -----------------------------
  // Clipboard / URL
  // -----------------------------
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

  function updateUrlWithRoom(roomId) {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    history.replaceState({}, '', url.toString());
  }

  function clearRoomFromUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState({}, '', url.toString());
  }

  function getRoomFromQuery() {
    const url = new URL(location.href);
    return normalizeRoomCode(url.searchParams.get('room') || '');
  }

  // -----------------------------
  // Utility
  // -----------------------------
  function on(el, event, handler) {
    if (el) el.addEventListener(event, handler);
  }

  function onDb(ref, event, handler, scope = 'room') {
    ref.on(event, handler);
    const off = () => ref.off(event, handler);
    if (scope === 'global') {
      state.globalDbListeners.push(off);
    } else {
      state.roomDbListeners.push(off);
    }
  }

  function disableLobbyButtons(disabled) {
    els.joinBtn.disabled = disabled;
    els.createBtn.disabled = disabled;
  }

  function sanitizeNickname(raw) {
    const s = String(raw || '').trim().replace(/\s+/g, ' ');
    if (s.length < 2) return '';
    return s.slice(0, 16);
  }

  function normalizeRoomCode(v) {
    return String(v || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
  }

  function generateRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < ROOM_CODE_LEN; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  function secToMMSS(sec) {
    const s = Math.max(0, Math.floor(sec));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.round(n);
    return Math.min(max, Math.max(min, i));
  }

  function getOrCreateUid() {
    const existing = localStorage.getItem(STORAGE_KEYS.uid);
    if (existing) return existing;

    const uid = `u_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    localStorage.setItem(STORAGE_KEYS.uid, uid);
    return uid;
  }

  function nowServerMs() {
    return Date.now() + state.serverOffsetMs;
  }
})();
