// src/history.js
import { state, nowServerMs, getCurrentUid } from './state.js';

/**
 * Initialize a new work session when work phase starts
 */
export function initWorkSession() {
  state.workSession = {
    startedAt: nowServerMs(),
    startTask: state.currentTask || '',
    isActive: true,
  };
}

/**
 * Record completed work session to Firebase
 */
export async function recordWorkSessionHistory() {
  if (!state.workSession.isActive) return;
  if (!state.roomRef) return;

  const me = getCurrentUid();
  if (!me) return;

  const completedAt = nowServerMs();
  const startedAt = state.workSession.startedAt || completedAt;
  const duration = Math.round((completedAt - startedAt) / 1000);

  // Only record if session was at least 30 seconds
  if (duration < 30) {
    state.workSession.isActive = false;
    return;
  }

  const sessionId = `session_${startedAt}`;
  const historyEntry = {
    startedAt,
    completedAt,
    duration,
    task: state.workSession.startTask || '',
    roomId: state.roomId,
    phaseConfig: {
      workSec: state.settings.workSec,
    },
  };

  try {
    await state.roomRef
      .child(`participants/${me}/history/${sessionId}`)
      .set(historyEntry);
  } catch (err) {
    console.error('Failed to save work session history:', err);
  } finally {
    state.workSession.isActive = false;
  }
}

/**
 * Load history for current user in current room
 */
export async function loadWorkHistory() {
  if (!state.roomRef) return [];

  const me = getCurrentUid();
  if (!me) return [];

  try {
    const snap = await state.roomRef
      .child(`participants/${me}/history`)
      .orderByChild('completedAt')
      .limitToLast(50)
      .once('value');

    if (!snap.exists()) return [];

    const history = [];
    snap.forEach((child) => {
      history.push({ id: child.key, ...child.val() });
    });

    // Sort by completedAt descending (newest first)
    return history.sort((a, b) => b.completedAt - a.completedAt);
  } catch (err) {
    console.error('Failed to load work history:', err);
    return [];
  }
}

/**
 * Delete a specific history entry
 */
export async function deleteHistoryEntry(sessionId) {
  if (!state.roomRef) return;

  const me = getCurrentUid();
  if (!me) return;

  try {
    await state.roomRef
      .child(`participants/${me}/history/${sessionId}`)
      .remove();
  } catch (err) {
    console.error('Failed to delete history entry:', err);
    throw err;
  }
}
