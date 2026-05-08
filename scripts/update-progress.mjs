import { readFile, writeFile } from "node:fs/promises";

const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

const TEAMS = [
  { name: "Crusaders", guildId: 744461 },
  { name: "Templars", guildId: 816789 },
];

const CONFIGURED_ZONE_ID = process.env.WCL_ZONE_ID ? Number(process.env.WCL_ZONE_ID) : null;
const RAID_SIZE = Number(process.env.WCL_RAID_SIZE || 20);
const RAID_DIFFICULTY = process.env.WCL_RAID_DIFFICULTY ? Number(process.env.WCL_RAID_DIFFICULTY) : null;
const FALLBACK_TOTAL = Number(process.env.WCL_BOSS_COUNT || 8);

const requireEnv = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const getAccessToken = async () => {
  const clientId = requireEnv("WCL_CLIENT_ID");
  const clientSecret = requireEnv("WCL_CLIENT_SECRET");
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(WCL_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!response.ok) {
    throw new Error(`Warcraft Logs token request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
};

const graphql = async (token, query, variables = {}) => {
  const response = await fetch(WCL_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Warcraft Logs GraphQL request failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(`Warcraft Logs GraphQL error: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
};

const LATEST_ZONE_QUERY = `
  query LatestRaidZone {
    worldData {
      zones {
        id
        name
        frozen
        encounters {
          id
          name
        }
      }
    }
  }
`;

const ZONE_QUERY = `
  query RaidZone($zoneId: Int!) {
    worldData {
      zone(id: $zoneId) {
        id
        name
        frozen
        encounters {
          id
          name
        }
      }
    }
  }
`;

const TEAM_QUERY = `
  query TeamProgress($guildId: Int!, $zoneId: Int!, $size: Int!, $difficulty: Int) {
    progressRaceData {
      progressRace(zoneID: $zoneId, difficulty: $difficulty, size: $size, guildID: $guildId)
    }
    guildData {
      guild(id: $guildId) {
        id
        name
        zoneRanking(zoneId: $zoneId) {
          progress(size: $size) {
            worldRank {
              number
              percentile
              color
            }
            regionRank {
              number
              percentile
              color
            }
            serverRank {
              number
              percentile
              color
            }
          }
        }
      }
    }
  }
`;

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const getNumber = (...values) => {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return null;
};

const findProgressString = (value) => {
  if (typeof value === "string") {
    const match = value.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    return match ? { killed: Number(match[1]), total: Number(match[2]), text: match[0] } : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProgressString(item);
      if (found) {
        return found;
      }
    }
  }

  if (isObject(value)) {
    for (const item of Object.values(value)) {
      const found = findProgressString(item);
      if (found) {
        return found;
      }
    }
  }

  return null;
};

const looksLikeEncounter = (item) =>
  isObject(item) &&
  ("slug" in item || "encounterID" in item || "encounterId" in item || "encounter" in item || "firstDefeated" in item);

const defeatedFromEncounterArray = (items) => {
  if (!items.length || !items.every(looksLikeEncounter)) {
    return null;
  }

  const killed = items.filter((item) =>
    item.isDefeated === true ||
    item.defeated === true ||
    item.killed === true ||
    item.firstDefeated ||
    item.killTime ||
    item.killTimestamp
  ).length;

  return { killed, total: items.length };
};

const findEncounterProgress = (value) => {
  if (Array.isArray(value)) {
    const direct = defeatedFromEncounterArray(value);
    if (direct) {
      return direct;
    }

    for (const item of value) {
      const found = findEncounterProgress(item);
      if (found) {
        return found;
      }
    }
  }

  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/encountersDefeated|defeatedEncounters|bossesKilled/i.test(key) && Array.isArray(item)) {
        return { killed: item.length, total: null };
      }

      const found = findEncounterProgress(item);
      if (found) {
        return found;
      }
    }
  }

  return null;
};

