// 合并 VNDB 列表（data.json）与 Notion a/b/c，输出最终 data.json。只写入白名单字段。
// 状态拿不准的条目不猜：写进日志的“待确认”清单（只含链接，不含价格/备注）。
import { readFile, writeFile } from "node:fs/promises";

const NT = process.env.NOTION_TOKEN;
const DB = { a: process.env.NOTION_DB_A, b: process.env.NOTION_DB_B, c: process.env.NOTION_DB_C };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RANK = { wish: 0, play: 1, done: 2 };            // 愿望单 < 在玩 < 已完成
const best = (x, y) => (RANK[y] > RANK[x] ? y : x);
const pending = [];

// ---------- 网络 ----------
async function notion(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://api.notion.com/v1" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${NT}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" }
    });
    if (r.status === 429) { await sleep((+r.headers.get("retry-after") || 2) * 1000); continue; }
    if (!r.ok) throw new Error(`Notion ${path} -> ${r.status}`);
    await sleep(350);
    return r.json();
  }
  throw new Error("Notion 多次被限速");
}
async function vndb(path, body) {
  const r = await fetch("https://api.vndb.org/kana" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`VNDB ${path} -> ${r.status} ${await r.text()}`);
  await sleep(350);
  return r.json();
}
async function queryAll(dbId) {
  const ds = (await notion("GET", `/databases/${dbId}`)).data_sources[0].id;
  const out = []; let cursor;
  do {
    const j = await notion("POST", `/data_sources/${ds}/query`, { page_size: 100, ...(cursor && { start_cursor: cursor }) });
    out.push(...j.results); cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ---------- 字段读取 ----------
const txt = p => {
  if (!p) return "";
  switch (p.type) {
    case "title": return p.title.map(t => t.plain_text).join("");
    case "rich_text": return p.rich_text.map(t => t.plain_text).join("");
    case "url": return p.url ?? "";
    case "select": return p.select?.name ?? "";
    case "status": return p.status?.name ?? "";
    case "date": return p.date?.start ?? "";
    case "formula": {
      const f = p.formula;
      if (f.type === "date") return f.date?.start ?? "";
      if (f.type === "boolean") return f.boolean ? "true" : "";
      return f[f.type] == null ? "" : String(f[f.type]);
    }
    default: return "";
  }
};
// Notion 里的链接可能没写 https://，补全，否则浏览器会当成相对路径
const fix = u => /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : "https://" + u.replace(/^\/+/, "");
const day = d => (d || "").slice(0, 10);
// 时长字段（小时）：数字或返回数字的公式；<=0 当作没有
const num = p => {
  if (!p) return null;
  const v = p.type === "number" ? p.number
    : p.type === "formula" ? (p.formula.type === "number" ? p.formula.number : parseFloat(p.formula.string)) : NaN;
  return v > 0 ? v : null;
};
const multi = p => p?.multi_select?.map(x => x.name) ?? [];
const rel = p => p?.relation?.map(x => x.id) ?? [];
const ext = p => p?.files?.find(f => f.type === "external")?.external.url ?? "";   // Notion 托管封面会过期，先留空

// ---------- VNDB 标题规则（与 fetch-vndb.mjs 一致）----------
function pickTitle(titles, fallback) {
  const hans = titles.filter(x => ["zh-Hans", "zh"].includes(x.lang)).sort((a, b) => b.official - a.official)[0];
  const off = lang => titles.find(x => x.lang === lang && x.official)?.title;
  return hans?.title ?? off("zh-Hant") ?? off("ja") ?? off("en") ?? fallback;
}
const toInfo = v => {
  const t = v.titles ?? [], title = pickTitle(t, v.title);
  const orig = t.find(x => x.main)?.title ?? v.alttitle ?? "";
  return { id: v.id, title, subtitle: orig && orig !== title ? orig : "", released: v.released ?? "",
    thumb: v.image?.thumbnail ?? v.image?.url ?? "" };
};

// ---------- Steam 封面 ----------
// 优先级：简中专属 2x > 繁中专属 2x > 默认 2x > 简中专属 1x > 繁中专属 1x > 默认 1x
// “专属”= 该语言返回的文件名与英文（默认）版本不同。地址必须用接口返回的格式拼，旧式 appid+文件名会 404。
async function steamCovers(appids) {
  const get = async (ids, language) => {
    const input = { ids: ids.map(appid => ({ appid })), context: { language, country_code: "CN" }, data_request: { include_assets: true } };
    const r = await fetch("https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=" + encodeURIComponent(JSON.stringify(input)));
    if (!r.ok) throw new Error(`Steam GetItems(${language}) -> ${r.status}`);
    return (await r.json()).response?.store_items ?? [];
  };
  const res = { schinese: new Map(), tchinese: new Map(), english: new Map() };
  for (const lang of Object.keys(res))
    for (let i = 0; i < appids.length; i += 40) {
      for (const it of await get(appids.slice(i, i + 40), lang)) res[lang].set(it.appid ?? it.id, it.assets ?? {});
      await sleep(300);
    }
  const out = new Map();
  for (const id of appids) {
    const s = res.schinese.get(id) ?? {}, t = res.tchinese.get(id) ?? {}, e = res.english.get(id) ?? {}, cand = [];
    for (const k of ["library_capsule_2x", "library_capsule"]) {
      if (s[k] && s[k] !== e[k]) cand.push([s.asset_url_format, s[k]]);
      if (t[k] && t[k] !== e[k]) cand.push([t.asset_url_format, t[k]]);
      if (e[k]) cand.push([e.asset_url_format, e[k]]);
    }
    const [fmt, file] = cand[0] ?? [];
    if (fmt && file) out.set(id, "https://shared.akamai.steamstatic.com/store_item_assets/" + fmt.replace("${FILENAME}", file));
  }
  return out;
}

// ---------- 节点 ----------
const list = JSON.parse(await readFile("data.json", "utf8"));
const nodes = new Map(), edges = [];
const add = n => nodes.set(n.key, { store: [], guide: [], tags: [], started: "", finished: "", hours: null, ...n });

// VNDB 列表：Finished/Playing/Wishlist（及你的自定义愿望单标签）。搁置/放弃不在白名单里，已被 fetch-vndb 过滤。
const LABEL = { finished: "done", playing: "play", wishlist: "wish", "🎮想玩的ns": "wish" };
const info = new Map();
for (const it of list.items) {
  info.set(it.id, it);
  let st = null;
  for (const l of it.labels ?? []) {
    const s = LABEL[l.toLowerCase()];
    if (s) st = st ? best(st, s) : s;
    else pending.push([`VNDB 标签「${l}」没有对应状态`, "https://vndb.org/" + it.id]);
  }
  // 愿望单小标签：VNDB 的 Wishlist 和你的自定义愿望单标签
  const VTAG = { wishlist: "VNDB愿望单", "🎮想玩的ns": "🎮想玩的ns" };
  const tags = st === "wish" ? (it.labels ?? []).map(l => VTAG[l.toLowerCase()]).filter(Boolean) : [];
  if (st) add({ key: "v:" + it.id, src: "vndb", status: st, vn: it.id, tags, started: day(it.started), finished: day(it.finished) });
}

const base = (src, pg, status, P, dateProp) => {
  const m = txt(P["VNDB"]).match(/vndb\.org\/([vr]\d+)|^([vr]\d+)$/i);
  const id = (m?.[1] ?? m?.[2] ?? "").toLowerCase();
  return {
    store: [], guide: [], tags: [], started: "", finished: "", hours: null,
    key: `${src}:${pg.id}`, src, status, title: txt(P["名称"]).trim(), cover: ext(P["封面"]),
    released: day(txt(P[dateProp])), notion: pg.url, edited: Date.parse(pg.last_edited_time) / 1000 || 0,
    vn: id.startsWith("v") ? id : "", rel: id.startsWith("r") ? id : ""
  };
};

const stat = { aSkipped: 0, bNone: 0, bNoneDated: 0 };
if (NT) {
  const A = DB.a ? await queryAll(DB.a) : [], B = DB.b ? await queryAll(DB.b) : [], C = DB.c ? await queryAll(DB.c) : [];

  // a 实体卡带：制作含“实物”的整行排除；日期优先，都没有再按状态映射
  const A_MAP = { 要玩: "wish", 可以: "wish", 续作: "wish", 已购: "play", 出售: "done", 其他: "done" };
  for (const pg of A) {
    const P = pg.properties;
    if (multi(P["制作"]).includes("实物")) { stat.aSkipped++; continue; }
    const st = txt(P["全流程日期"]) ? "done" : txt(P["购入日期"]) ? "play" : A_MAP[txt(P["状态"])];
    if (!st) { pending.push([`a 库状态「${txt(P["状态"]) || "空"}」无法判断`, pg.url]); continue; }
    const n = base("a", pg, st, P, "发售日期");
    n.finished = day(txt(P["全流程日期"])); n.hours = num(P["全流程时长"]);      // 全流程日期是单个日期（通关当天）
    if (st === "wish") n.tags = [txt(P["状态"])];                                // 要玩 / 可以 / 续作
    if (txt(P["NS"])) n.store.push({ label: "NS", url: fix(txt(P["NS"])) });
    if (txt(P["攻略"])) n.guide.push(fix(txt(P["攻略"])));
    rel(P["游戏愿望单"]).forEach(id => edges.push([n.key, "b:" + id]));
    add(n);
  }

  // b PC：勾选决定是否记录；日期优先区分在玩/已完成
  for (const pg of B) {
    const P = pg.properties, lib = P["库"]?.checkbox, wish = P["愿望单"]?.checkbox, q = txt(P["期待"]);
    const dated = txt(P["全成就日期"]) || txt(P["入库日期"]);
    if (!lib && !wish) { stat.bNone++; if (dated) stat.bNoneDated++; continue; }
    const st = txt(P["全成就日期"]) ? "done" : txt(P["入库日期"]) ? "play"
      : lib ? (q === "已完成" ? "done" : "play") : "wish";
    const n = base("b", pg, st, P, "发行日期");
    n.started = day(txt(P["入库日期"])); n.finished = day(txt(P["全成就日期"]));
    n.hours = num(P["全成就时长"]) ?? num(P["Steam时长"]);                         // 先全成就时长，没有再用 Steam 时长
    n.tags = st === "wish" && q === "进行中" ? ["进行中"] : [];
    if (txt(P["Steam"])) n.store.push({ label: "Steam", url: fix(txt(P["Steam"])) });
    n.appid = +(txt(P["Steam"]).match(/store\.steampowered\.com\/app\/(\d+)/)?.[1] ?? 0);
    add(n);
  }

  // c 游玩记录：没有结束日期 = 在玩
  for (const pg of C) {
    const P = pg.properties;
    const n = base("c", pg, txt(P["结束日期"]) ? "done" : "play", P, "发行");
    n.started = day(txt(P["开始日期"])); n.finished = day(txt(P["结束日期"])); n.hours = num(P["时长"]);
    rel(P["主机愿望单"]).forEach(id => edges.push([n.key, "a:" + id]));
    rel(P["游戏愿望单"]).forEach(id => edges.push([n.key, "b:" + id]));
    add(n);
  }
}

// ---------- 版本链接 r -> 所属作品 v ----------
const rs = [...new Set([...nodes.values()].map(n => n.rel).filter(Boolean))], rmap = {};
for (let i = 0; i < rs.length; i += 20) {
  const ids = rs.slice(i, i + 20);
  const j = await vndb("/release", {
    filters: ids.length === 1 ? ["id", "=", ids[0]] : ["or", ...ids.map(x => ["id", "=", x])],
    fields: "id,vns{id}", results: 100
  });
  for (const r of j.results) rmap[r.id] = (r.vns ?? []).map(v => v.id);
}
for (const n of nodes.values()) if (n.rel) {
  const v = rmap[n.rel];
  if (v?.length === 1) n.vn = v[0];
  else pending.push([`版本 ${n.rel} 无法确定所属作品`, n.notion]);
}

// ---------- 并查集：按关联和 VNDB 作品合并成“同一个游戏” ----------
const parent = new Map([...nodes.keys()].map(k => [k, k]));
const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
const union = (x, y) => { if (nodes.has(x) && nodes.has(y)) parent.set(find(x), find(y)); };
edges.forEach(([x, y]) => union(x, y));
const byVn = new Map();
for (const n of nodes.values()) if (n.vn) { if (byVn.has(n.vn)) union(n.key, byVn.get(n.vn)); else byVn.set(n.vn, n.key); }
const groups = new Map();
for (const n of nodes.values()) { const r = find(n.key); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }

// 不在你 VNDB 列表里的作品，补查标题和封面
const missing = [...new Set([...nodes.values()].map(n => n.vn).filter(v => v && !info.has(v)))];
for (let i = 0; i < missing.length; i += 20) {
  const ids = missing.slice(i, i + 20);
  const j = await vndb("/vn", {
    filters: ids.length === 1 ? ["id", "=", ids[0]] : ["or", ...ids.map(x => ["id", "=", x])],
    fields: "id,title,alttitle,titles{lang,title,official,main},released,image{url,thumbnail}", results: 100
  });
  for (const v of j.results) info.set(v.id, toInfo(v));
}

const appids = [...new Set([...nodes.values()].map(n => n.appid).filter(Boolean))];
const steam = appids.length
  ? await steamCovers(appids).catch(e => { console.log("Steam 封面获取失败，改用其他封面：", e.message); return new Map(); })
  : new Map();
console.log(`Steam 封面：${steam.size}/${appids.length}`);

// ---------- 输出 ----------
const items = [];
for (const ns of groups.values()) {
  const nn = ns.filter(n => n.src !== "vndb");
  const vnIds = [...new Set(ns.map(n => n.vn).filter(Boolean))];
  if (vnIds.length > 1) pending.push([`同一游戏对应多个 VNDB 作品：${vnIds.join(", ")}`, nn[0]?.notion ?? ""]);
  const vnId = vnIds[0] ?? "", f = info.get(vnId);
  const status = ns.map(n => n.status).reduce(best);
  const pick = (fn, order = ["b", "a", "c"]) => order.map(s => nn.find(n => n.src === s)).filter(Boolean).map(fn).find(Boolean);
  const ORDER = ["vndb", "c", "a", "b"];   // 起止时间/时长的来源优先级（VNDB 没有时长字段）
  const first = k => ORDER.flatMap(s => ns.filter(n => n.src === s)).map(n => n[k]).find(v => v);
  const one = ["c", "b", "a"].map(s => nn.find(n => n.src === s)).filter(Boolean).slice(0, 1);   // 只给一个 Notion 链接，优先 c > b > a
  items.push({
    id: vnId || ns[0].key,
    sources: [...new Set(ns.map(n => n.src))],
    title: f?.title || pick(n => n.title, ["c", "a", "b"]) || "（无标题）",
    subtitle: f?.subtitle ?? "",
    released: pick(n => n.released, ["c", "a", "b"]) || f?.released || "",   // 发售日期来源：c > a > b > VNDB
    cover: steam.get(nn.find(n => n.appid)?.appid) || f?.thumb || pick(n => n.cover) || "",   // Steam > VNDB > Notion 外链
    status,
    tags: status === "wish" ? [...new Set(["a", "b", "c", "vndb"].flatMap(s => ns.filter(n => n.src === s).flatMap(n => n.tags)))] : [],
    vote: f?.vote ?? null,
    started: first("started") ?? "",
    finished: first("finished") ?? "",
    hours: first("hours") ?? null,
    releases: f?.releases ?? [],
    links: {
      notion: one.map(n => ({ src: n.src, url: n.notion })),
      store: nn.flatMap(n => n.store),
      guide: nn.flatMap(n => n.guide),
      vndb: vnId
    },
    lastmod: Math.max(f?.lastmod ?? 0, ...nn.map(n => n.edited))
  });
}

await writeFile("data.json", JSON.stringify({ updated: new Date().toISOString(), items }, null, 1));

const cnt = s => items.filter(i => i.status === s).length;
console.log(`输出 ${items.length} 条：愿望单 ${cnt("wish")}，在玩 ${cnt("play")}，已完成 ${cnt("done")}`);
console.log(`排除：a 实物 ${stat.aSkipped}；b 未勾选 ${stat.bNone}（其中带日期 ${stat.bNoneDated}，未输出，如需记录请告诉我）`);
console.log(`待确认 ${pending.length} 条（只列原因和链接）：`);
pending.forEach(([why, url]) => console.log(" -", why, url));
