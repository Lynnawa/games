// 从 VNDB API 拉取用户列表，输出 data.json（Node 20+）
import { writeFile } from "node:fs/promises";

const API = "https://api.vndb.org/kana";
const user = process.env.VNDB_USER;
if (!user) throw new Error("缺少环境变量 VNDB_USER（VNDB 用户名或 uXXXX 形式的 ID）");

const headers = { "Content-Type": "application/json" };
if (process.env.VNDB_TOKEN) headers.Authorization = `Token ${process.env.VNDB_TOKEN}`;

// 白名单：只公开这些标签（逗号分隔，不区分大小写），例如 "Finished,Playing"
// 不在这些标签里的条目整条不导出；条目上的其他私密标签也不会写进 data.json
const pub = (process.env.PUBLIC_LABELS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
if (!pub.length) throw new Error("缺少 PUBLIC_LABELS：请先指定要公开的标签名，避免误公开私密列表");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 用户名 -> 用户 ID
let uid = user;
if (!/^u\d+$/i.test(user)) {
  const r = await fetch(`${API}/user?q=${encodeURIComponent(user)}`, { headers });
  const j = await r.json();
  uid = j[user]?.id;
  if (!uid) throw new Error(`找不到 VNDB 用户：${user}`);
}

const fields = [
  "id", "vote", "added", "lastmod", "started", "finished",
  "labels{id,label}",
  "vn{title,alttitle,released,image{url,thumbnail,sexual,violence}}"
].join(",");

const items = [];
for (let page = 1, more = true; more; page++) {
  const r = await fetch(`${API}/ulist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ user: uid, fields, sort: "lastmod", reverse: true, results: 100, page })
  });
  if (!r.ok) throw new Error(`ulist 请求失败 ${r.status}：${await r.text()}`);
  const j = await r.json();
  for (const e of j.results) {
    const labels = (e.labels ?? []).map(l => l.label).filter(l => pub.includes(l.toLowerCase()));
    if (!labels.length) continue;
    items.push({
      id: e.id,                       // 例如 "v17"，后续合并 Notion 数据时用作主键
      sources: ["vndb"],
      title: e.vn?.title ?? e.id,
      alttitle: e.vn?.alttitle ?? "",
      released: e.vn?.released ?? "",
      cover: e.vn?.image?.url ?? "",
      thumb: e.vn?.image?.thumbnail ?? e.vn?.image?.url ?? "",
      sexual: e.vn?.image?.sexual ?? 0,
      violence: e.vn?.image?.violence ?? 0,
      vote: e.vote ?? null,           // 10–100
      added: e.added,
      lastmod: e.lastmod,
      started: e.started ?? "",
      finished: e.finished ?? "",
      labels
    });
  }
  more = j.more;
  await sleep(350);                   // 避开限速（约 200 次/分钟）
}

await writeFile("data.json", JSON.stringify({ updated: new Date().toISOString(), user: uid, items }, null, 1));
console.log(`已写入 ${items.length} 条`);
