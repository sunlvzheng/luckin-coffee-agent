/**
 * 静态站点 UI：只负责「渲染 + 交互」，
 * 所有业务逻辑都来自 ./core（同一份心核也跑在本地服务和 Node 终端里）。
 */

import {
  BACKEND_MODES,
  CoffeeAgent,
  TOOL_LABELS,
  createBackend,
  createLlmClient,
  findProvider,
  fromJSON,
  groupedProviders,
  providerHint,
  resetSession,
  toJSON,
} from "./core/index.js";
import { createDemoLlm } from "./core/llm-demo.js";

const CONFIG_KEY = "luckin.config.v1";
const SESSION_KEY = "luckin.session.v1";

const LLM_MODES = [
  { id: "demo", label: "内置演示模型（无需 Key）" },
  { id: "direct", label: "直连模型（填自己的 Key）" },
  { id: "proxy", label: "经后端代理（Key 留在服务端）" },
];

const DEFAULT_CONFIG = {
  backendMode: "mock",
  baseUrl: "",
  password: "",
  llmMode: "demo",
  providerId: "deepseek",
  llmBaseUrl: "https://api.deepseek.com",
  llmModel: "deepseek-chat",
  llmKey: "",
};

const loadJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
};

const saveJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下可能失败，忽略 */
  }
};

const state = {
  config: loadJson(CONFIG_KEY, DEFAULT_CONFIG),
  session: fromJSON(loadJson(SESSION_KEY, {})),
  agent: null,
  backend: null,
  turn: null,
  toolRows: [],
  streaming: false,
  pendingConfirm: false,
};

const $ = (id) => document.getElementById(id);
const chatEl = $("chat");

// --------------------------------------------------------------------------- //
// Markdown 极简渲染
// --------------------------------------------------------------------------- //
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const inline = (text) =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

const isTableStart = (lines, index) =>
  /\|/.test(lines[index]) && index + 1 < lines.length && /\|/.test(lines[index + 1]) &&
  /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1]);

