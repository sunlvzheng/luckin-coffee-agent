/**
 * 公用心核 · 模型服务商预设
 *
 * browser 字段是**实测**结论，判定标准很严格：
 *   先做 OPTIONS 预检，再发一次真实 POST（假 Key），
 *   只有「真实响应里确实带 Access-Control-Allow-Origin」才算可浏览器直连。
 *   有些网关只在预检时加 CORS 头、真实响应却不加，浏览器读不到结果，等于不可用
 *   （火山方舟/豆包 就是这种：预检 200 且有 ACAO，实际 POST 的 401 响应没有 ACAO）。
 *
 *   true      实测可浏览器直连
 *   "ollama"  本地服务，需先设 OLLAMA_ORIGINS=* 才允许跨域
 *   false     实测不可直连，请改用「经后端代理」模式
 *   "unknown" 未实测，取决于对方 CORS 配置
 */

export const PROVIDER_PRESETS = [
  // ------------------------------ 国内 ------------------------------ //
  {
    id: "deepseek",
    group: "国内",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    browser: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "国内直连、便宜、函数调用稳定，默认推荐。",
  },
  {
    id: "siliconflow",
    group: "国内",
    label: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "Qwen/Qwen2.5-7B-Instruct"],
    defaultModel: "deepseek-ai/DeepSeek-V3",
    browser: true,
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    note: "聚合多家开源模型，注册常送额度。",
  },
  {
    id: "moonshot",
    group: "国内",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k"],
    defaultModel: "moonshot-v1-8k",
    browser: true,
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    note: "长上下文，中文体验好。",
  },
  {
    id: "zhipu",
    group: "国内",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
    defaultModel: "glm-4-flash",
    browser: true,
    keyUrl: "https://bigmodel.cn/usercenter/apikeys",
    note: "glm-4-flash 有免费额度，适合先试。",
  },
  {
    id: "dashscope",
    group: "国内",
    label: "阿里云百炼（通义千问）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-turbo", "qwen-plus", "qwen-max"],
    defaultModel: "qwen-plus",
    browser: true,
    keyUrl: "https://bailian.console.aliyun.com/",
    note: "通义千问系列，新用户有免费额度。",
  },
  {
    id: "qianfan",
    group: "国内",
    label: "百度千帆（文心）",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: ["ernie-4.0-turbo-8k", "ernie-speed-128k"],
    defaultModel: "ernie-4.0-turbo-8k",
    browser: true,
    keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    note: "模型名以千帆控制台为准，可自己填。",
  },
  {
    id: "minimax",
    group: "国内",
    label: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    models: ["MiniMax-Text-01", "abab6.5s-chat"],
    defaultModel: "MiniMax-Text-01",
    browser: true,
    keyUrl: "https://platform.minimaxi.com/",
    note: "长文本能力强。",
  },
  {
    id: "stepfun",
    group: "国内",
    label: "阶跃星辰 StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    models: ["step-2-16k", "step-1-8k"],
    defaultModel: "step-2-16k",
    browser: true,
    keyUrl: "https://platform.stepfun.com/",
    note: "模型名可在控制台查看。",
  },
  {
    id: "volces",
    group: "国内",
    label: "火山方舟（豆包）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-pro-32k"],
    defaultModel: "doubao-pro-32k",
    browser: false,
    keyUrl: "https://console.volcengine.com/ark",
    note: "实测：预检能过、但真实响应没有 CORS 头，浏览器拿不到结果，请用「经后端代理」。",
  },

  // ------------------------------ 海外 ------------------------------ //
  {
    id: "openrouter",
    group: "海外",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["deepseek/deepseek-chat", "google/gemini-2.0-flash-001", "anthropic/claude-3.5-haiku"],
    defaultModel: "deepseek/deepseek-chat",
    browser: true,
    keyUrl: "https://openrouter.ai/keys",
    note: "一个 Key 调多家模型，按量计费。",
  },
  {
    id: "together",
    group: "海外",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    models: ["deepseek-ai/DeepSeek-V3", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    defaultModel: "deepseek-ai/DeepSeek-V3",
    browser: true,
    keyUrl: "https://api.together.xyz/settings/api-keys",
    note: "海外开源模型托管。",
  },
  {
    id: "openai",
    group: "海外",
    label: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o"],
    defaultModel: "gpt-4o-mini",
    browser: false,
    keyUrl: "https://platform.openai.com/api-keys",
    note: "官方不返回 CORS 头，浏览器直连必然失败，请用「经后端代理」。",
  },

  // ------------------------ 本地 / 自定义 ------------------------ //
  {
    id: "ollama",
    group: "本地 / 自定义",
    label: "本地 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5:7b", "llama3.1:8b", "deepseek-r1:7b"],
    defaultModel: "qwen2.5:7b",
    browser: "ollama",
    keyUrl: "",
    note: "完全本地、不花钱。需先设环境变量 OLLAMA_ORIGINS=* 并重启 Ollama，否则浏览器跨域被拦。",
  },
  {
    id: "custom",
    group: "本地 / 自定义",
    label: "自定义地址",
    baseUrl: "",
    models: [],
    defaultModel: "",
    browser: "unknown",
    keyUrl: "",
    note: "任意 OpenAI 兼容地址；能否浏览器直连取决于对方的 CORS 配置，点「测试连接」一试便知。",
  },
];

export const findProvider = (id) =>
  PROVIDER_PRESETS.find((item) => item.id === id) || PROVIDER_PRESETS[0];

/** 按 group 分好组，给下拉框用 */
export const groupedProviders = () => {
  const groups = new Map();
  for (const provider of PROVIDER_PRESETS) {
    const key = provider.group || "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(provider);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
};

/** 给界面用的一句状态说明 */
export const providerHint = (provider) => {
  if (!provider) return "";
  if (provider.browser === true) {
    return `✅ 实测可浏览器直连${provider.note ? ` · ${provider.note}` : ""}`;
  }
  if (provider.browser === "ollama") return `⚠️ ${provider.note}`;
  if (provider.browser === false) return `⛔ ${provider.note}`;
  return `❓ ${provider.note || "未验证对方的 CORS 配置，点「测试连接」一试便知。"}`;
};
