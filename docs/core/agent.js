/**
 * 公用心核 · Agent 循环
 *
 * 一轮对话：user → LLM（流式）→ 有 tool_calls 就依次执行 → 结果回填 → 再问 LLM → …
 * 直到 LLM 不再调用工具。
 *
 * 敏感工具（下单/取消）会中断本轮：先发 confirm 事件，等界面确认后再用 resume() 继续。
 * 事件协议见 README，core 与界面之间只靠这套事件通信。
 */

import { short } from "./format.js";
import { buildSystemContent } from "./prompt.js";
import { SENSITIVE_TOOLS, TOOL_SCHEMAS, ToolRunner } from "./tools.js";

export const MAX_HISTORY = 60;

const toolMessage = (callId, content) => ({ role: "tool", tool_call_id: callId, content });

export class CoffeeAgent {
  /**
   * @param {object} options
   * @param {{chat: Function, model?: string}} options.llm      LLM 客户端（core/llm.js）
   * @param {object} options.backend                            后端适配器（core/backends/*）
   * @param {number} [options.maxHistory]
   */
  constructor({ llm, backend, maxHistory = MAX_HISTORY }) {
    if (!llm) throw new Error("CoffeeAgent 需要 llm");
    if (!backend) throw new Error("CoffeeAgent 需要 backend");
    this.llm = llm;
    this.tools = new ToolRunner(backend);
    this.maxHistory = maxHistory;
  }

  get backend() {
    return this.tools.backend;
  }

  async setBackend(backend) {
    this.tools = new ToolRunner(backend);
  }

  // ------------------------------------------------------------------ //
  // 对外接口
  // ------------------------------------------------------------------ //

  /** 处理一条用户消息，产出界面事件流 */
  async *stream(session, userText) {
    session.history.push({ role: "user", content: userText });
    yield* this._loop(session);
  }

  /** 用户点确认/取消之后，继续之前被中断的一轮 */
  async *resume(session, approved) {
    const pause = session.pause;
    if (!pause) {
      yield { type: "error", message: "当前没有待确认的操作" };
      return;
    }
    session.pause = null;

    const { call, args, payload } = pause;
    const results = pause.results;

    if (approved) {
      yield { type: "status", text: "用户已确认，正在提交…" };
      let result;
      try {
        result = await this.tools.executeConfirmed(session, call.name, args, payload);
      } catch (error) {
        result = { ok: false, summary: `执行失败：${error.message}`, cards: [], display: "" };
      }
      results.push(toolMessage(call.id, result.summary));
      yield {
        type: "tool_end",
        name: call.name,
        ok: result.ok,
        summary: short(result.summary),
        display: result.display || short(result.summary, 80),
      };
      for (const card of result.cards || []) yield { type: "cards", items: [card] };
    } else {
      results.push(toolMessage(call.id, "用户取消了本次操作，没有执行。请不要重复提交，等用户下一步指令。"));
      yield {
        type: "tool_end",
        name: call.name,
        ok: true,
        summary: "用户已取消",
        display: "已取消，未下单",
      };
    }

    session.history.push(...results);

    yield* this._runCalls(session, pause.rest || [], []);
    if (session.pause) return;

    yield* this._loop(session);
  }

  // ------------------------------------------------------------------ //
  // 内部流程
  // ------------------------------------------------------------------ //

  _messages(session) {
    return [{ role: "system", content: buildSystemContent(session) }, ...this._trim(session.history)];
  }

  /** 裁剪历史，且必须落在 user 消息上，避免破坏 tool_calls 配对 */
  _trim(history) {
    if (history.length <= this.maxHistory) return [...history];
    const trimmed = history.slice(-this.maxHistory);
    const index = trimmed.findIndex((message) => message.role === "user");
    return index >= 0 ? trimmed.slice(index) : history.slice(-1);
  }

  async *_loop(session) {
    for (;;) {
      let final = null;
      let streamed = "";
      try {
        for await (const chunk of this.llm.chat(this._messages(session), { tools: TOOL_SCHEMAS })) {
          if (chunk.type === "text") {
            streamed += chunk.text;
            yield { type: "delta", text: chunk.text };
          } else if (chunk.type === "final") {
            final = chunk;
          }
        }
      } catch (error) {
        yield { type: "error", message: `调用模型失败：${error.message}` };
        return;
      }

      if (!final) {
        yield { type: "error", message: "模型没有返回任何内容" };
        return;
      }

      // 兼容不逐步吐字的模型：把还没展示过的正文补成 delta，避免界面空白
      const content = final.content || "";
      if (content && content !== streamed && content.startsWith(streamed)) {
        yield { type: "delta", text: content.slice(streamed.length) };
      }

      const calls = (final.toolCalls || []).map((call) => ({
        id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: call.name,
        arguments: call.arguments || "{}",
      }));

      const assistantMessage = { role: "assistant", content: final.content || null };
      if (calls.length) {
        assistantMessage.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      session.history.push(assistantMessage);

      if (!calls.length) {
        yield { type: "done" };
        return;
      }

      yield* this._runCalls(session, calls, []);
      if (session.pause) return;
    }
  }

  async *_runCalls(session, calls, results) {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      let args = {};
      try {
        const parsed = JSON.parse(call.arguments || "{}");
        if (parsed && typeof parsed === "object") args = parsed;
      } catch {
        args = {};
      }

      yield { type: "tool_start", name: call.name, args };

      if (SENSITIVE_TOOLS.has(call.name)) {
        let payload;
        try {
          payload = await this.tools.prepareConfirmation(session, call.name, args);
        } catch (error) {
          results.push(toolMessage(call.id, `准备失败：${error.message}`));
          yield {
            type: "tool_end",
            name: call.name,
            ok: false,
            summary: short(error.message),
            display: short(error.message, 80),
          };
          continue;
        }

        // 注意：这里不写历史，等确认后由 resume() 统一写入，避免重复
        session.pause = {
          call,
          args,
          payload,
          results,
          rest: calls.slice(index + 1),
        };
        yield { type: "confirm", payload };
        return;
      }

      let result;
      try {
        result = await this.tools.execute(session, call.name, args);
      } catch (error) {
        result = { ok: false, summary: `工具执行失败：${error.message}`, cards: [], display: "" };
      }

      results.push(toolMessage(call.id, result.summary));
      yield {
        type: "tool_end",
        name: call.name,
        ok: result.ok,
        summary: short(result.summary),
        display: result.display || short(result.summary, 80),
      };
      for (const card of result.cards || []) yield { type: "cards", items: [card] };
    }

    session.history.push(...results);
  }
}

/** 便捷工厂 */
export const createAgent = async ({ llm, backend }) => new CoffeeAgent({ llm, backend });