function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r/g, "").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const buffer = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buffer.push(lines[i]); i += 1; }
      i += 1;
      html.push(`<pre><code>${escapeHtml(buffer.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) { body.push(splitRow(lines[i])); i += 1; }
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        `${body.map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) { html.push(`<h4>${inline(heading[1])}</h4>`); i += 1; continue; }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`);
        i += 1;
      }
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    if (!line.trim()) { i += 1; continue; }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```)/.test(lines[i]) && !isTableStart(lines, i)) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (!paragraph.length) { paragraph.push(line); i += 1; }
    html.push(`<p>${inline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return html.join("");
}

// --------------------------------------------------------------------------- //
// DOM 工具
// --------------------------------------------------------------------------- //
const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
};

const scrollToBottom = () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });

const hideEmpty = () => $("empty")?.remove();

function ensureTurn() {
  if (state.turn) return state.turn;
  const message = el("div", "msg assistant");
  message.appendChild(el("div", "avatar", "☕"));
  const content = el("div", "content");
  message.appendChild(content);
  const bubble = el("div", "bubble");
  bubble.style.display = "none";
  content.appendChild(bubble);
  const extras = el("div", "content");
  content.appendChild(extras);
  chatEl.appendChild(message);
  state.turn = { bubble, extras, text: "" };
  return state.turn;
}

// --------------------------------------------------------------------------- //
// 渲染
// --------------------------------------------------------------------------- //
function addUser(text) {
  hideEmpty();
  state.turn = null;
  const message = el("div", "msg user");
  message.appendChild(el("div", "avatar", "🙋"));
  const content = el("div", "content");
  const bubble = el("div", "bubble", renderMarkdown(text));
  content.appendChild(bubble);
  message.appendChild(content);
  chatEl.appendChild(message);
  scrollToBottom();
}

function addDelta(text) {
  hideEmpty();
  const turn = ensureTurn();
  turn.text += text;
  turn.bubble.style.display = "";
  turn.bubble.innerHTML = renderMarkdown(turn.text);
  scrollToBottom();
}

function addError(message) {
  hideEmpty();
  const turn = ensureTurn();
  turn.extras.appendChild(el("div", "err", escapeHtml(message)));
  scrollToBottom();
}

function addToolRow(event) {
  hideEmpty();
  const turn = ensureTurn();
  const label = TOOL_LABELS[event.name] || event.name;
  const row = el("div", "tool", `<span class="dot"></span><span class="desc">${escapeHtml(label)}…</span>`);
  const args = event.args && Object.keys(event.args).length ? ` ${JSON.stringify(event.args)}` : "";
  row.title = (label + args).slice(0, 300);
  turn.extras.appendChild(row);
  state.toolRows.push({ name: event.name, row });
  scrollToBottom();
}

function finishToolRow(event) {
  const index = state.toolRows.findIndex((item) => item.name === event.name);
  const entry = index >= 0 ? state.toolRows.splice(index, 1)[0] : null;
  const label = TOOL_LABELS[event.name] || event.name;
  const description = event.ok
    ? (event.display || event.summary || "完成")
    : `失败：${event.display || event.summary || ""}`;
  const markup = `<span class="dot"></span><span class="desc">${escapeHtml(`${label} · ${String(description).slice(0, 120)}`)}</span>`;

  if (entry) {
    entry.row.className = `tool done${event.ok ? "" : " fail"}`;
    entry.row.innerHTML = markup;
    entry.row.title = `${label} · ${description}`;
  } else {
    ensureTurn().extras.appendChild(el("div", `tool done${event.ok ? "" : " fail"}`, markup));
  }

  if (event.name === "create_order" || event.name === "cancel_order") {
    state.pendingConfirm = false; // 确认已被处理
  }
  scrollToBottom();
}

const rowsHtml = (rows) =>
  `<div class="rows">${(rows || [])
    .map((row) => `<div class="k">${escapeHtml(row.k)}</div><div class="v${row.strong ? " strong" : ""}">${escapeHtml(row.v)}</div>`)
    .join("")}</div>`;

const goodsHtml = (items) =>
  !items?.length
    ? ""
    : `<ul class="goods">${items
        .map((item) => `<li><span>${escapeHtml(item.amount ? `${item.amount}×` : "")}${escapeHtml(item.name)}</span>` +
          `<span class="spec">${escapeHtml(item.spec || "")}</span></li>`)
        .join("")}</ul>`;

function appendCard(card) {
  hideEmpty();
  const box = el("div", "card");

  if (card.type === "stores") {
    const list = el("div", "store-list");
    for (const store of card.items || []) {
      const row = el("div", "store");
      row.appendChild(el("div", "store-main",
        `<div class="store-name">${escapeHtml(store.name)}` +
        `${store.status ? `<span class="tag">${escapeHtml(store.status)}</span>` : ""}</div>` +
        `<div class="store-sub">${escapeHtml(store.address || "")}</div>` +
        `<div class="store-sub">${escapeHtml(store.distance || "")} · ${escapeHtml(store.hours || "")} · #${escapeHtml(store.deptId)}</div>`));
      const button = el("button", "mini", "选这家");
      button.onclick = () => send(`就用「${store.name}」（deptId=${store.deptId}）这家店`);
      row.appendChild(button);
      list.appendChild(row);
    }
    box.appendChild(list);
  } else if (card.type === "products") {
    box.appendChild(el("h5", null, "搜索结果"));
    const grid = el("div", "prod-grid");
    for (const product of card.items || []) {
      const item = el("div", "prod");
      if (product.picture) {
        const image = el("img");
        image.src = product.picture;
        image.loading = "lazy";
        image.alt = product.name;
        item.appendChild(image);
      }
      item.appendChild(el("div", "name", escapeHtml(product.name)));
      item.appendChild(el("div", "spec", escapeHtml(product.spec || "")));
      item.appendChild(el("div", "price", escapeHtml(product.price || "")));
      const button = el("button", "mini", "要这个");
      button.onclick = () => send(
        `就要「${product.name}」（productId=${product.productId}，skuCode=${product.skuCode}，deptId=${card.items.deptId ?? ""}），帮我试算订单`,
      );
      item.appendChild(button);
      grid.appendChild(item);
    }
    box.appendChild(grid);
  } else if (card.type === "summary") {
    box.appendChild(el("h5", null, escapeHtml(card.title || "订单")));
    box.appendChild(el("div", null, rowsHtml(card.rows)));
    box.appendChild(el("div", null, goodsHtml(card.items)));
  } else if (card.type === "payment") {
    box.appendChild(el("h5", null, card.needPay ? "扫码支付" : "订单已提交"));
    box.appendChild(el("div", null, rowsHtml(card.rows)));

    if (card.needPay) {
      let source = card.qrSvg || "";
      if (!source && card.payQrUrl && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(card.payQrUrl)) source = card.payQrUrl;
      if (source) {
        const image = el("img", "qr");
        image.src = source;
        image.alt = "支付二维码";
        box.appendChild(image);
      } else {
        box.appendChild(el("div", "note", "未能生成二维码，请点下面的按钮打开支付链接。"));
      }
    } else {
      box.appendChild(el("div", "notice", "无需支付，等待取餐即可。"));
    }
    if (card.demo) box.appendChild(el("div", "note", "演示模式：这是模拟订单，链接不可支付。"));

    const actions = el("div", "actions");
    if (card.payUrl) {
      const open = el("button", "mini", "打开支付链接");
      open.onclick = () => window.open(card.payUrl, "_blank", "noopener");
      actions.appendChild(open);
      const copy = el("button", "mini", "复制链接");
      copy.onclick = () => navigator.clipboard?.writeText(card.payUrl);
      actions.appendChild(copy);
    }
    if (card.orderId) {
      const query = el("button", "mini", "刷新订单状态");
      query.onclick = () => send("查一下这个订单的状态");
      actions.appendChild(query);
    }
    box.appendChild(actions);
  } else if (card.type === "notice") {
    box.appendChild(el("div", "notice", escapeHtml(card.text || "")));
  }

  ensureTurn().extras.appendChild(box);
  scrollToBottom();
}

