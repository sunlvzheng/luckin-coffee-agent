/**
 * 公用心核 · 会话状态
 *
 * 会话完全跑在客户端（浏览器 / Node），后端是无状态的，
 * 所以刷新页面后可以用 toJSON / fromJSON 原样恢复。
 */

export const createSession = (overrides = {}) => ({
  id: overrides.id || defaultId(),
  lat: overrides.lat ?? null,
  lng: overrides.lng ?? null,
  store: null, // { deptId, name }
  storeCandidates: {}, // deptId -> 门店原始数据
  lastPreview: null, // { deptId, items, preview }
  lastOrderId: null,
  history: [], // LLM 消息
  pause: null, // 待确认的敏感工具调用
  uiLog: [], // 界面事件流（用于回放）
});

export const defaultId = () => {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto?.randomUUID) {
    try {
      return globalCrypto.randomUUID();
    } catch {
      /* 非安全上下文下会抛错，走下面的兜底 */
    }
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};

export const isWaitingConfirm = (session) => Boolean(session.pause);

/** 可持久化的字段（history / uiLog 一并保存，刷新后能接着聊） */
export const toJSON = (session) => ({
  id: session.id,
  lat: session.lat,
  lng: session.lng,
  store: session.store,
  storeCandidates: session.storeCandidates,
  lastPreview: session.lastPreview,
  lastOrderId: session.lastOrderId,
  history: session.history,
  pause: session.pause,
  uiLog: session.uiLog,
});

export const fromJSON = (raw, overrides = {}) => {
  const session = createSession(overrides);
  if (raw && typeof raw === "object") {
    Object.assign(session, raw, overrides);
  }
  session.history = Array.isArray(session.history) ? session.history : [];
  session.uiLog = Array.isArray(session.uiLog) ? session.uiLog : [];
  session.storeCandidates = session.storeCandidates || {};
  return session;
};

export const resetSession = (session) => {
  session.history = [];
  session.pause = null;
  session.lastPreview = null;
  session.lastOrderId = null;
  return session;
};
