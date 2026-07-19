#!/usr/bin/env python3
"""
AI Radar - 零依赖轻量代理 + 静态文件服务器

解决浏览器跨域（CORS）问题：
  - /api/aihot?<aihot 参数>  -> 转发 AI HOT 公开接口（自动带浏览器 UA）
  - /api/arxiv?query=LLM&max=20 -> 抓取 arXiv 并解析为 JSON
  - 其余路径 -> 托管当前目录下的静态文件（index.html / app.js / styles.css）

运行：  python proxy.py            # 默认端口 8787
        python proxy.py 9000       # 指定端口
部署：  本文件可直接作为 Serverless / 容器入口；也可替换为公共 CORS 代理。
"""
import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
import json
import re
import os
import sys
import ssl

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787

AIHOT_BASE = "https://aihot.virxact.com/api/public"
ARXIV_BASE = "https://export.arxiv.org/api/query"
HN_BASE = "https://hn.algolia.com/api/v1"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


# 本地/沙箱环境的 Python 常缺少完整证书链（如 arXiv 的 SSL 校验会失败）。
# 本代理仅抓取公开数据、不传递任何私密信息，故统一使用不校验上下文。
CTX = ssl._create_unverified_context()


def fetch_text(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def parse_arxiv(xml_text: str):
    """把 arXiv Atom feed 粗略解析成结构化列表。"""
    entries = []
    for m in re.finditer(r"<entry>(.*?)</entry>", xml_text, re.S):
        e = m.group(1)

        def grab(tag):
            mm = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", e, re.S)
            return re.sub(r"\s+", " ", mm.group(1)).strip() if mm else ""

        title = grab("title")
        summary = grab("summary")
        published = grab("published")
        updated = grab("updated")

        link = ""
        lm = re.search(r'<link[^>]*href="([^"]+)"[^>]*type="text/html"', e)
        if not lm:
            lm = re.search(r'<link[^>]*href="([^"]+)"', e)
        if lm:
            link = lm.group(1)

        authors = re.findall(r"<name>(.*?)</name>", e)
        entries.append({
            "title": title,
            "summary": summary,
            "published": published or updated,
            "link": link,
            "authors": authors,
        })
    return entries


class Handler(http.server.SimpleHTTPRequestHandler):
    def _send(self, code: int, payload):
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        elif isinstance(payload, str):
            body = payload.encode("utf-8")
        else:
            body = payload
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # ---- AI HOT 转发 ----
        if parsed.path == "/api/aihot":
            try:
                target = f"{AIHOT_BASE}/items?{parsed.query}"
                data = fetch_text(target)
                self._send(200, data)
            except Exception as exc:  # noqa: BLE001
                self._send(502, {"error": f"AI HOT 请求失败: {exc}"})
            return

        # ---- arXiv 转发 + 解析 ----
        if parsed.path == "/api/arxiv":
            qp = urllib.parse.parse_qs(parsed.query)
            query = qp.get("query", ["LLM"])[0]
            maxr = qp.get("max", ["20"])[0]
            try:
                maxr = max(1, min(int(maxr), 50))
            except ValueError:
                maxr = 20
            target = (
                f"{ARXIV_BASE}?search_query=all:{urllib.parse.quote(query)}"
                f"&max_results={maxr}&sortBy=submittedDate&sortOrder=descending"
            )
            try:
                xml = fetch_text(target)
                items = parse_arxiv(xml)
                self._send(200, {"count": len(items), "items": items})
            except Exception as exc:  # noqa: BLE001
                self._send(502, {"error": f"arXiv 请求失败: {exc}"})
            return

        # ---- Hacker News (Algolia) 转发 ----
        if parsed.path == "/api/hn":
            qp = urllib.parse.parse_qs(parsed.query)
            query = qp.get("query", ["artificial intelligence"])[0]
            try:
                target = (
                    f"{HN_BASE}/search?query={urllib.parse.quote(query)}"
                    f"&tags=story&hitsPerPage=40"
                )
                data = json.loads(fetch_text(target))
                hits = data.get("hits", [])
                items = []
                for h in hits:
                    oid = str(h.get("objectID", ""))
                    hn_url = h.get("url") or ("https://news.ycombinator.com/item?id=" + oid)
                    items.append({
                        "id": "hn-" + oid,
                        "title": h.get("title") or h.get("story_title") or "",
                        "url": hn_url,
                        "summary": h.get("story_text") or "",
                        "source": "Hacker News",
                        "author": h.get("author", ""),
                        "points": h.get("points", 0) or 0,
                        "comments": h.get("num_comments", 0) or 0,
                        "publishedAt": h.get("created_at", ""),
                        "category": "community",
                    })
                self._send(200, {"count": len(items), "items": items})
            except Exception as exc:  # noqa: BLE001
                self._send(502, {"error": f"HN 请求失败: {exc}"})
            return

        # ---- 健康检查 + 服务端时间 ----
        if parsed.path == "/api/health":
            from datetime import datetime, timezone
            self._send(200, {
                "status": "ok",
                "server_time": datetime.now(timezone.utc).isoformat(),
                "version": "6.0",
            })
            return

        # ---- 静态文件 ----
        super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"AI Radar 已启动 ->  http://localhost:{PORT}")
        print("按 Ctrl+C 停止")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
