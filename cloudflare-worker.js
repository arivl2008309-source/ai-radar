/**
 * AI Radar — 自建 CORS 代理（Cloudflare Worker）
 * --------------------------------------------------
 * 作用：让公网版网页能稳定地直接请求 AI HOT / arXiv / Hacker News，
 *       不再依赖第三方公共 CORS 代理（那些经常抽风导致「Failed to fetch」）。
 *
 * 部署方式（最简单，无需装任何东西）：
 *   1. 打开 https://dash.cloudflare.com/  → 左侧「Workers & Pages」→「Create」
 *   2. 取一个子域名（如 ai-radar-proxy），选「Workers」→「Create Worker」
 *   3. 把本文件内容全部粘贴进代码框，点「Deploy」
 *   4. 部署后你会得到一个地址，形如：
 *        https://ai-radar-proxy.<你的子域>.workers.dev
 *   5. 把这个地址填到 app.js 顶部的 WORKER_PROXY 变量里（见下方说明）。
 *
 * 安全说明：
 *   - 仅允许白名单内的域名被代理，避免被人拿去当开放代理滥用。
 *   - 仅支持 https GET，不转发任何请求头（除 UA），不记录日志。
 */

// 允许被代理的上游域名（AI Radar 用到的全部数据源）
const ALLOWED_HOSTS = [
  "aihot.virxact.com",     // AI 资讯 / 行业应用
  "export.arxiv.org",      // arXiv 论文
  "arxiv.org",
  "hn.algolia.com",        // Hacker News 社区热帖
  "news.ycombinator.com"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 预检请求（浏览器跨域 OPTIONS）直接放行
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // 取要代理的目标地址（?url=https://...）
    const target = url.searchParams.get("url");
    if (!target) {
      return jsonError(400, "missing 'url' parameter");
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch (e) {
      return jsonError(400, "invalid 'url'");
    }

    if (parsed.protocol !== "https:") {
      return jsonError(400, "only https targets are allowed");
    }
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
      return jsonError(403, "host not allowed: " + parsed.hostname);
    }

    try {
      const upstream = await fetch(target, {
        method: "GET",
        headers: { "User-Agent": "AI-Radar/6.0 (+https://arivl2008309-source.github.io/ai-radar/)" },
        redirect: "follow"
      });

      // 透传上游响应体，附上宽松 CORS 头
      const headers = new Headers();
      headers.set("Access-Control-Allow-Origin", "*");
      const ct = upstream.headers.get("Content-Type");
      if (ct) headers.set("Content-Type", ct);
      headers.set("Cache-Control", "public, max-age=60");
      return new Response(upstream.body, {
        status: upstream.status,
        headers
      });
    } catch (e) {
      return jsonError(502, "upstream fetch failed: " + e.message);
    }
  }
};

function jsonError(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
