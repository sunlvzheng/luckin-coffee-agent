/**
 * 后端适配层 · CLI 直连（仅 Node）
 *
 * 浏览器里用不了（不能起进程），但同一份心核放在 Node 里跑时，
 * 就可以直接调 luckin.exe —— 这就是“公用逻辑”的验证点：
 * 换后端不换 Agent。
 */

import { spawn } from "node:child_process";
import { itemSpec } from "../format.js";

const extractJson = (text) => {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* 继续尝试宽松提取 */
  }
  const start = raw.search(/[{[]/);
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
};

const unwrap = (payload) => (payload && typeof payload === "object" && "data" in payload ? payload.data : payload);

export const createCliBackend = ({ exe, token = "", timeout = 120000 } = {}) => {
  const run = (args, { allowText = false } = {}) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (token) env.LUCKIN_MCP_ORDER_TOKEN = token;

      const child = spawn(exe, args, { env, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`调用超时（>${Math.round(timeout / 1000)}s）：luckin ${args.join(" ")}`));
      }, timeout);

      child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`无法启动 luckin CLI（${exe}）：${error.message}`));
      });
      child.on("close", () => {
        clearTimeout(timer);
        const payload = extractJson(stdout) || extractJson(stderr);
        if (payload === null) {
          if (allowText) return resolve((stdout || stderr).trim());
          return reject(new Error((stdout + stderr).trim().slice(0, 400) || "命令没有返回可解析的结果"));
        }
        if (payload && payload.success === false) {
          return reject(new Error(payload.msg || `调用失败（code=${payload.code}）`));
        }
        resolve(payload);
      });
    });

  const data = async (args) => unwrap(await run(args));

  return {
    id: "cli",
    label: "本地 CLI（真实下单）",
    realOrder: true,
    notes: exe,

    async ping() {
      try {
        const text = await run(["version"], { allowText: true });
        return { ok: true, version: String(text).replace(/^luckin\s*/i, ""), detail: exe };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },

    stores({ latitude, longitude, keyword }) {
      const args = ["store", Number(latitude).toFixed(6), Number(longitude).toFixed(6)];
      if (keyword) args.push(keyword);
      return data(args).then((list) => list || []);
    },

    searchProducts({ deptId, query }) {
      return data(["menu", String(deptId), query]).then((list) => list || []);
    },

    previewOrder({ deptId, items }) {
      const args = ["order", "preview", String(deptId)];
      for (const item of items) args.push("-p", itemSpec(item));
      return data(args);
    },

    createOrder({ deptId, items, latitude, longitude, coupons }) {
      const args = [
        "order",
        "create",
        String(deptId),
        "--lat",
        Number(latitude).toFixed(6),
        "--lng",
        Number(longitude).toFixed(6),
      ];
      for (const item of items) args.push("-p", itemSpec(item));
      for (const coupon of coupons || []) if (coupon) args.push("--coupon", String(coupon));
      return data(args);
    },

    orderDetail({ orderId }) {
      return data(["order", "detail", String(orderId)]);
    },

    async cancelOrder({ orderId }) {
      const payload = await run(["order", "cancel", String(orderId)]);
      const value = unwrap(payload);
      if (typeof value === "boolean") return { ok: value, message: "" };
      if (value && typeof value === "object") {
        return { ok: value.success !== false, message: value.msg || "" };
      }
      return { ok: Boolean(value), message: "" };
    },

    /** Node 侧不引入二维码依赖，交给界面显示链接 */
    async makeQr() {
      return null;
    },
  };
};