const findNumericProgress = (value) => {
  if (!isObject(value)) {
    return null;
  }

  const killed = getNumber(
    value.killed,
    value.defeated,
    value.bossesKilled,
    value.bosses_killed,
    value.numBossesKilled,
    value.encountersDefeated,
    value.encounters_defeated
  );
  const total = getNumber(value.total, value.totalBosses, value.total_bosses, value.numBosses, value.encounterCount);

  if (killed !== null || total !== null) {
    return { killed, total };
  }

  for (const item of Object.values(value)) {
    const found = findNumericProgress(item);
    if (found) {
      return found;
    }
  }

  return null;
};

const parseProgressRace = (progressRace, fallbackTotal) => {
  const progressString = findProgressString(progressRace);
  if (progressString) {
    return progressString;
  }

  const numeric = findNumericProgress(progressRace);
  if (numeric?.killed !== null) {
    return {
      killed: numeric.killed,
      total: numeric.total || fallbackTotal,
      text: `${numeric.killed}/${numeric.total || fallbackTotal}`,
    };
  }

  const encounterProgress = findEncounterProgress(progressRace);
  if (encounterProgress) {
    const total = encounterProgress.total || fallbackTotal;

    return {
      killed: encounterProgress.killed,
      total,
      text: `${encounterProgress.killed}/${total}`,
    };
  }

  return null;
};

const formatRank = (rank) => (rank?.number ? `World #${rank.number}` : "Progress niet gevonden");

const resolveZone = async (token) => {
  if (CONFIGURED_ZONE_ID) {
    const data = await graphql(token, ZONE_QUERY, { zoneId: CONFIGURED_ZONE_ID });
    const zone = data.worldData.zone;

    if (!zone) {
      throw new Error(`Configured WCL_ZONE_ID ${CONFIGURED_ZONE_ID} was not found`);
    }

    return zone;
  }

  const data = await graphql(token, LATEST_ZONE_QUERY);
  const raidZones = data.worldData.zones
    .filter((zone) => !zone.frozen)
    .filter((zone) => (zone.encounters?.length || 0) >= 4)
    .sort((a, b) => b.id - a.id);

  if (!raidZones.length) {
    throw new Error("Could not find an active Warcraft Logs raid zone");
  }

  return raidZones[0];
};

const summarizeTeam = async (token, team, zone) => {
  const data = await graphql(token, TEAM_QUERY, {
    guildId: team.guildId,
    zoneId: zone.id,
    size: RAID_SIZE,
    difficulty: RAID_DIFFICULTY,
  });

  const rankings = data.guildData.guild.zoneRanking.progress;
  const total = zone.encounters?.length || FALLBACK_TOTAL;
  const parsedProgress = parseProgressRace(data.progressRaceData.progressRace, total);
  const killed = parsedProgress?.killed ?? null;
  const progressTotal = parsedProgress?.total || total;

  return {
    name: team.name,
    guildId: team.guildId,
    zoneId: zone.id,
    raid: zone.name,
    killed,
    total: progressTotal,
    progressText: parsedProgress?.text || formatRank(rankings?.worldRank),
    rankings,
    lastUpdated: new Date().toISOString(),
  };
};

const sortKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (isObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortKeys(value[key]);
        return result;
      }, {});
  }

  return value;
};

const main = async () => {
  const token = await getAccessToken();
  const zone = await resolveZone(token);
  const teams = [];

  console.log(`Using WCL zone ${zone.id}: ${zone.name}`);

  for (const team of TEAMS) {
    teams.push(await summarizeTeam(token, team, zone));
  }

  const progress = {
    generatedAt: new Date().toISOString(),
    source: "warcraftlogs",
    teams,
  };

  const next = `${JSON.stringify(progress, null, 2)}\n`;

  try {
    const current = await readFile("progress.json", "utf8");
    const { generatedAt: _currentGeneratedAt, ...currentProgress } = JSON.parse(current);
    const { generatedAt: _nextGeneratedAt, ...nextProgress } = progress;
    const currentComparable = sortKeys(currentProgress);
    const nextComparable = sortKeys(nextProgress);

    if (JSON.stringify(currentComparable) === JSON.stringify(nextComparable)) {
      console.log("progress.json is already up to date");
      return;
    }
  } catch {
    // If the file does not exist or is invalid, rewrite it below.
  }

  await writeFile("progress.json", next);
  console.log("progress.json updated");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
