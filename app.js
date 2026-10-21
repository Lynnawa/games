async function load() {
  const res = await fetch("data.json");
  const games = await res.json();
  render(games);

  document.getElementById("search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = games.filter(g =>
      (g.title || "").toLowerCase().includes(q) ||
      (g.vndbId || "").toLowerCase().includes(q) ||
      (g.developer || "").toLowerCase().includes(q)
    );
    render(filtered);
  });
}

function render(games) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  games.forEach(g => {
    const card = document.createElement("article");
    card.className = "card";

    const cover = g.cover
      ? `<img src="${g.cover}" alt="${g.title}" loading="lazy">`
      : `<div class="cover-empty"></div>`;

    const vndbBadge = g.vndbId
      ? `<a class="badge" href="https://vndb.org/v${g.vndbId}" target="_blank" rel="noopener">VNDB</a>`
      : "";

    const statusBadge = g.status
      ? `<span class="tag">${g.status}</span>`
      : "";

    card.innerHTML = `
      <div class="cover">${cover}</div>
      <div class="info">
        <h2>${g.title}</h2>
        <div class="meta">
          ${statusBadge}
          ${g.releaseDate ? `<span class="tag">${g.releaseDate}</span>` : ""}
        </div>
        <div class="badges">${vndbBadge}</div>
        ${g.developer ? `<p class="dev">${g.developer}</p>` : ""}
      </div>
    `;

    list.appendChild(card);
  });
}

load();
