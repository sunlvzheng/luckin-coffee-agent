/**
 * 公用心核的离线自测（Node 原生，无第三方依赖）。
 *
 * 用一个「假的模型客户端」+「演示后端」把 Agent 循环完整跑一遍：
 * 流式输出、工具参数拼装、下单确认门、确认/取消两条恢复分支、历史配对完整性。
 *
 *   node scripts/core_test.mjs
 */

import { CoffeeAgent } from "../docs/core/agent.js";
import { createMockBackend } from "../docs/core/backends/mock.js";
import { createSession } from "../docs/core/session.js";

const failures = [];

const check = (condition, label) => {
  console.log(`${condition ? "  ✅" : "  ❌"} ${label}`);
  if (!condition) failures.push(label);
};

/** 按固定剧本走的假模型：和 scripts 里那份心核接口完全一致 */
const createScriptedLlm = () => ({
  model: "scripted",
  async *chat(messages) {
    const called = [];
    const results = [];
    for (const message of messages) {
      if (message.role === "assistant") for (const call of message.tool_calls || []) called.push(call.function.name);
      if (message.role === "tool") {
        try { results.push(JSON.parse(message.content)); } catch { results.push(message.content); }
      }
    }
    const last = results[results.length - 1];
    const previous = called[called.length - 1];
    const find = (key) => [...results].reverse().find((r) => r && typeof r === "object" && key in r);

    const finish = (content) => ({ type: "final", content, toolCalls: [] });
    const tool = (name, args, speech = "") => ({
      type: "final",
      content: speech,
      toolCalls: [{ id: `c_${name}_${Date.now().toString(36)}`, name, arguments: JSON.stringify(args) }],
    });

    if (last && typeof last === "object" && last.ok === true && last.orderId) {
      yield finish("下单成功，请扫码支付。");
      return;
    }
    if (typeof last === "string" && last.includes("取消")) {
      yield finish("好的，已取消。");
      return;
    }
    if (!called.length) { yield tool("find_stores", {}, "好嘞，我先看看附近有哪些门店～"); return; }

    if (previous === "find_stores") {
      const stores = find("stores");
      yield tool("search_products", { dept_id: stores.stores[0].deptId, query: "生椰拿铁 冰 少少甜 大杯" }, "选好门店了，看看想喝什么～");
      return;
    }
    if (previous === "search_products") {
      const products = find("products");
      yield tool("preview_order", {
        dept_id: products.deptId,
        items: [{ product_id: products.products[0].productId, sku_code: products.products[0].skuCode, amount: 1 }],
      });
      return;
    }
    if (previous === "preview_order") {
      const products = find("products");
      const preview = find("payAmount");
      yield tool("create_order", {
        dept_id: preview.deptId,
        items: [{ product_id: products.products[0].productId, sku_code: products.products[0].skuCode, amount: 1 }],
      }, `试算好了，实付 ¥${Number(preview.payAmount).toFixed(2)}，确认的话我就下单。`);
      return;
    }
    yield finish("好，还想再来点什么？");
  },
});

const collect = async (iterator) => {
  const events = [];
  for await (const event of iterator) events.push(event);
  return events;
};

const types = (events, kind) => events.filter((event) => event.type === kind);

/** 历史里每个 tool_call 都要有且只有一个 tool 结果 */
const checkHistory = (session, label) => {
  const callIds = [];
  for (const message of session.history) {
    if (message.role === "assistant") for (const call of message.tool_calls || []) callIds.push(call.id);
  }
  const toolIds = session.history.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  check(toolIds.length === new Set(toolIds).size, `${label}：tool 结果没有重复`);
  check(toolIds.every((id) => callIds.includes(id)), `${label}：每个 tool 结果都有对应 tool_call`);
};

const scenario = async (approved, label) => {
  console.log(`\n=== 场景：${label} ===`);
  const backend = createMockBackend();
  let createCalls = 0;
  const createOrder = backend.createOrder.bind(backend);
  backend.createOrder = async (payload) => { createCalls += 1; return createOrder(payload); };

  const agent = new CoffeeAgent({ llm: createScriptedLlm(), backend });
  const session = createSession({ lat: 39.9042, lng: 116.4074 });

  const events = await collect(agent.stream(session, "来一杯冰生椰拿铁，少少甜"));
  const tools = types(events, "tool_start").map((event) => event.name);
  check(JSON.stringify(tools) === JSON.stringify(["find_stores", "search_products", "preview_order", "create_order"]),
    `工具调用顺序：${tools.join(" → ")}`);
  check(types(events, "delta").length > 0, "有流式文本输出");
  check(session.lastPreview?.items?.[0]?.sku_code?.startsWith("SP2077-"), `skuCode 原样透传：${session.lastPreview?.items?.[0]?.sku_code}`);
  check(types(events, "cards").length >= 3, "渲染了门店 / 商品 / 试算三类卡片");
  const confirms = types(events, "confirm");
  check(confirms.length === 1, "产生了 1 张下单确认卡");
  check(confirms[0]?.payload?.payAmount > 0, `确认卡带金额：${confirms[0]?.payload?.payAmount}`);
  check(Boolean(session.pause), "会话进入等待确认状态");
  check(createCalls === 0, "确认前没有真正下单");

  const resumed = await collect(agent.resume(session, approved));
  if (approved) {
    const payment = types(resumed, "cards").flatMap((event) => event.items).find((card) => card.type === "payment");
    check(Boolean(payment), "生成了支付卡片");
    check(payment?.orderId?.length > 0, `订单号：${payment?.orderId}`);
    check(createCalls === 1, "确认后只下单一次");
  } else {
    check(createCalls === 0, "取消后没有下单");
    check(types(resumed, "delta").length > 0, "取消后模型给出了收尾回复");
  }

  checkHistory(session, label);
};

/** 定位缺失时的引导分支 */
const locationScenario = async () => {
  console.log("\n=== 场景：未设置定位 ===");
  const agent = new CoffeeAgent({ llm: createScriptedLlm(), backend: createMockBackend() });
  const session = createSession();
  const events = await collect(agent.stream(session, "来一杯拿铁"));
  const toolEnd = types(events, "tool_end")[0];
  check(toolEnd?.ok === false && String(toolEnd.summary).includes("定位"), "缺定位时给出明确提示而不是崩溃");
};

const main = async () => {
  await scenario(true, "确认下单");
  await scenario(false, "用户取消");
  await locationScenario();

  console.log("\n" + "=".repeat(60));
  if (failures.length) {
    console.log(`❌ 失败 ${failures.length} 项：`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exit(1);
  }
  console.log("✅ 全部通过（使用演示后端，未调用真实接口、未产生订单）");
};

main().catch((error) => {
  console.error(`自测异常：${error.stack || error.message}`);
  process.exit(1);
});