function appendConfirm(payload) {
  hideEmpty();
  const turn = ensureTurn();
  const box = el("div", "card");
  box.style.borderColor = "#f0d9b5";
  box.style.background = "#fffdf8";
  box.appendChild(el("h5", null, escapeHtml(payload.title || "请确认")));
  box.appendChild(el("div", null, rowsHtml(payload.rows)));
  box.appendChild(el("div", null, goodsHtml(payload.items)));
  if (payload.note) box.appendChild(el("div", "note", escapeHtml(payload.note)));

  const actions = el("div", "actions");
  const yes = el("button", "primary grow", "确认");
  const no = el("button", "grow", "取消");
  yes.onclick = () => { yes.disabled = true; no.disabled = true; resolveConfirm(true, box); };
  no.onclick = () => { yes.disabled = true; no.disabled = true; resolveConfirm(false, box); };
  actions.appendChild(yes);
  actions.appendChild(no);
  box.appendChild(actions);

  turn.extras.appendChild(box);
  state.turn = null; // 确认之后的输出另起一条消息
  scrollToBottom();
}

async function resolveConfirm(approved, box) {
  box.querySelector(".actions").replaceChildren(el("div", "status", approved ? "已确认，正在提交…" : "已取消"));
  state.pendingConfirm = false;
  syncBusy();
  await runStream(state.agent.resume(state.session, approved));
  scrollToBottom();
}

// --------------------------------------------------------------------------- //
// 事件分发（core 与 UI 之间唯一的契约）
// --------------------------------------------------------------------------- //
function renderEvent(event, replay = false) {
  switch (event.type) {
    case "user":
      if (replay) addUser(event.text);
      break;
    case "delta": addDelta(event.text); break;
    case "status": ensureTurn().extras.appendChild(el("div", "status", `· ${escapeHtml(event.text)}`)); break;
    case "tool_start": addToolRow(event); break;
    case "tool_end": finishToolRow(event); break;
    case "cards": (event.items || []).forEach(appendCard); break;
    case "confirm": appendConfirm(event.payload); state.pendingConfirm = true; syncBusy(); break;
    case "done": state.turn = null; break;
    case "error": addError(event.message || "未知错误"); state.turn = null; break;
    default: break;
  }
}

function syncBusy() {
  const busy = state.streaming || state.pendingConfirm;
  $("send").disabled = busy;
  $("input").disabled = busy;
}

