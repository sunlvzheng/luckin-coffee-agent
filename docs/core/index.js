/**
 * 公用心核入口。
 *
 * 同一份逻辑在三处复用：
 *   - 静态站点（GitHub Pages）   backend: mock / http
 *   - 本地服务托管的页面          backend: http
 *   - Node 终端版                 backend: cli / mock
 */

export { CoffeeAgent, MAX_HISTORY, createAgent } from "./agent.js";
export { createLlmClient } from "./llm.js";
export { createDemoLlm } from "./llm-demo.js";
export { ToolRunner, TOOL_SCHEMAS, SENSITIVE_TOOLS } from "./tools.js";
export {
  SYSTEM_PROMPT,
  TOOL_LABELS,
  buildSystemContent,
} from "./prompt.js";
export {
  createSession,
  fromJSON,
  isWaitingConfirm,
  resetSession,
  toJSON,
} from "./session.js";
export {
  briefProduct,
  briefStore,
  fmtTs,
  itemSpec,
  money,
  normalizeItems,
  short,
  specOf,
  toOrderRows,
  toPreview,
} from "./format.js";
export { BACKEND_MODES, createBackend } from "./backends/index.js";
export { PROVIDER_PRESETS, findProvider, groupedProviders, providerHint } from "./providers.js";
