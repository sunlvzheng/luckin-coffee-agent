/**
 * 后端工厂：按模式创建后端适配器。
 *
 *   mock  → 演示（静态站点默认，零配置、不扣款）
 *   http  → 薄桥接服务（浏览器真实下单的唯一途径）
 *   cli   → 直接 spawn luckin.exe（仅 Node）
 *   auto  → Node 环境优先 cli，浏览器环境回落到 http
 */

export const BACKEND_MODES = [
  { id: "mock", label: "演示模式", hint: "内置样例数据，不会下单" },
  { id: "http", label: "连接服务", hint: "用自己的后端真实下单" },
  { id: "cli", label: "本地 CLI", hint: "仅 Node 终端版可用" },
];

export const createBackend = async (mode = "mock", options = {}) => {
  switch (mode) {
    case "mock": {
      const { createMockBackend } = await import("./mock.js");
      return createMockBackend(options);
    }
    case "http": {
      const { createHttpBackend } = await import("./http.js");
      if (!options.baseUrl) throw new Error("连接服务模式需要填写后端地址");
      return createHttpBackend(options);
    }
    case "cli": {
      if (typeof process === "undefined" || !process.versions?.node) {
        throw new Error("CLI 直连模式只能在 Node 里使用；浏览器请用「连接服务」模式");
      }
      const { createCliBackend } = await import("./cli.js");
      if (!options.exe) throw new Error("CLI 直连模式需要提供 luckin.exe 路径");
      return createCliBackend(options);
    }
    case "auto": {
      const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);
      if (isNode && options.exe) return createBackend("cli", options);
      if (options.baseUrl) return createBackend("http", options);
      return createBackend("mock", options);
    }
    default:
      throw new Error(`未知的后端模式：${mode}`);
  }
};
