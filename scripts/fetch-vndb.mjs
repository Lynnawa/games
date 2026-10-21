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
  "releases{id,list_status,title,released,platforms,languages{lang},extlinks{url,label}}",
  "vn{title,alttitle,titles{lang,title,official,main},released,image{url,thumbnail,sexual,violence}}"
].join(",");

// 主标题优先级：简中(官方或非官方) > 官方繁中 > 官方日语 > 官方英语，都没有则用 VNDB 默认标题
function pickTitle(titles, fallback) {
  const hans = titles.filter(x => ["zh-Hans", "zh"].includes(x.lang)).sort((a, b) => b.official - a.official)[0];
  const off = lang => titles.find(x => x.lang === lang && x.official)?.title;
  return hans?.title ?? off("zh-Hant") ?? off("ja") ?? off("en") ?? fallback;
}

let withTitles = 0, sample = null;
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
    const titles = e.vn?.titles ?? [];
    if (titles.length) { withTitles++; sample ??= titles; }
    const title = pickTitle(titles, e.vn?.title ?? e.id);
    // 副标题：作品最初的源语言标题（main）；与主标题相同则不显示
    const orig = titles.find(x => x.main)?.title ?? e.vn?.alttitle ?? "";
    const labels = (e.labels ?? []).map(l => l.label).filter(l => pub.includes(l.toLowerCase()));
    if (!labels.length) continue;
    items.push({
      id: e.id,                       // 例如 "v17"，后续合并 Notion 数据时用作主键
      sources: ["vndb"],
      title,
      subtitle: orig && orig !== title ? orig : "",
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
      labels,
      // 你在 VNDB 里加入列表的具体版本；list_status：0 未知 1 待玩 2 进行中 3 已完成 4 放弃
      releases: (e.releases ?? [])
        .map(r => ({
          id: r.id,
          status: r.list_status,
          title: r.title ?? "",
          released: r.released ?? "",
          platforms: r.platforms ?? [],
          langs: (r.languages ?? []).map(l => l.lang),
          links: (r.extlinks ?? []).map(x => ({ label: x.label, url: x.url }))
        }))
        .sort((x, y) => (y.status === 3) - (x.status === 3))
    });
  }
  more = j.more;
  await sleep(350);                   // 避开限速（约 200 次/分钟）
}

// 诊断信息：看 Actions 日志即可判断多语言标题有没有取到
console.log(`取到多语言标题的条目：${withTitles}`);
console.log("示例 titles：", JSON.stringify(sample));
await writeFile("data.json", JSON.stringify({ updated: new Date().toISOString(), user: uid, items }, null, 1));
console.log(`已写入 ${items.length} 条`);
