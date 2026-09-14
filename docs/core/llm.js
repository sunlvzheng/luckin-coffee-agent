/**
 * 公用 LLM 客户端（OpenAI 兼容 + 流式）
 *
 * 两种连接方式共用同一套协议解析：
 *   direct → 浏览器/Node 直接打模型接口（用户自带 Key）
 *   proxy  → 打自己的后端，由后端注入 Key 并转发（Key 不出服务端）
 *
 * 异步生成器协议：
 *   yield { type: 'text', text }            文本增量
 *   yield { type: 'final', content, toolCalls }  本轮结束
 */

const normalizeBase = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("缺少 LLM_BASE_URL");
  if (/\/v\d+$/.test(trimmed) || /\/v\d+\//.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
};

const parseSseEvents = (buffer) => {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  return { blocks, rest };
};

export const createLlmClient = ({ mode = "direct", baseUrl = "", apiKey = "", model = "", proxyPath = "/api/llm", extraHeaders = {} } = {}) => ({
  model,
  mode,

  async *chat(messages, { tools, temperature = 0.3, signal } = {}) {
    const isProxy = mode === "proxy";
    const url = isProxy ? proxyPath : `${normalizeBase(baseUrl)}/chat/completions`;
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (!isProxy && apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const body = {
      messages,
      temperature,
      stream: true,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
      ...(isProxy ? { model } : { model: model || undefined }),
    };

    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error) {
      throw new Error(`连不上模型服务（${url}）：${error.message}`);
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      if (response.status === 401 && !isProxy) {
        throw new Error("模型鉴权失败（401）：请检查 API Key");
      }
      throw new Error(`模型服务返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    if (!response.body) throw new Error("模型服务没有返回流式内容");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const slots = new Map(); // tool_calls 分片按 index 聚合
    let content = "";
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { blocks, rest } = parseSseEvents(buffer);
      buffer = rest;

      for (const block of blocks) {
        for (const line of block.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            content += delta.content;
            yield { type: "text", text: delta.content };
          }
          for (const call of delta.tool_calls || []) {
            const index = call.index ?? 0;
            const slot = slots.get(index) || { id: "", name: "", arguments: "" };
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name += call.function.name;
            if (call.function?.arguments) slot.arguments += call.function.arguments;
            slots.set(index, slot);
          }
        }
      }
    }

    const toolCalls = [...slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, slot]) => slot)
      .filter((slot) => slot.name);

    yield { type: "final", content, toolCalls };
  },
});
