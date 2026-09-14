/**
 * 公用心核 · 内置演示模型（不需要任何 API Key / 网络）
 *
 * 它实现了和真实 LLM 完全一样的接口（chat() 异步生成器），
 * 只是「决策」换成了一套固定规则，用来在静态站点上零配置演示整个点单流程。
 *
 * 用途：GitHub Pages 上没有 Key 的访客也能完整体验 Agent 的事件流、卡片与确认门。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseTool = (content) => {
  try {
    const value = JSON.parse(content ?? "null");
    return value;
  } catch {
    return content;
  }
};

const collect = (messages) => {
  const calledTools = [];
  const toolResults = [];
  let lastUser = "";
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls || []) calledTools.push(call.function?.name || "");
    } else if (message.role === "tool") {
      toolResults.push(parseTool(message.content));
    } else if (message.role === "user") {
      lastUser = String(message.content || "");
    }
  }
  // 历史最后一条还是 user 消息，说明刚进入新一轮（工具结果还没回填）
  const startOfTurn = messages[messages.length - 1]?.role === "user";
  return { calledTools, toolResults, lastUser, startOfTurn };
};

const findPayload = (payloads, key) => {
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const payload = payloads[i];
    if (payload && typeof payload === "object" && key in payload) return payload;
  }
  return null;
};

/** 去掉「就用「xxx」（deptId=1）」这类按钮产生的噪音，得到干净的商品关键词 */
const toQuery = (text) =>
  String(text || "")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/(就用|就要|帮我|来一杯|来两杯|我想要|给我|下单|这家店|这个|的话)/g, " ")
    .replace(/[，,。！!？?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** 规则决策：返回 { speech, tool } */
const decide = (messages) => {
  const { calledTools, toolResults, lastUser, startOfTurn } = collect(messages);
  const last = toolResults[toolResults.length - 1];
  const previous = calledTools[calledTools.length - 1];

  // ---- A. 新一轮开始：先看用户这句话想要什么 ----
  if (startOfTurn) {
    const coords = lastUser.match(/(-?\d{1,3}\.\d{3,})[^\d-]+(-?\d{1,3}\.\d{3,})/);
    if (coords) {
      return {
        speech: `收到定位 ${coords[1]}, ${coords[2]}，我看看附近的门店～`,
        tool: { name: "set_location", args: { latitude: Number(coords[1]), longitude: Number(coords[2]) } },
      };
    }

    const dept = lastUser.match(/deptId=(\d+)/);
    const product = lastUser.match(/productId=(\d+)/);
    const sku = lastUser.match(/skuCode=([\w-]+)/);

    if (dept && product && sku) {
      return {
        speech: "好的，我先帮你试算一下这杯的价格。",
        tool: {
          name: "preview_order",
          args: {
            dept_id: Number(dept[1]),
            items: [{ product_id: Number(product[1]), sku_code: sku[1], amount: 1 }],
          },
        },
      };
    }
    if (dept) {
      return {
        speech: "好的，就在这家店帮你找。",
        tool: { name: "search_products", args: { dept_id: Number(dept[1]), query: toQuery(lastUser) || "推荐饮品" } },
      };
    }
    if (/订单|取餐码|好了没|做好/.test(lastUser)) {
      const created = findPayload(toolResults, "orderId");
      if (created?.orderId) {
        return { speech: "我看一下订单状态～", tool: { name: "get_order", args: { order_id: String(created.orderId) } } };
      }
      return { speech: "还没有查到你的订单记录。先点一杯？我可以帮你找门店。" };
    }
    return {
      speech: "好嘞，我先看看附近有哪些门店～",
      tool: { name: "find_stores", args: {} },
    };
  }

  // ---- B. 工具刚跑完：先处理结束态 ----
  if (typeof last === "string" && last.includes("尚未设置定位")) {
    return {
      speech:
        "先告诉我你在哪儿吧～ 可以点右上角「📍 定位」，或直接把坐标发我（例如 `39.9042, 116.4074`）。",
    };
  }

  if (last && typeof last === "object" && last.ok === true && last.orderId) {
    return {
      speech:
        `已经下单成功，订单号 **${last.orderId}**，实付 ${last.payAmount ?? "-"}。\n\n` +
        (last.needPay
          ? "请打开支付链接完成付款（真实环境这里会是可扫码的二维码）。支付后跟我说「取餐码」，我帮你查。"
          : "（当前是演示模式，不会真的扣款）"),
    };
  }

  if (typeof last === "string" && last.includes("取消")) {
    return { speech: "好的，那就不下单了～ 想喝的时候随时叫我。" };
  }

  if (last && typeof last === "object" && "pickupCode" in last) {
    return {
      speech:
        `订单当前状态：**${last.status}**` +
        (last.pickupCode ? `，取餐码 **${last.pickupCode}**` : "（还没出取餐码）") +
        `。`,
    };
  }

  // ---- C. 继续推进链条 ----
  if (previous === "set_location") {
    return { speech: "定位收到，我看看附近的门店～", tool: { name: "find_stores", args: {} } };
  }

  if (previous === "find_stores") {
    const stores = findPayload(toolResults, "stores");
    const deptMatch = lastUser.match(/deptId=(\d+)/);
    const deptId = deptMatch ? Number(deptMatch[1]) : stores?.stores?.[0]?.deptId;
    if (!deptId) return { speech: "附近没有找到营业中的门店，换个位置试试？" };
    return {
      speech: "选好门店了，看看想喝什么～",
      tool: { name: "search_products", args: { dept_id: deptId, query: toQuery(lastUser) || "生椰拿铁" } },
    };
  }

  if (previous === "search_products") {
    const result = findPayload(toolResults, "products");
    const first = result?.products?.[0];
    if (!first) return { speech: "这家店没搜到合适的饮品，换个关键词试试？" };
    return {
      speech: "找到了，我先帮你试算价格。",
      tool: {
        name: "preview_order",
        args: {
          dept_id: result.deptId,
          items: [{ product_id: first.productId, sku_code: first.skuCode, amount: 1 }],
        },
      },
    };
  }

  if (previous === "preview_order") {
    const preview = findPayload(toolResults, "payAmount");
    const result = findPayload(toolResults, "products");
    const first = result?.products?.[0];
    if (!preview || !first) return { speech: "试算失败了，要不算了？" };
    return {
      speech: `试算好了：**${first.productName}**，实付 **¥${Number(preview.payAmount).toFixed(2)}**，预计 ${preview.pickup} 取餐。确认的话我就下单。`,
      tool: {
        name: "create_order",
        args: {
          dept_id: preview.deptId,
          items: [{ product_id: first.productId, sku_code: first.skuCode, amount: 1 }],
        },
      },
    };
  }

  return { speech: "好，还想再来点什么？" };
};

/**
 * 与真实 LLM 客户端同构的演示模型。
 * @param {{delay?: number}} [options]
 */
export const createDemoLlm = ({ delay = 260 } = {}) => ({
  model: "内置演示模型",
  demo: true,

  async *chat(messages) {
    await sleep(delay);
    const { speech = "", tool } = decide(messages);

    // 逐字吐出来，让流式效果与真实模型一致
    for (let i = 0; i < speech.length; i += 6) {
      await sleep(8);
      yield { type: "text", text: speech.slice(i, i + 6) };
    }

    if (tool) {
      yield {
        type: "final",
        content: speech,
        toolCalls: [
          {
            id: `demo_${tool.name}_${Date.now().toString(36)}`,
            name: tool.name,
            arguments: JSON.stringify(tool.args),
          },
        ],
      };
      return;
    }

    yield { type: "final", content: speech, toolCalls: [] };
  },
});
