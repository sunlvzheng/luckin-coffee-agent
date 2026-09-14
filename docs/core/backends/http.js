/**
 * 后端适配层 · HTTP 桥接
 *
 * 浏览器不能直接调瑞幸 MCP（服务端没有返回 CORS 头，预检还会 401），
 * 所以真实点单统一走一个薄桥接服务：由它去调 luckin CLI / MCP。
 *
 * 桥接服务只需实现：
 *   POST {base}/api/invoke  { command, args }  → { ok, data } | { ok:false, error }
 *   POST {base}/api/qr      { text }           → { ok, svg }
 *   GET  {base}/api/status                     → { ok, cli, version, llm }
 */

const joinUrl = (base, path) => `${String(base || "").replace(/\/+$/, "")}${path}`;

export const createHttpBackend = ({ baseUrl, password = "" } = {}) => {
  const post = async (path, body) => {
    let response;
    try {
      response = await fetch(joinUrl(baseUrl, path), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Password": password },
        body: JSON.stringify(body || {}),
      });
    } catch (error) {
      throw new Error(`连不上服务（${baseUrl}）：${error.message}`);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`服务返回了非 JSON 内容（HTTP ${response.status}）`);
    }
    if (response.status === 401) throw new Error("访问口令错误");
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.detail || `HTTP ${response.status}`);
    }
    return payload;
  };

  const invoke = async (command, args) => {
    const payload = await post("/api/invoke", { command, args });
    return payload.data;
  };

  return {
    id: "http",
    label: "连接服务（真实下单）",
    realOrder: true,
    notes: `后端：${baseUrl}`,

    async ping() {
      let response;
      try {
        response = await fetch(joinUrl(baseUrl, "/api/status"));
      } catch (error) {
        return { ok: false, detail: `连不上服务：${error.message}` };
      }
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
      const status = await response.json();
      return {
        ok: true,
        version: status.version || "",
        detail: `CLI ${status.exeOk ? "已就绪" : "未找到"}｜模型 ${status.llmReady ? status.model : "未配置"}`,
      };
    },

    stores: ({ latitude, longitude, keyword }) => invoke("stores", { latitude, longitude, keyword }),
    searchProducts: ({ deptId, query }) => invoke("searchProducts", { deptId, query }),
    previewOrder: ({ deptId, items }) => invoke("previewOrder", { deptId, items }),
    createOrder: ({ deptId, items, latitude, longitude, coupons }) =>
      invoke("createOrder", { deptId, items, latitude, longitude, coupons }),
    orderDetail: ({ orderId }) => invoke("orderDetail", { orderId }),
    cancelOrder: ({ orderId }) => invoke("cancelOrder", { orderId }),

    async makeQr(text) {
      if (!text) return null;
      try {
        const payload = await post("/api/qr", { text });
        return payload.svg || null;
      } catch {
        return null; // 二维码失败不影响主流程
      }
    },
  };
};