async function runStream(iterator) {
  state.streaming = true;
  syncBusy();
  try {
    for await (const event of iterator) {
      state.session.uiLog.push(event);
      renderEvent(event);
    }
  } catch (error) {
    const message = error?.message || String(error);
    state.session.uiLog.push({ type: "error", message });
    renderEvent({ type: "error", message });
  } finally {
    state.streaming = false;
    syncBusy();
    persist();
    updateMeta();
  }
}

async function send(text) {
  const value = String(text || "").trim();
  if (!value || state.streaming || state.pendingConfirm) return;
  if (!state.agent) { addError("还没有连上数据源，请先在「设置」里选好。"); return; }

  addUser(value);
  state.session.uiLog.push({ type: "user", text: value });
  $("input").value = "";
  autoGrow();
  await runStream(state.agent.stream(state.session, value));
}

// --------------------------------------------------------------------------- //
// 配置 / 连接
// --------------------------------------------------------------------------- //
const normalizeBase = (url) => String(url || "").trim().replace(/\/+$/, "");

function readForm() {
  state.config = {
    backendMode: $("cfgBackend").value,
    baseUrl: $("cfgBaseUrl").value.trim(),
    password: $("cfgPassword").value.trim(),
    llmMode: $("cfgLlmMode").value,
    providerId: $("cfgProvider").value,
    llmBaseUrl: $("cfgLlmBaseUrl").value.trim(),
    llmModel: $("cfgLlmModel").value.trim(),
    llmKey: $("cfgLlmKey").value.trim(),
  };
  return state.config;
}

/** 切换服务商：自动填地址、刷新模型候选与提示 */
function applyProvider(providerId, { keepModel = false } = {}) {
  const provider = findProvider(providerId);
  state.config.providerId = provider.id;
  $("cfgProvider").value = provider.id;
  $("cfgLlmBaseUrl").value = provider.baseUrl || "";
  if (!keepModel || !$("cfgLlmModel").value) $("cfgLlmModel").value = provider.defaultModel || "";
  renderModelOptions(provider, $("cfgLlmModel").value);

  const note = $("cfgProviderNote");
  note.textContent = providerHint(provider);
  note.className = `tip provider-note ${provider.browser === true ? "good" : provider.browser === false ? "bad" : "warn"}`;

  const link = $("cfgKeyUrl");
  if (provider.keyUrl) {
    link.href = provider.keyUrl;
    link.classList.remove("hide");
  } else {
    link.classList.add("hide");
  }
}

function renderModelOptions(provider, current) {
  const options = [...(provider?.models || [])];
  if (current && !options.includes(current)) options.push(current);
  $("modelOptions").innerHTML = options.map((model) => `<option value="${model}"></option>`).join("");
}

function fillForm() {
  $("cfgBackend").innerHTML = BACKEND_MODES.map((mode) => `<option value="${mode.id}">${mode.label}</option>`).join("");
  $("cfgLlmMode").innerHTML = LLM_MODES.map((mode) => `<option value="${mode.id}">${mode.label}</option>`).join("");
  $("cfgProvider").innerHTML = groupedProviders()
    .map((group) => `<optgroup label="${group.label}">` +
      group.items.map((item) => `<option value="${item.id}">${item.label}</option>`).join("") +
      `</optgroup>`)
    .join("");

  const config = state.config;
  $("cfgBackend").value = config.backendMode;
  $("cfgBaseUrl").value = config.baseUrl;
  $("cfgPassword").value = config.password;
  $("cfgLlmMode").value = config.llmMode;
  $("cfgLlmKey").value = config.llmKey;

  // 先按服务商预设铺好地址与模型候选，再用用户存过的值覆盖
  applyProvider(config.providerId || "deepseek", { keepModel: true });
  if (config.llmBaseUrl) $("cfgLlmBaseUrl").value = config.llmBaseUrl;
  if (config.llmModel) $("cfgLlmModel").value = config.llmModel;
  renderModelOptions(findProvider($("cfgProvider").value), $("cfgLlmModel").value);

  $("btnForgetKey").disabled = !config.llmKey;
  updateTip();
}

function createLlm() {
  const config = state.config;
  if (config.llmMode === "demo") return createDemoLlm();
  if (config.llmMode === "proxy") {
    const base = normalizeBase(config.baseUrl);
    return createLlmClient({
      mode: "proxy",
      proxyPath: base ? `${base}/api/llm` : "/api/llm",
      model: config.llmModel,
      extraHeaders: config.password ? { "X-Password": config.password } : {},
    });
  }
  return createLlmClient({
    mode: "direct",
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmKey,
    model: config.llmModel,
  });
}

