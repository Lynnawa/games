const fs = require("fs");

const API_KEY = process.env.VNDB_API_KEY;
const API_URL = "https://api.vndb.org/kana/vnlist";

async function fetchAll() {
  if (!API_KEY) {
    throw new Error("缺少 VNDB_API_KEY");
  }

  const results = [];
  let page = 1;

  while (true) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${API_KEY}`
      },
      body: JSON.stringify({
        fields: "id,vn.id,vn.title,vn.released,vn.developer,vn.image.url",
        filters: [],
        page
      })
    });

    const json = await res.json();

    if (!res.ok) {
      throw new Error(`VNDB API error: ${json.error || res.status}`);
    }

    results.push(...(json.results || []));

    if (!json.more) break;
    page += 1;
  }

  return results;
}

async function main() {
  const items = await fetchAll();

  const games = items.map(item => {
    const vn = item.vn || item;

    const rawId = vn.id || item.id || "";
    const vndbId = rawId.toString().replace(/^v/, "").trim();

    return {
      id: vndbId || `temp_${item.id}`,
      vndbId,
      title: vn.title || "",
      releaseDate: vn.released || "",
      developer: vn.developer || "",
      cover: vn.image?.url || "",
      vndbLink: vndbId ? `https://vndb.org/v${vndbId}` : "",
      status: item.status || "",
      rating: item.rating ?? null,
      voteCount: item.votecount ?? null
    };
  });

  fs.writeFileSync("data.json", JSON.stringify(games, null, 2));
  console.log(`已生成 data.json，共 ${games.length} 条`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
