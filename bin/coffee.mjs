/**
 * Node 终端版：同一份公用心核 + CLI 直连后端。
 *
 * 这是「换后端不换 Agent」的验证点 —— 浏览器版和这里的
 * Agent 循环、工具定义、提示词、事件流完全是同一套代码。
 *
 *   node bin/coffee.mjs            # 直接用 A-1 1 默认配置（.env / ~/.luckin）
 *   node bin/coffee.mjs --demo     # 强制演示模式（不连真实接口）
 */

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { CoffeeAgent, TOOL_LABELS, createBackend, createLlmClient, createSession } from "../docs/core/index.js";
import { createDemoLlm } from "../docs/core/llm-demo.js";

const args = process.argv.slice(2);
const useDemo = args.includes("--demo");

/** 读项目根目录的 .env（已存在的环境变量优先） */
const loadEnvFile = (path) => {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
};

loadEnvFile(join(process.cwd(), ".env"));

const defaultExe = () => {
  if (process.env.LUCKIN_EXE) return process.env.LUCKIN_EXE;
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const exe = join(local, ".luckin", "bin", "luckin.exe");
  if (existsSync(exe)) return exe;
  return join(homedir(), ".luckin", "bin", platform() === "win32" ? "luckin.exe" : "luckin");
};

const main = async () => {
  const exe = defaultExe();
  const backend = await createBackend(useDemo || !existsSync(exe) ? "mock" : "cli", {
    exe,
    token: process.env.LUCKIN_MCP_ORDER_TOKEN,
  });

  const llm = process.env.LLM_API_KEY
    ? createLlmClient({
        mode: "direct",
        baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com",
        apiKey: process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL || "deepseek-chat",
      })
    : createDemoLlm();

  const agent = new CoffeeAgent({ llm, backend });
  const session = createSession({
    lat: process.env.LUCKIN_LAT ? Number(process.env.LUCKIN_LAT) : null,
    lng: process.env.LUCKIN_LNG ? Number(process.env.LUCKIN_LNG) : null,
  });

  console.log("☕ 瑞幸点单 Agent（终端版，输出 /quit 退出）");
  console.log(`   数据来源：${backend.label}`);
  console.log(`   模型：${llm.model}${llm.demo ? "（内置演示模型，设置 LLM_API_KEY 可换成真模型）" : ""}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const render = (event) => {
    switch (event.type) {
      case "delta":
        process.stdout.write(event.text);
        break;
      case "status":
        console.log(`  · ${event.text}`);
        break;
      case "tool_start":
        console.log(`  ⚙ ${TOOL_LABELS[event.name] || event.name} …`);
        break;
      case "tool_end": {
        const mark = event.ok ? "✓" : "✗";
        console.log(`  ${mark} ${TOOL_LABELS[event.name] || event.name} · ${event.display || event.summary}`);
        break;
      }
      case "cards":
        for (const card of event.items || []) {
          if (card.type === "stores") {
            for (const store of card.items) console.log(`      #${store.deptId} ${store.name} ${store.distance} ${store.status}`);
          } else if (card.type === "products") {
            for (const item of card.items) console.log(`      ${item.name} ${item.price} ${item.spec}`);
          } else if (card.type === "summary" || card.type === "payment") {
            for (const row of card.rows || []) console.log(`      ${row.k}：${row.v}`);
            for (const item of card.items || []) console.log(`      ${item.amount}×${item.name} ${item.spec || ""}`);
            if (card.payUrl) console.log(`      支付链接：${card.payUrl}`);
          } else if (card.type === "notice") {
            console.log(`      ${card.text}`);
          }
        }
        break;
      case "confirm":
        console.log(`\n  ── ${event.payload.title} ──`);
        for (const row of event.payload.rows || []) console.log(`      ${row.k}：${row.v}`);
        for (const item of event.payload.items || []) console.log(`      ${item.amount}×${item.name} ${item.spec || ""}`);
        if (event.payload.note) console.log(`      ⚠ ${event.payload.note}`);
        break;
      case "error":
        console.log(`\n  ❌ ${event.message}`);
        break;
      default:
        break;
    }
  };

  for (;;) {
    let line;
    try {
      line = (await rl.question("\n你> ")).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (["/quit", "/exit", "quit", "exit"].includes(line)) break;

    process.stdout.write("☕> ");
    for await (const event of agent.stream(session, line)) render(event);
    console.log();

    while (session.pause) {
      const answer = (await rl.question("  确认执行？(y/N) ")).trim().toLowerCase();
      console.log();
      for await (const event of agent.resume(session, answer === "y" || answer === "yes")) render(event);
      console.log();
    }
  }

  rl.close();
  console.log("\n再见 ☕");
};

main().catch((error) => {
  console.error(`启动失败：${error.message}`);
  process.exit(1);
});
