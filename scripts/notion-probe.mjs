// Notion 连通性检查：只输出字段名、类型和各字段的填写数量，不打印任何条目内容
// 公开仓库的 Actions 日志是公开的，所以这里绝不输出标题、价格、备注等内容
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) throw new Error("缺少 NOTION_TOKEN");
const VN_PROP = process.env.VNDB_PROP || "VNDB";   // 存放 VNDB 链接的字段名

const dbs = { a: process.env.NOTION_DB_A, b: process.env.NOTION_DB_B, c: process.env.NOTION_DB_C };
const H = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://api.notion.com/v1" + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep((+r.headers.get("retry-after") || 2) * 1000); continue; }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.json().catch(() => ({}))).message ?? ""}`);
    await sleep(350);                               // 限速约每秒 3 次
    return r.json();
  }
  throw new Error(`${path} 多次被限速`);
}

function filled(p) {
  switch (p.type) {
    case "title": return p.title.some(t => t.plain_text.trim());
    case "rich_text": return p.rich_text.some(t => t.plain_text.trim());
    case "url": return !!p.url;
    case "select": case "status": return !!p[p.type];
    case "multi_select": return p.multi_select.length > 0;
    case "number": return p.number !== null;
    case "date": return !!p.date;
    case "checkbox": return p.checkbox;
    case "relation": return p.relation.length > 0;
    case "files": return p.files.length > 0;
    case "formula": { const v = p.formula[p.formula.type]; return v != null && v !== ""; }
    case "rollup": { const v = p.rollup; return v.type === "array" ? v.array.length > 0 : v[v.type] != null; }
    default: return false;
  }
}

const textOf = p => !p ? "" :
  p.type === "url" ? p.url ?? "" :
  p.type === "rich_text" ? p.rich_text.map(t => t.plain_text).join("") :
  p.type === "formula" ? p.formula.string ?? p.formula.url ?? "" : "";

for (const [key, id] of Object.entries(dbs)) {
  if (!id) { console.log(`\n[库 ${key}] 未设置 NOTION_DB_${key.toUpperCase()}，跳过`); continue; }
  console.log(`\n===== 库 ${key} =====`);
  try {
    const db = await api("GET", `/databases/${id}`);
    const sources = db.data_sources ?? [];
    console.log(`可访问，数据源数量：${sources.length}`);
    if (!sources.length) continue;
    if (sources.length > 1) console.log("注意：有多个数据源，这里只检查第一个");
    const ds = sources[0].id;

    const schema = await api("GET", `/data_sources/${ds}`);
    const props = Object.entries(schema.properties).map(([name, v]) => ({ name, type: v.type }));
    const count = Object.fromEntries(props.map(p => [p.name, 0]));
    const hosted = {};                              // 封面等文件字段：Notion 托管（会过期）的行数
    const vn = { none: 0, vn: 0, release: 0, other: 0 };
    let rows = 0, cursor;

    do {
      const j = await api("POST", `/data_sources/${ds}/query`, { page_size: 100, ...(cursor && { start_cursor: cursor }) });
      for (const page of j.results) {
        rows++;
        for (const [name, p] of Object.entries(page.properties)) {
          if (filled(p)) count[name]++;
          if (p.type === "files" && p.files.some(f => f.type === "file")) hosted[name] = (hosted[name] || 0) + 1;
        }
        if (VN_PROP in page.properties) {
          const t = textOf(page.properties[VN_PROP]).trim();
          if (!t) vn.none++;
          else if (/vndb\.org\/r\d+|^r\d+$/i.test(t)) vn.release++;
          else if (/vndb\.org\/v\d+|^v\d+$/i.test(t)) vn.vn++;
          else vn.other++;
        }
      }
      cursor = j.has_more ? j.next_cursor : undefined;
    } while (cursor);

    console.log(`总行数：${rows}`);
    console.log("字段（类型）：已填写行数/总行数");
    for (const p of props) console.log(`  ${p.name}（${p.type}）：${count[p.name]}/${rows}`);
    if (Object.keys(hosted).length) console.log("Notion 托管文件（链接会过期）的行数：", JSON.stringify(hosted));
    if (VN_PROP in schema.properties) console.log(`「${VN_PROP}」分类：空 ${vn.none}，作品链接 ${vn.vn}，版本链接 ${vn.release}，其他格式 ${vn.other}`);
    else console.log(`未找到名为「${VN_PROP}」的字段`);
  } catch (e) {
    console.log("失败：", e.message);
  }
}
