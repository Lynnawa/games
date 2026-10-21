// Steam 封面检查：只输出统计数字和素材字段样例（Steam 素材是公开信息），不输出游戏名或任何 Notion 内容
const NT = process.env.NOTION_TOKEN, DBB = process.env.NOTION_DB_B, KEY = process.env.STEAM_API_KEY;
if (!NT || !DBB) throw new Error("缺少 NOTION_TOKEN 或 NOTION_DB_B");
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
async function queryAll(dbId) {
  const ds = (await notion("GET", `/databases/${dbId}`)).data_sources[0].id;
  const out = []; let cursor;
  do {
    const j = await notion("POST", `/data_sources/${ds}/query`, { page_size: 100, ...(cursor && { start_cursor: cursor }) });
    out.push(...j.results); cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return out;
}

// 1) 从 b 库的 Steam 链接取 appid
const rows = await queryAll(DBB);
const ids = []; let empty = 0, bad = 0;
for (const pg of rows) {
  const u = pg.properties["Steam"]?.url ?? "";
  if (!u) { empty++; continue; }
  const m = u.match(/store\.steampowered\.com\/app\/(\d+)/);
  if (m) ids.push(+m[1]); else bad++;
}
const uniq = [...new Set(ids)];
console.log(`b 库 ${rows.length} 行：Steam 链接为空 ${empty}，格式无法解析 ${bad}，有效 appid ${uniq.length} 个`);

// 2) 向 Steam 商店接口查询素材清单（按语言）
async function getItems(appids, language) {
  const input = { ids: appids.map(appid => ({ appid })), context: { language, country_code: "CN" }, data_request: { include_assets: true } };
  const url = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=" + encodeURIComponent(JSON.stringify(input));
  let r = await fetch(url);
  if ((r.status === 401 || r.status === 403) && KEY) { console.log("  无 key 被拒绝，改用 STEAM_API_KEY 重试"); r = await fetch(url + "&key=" + KEY); }
  if (!r.ok) throw new Error(`GetItems(${language}) -> ${r.status}`);
  return (await r.json()).response?.store_items ?? [];
}
const LANGS = ["schinese", "tchinese", "english"], res = {};
for (const lang of LANGS) {
  res[lang] = new Map();
  for (let i = 0; i < uniq.length; i += 40) {
    for (const it of await getItems(uniq.slice(i, i + 40), lang)) res[lang].set(it.appid ?? it.id, it);
    await sleep(300);
  }
  const all = [...res[lang].values()], A = it => it.assets ?? {};
  console.log(`[${lang}] 返回 ${all.length} 项；有 assets ${all.filter(it => it.assets).length}；` +
    `有 library_capsule_2x ${all.filter(it => A(it).library_capsule_2x).length}；有 library_capsule ${all.filter(it => A(it).library_capsule).length}`);
}

// 3) 简中/繁中是否有专属文件（和英文版文件名不同）
const fname = (lang, id) => res[lang].get(id)?.assets?.library_capsule_2x ?? res[lang].get(id)?.assets?.library_capsule ?? "";
let zhS = 0, zhT = 0;
for (const id of uniq) {
  const en = fname("english", id);
  if (fname("schinese", id) && fname("schinese", id) !== en) zhS++;
  if (fname("tchinese", id) && fname("tchinese", id) !== en) zhT++;
}
console.log(`有简中专属封面 ${zhS} 个，有繁中专属封面 ${zhT} 个（文件名与英文版不同）`);

// 4) 字段样例 + 地址拼接验证（取前 5 个）
const sample = [...res.english.values()][0];
if (sample) {
  console.log("assets 字段名：", Object.keys(sample.assets ?? {}).join(", "));
  console.log("assets 样例：", JSON.stringify(sample.assets ?? {}).slice(0, 600));
}
for (const it of [...res.english.values()].slice(0, 5)) {
  const a = it.assets ?? {}, id = it.appid ?? it.id, file = a.library_capsule_2x || a.library_capsule;
  const urls = [];
  if (a.asset_url_format && file) urls.push(["接口格式", "https://shared.akamai.steamstatic.com/store_item_assets/" + a.asset_url_format.replace("${FILENAME}", file)]);
  urls.push(["旧式拼接", `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/library_capsule_2x.jpg`]);
  for (const [name, u] of urls) { const r = await fetch(u, { method: "HEAD" }); console.log(`  appid ${id} ${name}：HTTP ${r.status}`); }
}
