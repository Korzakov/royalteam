const tabs = document.querySelectorAll(".tab");
const cards = document.querySelectorAll(".role-card");
const form = document.querySelector("#applyForm");
const result = document.querySelector("#formResult");
const roleCount = document.querySelector("#roleCount");
const progressTeams = document.querySelector("#progressTeams");
const progressUpdated = document.querySelector("#progressUpdated");

const fallbackProgress = {
  teams: [
    {
      name: "Crusaders",
      raid: "Manaforge Omega",
      difficulty: "Heroic",
      killed: 6,
      total: 8,
      bestPercent: 12.4,
      latestKill: "Nog te koppelen",
      lastUpdated: "2026-05-08T12:00:00Z",
    },
    {
      name: "Templars",
      raid: "Manaforge Omega",
      difficulty: "Mythic",
      killed: 3,
      total: 8,
      bestPercent: 44.8,
      latestKill: "Nog te koppelen",
      lastUpdated: "2026-05-08T12:00:00Z",
    },
  ],
};

const updateRoleCount = (filter) => {
  const visibleCards = [...cards].filter((card) => filter === "all" || card.dataset.role === filter);
  const label = filter === "all" ? "open rollen" : `open ${filter} rollen`;
  roleCount.textContent = `${visibleCards.length} ${label} zichtbaar`;
};

const formatDate = (value) =>
  new Intl.DateTimeFormat("nl-NL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

const renderProgress = (data) => {
  progressTeams.innerHTML = data.teams
    .map((team) => {
      const progress = Math.round((team.killed / team.total) * 100);

      return `
        <article class="progress-card">
          <span class="progress-label">${team.name}</span>
          <strong>${team.killed}/${team.total} ${team.raid}</strong>
          <div class="progress-meta">
            <span>${team.difficulty}</span>
            <span>Best pull: ${team.bestPercent}%</span>
          </div>
          <div class="progress-bar" style="--progress: ${progress}%">
            <span></span>
          </div>
          <p>Laatste kill: ${team.latestKill || "Nog te koppelen"}</p>
        </article>
      `;
    })
    .join("");

  const newestUpdate = data.teams
    .map((team) => team.lastUpdated)
    .sort()
    .at(-1);

  progressUpdated.textContent = `Laatst bijgewerkt: ${formatDate(newestUpdate)}`;
};

const loadProgress = () => {
  fetch("progress.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Progress data niet gevonden");
      }

      return response.json();
    })
    .then(renderProgress)
    .catch(() => {
      renderProgress(fallbackProgress);
      progressUpdated.textContent = "Voorbeeldprogress geladen. Koppel progress.json voor live updates.";
    });
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const filter = tab.dataset.filter;

    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    cards.forEach((card) => {
      const isVisible = filter === "all" || card.dataset.role === filter;
      card.classList.toggle("is-hidden", !isVisible);
    });
    updateRoleCount(filter);
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const data = new FormData(form);
  const character = data.get("character").trim();
  const spec = data.get("spec").trim();
  const role = data.get("role");
  const message = data.get("message").trim();

  const application = `Aanmelding RoyalTeam: ${character} - ${spec} (${role})${message ? `. ${message}` : "."}`;

  if (!navigator.clipboard) {
    result.textContent = application;
    return;
  }

  navigator.clipboard
    .writeText(application)
    .then(() => {
      result.textContent = "Aanmeldingstekst gekopieerd. Plak hem in Discord om te versturen.";
    })
    .catch(() => {
      result.textContent = application;
    });
});

updateRoleCount("all");
loadProgress();
