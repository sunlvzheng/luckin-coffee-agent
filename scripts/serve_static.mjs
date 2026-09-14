/**
 * 本地预览静态站：完全模拟 GitHub Pages 的托管方式。
 *
 * 用途：上传前先确认「部署到子路径」也能正常打开（ES Module 相对路径最容易在这里踩坑），
 * 顺便绕开 `python -m http.server` 在 Windows 上把 .js 当 text/plain 的毛病。
 *
 *   node scripts/serve_static.mjs                      # 根路径，默认 8080
 *   node scripts/serve_static.mjs 8080 /luckin-agent    # 子路径，模拟 https://user.github.io/luckin-agent/
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../docs", import.meta.url)));
const PORT = Number(process.argv[2] || 8080);
const BASE = `/${String(process.argv[3] || "").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

const send = (res, status, body, type = "text/plain; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
};

const server = createServer(async (req, res) => {
  let pathname = decodeURIComponent((req.url || "/").split("?")[0]);

  if (BASE && pathname === BASE) {
    res.writeHead(302, { Location: `${BASE}/` });
    res.end();
    return;
  }
  if (BASE) {
    if (!pathname.startsWith(`${BASE}/`)) {
      return send(res, 404, `路径前缀不对：本次预览的站点挂在 ${BASE}/ 下，请访问 ${BASE}/`);
    }
    pathname = pathname.slice(BASE.length) || "/";
  }

  let target = resolve(join(ROOT, normalize(pathname)));
  // 防目录穿越
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return send(res, 403, "forbidden");
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, "index.html");
  } catch {
    return send(res, 404, `404 找不到：${pathname}`);
  }

  try {
    const body = await readFile(target);
    send(res, 200, body, MIME[extname(target).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, `404 找不到：${pathname}`);
  }
});

server.listen(PORT, () => {
  console.log("静态站预览已启动（模拟 GitHub Pages）：");
  console.log(`  http://127.0.0.1:${PORT}${BASE}/`);
  console.log(`  根目录：${ROOT}`);
  if (BASE) console.log(`  挂在子路径 ${BASE}/ 下，用于验证部署到 user.github.io/<repo>/ 的情况`);
});