async function rebuild() {
  const config = readForm();
  saveJson(CONFIG_KEY, config);
  $("cfgStatus").textContent = "连接中…";

  try {
    state.backend = await createBackend(config.backendMode, {
      baseUrl: normalizeBase(config.baseUrl),
      password: config.password,
    });
  } catch (error) {
    $("cfgStatus").textContent = `❌ ${error.message}`;
    return;
  }

  state.agent = new CoffeeAgent({ llm: createLlm(), backend: state.backend });
  const ping = await state.backend.ping().catch((error) => ({ ok: false, detail: error.message }));
  $("cfgStatus").textContent = ping.ok ? `✅ ${state.backend.label}${ping.detail ? `（${ping.detail}）` : ""}` : `❌ ${ping.detail}`;
  updateMeta();
  updateTip();
}

function updateMeta() {
  const chips = [];
  const backend = state.backend;
  chips.push(backend
    ? `<span class="chip ${backend.realOrder ? "ok" : ""}">${escapeHtml(backend.label)}</span>`
    : '<span class="chip err">未连接</span>');
  chips.push(`<span class="chip">${escapeHtml(
    state.config.llmMode === "demo"
      ? "内置演示模型"
      : `${findProvider(state.config.providerId || "deepseek").label} · ${state.config.llmModel || "未选模型"}`,
  )}</span>`);
  chips.push(state.session.lat != null
    ? `<span class="chip">📍 ${Number(state.session.lat).toFixed(4)}, ${Number(state.session.lng).toFixed(4)}</span>`
    : '<span class="chip warn">📍 未设置定位</span>');
  $("meta").innerHTML = chips.join("");

  const banner = $("banner");
  if (backend && !backend.realOrder) {
    banner.textContent = `演示模式：使用内置样例数据，不会调用真实接口、不会下单扣款。要真实点单请在「设置」里切换到「连接服务」。`;
    banner.classList.remove("hide");
  } else {
    banner.classList.add("hide");
  }
}

function updateTip() {
  const config = state.config;
  const tips = [];
  tips.push(config.backendMode === "mock"
    ? "数据来源：内置样例数据，用来体验完整流程，不会真实下单。"
    : "数据来源：你自部署的后端（本项目里的 coffee_agent 服务）。浏览器直连瑞幸接口会被 CORS 拦截，所以真实下单必须经过后端。");
  if (config.llmMode === "demo") {
    tips.push("模型来源：内置演示模型，按固定规则驱动工具，不调用任何大模型接口。");
  } else if (config.llmMode === "direct") {
    tips.push("模型来源：浏览器直连服务商，Key 只写在本机 localStorage，请求不经本站服务器。");
  } else {
    tips.push("模型来源：经后端代理，Key 存在服务端 .env 里，浏览器拿不到。");
    if (!config.baseUrl) {
      tips.push("⚠️ 代理模式需要先在上面「后端地址」里填好服务地址，否则会去请求本站的 /api/llm（静态站点上并不存在）。");
    }
  }
  $("cfgTip").textContent = tips.join(" ");
}

/** 测试连接：演示模型直接过；代理模式 ping 后端；直连模式真发一个最小请求验证 Key */
async function testConnection() {
  const config = readForm();
  saveJson(CONFIG_KEY, config);
  updateTip();
  updateMeta();

  if (config.llmMode === "demo") {
    $("cfgStatus").textContent = "✅ 内置演示模型无需测试";
    return;
  }

  if (config.llmMode === "proxy") {
    if (!state.backend) { await rebuild(); return; }
    $("cfgStatus").textContent = "测试中…";
    const ping = await state.backend.ping().catch((error) => ({ ok: false, detail: error.message }));
    $("cfgStatus").textContent = ping.ok ? `✅ 后端正常（${ping.detail || "OK"}）` : `❌ ${ping.detail}`;
    return;
  }

  if (!config.llmBaseUrl || !config.llmModel) {
    $("cfgStatus").textContent = "❌ 请先填好接口地址与模型名";
    return;
  }
  if (!config.llmKey) {
    $("cfgStatus").textContent = "❌ 请先填入临时 API Key";
    return;
  }

  $("cfgStatus").textContent = "正在用你的 Key 直连测试…";
  try {
    const llm = createLlmClient({
      mode: "direct",
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmKey,
      model: config.llmModel,
    });
    let text = "";
    for await (const chunk of llm.chat([{ role: "user", content: "只回复两个字：收到" }], {})) {
      if (chunk.type === "text") text += chunk.text;
    }
    $("cfgStatus").textContent = `✅ 连通成功：${(text || "（无文本返回）").slice(0, 24)}`;
  } catch (error) {
    $("cfgStatus").textContent = `❌ ${error.message}`;
  }
}

