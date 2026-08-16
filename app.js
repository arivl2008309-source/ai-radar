/* ============== AI 雷达 · 交互引擎 v5（稳定版） ============== */

(function() {
  "use strict";

  /* ---- 常量 ---- */
  var API = { aihot: "/api/aihot", arxiv: "/api/arxiv", hn: "/api/hn" };

  /* ============================================================
     部署模式自适应（本地 / 公网 CloudStudio 双模式）
     - 本地（localhost / 127.0.0.1）→ 走本地 Python 代理 /api/*
     - 公网（CloudStudio 等）→ 走公共 CORS 代理直接取上游，无需后端
     ============================================================ */
  var IS_LOCAL = (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "");
  var AIHOT_BASE = "https://aihot.virxact.com/api/public";
  var ARXIV_BASE = "https://export.arxiv.org/api/query";
  var HN_BASE    = "https://hn.algolia.com/api/v1";

  // 自建 Cloudflare Worker 代理（部署后填入地址；留空则只用公共代理）
  // 部署教程见 cloudflare-worker.js 文件头注释
  var WORKER_PROXY = "https://ai-radar-proxy.arivl2008309.workers.dev";

  // 公共 CORS 代理（按优先级排列，自动故障转移）
  // 每个代理返回格式可能不同：{items:[...]} / {contents:"..."} / 原始文本
  var CORS_PROXIES = [
    // ── 前缀式（直接拼 URL）──
    function(u){ return "https://proxy.cors.sh/" + u; },
    function(u){ return "https://corsproxy.io/?u=" + encodeURIComponent(u); },
    // ── 参数式（URL 作为参数）──
    function(u){ return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u); },
    function(u){ return "https://api.allorigins.win/get?url=" + encodeURIComponent(u); },   // 返回 {contents: "..."}
    function(u){ return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u); }
  ];
  // 若配置了自建 Worker，则作为最高优先级（稳、快、可控），公共代理降级为兜底
  if (WORKER_PROXY && WORKER_PROXY.trim()) {
    var wp = WORKER_PROXY.trim().replace(/\/+$/, "");
    CORS_PROXIES.unshift(function(u){ return wp + "/?url=" + encodeURIComponent(u); });
  }

  // 经 CORS 代理取数据；asText=true 返回原始文本（arXiv XML）；失败自动切下一个代理
  async function fetchViaCors(target, asText) {
    var lastErr;
    for (var i = 0; i < CORS_PROXIES.length; i++) {
      try {
        var url = CORS_PROXIES[i](target);
        var res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15" },
          signal: AbortSignal.timeout(20000)  // 单个代理超时 20s
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var data = asText ? await res.text() : await res.json();
        // allorigins /get 模式返回 {contents: "原始内容"}，需提取
        if (!asText && data && typeof data.contents === "string") {
          try { data = JSON.parse(data.contents); } catch(e) { /* 非JSON，保持原样 */ }
        }
        return data;
      } catch (e) { lastErr = e; console.warn("CORS proxy[" + i + "] failed:", e.message); }
    }
    throw lastErr || new Error("所有 CORS 代理均不可用");
  }

  // 浏览器端解析 arXiv XML（公网模式无后端代理）
  function parseArxivXML(xml) {
    var doc = new DOMParser().parseFromString(xml, "text/xml");
    var entries = doc.getElementsByTagName("entry");
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var g = function(t){ var n = e.getElementsByTagName(t)[0]; return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; };
      var link = "", links = e.getElementsByTagName("link");
      for (var j = 0; j < links.length; j++) {
        if (links[j].getAttribute("type") === "text/html") { link = links[j].getAttribute("href"); break; }
      }
      if (!link && links[0]) link = links[0].getAttribute("href") || "";
      var authors = [];
      var ns = e.getElementsByTagName("name");
      for (var k = 0; k < ns.length; k++) authors.push(ns[k].textContent);
      out.push({ title: g("title"), summary: g("summary"), published: g("published") || g("updated"), link: link, authors: authors });
    }
    return out;
  }

  /* ---- 三大数据源统一封装（双模式）---- */
  // AI HOT：p = {mode, take, since, category, q}
  async function aihotItems(p) {
    var qs = "mode=" + (p.mode || "all") + "&take=" + (p.take || 100);
    if (p.since)    qs += "&since=" + encodeURIComponent(p.since);
    if (p.category) qs += "&category=" + encodeURIComponent(p.category);
    if (p.q)        qs += "&q=" + encodeURIComponent(p.q);
    if (IS_LOCAL) {
      var r = await fetch(API.aihot + "?" + qs);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return ((await r.json()).items || []).filter(Boolean);
    }
    var d = await fetchViaCors(AIHOT_BASE + "/items?" + qs);
    return (Array.isArray(d) ? d : (d && d.items) || []).filter(Boolean);
  }

  // Hacker News：返回已映射的 community 条目
  async function hnItems(query) {
    if (IS_LOCAL) {
      var r = await fetch(API.hn + "?query=" + encodeURIComponent(query));
      if (!r.ok) throw new Error("HTTP " + r.status);
      return ((await r.json()).items || []).filter(Boolean);
    }
    var data = await fetchViaCors(HN_BASE + "/search?query=" + encodeURIComponent(query) + "&tags=story&hitsPerPage=40");
    return (data.hits || []).map(function(h) {
      var oid = String(h.objectID || "");
      return {
        id: "hn-" + oid, title: h.title || h.story_title || "",
        url: h.url || ("https://news.ycombinator.com/item?id=" + oid),
        summary: h.story_text || "", source: "Hacker News",
        author: h.author || "", points: h.points || 0,
        comments: h.num_comments || 0, publishedAt: h.created_at || "",
        category: "community"
      };
    });
  }

  // arXiv：返回已映射的 paper 条目
  async function arxivItems(query, max) {
    max = max || 30;
    if (IS_LOCAL) {
      var r = await fetch(API.arxiv + "?query=" + encodeURIComponent(query) + "&max=" + max);
      if (!r.ok) throw new Error("HTTP " + r.status);
      var j = await r.json();
      return (j.items || []).map(function(p) {
        return { category: "paper", title: p.title, summary: p.summary || p.description || "",
                 source: "arXiv", publishedAt: p.publishedAt || p.published };
      });
    }
    var target = ARXIV_BASE + "?search_query=all:" + encodeURIComponent(query)
      + "&max_results=" + max + "&sortBy=submittedDate&sortOrder=descending";
    var xml = await fetchViaCors(target, "text");
    return parseArxivXML(xml).map(function(p) {
      return { category: "paper", title: p.title, summary: p.summary || "",
               source: "arXiv", publishedAt: p.published };
    });
  }
  var SECTORS = [
    {key:"医疗", icon:"\u{1FA7A}", sub:"诊断·药物·器械", color:"#ec4899", kw:["医疗","医院","诊断","药物","制药","临床","健康","基因","手术","医学","患者","医保"]},
    {key:"金融", icon:"\u{1F4B0}", sub:"风控·投研·客服", color:"#3b82f6", kw:["金融","银行","保险","投资","券商","信贷","风控","财富","基金","支付","理财","证券"]},
    {key:"制造", icon:"\u{1F3ED}", sub:"质检·预测·排产", color:"#f59e0b", kw:["制造","工厂","工业","质检","供应链","产线","车间","生产制造","物流"]},
    {key:"零售", icon:"\u{1F6D2}", sub:"推荐·库存·导购", color:"#10b981", kw:["零售","电商","消费","品牌","营销","带货","货架","门店","商超","商城"]},
    {key:"教育", icon:"\u{1F4DA}", sub:"备课·批改·答疑", color:"#8b5cf6", kw:["教育","学习","教学","课程","学校","培训","辅导","学情","作业"]},
    {key:"汽车", icon:"\u{1F697}", sub:"智驾·座舱·电池", color:"#6366f1", kw:["汽车","智驾","自动驾驶","座舱","新能源","电动车","电池","出行","车厂","车载"]},
    {key:"政务", icon:"\u{1F3DB}", sub:"审批·办事·安防", color:"#14b8a6", kw:["政务","政府","城市","公共","监管","政策","治理","城管","公安"]},
    {key:"文娱", icon:"\u{1F3AC}", sub:"生成·推荐·翻译", color:"#ef4444", kw:["文娱","影视","游戏","视频","音乐","内容","直播","动漫","短剧","传媒"]},
    {key:"农业", icon:"\u{1F33E}", sub:"监测·育种·农机", color:"#84cc16", kw:["农业","种植","养殖","粮食","农机","乡村","农"]},
    {key:"能源", icon:"\u{26A1}", sub:"调度·勘探·交易", color:"#f97316", kw:["能源","电力","电网","光伏","风电","油气","储能","碳中和","发电"]},
    {key:"机器人", icon:"\u{1F916}", sub:"操作·导航·协作", color:"#06b6d4", kw:["机器人","人形","具身","机械臂","协作"]},
    {key:"法律", icon:"⚖️", sub:"合规·合同·判例", color:"#a855f7", kw:["法律","司法","律师","合同","合规","判例","法院","法规","监管","立法","诉讼"]},
    {key:"网安", icon:"🛡️", sub:"攻防·隐私·防护", color:"#0ea5e9", kw:["安全","网络","漏洞","攻防","黑客","隐私","数据保护","钓鱼","加密","防护","风控"]},
    {key:"科研", icon:"🔬", sub:"实验·基金·学术", color:"#22c55e", kw:["科研","学术","研究","实验","论文","基金","实验室","学者","期刊","突破"]},
    {key:"all_industry", icon:"\u{1F310}", sub:"全部行业动态汇总", color:"#64748b", kw:[]}
  ];
  var CAT_COLORS = {
    "ai-models":"#6366f1","ai-products":"#8b5cf6","industry":"#10b981",
    "paper":"#f59e0b","tip":"#ef4444","community":"#f43f5e"
  };
  var AVATAR_PALETTE = [
    "#6366f1","#8b5cf6","#ec4899","#3b82f6","#10b981",
    "#f59e0b","#ef4444","#14b8a6","#06b6d4","#f97316"
  ];

  /* ---- DOM ---- */
  var $ = function(s) { return document.querySelector(s); };
  var content  = $("#content");
  var statusEl = $("#status");
  var searchInput = $("#searchInput");
  var timeSelect = $("#timeSelect");
  var catChips  = $("#catChips");

  /* ---- 状态 ---- */
  var state = {
    tab: "news", cat: "all", hours: 72, query: "",
    industryView: "wall",
    currentSector: null,
    industryPool: null,
    industryPoolLoaded: false,
    sectorCounts: {},
    filter: { smart: true, dedup: true, quality: false },
    lastUpdated: null,          // 最后成功加载数据的时间戳
    favs: JSON.parse(localStorage.getItem("aiRadar_favs") || "[]"),
    readSet: new Set(JSON.parse(localStorage.getItem("aiRadar_read") || "[]"))
  };

  // 下拉刷新控制器（移动端手势）
  var ptrCtl = null;

  /* ---- 工具函数 ---- */
  function setStatus(msg, cls) {
    statusEl.innerHTML = msg ? '<span class="' + (cls || "") + '">' + msg + "</span>" : "";
  }

  /* ---- 最后更新时间追踪 ---- */
  var luEl = null;   // DOM 延迟取
  function getLuEl() {
    if (!luEl) luEl = document.getElementById("lastUpdated");
    return luEl;
  }
  function updateLastUpdated() {
    state.lastUpdated = new Date();
    var el = getLuEl();
    if (!el) return;
    var dot = el.querySelector(".lu-dot");
    var txt = el.querySelector(".lu-text");
    if (dot) { dot.classList.remove("stale"); }
    if (txt) {
      txt.textContent = "数据更新于 " + state.lastUpdated.toLocaleTimeString("zh-CN", {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      }) + (IS_LOCAL ? "" : " · 公共代理");
    }
    // 存储到 localStorage（跨会话保留）
    try { localStorage.setItem("aiRadar_lastUpdate", state.lastUpdated.toISOString()); } catch(e) {}
    // 下拉刷新完成后复位指示器
    if (ptrCtl && ptrCtl.active) ptrCtl.finish();
  }
  function showStaleTime() {
    var el = getLuEl();
    if (!el) return;
    var dot = el.querySelector(".lu-dot");
    var txt = el.querySelector(".lu-text");
    if (dot) dot.classList.add("stale");
    // 尝试从存储恢复上次时间
    var saved = localStorage.getItem("aiRadar_lastUpdate");
    if (saved) {
      try {
        var d = new Date(saved);
        if (!isNaN(d.getTime())) {
          if (txt) txt.textContent = "上次更新 " + timeAgo(d) + (IS_LOCAL ? "" : " · 公共代理");
          return;
        }
      } catch(e) {}
    }
    if (txt) txt.textContent = "等待数据加载…" + (IS_LOCAL ? "" : " · 公共代理");
  }

  /* ---- 自动刷新机制 ---- */
  var _refreshTimer = null;
  var REFRESH_INTERVAL_MS = 30 * 60 * 1000;  // 30 分钟

  function scheduleAutoRefresh() {
    clearAutoRefresh();
    _refreshTimer = setTimeout(function() {
      // 静默刷新（不显示 skeleton，用户无感知）
      loadAll(true);
    }, REFRESH_INTERVAL_MS);
  }
  function clearAutoRefresh() {
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  }

  // 页面重新获得焦点时检查是否需要刷新（超过 5 分钟则自动刷新）
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible" && state.lastUpdated) {
      var elapsed = Date.now() - state.lastUpdated.getTime();
      if (elapsed > 5 * 60 * 1000) {
        loadAll(true);  // 静默刷新
      }
    }
  });
  function skeleton(n) {
    var arr = [];
    for (var i = 0; i < n; i++) arr.push('<div class="skeleton"></div>');
    content.innerHTML = arr.join("");
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return "\u521a\u521a";
    var m = Math.floor(diff / 60000);
    if (m < 1) return "\u521a\u521a";
    if (m < 60) return m + " \u5206\u949f\u524d";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " \u5c0f\u65f6\u524d";
    var d = Math.floor(h / 24);
    if (d < 30) return d + " \u5929\u524d";
    return Math.floor(d / 30) + " \u6708\u524d";
  }

  function avatarHTML(src) {
    if (!src) return "";
    var name = src.replace(/[\uff08\uff09()\s]/g, "");
    var ch = name.charAt(0) || "?";
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
    var color = AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
    return '<span class="avatar" style="background:' + color + '">' + ch + '</span>';
  }

  function extractHighlights(text) {
    if (!text) return [];
    var re = /(\d[\d,]*\.?\d*)\s*(\u4e07\u4ebf\u7f8e\u5143|\u4e07\uebf4|\u7f8e\u5143|GB|TB|MB|KB|B|Token|Tokens|%|\uff05|\u4e07|\u4ebf|\u7f8e\u5143|\u5143|\u6b27\u5143|\u500d|\u5c0f\u65f6|\u5206\u949f|\u79d2|\u5929|\u5468|\u6708|\u5e74|\u7bc7|\u4e2a|\u5bb6|\u6761|\u6b21|\u53c2\u6570|ARR|GPU|\u5361)/g;
    var out = [], seen = new Set(), m;
    while ((m = re.exec(text)) && out.length < 4) {
      var val = m[0].trim();
      if (/^(19|20)\d\d\s*\u5e74$/.test(val)) continue;
      if (/\u6708|\u65e5/.test(val) && parseInt(val, 10) <= 31) continue;
      if (seen.has(val)) continue;
      seen.add(val);
      out.push(val);
    }
    return out;
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* ============== 信息过滤引擎 ============== */

  // 权威/高可信来源（命中则质量加分、显示「权威」徽标）
  var TRUSTED = /(openai|anthropic|google|deepmind|microsoft|meta ai|mistral|hugging ?face|arxiv|mit|stanford|berkeley|cmu|gemini|claude|gpt|perplexity|cohere|nvidia|baidu|alibaba|tencent|字节|智谱|百川|kimi|minimax|月之暗面|ibm|apple|amazon|salesforce|adobe|机器之心|量子位|36氪|infoq|新智元|雷锋网|甲子光年|极客公园|爱范儿|晚点|techcrunch|the verge|wired|nature|science)/i;

  // 垃圾/推广/标题党特征
  var JUNK_PATTERNS = [
    /震惊/, /速看/, /重磅突发/, /刚刚[！!]/, /免费领取/, /免费领/, /限时/, /邀请码/,
    /扫码关注/, /加微信/, /优惠券/, /折扣/, /薅羊毛/, /返利/, /0元购/, /点击领取/,
    /关注领取/, /充值/, /招代理/, /日赚/, /月入过万/, /兼职刷单/, /推广佣金/,
    /course\s*discount/i, /buy\s*now/i, /limited\s*offer/i, /免费公开课|0元学|拼团|砍价|扫码进群/
  ];

  function normalizeTitle(t) {
    return (t || "").toLowerCase()
      .replace(/[\s\u3000]+/g, "")
      .replace(/[^\w\u4e00-\u9fa5]/g, "")
      .replace(/(全文|（全文）|【.*?】|（.*?）)$/g, "");
  }

  // 分词：英文单词 + 中文二元组（用于近重检测）
  function tokenize(text) {
    var s = (text || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, " ");
    var toks = s.split(/\s+/).filter(Boolean);
    var cn = (text || "").replace(/[^\u4e00-\u9fa5]/g, "");
    for (var i = 0; i < cn.length - 1; i++) toks.push(cn.substr(i, 2));
    return toks;
  }

  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    var sb = new Set(b), inter = 0;
    a.forEach(function(x) { if (sb.has(x)) inter++; });
    var union = a.length + b.length - inter;
    return union ? inter / union : 0;
  }

  function isJunk(it) {
    var t = (it.title || "") + " " + (it.summary || it.description || "");
    for (var i = 0; i < JUNK_PATTERNS.length; i++) {
      if (JUNK_PATTERNS[i].test(t)) return true;
    }
    if ((it.title || "").trim().length < 6) return true;
    if ((it.summary || it.description || "").trim().length < 18 && !(it.points > 0)) return true;
    return false;
  }

  function scoreItem(it) {
    var s = 50;
    if (TRUSTED.test(it.source || "")) s += 20;
    if (it.points != null) s += Math.min(Math.floor(it.points / 50), 25);  // 社区热帖按赞加分
    var sum = (it.summary || it.description || "").trim();
    if (sum.length >= 80 && sum.length <= 420) s += 10;
    else if (sum.length > 420) s += 5;
    else if (sum.length < 18) s -= 20;
    var hl = extractHighlights(sum || it.title);
    s += Math.min(hl.length * 4, 12);
    var d = new Date(it.publishedAt || it.published || 0).getTime();
    if (!isNaN(d)) {
      var ageH = (Date.now() - d) / 3600000;
      if (ageH >= 0 && ageH < 48) s += 5;
      else if (ageH > 720) s -= 6;
    }
    return Math.max(0, Math.min(100, Math.round(s)));
  }

  function qualityLabel(q) {
    if (q >= 80) return { txt: "优质", cls: "excellent" };
    if (q >= 60) return { txt: "良好", cls: "good" };
    return { txt: "一般", cls: "ok" };
  }

  function readTime(text) {
    var len = (text || "").length;
    if (!len) return "";
    return Math.max(1, Math.ceil(len / 300)) + " 分钟读";
  }

  function filterOpts() {
    return {
      smart: state.filter.smart,
      dedup: state.filter.dedup,
      minQuality: state.filter.quality ? 70 : 0
    };
  }

  // 核心：去重 + 去垃圾 + 质量评分 + 阈值过滤
  function processItems(raw, opts) {
    if (!Array.isArray(raw)) raw = Array.isArray(raw && raw.items) ? raw.items : [];
    opts = opts || {};
    var smart = opts.smart !== false;
    var dedup = opts.dedup !== false;
    var minQ = opts.minQuality || 0;
    var seen = new Set();
    var norms = [];
    var kept = [], removed = { junk: 0, dup: 0, lowq: 0 };
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (smart && isJunk(it)) { removed.junk++; continue; }
      var id = it.id || it.url || normalizeTitle(it.title);
      if (dedup) {
        if (seen.has(id)) { removed.dup++; continue; }
        var toks = tokenize(it.title);
        var near = false;
        for (var j = 0; j < norms.length; j++) {
          if (jaccard(toks, norms[j]) > 0.62) { near = true; break; }
        }
        if (near) { removed.dup++; continue; }
        seen.add(id); norms.push(toks);
      }
      var q = scoreItem(it);
      it._quality = q;
      if (q < minQ) { removed.lowq++; continue; }
      kept.push(it);
    }
    return { items: kept, removed: removed };
  }

  function reportFilter(total, r) {
    var removed = total - r.items.length;
    var parts = [];
    if (r.removed.junk) parts.push("垃圾 " + r.removed.junk);
    if (r.removed.dup) parts.push("重复 " + r.removed.dup);
    if (r.removed.lowq) parts.push("低质 " + r.removed.lowq);
    var msg = r.items.length + " 条结果";
    if (removed > 0) msg += " · 已滤除 " + removed + " 条（" + parts.join(" · ") + "）";
    setStatus(msg, "ok");
  }

  /* ---- 卡片渲染 ---- */
  function cardHTML(item) {
    var cat = item.category || "";
    var catColor = CAT_COLORS[cat] || varCSS("--accent");
    var isCommunity = cat === "community";
    var score = typeof item.score === "number" ? item.score
      : (item.points != null ? item.points : (item.hot || 70));
    var title = esc(item.title || "");
    var summary = esc(item.summary || item.description || "");
    var source = esc(item.source || "");
    var url = (item.url || "").indexOf("http") === 0 ? item.url : "";
    var timeStr = timeAgo(item.publishedAt || item.published || item.date || "");
    var author = esc(item.author || (Array.isArray(item.authors) ? item.authors.join(", ") : item.authors) || "");
    var q = typeof item._quality === "number" ? item._quality : scoreItem(item);
    var ql = qualityLabel(q);
    var rt = readTime(item.summary || item.description || "");
    var isTrusted = TRUSTED.test(item.source || "");

    var hl = extractHighlights(summary || title);
    var hlHTML = hl.length
      ? '<div class="highlights">' + hl.map(function(h) { return '<span class="hl">' + esc(h) + '</span>'; }).join("") + '</div>'
      : "";
    var longSummary = (summary || "").length > 160;

    var tagRow = '<div class="tag-row">'
      + (cat ? '<span class="cat-tag" style="background:' + catColor + '">' + esc(catLabel(cat)) + '</span>' : "")
      + '<span class="q-badge ' + ql.cls + '">' + ql.txt + '</span>'
      + (isTrusted ? '<span class="auth-badge" title="权威来源">权威</span>' : "")
      + '</div>';

    var timeRight = '<span class="time">' + timeStr + (rt ? ' · ' + rt : '') + '</span>';

    var heatHTML = isCommunity
      ? '<span class="heat">▲ ' + (item.points || 0) + '</span><span class="attr">💬 ' + (item.comments || 0) + '</span>'
      : '<span class="heat">🔥 ' + score + '</span>';

    return '<article class="card ' + (state.readSet.has(item.id || item.url || title) ? "read" : "") + '"'
      + ' data-id="' + esc(item.id || item.url || title) + '"'
      + ' data-url="' + url + '" style="--bar:' + catColor + '">'
      + '<div class="card-top">' + tagRow + timeRight + '</div>'
      + '<h3>' + title + '</h3>'
      + hlHTML
      + '<p class="summary">' + summary + '</p>'
      + (longSummary ? '<button class="expand-btn">展开 \u25BC</button>' : '')
      + '<div class="card-foot">'
      +   '<div class="src">' + avatarHTML(source) + '<span class="abs">' + source + '</span></div>'
      +   '<div class="foot-right">'
      +     (author ? '<span class="attr">✍ ' + author + '</span>' : '')
      +     heatHTML
      +     '<button class="star ' + (isFav(item) ? "active" : '') + '" title="收藏">☆</button>'
      +   '</div>'
      + '</div>'
      + '</article>';
  }

  function catLabel(key) {
    var map = {"ai-models":"\u6a21\u578b\u53d1\u5e03","ai-products":"\u54c1\u66f4\u65b0","industry":"\u884c\u4e1a\u52a8\u6001","paper":"\u8bba\u6587\u7814\u7a76","tip":"\u6280\u5de7\u89c2\u70b9","community":"\u793e\u533a\u70ed\u5e16"};
    return map[key] || key;
  }

  function varCSS(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#6366f1";
  }

  /* ---- 收藏/已读 ---- */
  function isFav(item) {
    var id = item.id || item.url || item.title;
    return state.favs.some(function(f) { return (f.id || f.url || f.title) === id; });
  }
  function toggleFav(item, btn) {
    var id = item.id || item.url || item.title;
    var idx = -1;
    for (var i = 0; i < state.favs.length; i++) {
      if ((state.favs[i].id || state.favs[i].url || state.favs[i].title) === id) { idx = i; break; }
    }
    if (idx >= 0) { state.favs.splice(idx, 1); btn.classList.remove("active"); }
    else { state.favs.push(Object.assign({}, item)); btn.classList.add("active"); }
    localStorage.setItem("aiRadar_favs", JSON.stringify(state.favs));
    updateFavCount();
  }
  function markRead(id) {
    state.readSet.add(id);
    localStorage.setItem("aiRadar_read", JSON.stringify(Array.from(state.readSet)));
  }

  /* ---- 错误展示（大字报+重试） ---- */
  var _lastLoadFn = null;
  function showError(title, detail) {
    // 智能检测 CORS 代理故障，给出更有用的提示
    var isCorsErr = /Failed to fetch|CORS|proxy|网络|fetch/i.test(detail || "");
    var hint = "";
    if (isCorsErr && !IS_LOCAL) {
      hint = "<br><small style='color:var(--accent);margin-top:8px;display:block'>"
        + "💡 公网模式依赖免费代理服务，偶尔会波动。<br>"
        + "稍等几秒点「重新加载」通常即可恢复，或使用本地版（localhost:8787）更稳定。</small>";
    }
    content.className = "grid";
    content.innerHTML = ""
      + '<div class="empty" style="border:1px solid var(--line);background:var(--card);border-radius:var(--radius);padding:40px 20px;">'
      +   '<span class="big">' + (isCorsErr ? "&#127760;" : "&#9888;") + '</span>'
      +   '<div style="font-size:16px;font-weight:700;margin:10px 0 6px">' + esc(title) + '</div>'
      +   '<div style="font-size:12.5px;color:var(--muted);margin-bottom:16px">' + esc(detail || "\u7f51\u7edc\u8fde\u63a5\u5f02\u5e38\uff0c\u8bf7\u68c0\u67e5\u4ee3\u7406\u662f\u5426\u8fd0\u884c") + hint + '</div>'
      +   '<button id="_retryBtn" style="display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;border:none;padding:8px 20px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:700"> &#x21BB; \u91cd\u65b0\u52a0\u8f7d </button>'
      + '</div>';
    setStatus("\u52a0\u8f7d\u5931\u8d25: " + detail, "err");
    var retryBtn = document.getElementById("_retryBtn");
    if (retryBtn) retryBtn.addEventListener("click", function() {
      if (_lastLoadFn) _lastLoadFn();
    });
    // 公网模式 + CORS 类错误 → 3 秒后自动重试一次（免费代理波动通常是秒级恢复）
    if (isCorsErr && !IS_LOCAL && _lastLoadFn) {
      clearTimeout(window._autoRetryTimer);
      window._autoRetryTimer = setTimeout(function() {
        var btn = document.getElementById("_retryBtn");
        if (btn) { btn.textContent = "⏳ 自动重试中…"; btn.disabled = true; }
        if (_lastLoadFn) _lastLoadFn();
      }, 3000);
    }
  }

  function updateFavCount() {
    $("#favCount").textContent = String(state.favs.length);
  }

  /* ---- 行业：入口墙 + 详情 + 导航 ---- */

  // 移除可能存在的行业返回栏（切换标签/返回墙时）
  function clearSectorHead() {
    var head = content.previousElementSibling;
    if (head && head.classList && head.classList.contains("view-head")) head.remove();
  }

  // 渲染"返回行业"导航栏（插入到内容区之前）
  function renderSectorHead(s) {
    clearSectorHead();
    var name = s.key === "all_industry" ? "全部动态" : s.key;
    var head = document.createElement("div");
    head.className = "view-head";
    head.innerHTML = '<span class="back" id="sectorBack">&#8592; 返回行业</span>'
      + '<h2>' + esc(name) + ' · 应用案例</h2>'
      + '<span class="scount">' + esc(s.sub || "") + '</span>';
    content.parentNode.insertBefore(head, content);
    document.getElementById("sectorBack").addEventListener("click", function() {
      renderSectorWall();
    });
  }

  // 判断一条资讯是否属于某行业（缓存池客户端分组用）
  function sectorMatch(item, sectorKey) {
    if (sectorKey === "all_industry") return true;
    var s = null;
    for (var i = 0; i < SECTORS.length; i++) { if (SECTORS[i].key === sectorKey) { s = SECTORS[i]; break; } }
    if (!s || !s.kw || !s.kw.length) return false;
    var hay = ((item.title || "") + " " + (item.summary || item.description || "")).toLowerCase();
    return s.kw.some(function(k) { return hay.indexOf(k.toLowerCase()) >= 0; });
  }

  // 行业入口墙（卡片改为 div，无锚点，绝不跳顶）
  function renderSectorWall() {
    state.industryView = "wall";
    state.currentSector = null;
    clearSectorHead();
    content.className = "sector-wall";
    var html = SECTORS.map(function(s) {
      return '<div class="sector-card" data-sector="' + esc(s.key) + '" style="--sc:' + s.color + ';--sc-soft:' + s.color + '18">'
        + '<div class="sc-ico">' + s.icon + '</div>'
        + '<div class="sc-name">' + (s.key === "all_industry" ? "\u5168\u90e8\u52a8\u6001" : s.key) + '</div>'
        + '<div class="sc-sub">' + s.sub + '</div>'
        + '<div class="sc-foot"><span class="sc-arrow">\u67e5\u770b\u6848\u4f8b &rarr;</span><span class="sc-count loading">\u2026</span></div>'
        + '</div>';
    }).join("");
    content.innerHTML = html;
    wireCards();
    countSectorBadges();     // 服务端轻量计数（准确）
    prefetchIndustryPool();   // 后台预取池（缓存加速详情打开）
  }

  // ── 徽标计数：用与 loadSectorItems 相同的服务端关键词策略，保证数字和点进去一致 ──
  async function countSectorBadges() {
    var since = new Date(Date.now() - 720 * 3600000).toISOString();   // 30 天窗口
    var counts = {};
    // all_industry 直接标大数
    try { counts["all_industry"] = 200; } catch(e) { counts["all_industry"] = null; }
    // 逐行业用最佳关键词搜 take:5 就够计数（省流量）
    var tasks = SECTORS.filter(function(s) { return s.key !== "all_industry"; }).map(function(s) {
      return (async function() {
        var bestN = 0;
        var kws = (s.kw && s.kw.length) ? s.kw.slice(0, 6) : [s.key];
        for (var i = 0; i < kws.length; i++) {
          try { var r = await aihotItems({ mode: "all", since: since, take: 5, q: kws[i] }); if (r.length > bestN) bestN = r.length; if (bestN >= 3) break; }
          catch(e2) {}
        }
        counts[s.key] = bestN > 0 ? bestN : 0;
      })();
    });
    await Promise.allSettled(tasks);
    // 写入 DOM
    state.sectorCounts = counts;
    content.querySelectorAll(".sector-card").forEach(function(card) {
      var key = card.dataset.sector;
      var n = counts[key];
      var badge = card.querySelector(".sc-count");
      if (!badge) return;
      badge.classList.remove("loading");
      if (typeof n === "number" && n > 0) { badge.textContent = n + "+ \u6761"; badge.classList.remove("zero"); }
      else if (typeof n === "number") { badge.textContent = "\u6709\u66f4\u65b0"; badge.classList.add("zero"); }
      else { badge.textContent = "~"; badge.classList.add("zero"); }
    });
  }

  // 预取全量池（后台缓存，加速详情打开；不再作为徽标唯一数据源）
  async function prefetchIndustryPool() {
    if (state.industryPoolLoaded) return;
    try {
      var since = new Date(Date.now() - 720 * 3600000).toISOString();
      var poolRaw = await aihotItems({ mode: "all", since: since, take: 200 });
      state.industryPool = processItems(poolRaw, filterOpts()).items;
      state.industryPoolLoaded = true;
      // 池就绪后若徽标还是 loading 状态（countSectorBadges 失败兜底），用池匹配补充
      content.querySelectorAll(".sc-count.loading").forEach(function(badge) {
        var card = badge.closest(".sector-card");
        if (!card) return;
        var key = card.dataset.sector;
        var n = state.sectorCounts[key];
        if (typeof n !== "number" || n === 0) {
          // 用池重新算一遍
          n = state.industryPool.filter(function(it) { return sectorMatch(it, key); }).length;
          if (n > 0) { badge.textContent = n + "+ \u6761"; badge.classList.remove("zero","loading"); }
          else { badge.textContent = "\u6709\u66f4\u65b0"; badge.classList.remove("loading"); badge.classList.add("zero"); }
        }
      });
    } catch (e) { /* 后台缓存失败不影响任何功能 */ }
  }

  // 打开某个行业详情
  function openSector(key) {
    var s = null;
    for (var i = 0; i < SECTORS.length; i++) { if (SECTORS[i].key === key) { s = SECTORS[i]; break; } }
    if (!s) s = { key: key, sub: "" };
    state.industryView = "sector";
    state.currentSector = key;
    renderSectorHead(s);
    loadSectorItems(key);
  }

  /* ---- 收藏视图 ---- */
  function renderFavs() {
    if (!state.favs.length) {
      content.className = "grid";
      content.innerHTML = '<div class="empty"><span class="big">&#9734;</span>\u8FD8\u6CA1\u6709\u6536\u85CF<br>\u70B9\u51FB\u5361\u7247\u53F3\u4E0B &#9734; \u5373\u53EF\u6536\u85CF</div>';
      return;
    }
    content.className = "grid";
    content.innerHTML = state.favs.map(cardHTML).join("");
    wireCards();
  }

  /* ---- 数据加载 ---- */
  var liveItems = [];

  // 加载资讯（统一入口，带 items 追踪 + 自动刷新）
  async function loadNewsData(silent) {
    if (!silent) { setStatus("\u6B63\u5728\u52A0\u8F7D AI \u8D44\u8BAF\u2026", ""); skeleton(6); }
    try {
      var since = new Date(Date.now() - state.hours * 3600000).toISOString();
      var raw = await aihotItems({
        mode: "all", since: since, take: 100,
        category: (state.cat && state.cat !== "all") ? state.cat : null,
        q: state.query || null
      });

      if (!raw.length) {
        setStatus("\u5F53\u524D\u6761\u4EF6\u6682\u65E0\u6570\u636E", "");
        content.innerHTML = '<div class="empty"><span class="big">&#128269;</span>\u6CA1\u6709\u627E\u5230\u76F8\u5173\u5185\u5BB9</div>';
        showStaleTime(); return;
      }

      var r = processItems(raw, filterOpts());
      liveItems = r.items;
      content.className = "grid";
      content.innerHTML = liveItems.map(cardHTML).join("");
      reportFilter(raw.length, r);
      wireCards(); fillTicker(liveItems);
      updateLastUpdated();
      scheduleAutoRefresh();
    } catch(e) {
      console.error("loadNewsData:", e);
      _lastLoadFn = loadNewsData;
      showError("AI \u8D44\u8BAF\u52A0\u8F7D\u5931\u8D25", e.message);
    }
  }

  // 加载论文
  async function loadPapersData(silent) {
    if (!silent) { setStatus("\u68C0\u7D22 arXiv \u8BBA\u6587\u2026", ""); skeleton(6); }
    try {
      var q = state.query || "artificial intelligence";
      var raw = await arxivItems(q, 30);

      if (!raw.length) {
        setStatus("\u672A\u627E\u5230\u5339\u914D\u8BBA\u6587", "");
        content.innerHTML = '<div class="empty"><span class="big">&#128214;</span>\u6CA1\u6709\u627E\u5230\u8BBA\u6587</div>';
        showStaleTime(); return;
      }

      var r = processItems(raw, filterOpts());
      liveItems = r.items;
      content.className = "grid";
      content.innerHTML = liveItems.map(cardHTML).join("");
      reportFilter(raw.length, r);
      wireCards();
      updateLastUpdated();
      scheduleAutoRefresh();
    } catch(e) {
      console.error("loadPapersData:", e);
      _lastLoadFn = loadPapersData;
      showError("\u8BBA\u6587\u52A0\u8F7D\u5931\u8D25", e.message);
    }
  }

  // 加载行业应用详情
  async function loadSectorItems(key, silent) {
    var label = key === "all_industry" ? "全部动态" : key;
    if (!silent) { setStatus("\u6B63\u5728\u52A0\u8F7D\u300C" + label + "\u300D\u5E94\u7528\u6848\u4F8B\u2026", ""); skeleton(6); }
    var q = state.query;
    try {
      var items = [];
      // 统一时间窗口：30 天，给数据少的行业更多覆盖
      var since = new Date(Date.now() - 720 * 3600000).toISOString();

      // 1) 命中已预取的全量池（即时，无网络等待）
      if (state.industryPoolLoaded) {
        items = state.industryPool.filter(function(it) { return sectorMatch(it, key); });
      }

      // 2) 服务端精确查询：专业关键词命中率远高于行业名单字
      //    池为空、或偏少（<20）时，去服务端再捞一遍，取命中最多的关键词组
      if (items.length === 0 || items.length < 20) {
        if (key === "all_industry") {
          items = await aihotItems({ mode: "all", since: since, take: 200, q: q || null });
        } else {
          // 获取该行业的最佳关键词
          var secDef = null;
          for (var si = 0; si < SECTORS.length; si++) {
            if (SECTORS[si].key === key) { secDef = SECTORS[si]; break; }
          }
          // 用每个关键词分别搜，取命中最多的
          var bestItems = [], bestKw = "";
          var searchKws = (secDef && secDef.kw && secDef.kw.length) ? secDef.kw.slice(0, 8) : [key];
          for (var ki = 0; ki < searchKws.length; ki++) {
            try {
              var kwResult = await aihotItems({ mode: "all", since: since, take: 50, q: searchKws[ki] });
              if (kwResult.length > bestItems.length) { bestItems = kwResult; bestKw = searchKws[ki]; }
              if (bestItems.length >= 20) break;   // 够多了就不再试
            } catch(e2) { /* 单词失败继续下一个 */ }
          }
          if (bestItems.length > items.length) { items = bestItems; }
        }
      }

      // 用户额外搜索词过滤（对最终集合生效）
      if (q && items.length) {
        var lowQ = q.toLowerCase();
        items = items.filter(function(it) {
          return ((it.title || "") + " " + (it.summary || it.description || "")).toLowerCase().indexOf(lowQ) >= 0;
        });
      }

      // 3) 兜底A：从预取全量池做客户端全文匹配
      if (!items.length && key !== "all_industry" && state.industryPoolLoaded && state.industryPool.length) {
        items = state.industryPool.filter(function(it) { return sectorMatch(it, key); });
      }
      // 3) 兜底B：拿 category=industry
      if (!items.length && key !== "all_industry") {
        items = await aihotItems({ mode: "all", since: since, take: 50, category: "industry" });
      }

      // 统一过滤：去重 + 去垃圾 + 质量评分
      var rawLen = items.length;
      var r = processItems(items, filterOpts());
      liveItems = r.items;

      if (!liveItems.length) {
        setStatus("\u300C" + label + "\u300D\u6682\u65E0\u8FD1\u671F\u6848\u4F8B", "");
        content.innerHTML = '<div class="empty"><span class="big">&#x1F3ED;</span>'
          + '\u8BE5\u884C\u4E1A\u6682\u65E0\u6700\u65B0\u6848\u4F8B<br><small>\u53EF\u5207\u6362\u5230\u5176\u4ED6\u884C\u4E1A\u6216\u6269\u5927\u65F6\u95F4</small></div>';
        showStaleTime(); return;
      }

      content.className = "grid";
      content.innerHTML = liveItems.map(cardHTML).join("");
      reportFilter(rawLen, r);
      wireCards(); fillTicker(liveItems);
      updateLastUpdated();
      scheduleAutoRefresh();
    } catch (e) {
      console.error("loadSectorItems:", e);
      _lastLoadFn = function() { loadSectorItems(key); };
      showError("\u300C" + label + "\u300D\u52A0\u8F7D\u5931\u8D25", e.message);
    }
  }

  // 加载 Hacker News 社区热帖
  async function loadHNData(silent) {
    if (!silent) { setStatus("检索 Hacker News 社区热帖…", ""); skeleton(6); }
    try {
      var q = state.query || "artificial intelligence";
      var raw = await hnItems(q);

      if (!raw.length) {
        setStatus("未找到社区热帖", "");
        content.innerHTML = '<div class="empty"><span class="big">💬</span>没有找到相关热帖</div>';
        showStaleTime(); return;
      }

      var r = processItems(raw, filterOpts());
      liveItems = r.items;
      content.className = "grid";
      content.innerHTML = liveItems.map(cardHTML).join("");
      reportFilter(raw.length, r);
      wireCards();
      updateLastUpdated();
      scheduleAutoRefresh();
    } catch (e) {
      console.error("loadHNData:", e);
      _lastLoadFn = loadHNData;
      showError("社区热帖加载失败", e.message);
    }
  }

  /* ---- 统一加载入口 ---- */
  function loadAll(silent) {
    switch (state.tab) {
      case "papers": clearSectorHead(); loadPapersData(silent); break;
      case "industry":
        if (state.industryView === "wall") {
          if (state.query) openSector("all_industry");   // 墙上直接搜 → 进全部动态并过滤
          else renderSectorWall();
        } else {
          loadSectorItems(state.currentSector, silent);
        }
        break;
      case "community": clearSectorHead(); loadHNData(silent); break;
      default: clearSectorHead(); loadNewsData(silent); break;
    }
  }

  /* ---- 跑马灯 ---- */
  function fillTicker(items) {
    var track = $("#tickerTrack");
    if (!track || !items || !items.length) return;
    var html = items.slice(0, 14).map(function(it) {
      var u = (it.url || "").indexOf("http") === 0 ? ' data-url="' + esc(it.url) + '"' : "";
      return '<span class="ticker-item"' + u + '>' + esc(it.title || "") + '</span>';
    }).join("");
    track.innerHTML = html + html;
  }

  /* ---- 事件绑定 ---- */
  function wireCards() {
    // 卡片点击
    var cards = content.querySelectorAll(".card");
    cards.forEach(function(card) {
      card.addEventListener("click", function(e) {
        if (e.target.closest(".star")) return;
        if (e.target.closest(".expand-btn")) return;
        var id = card.dataset.id;
        var url = card.dataset.url;
        if (id) markRead(id);
        card.classList.add("read");
        if (url) window.open(url, "_blank", "noopener");
      });

      // 展开/收起
      var expBtn = card.querySelector(".expand-btn");
      if (expBtn) {
        expBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          var p = card.querySelector(".summary");
          var expanded = p.classList.toggle("expanded");
          expBtn.textContent = expanded ? "\u6536\u8D77 \u25B4" : "\u5C55\u5F00 \u25BC";
        });
      }

      // 收藏
      var starBtn = card.querySelector(".star");
      if (starBtn) {
        starBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          var allCards = Array.from(document.querySelectorAll(".card"));
          var idx = allCards.indexOf(card);
          if (liveItems[idx]) toggleFav(liveItems[idx], starBtn);
        });
      }
    });

    // 行业卡片点击（div 元素，无锚点，不会跳回顶部）
    var secCards = content.querySelectorAll(".sector-card");
    secCards.forEach(function(sc) {
      sc.addEventListener("click", function(e) {
        e.preventDefault(); e.stopPropagation();
        openSector(sc.dataset.sector);
      });
    });
  }

  function getCurrentItems() { return liveItems; }

  /* ---- 主题切换 ---- */
  function initTheme() {
    var saved = localStorage.getItem("aiRadar_theme");
    var prefersDark = window.matchMedia("(prefers-color-scheme:dark)").matches;
    var theme = saved || (prefersDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    var btn = $("#themeToggle");
    btn.textContent = theme === "dark" ? "\u2600\uFE0F" : "\u{1F319}";
    btn.addEventListener("click", function() {
      var cur = document.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("aiRadar_theme", next);
      btn.textContent = next === "dark" ? "\u2600\uFE0F" : "\u{1F319}";
    });
  }

  /* ===== 初始化 ===== */
  initTheme();
  updateFavCount();

  // 标签切换
  $("#mainTabs").addEventListener("click", function(e) {
    var btn = e.target.closest(".tab");
    if (!btn) return;
    document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("active"); });
    btn.classList.add("active");
    state.tab = btn.dataset.tab;
    catChips.classList.toggle("hidden", state.tab !== "news");
      searchInput.placeholder = state.tab === "papers"
        ? "\u641C\u7D22\u8BBA\u6587\u5173\u952E\u8BD5\u2026"
        : state.tab === "community"
          ? "\u641C\u7D22 HN \u70ED\u5E16\u5173\u952E\u8BCD\u2026"
          : state.tab === "industry"
            ? "\u641C\u7D22\u5E94\u7528\u573A\u666F\u2026"
            : "\u641C\u7D22\u5173\u952E\u8BD5\uff08\u5982 OpenAI / Agent / RAG\uff09\u2026";
    if (state.tab === "industry") state.industryView = "wall";
    loadAll();
  });

  // 分类 chip
  catChips.addEventListener("click", function(e) {
    var btn = e.target.closest(".chip");
    if (!btn) return;
    document.querySelectorAll(".chip").forEach(function(c) { c.classList.remove("active"); });
    btn.classList.add("active");
    state.cat = btn.dataset.cat;
    loadAll();
  });

  // 时间窗
  timeSelect.addEventListener("change", function() {
    state.hours = parseInt(timeSelect.value, 10);
    loadAll();
  });

  // 搜索防抖
  var timer = null;
  searchInput.addEventListener("input", function() {
    clearTimeout(timer);
    timer = setTimeout(function() {
      state.query = searchInput.value.trim();
      loadAll();
    }, 350);
  });

  // 智能过滤开关
  document.querySelectorAll(".ftoggle").forEach(function(b) {
    b.addEventListener("click", function() {
      var f = b.dataset.f;
      if (f === "quality") state.filter.quality = !state.filter.quality;
      else state.filter[f] = !state.filter[f];
      var on = (f === "quality") ? state.filter.quality : state.filter[f];
      b.classList.toggle("active", on);
      loadAll();
    });
  });

  // 收藏按钮
  $("#favBtn").addEventListener("click", function() { renderFavs(); });

  // 刷新按钮（顶部 + 更新时间栏）
  var refreshBtn = document.getElementById("refreshBtn");
  var luRefreshBtn = document.getElementById("luRefresh");
  function doManualRefresh() {
    if (refreshBtn) { refreshBtn.innerHTML = '<span class="spin">🔄</span>'; }
    if (luRefreshBtn) { luRefreshBtn.innerHTML = '<span class="spin">🔄</span> 刷新中'; }
    clearAutoRefresh();
    loadAll(false);
    // 恢复图标
    setTimeout(function() {
      if (refreshBtn) refreshBtn.innerHTML = "🔄";
      if (luRefreshBtn) luRefreshBtn.innerHTML = "刷新";
    }, 1500);
  }
  if (refreshBtn) refreshBtn.addEventListener("click", doManualRefresh);
  if (luRefreshBtn) luRefreshBtn.addEventListener("click", doManualRefresh);

  // 跑马灯点击
  document.addEventListener("click", function(e) {
    var t = e.target.closest(".ticker-item");
    if (!t) return;
    var u = t.dataset.url;
    if (u) window.open(u, "_blank", "noopener");
  });

  /* ---- 下拉刷新（移动端手势） ---- */
  function setupPullToRefresh() {
    var wrap = $(".wrap");
    if (!wrap) return;
    var ptr = document.createElement("div");
    ptr.className = "ptr";
    ptr.innerHTML = '<span class="ptr-ico">↓</span><span class="ptr-txt">下拉刷新</span>';
    document.body.appendChild(ptr);
    var ico = ptr.querySelector(".ptr-ico");
    var txt = ptr.querySelector(".ptr-txt");

    var THRESHOLD = 64, MAX = 120;
    var startY = 0, pulling = false, dist = 0, refreshing = false;
    ptrCtl = { active: false, finish: finish };

    function setT(v) { ptr.style.transform = "translateY(" + v + "px)"; }
    function show(d) {
      dist = d;
      ptr.style.opacity = Math.min(1, dist / THRESHOLD);
      setT(dist - 56);
      if (wrap) wrap.style.transform = "translateY(" + dist + "px)";
      var over = dist >= THRESHOLD;
      ico.textContent = over ? "↑" : "↓";
      txt.textContent = over ? "释放立即刷新" : "下拉刷新";
    }
    function reset() {
      ptr.style.transition = "transform .3s ease, opacity .3s ease";
      if (wrap) wrap.style.transition = "transform .3s ease";
      setT(-56); ptr.style.opacity = "0";
      if (wrap) wrap.style.transform = "";
      setTimeout(function() { ptr.style.transition = ""; if (wrap) wrap.style.transition = ""; }, 320);
    }
    function finish() {
      refreshing = false; ptrCtl.active = false;
      if (ico) { ico.textContent = "↓"; ico.classList.remove("spin"); }
      if (txt) txt.textContent = "下拉刷新";
      reset();
    }

    function onStart(e) {
      if (refreshing) return;
      if (window.scrollY > 0) return;      // 仅在顶部触发
      startY = e.touches[0].clientY;
      pulling = true;
    }
    function onMove(e) {
      if (!pulling) return;
      var dy = e.touches[0].clientY - startY;
      if (dy <= 0) { if (dist) show(0); return; }
      if (e.cancelable) e.preventDefault();  // 阻止原生回弹，实现橡皮筋手感
      show(Math.min(MAX, dy * 0.5));        // 阻尼系数 0.5
    }
    function onEnd() {
      if (!pulling) return;
      pulling = false;
      if (dist >= THRESHOLD) {
        refreshing = true; ptrCtl.active = true;
        ptr.style.transition = "transform .25s ease, opacity .25s ease";
        setT(0); ptr.style.opacity = "1";
        if (wrap) { wrap.style.transition = "transform .25s ease"; wrap.style.transform = "translateY(56px)"; }
        ico.classList.add("spin"); ico.textContent = "🔄";
        txt.textContent = "正在刷新…";
        clearAutoRefresh();
        loadAll(false);
        setTimeout(function() { if (refreshing) finish(); }, 6000);  // 网络异常兜底复位
      } else {
        reset();
      }
      dist = 0;
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
  }

  // 首次加载
  setupPullToRefresh();
  showStaleTime();
  loadAll();

})();
