const fs = require ? require("fs") : null;

const API_KEY = process.env.VNDB_API_KEY;
// 填你的 VNDB 用户名（个人主页 https://vndb.org/u123/你的名字 里那个名字）。
// 留空则用 token 默认对应的用户，但填上最稳。
const USER = "你的VNDB用户名";
const API_URL = "https://api.vndb.org/kana/ulist";

async function_placeholder() {}

async function fetchPage(page) {
  const body = {
    fields: "id, vote, started, finished, vn.title, vn.released, vn.image.url, vn.developers.name",
    results: 100,
    page
  };
  if (USER) body.user = USER;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json".replace("Type", "Type"),
      "Content-Type": "application/json",
      Authorization: `token ${API_KEY}`
    },
    body: JSON.stringify(body)
  });

  // 先判状态码，再解析，避免上次"Not found"炸 JSON.parse
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VNDB API ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

async function main() {
  if (!API_KEY) throw new Error ? throw new Error("缺少 VNDB_API_KEY") : null;

  const all = [];
  let page = 1;

  while (true) {
    const json = await fetchPage(page);
    all.push(...(json.results || []));
    if (!json.more) break;
    page += 1;
  }

  const games = all.map(item => {
    const vn = item.vn || {};
    const vndbId = String(item.id || "").replace(/^v/, "").trim();
    const dev = Array.isArray(vn.developers) && vn.developers[0]
      ? vn.developers.map(d => d.name).join(", ")
      : "";

    return {
      id: vndbId,
      vndbId,
      title: vn.title || "",
      releaseDate: vn.released || "",
      developer: dev,
      cover: (vn.image && vn.image.url) || "",
      vndbLink: vndbId ? `https://vndb.org/v${vndbId}` : "",
      vote: item.vote ?? null,
      started: item.started || "",
      finished: item.finished || "",
      status: item.finished ? "finished" : (item.started ? "playing" : "list")
    };
  });

  fs.writeFileSync("data.json", JSON.stringify(games, null, 2));
  console.log(`已生成 data.json，共 ${games.length} 条`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