// --------------------------------------------------------------------------- //
// 持久化
// --------------------------------------------------------------------------- //
function persist() {
  saveJson(SESSION_KEY, toJSON(state.session));
}

function restoreUi() {
  hideEmpty();
  for (const event of state.session.uiLog || []) renderEvent(event, true);
  if (state.session.pause) state.pendingConfirm = true;
  if (!(state.session.uiLog || []).length) {
    chatEl.innerHTML =
      '<div class="center" id="empty">说一句“来一杯冰生椰拿铁，少少甜”试试。<br />' +
      "我会先帮你找门店、挑商品、试算价格，确认后才真正下单。</div>";
  }
  syncBusy();
}

// --------------------------------------------------------------------------- //
// 交互绑定
// --------------------------------------------------------------------------- //
const inputEl = $("input");
const autoGrow = () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
};

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (inputEl.value.trim()) send(inputEl.value);
});

inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (inputEl.value.trim()) send(inputEl.value);
  }
});

$("btnSettings").addEventListener("click", () => $("settings").classList.toggle("open"));
$("btnApply").addEventListener("click", () => rebuild());
$("btnPing").addEventListener("click", () => testConnection());

$("btnToggleKey").addEventListener("click", () => {
  const input = $("cfgLlmKey");
  const hidden = input.type === "password";
  input.type = hidden ? "text" : "password";
  $("btnToggleKey").textContent = hidden ? "隐藏 Key" : "显示 Key";
});

$("btnForgetKey").addEventListener("click", () => {
  $("cfgLlmKey").value = "";
  state.config.llmKey = "";
  saveJson(CONFIG_KEY, state.config);
  $("btnForgetKey").disabled = true;
  $("cfgStatus").textContent = "已清除本机保存的 Key";
});

$("cfgProvider").addEventListener("change", () => {
  applyProvider($("cfgProvider").value);
  updateTip();
});

$("cfgLlmMode").addEventListener("change", () => {
  const direct = $("cfgLlmMode").value === "direct";
  $("settings").classList.add("open");
  if (direct) $("cfgStatus").textContent = "填好 Key 后点「测试连接」，会真发一个最小请求验证";
});

$("btnClear").addEventListener("click", () => {
  if (state.pendingConfirm) { window.alert("有未完成的确认操作，请先点确认或取消"); return; }
  if (!window.confirm("清空当前对话？")) return;
  resetSession(state.session);
  state.session.uiLog = [];
  state.turn = null;
  state.toolRows = [];
  chatEl.innerHTML = '<div class="center" id="empty">对话已清空，说一句“来一杯冰美式”试试。</div>';
  persist();
});

$("btnLoc").addEventListener("click", () => {
  if (!navigator.geolocation) { window.alert("当前浏览器不支持定位"); return; }
  const button = $("btnLoc");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "定位中…";
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      button.disabled = false;
      button.textContent = original;
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      state.session.lat = lat;
      state.session.lng = lng;
      updateMeta();
      persist();
      send(`我的位置是 ${lat.toFixed(5)}, ${lng.toFixed(5)}，帮我看看附近的瑞幸门店`);
    },
    () => {
      button.disabled = false;
      button.textContent = original;
      window.alert("定位失败（浏览器定位需要 https 或 localhost）。可以直接把经纬度发给我，例如：39.9042, 116.4074");
    },
    { timeout: 10000 },
  );
});

(async function init() {
  fillForm();
  await rebuild();
  restoreUi();
  inputEl.focus();
})();
