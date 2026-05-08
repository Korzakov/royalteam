import { readFile, writeFile } from "node:fs/promises";

const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

const TEAMS = [
  { name: "Crusaders", guildId: 744461 },
  { name: "Templars", guildId: 816789 },
];

const DIFFICULTIES = new Map([
  [5, "Mythic"],
  [4, "Heroic"],
  [3, "Normal"],
  [2, "Flex"],
  [1, "LFR"],
]);

const RAID_DIFFICULTIES = new Set([3, 4, 5]);
const REPORT_LIMIT = Number(process.env.WCL_REPORT_LIMIT || 100);
const ZONE_ID = process.env.WCL_ZONE_ID ? Number(process.env.WCL_ZONE_ID) : null;

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

const graphql = async (token, query, variables) => {
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

const TEAM_QUERY = `
  query TeamProgress($guildId: Int!, $limit: Int!) {
    guildData {
      guild(id: $guildId) {
        id
        name
      }
    }
    reportData {
      reports(guildID: $guildId, limit: $limit) {
        data {
          code
          title
          startTime
          endTime
          zone {
            id
            name
            encounters {
              id
              name
            }
          }
          fights(killType: Encounters, translate: true) {
            id
            name
            encounterID
            difficulty
            kill
            bossPercentage
            fightPercentage
            startTime
            endTime
          }
        }
      }
    }
  }
`;

const RANKING_QUERY = `
  query GuildZoneRanking($guildId: Int!, $zoneId: Int!, $size: Int!) {
    guildData {
      guild(id: $guildId) {
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

const getFightPercent = (fight) => {
  if (typeof fight.bossPercentage === "number") {
    return fight.bossPercentage;
  }

  if (typeof fight.fightPercentage === "number") {
    return fight.fightPercentage;
  }

  return null;
};

const getEncounterCount = (reports) => {
  const encounters = new Map();

  for (const report of reports) {
    for (const encounter of report.zone?.encounters || []) {
      encounters.set(encounter.id, encounter.name);
    }
  }

  return encounters.size || 0;
};

const hasRaidFight = (report) =>
  (report.fights || []).some((fight) => fight.encounterID > 0 && RAID_DIFFICULTIES.has(fight.difficulty));

const chooseZoneReports = (reports) => {
  const raidReports = reports
    .filter((report) => report.zone?.id && report.zone?.encounters?.length)
    .filter(hasRaidFight)
    .filter((report) => !ZONE_ID || report.zone.id === ZONE_ID);

  if (!raidReports.length) {
    return [];
  }

  if (ZONE_ID) {
    return raidReports;
  }

  const latestZoneId = raidReports
    .slice()
    .sort((a, b) => b.endTime - a.endTime)
    .at(0).zone.id;

  return raidReports.filter((report) => report.zone.id === latestZoneId);
};

const summarizeTeam = async (token, team) => {
  const data = await graphql(token, TEAM_QUERY, { guildId: team.guildId, limit: REPORT_LIMIT });
  const reports = data.reportData.reports.data || [];
  const zoneReports = chooseZoneReports(reports);
  const runAt = new Date().toISOString();

  if (!zoneReports.length) {
    return {
      name: team.name,
      guildId: team.guildId,
      raid: "Geen raid data",
      difficulty: "Onbekend",
      killed: 0,
      total: 0,
      bestPercent: 100,
      latestKill: "Nog geen kill gevonden",
      lastUpdated: runAt,
    };
  }

  const fights = zoneReports
    .flatMap((report) =>
      (report.fights || []).map((fight) => ({
        ...fight,
        reportCode: report.code,
        reportEndTime: report.endTime,
        zoneName: report.zone.name,
      })),
    )
    .filter((fight) => fight.encounterID > 0 && RAID_DIFFICULTIES.has(fight.difficulty));

  if (!fights.length) {
    return {
      name: team.name,
      guildId: team.guildId,
      raid: zoneReports[0].zone.name,
      difficulty: "Onbekend",
      killed: 0,
      total: getEncounterCount(zoneReports),
      bestPercent: 100,
      latestKill: "Nog geen kill gevonden",
      lastUpdated: new Date(Math.max(...zoneReports.map((report) => report.endTime))).toISOString(),
    };
  }

  const preferredDifficulty = [...new Set(fights.map((fight) => fight.difficulty))]
    .sort((a, b) => b - a)
    .find((difficulty) => fights.some((fight) => fight.difficulty === difficulty && fight.kill))
    ?? [...new Set(fights.map((fight) => fight.difficulty))].sort((a, b) => b - a)[0];

  const difficultyFights = fights.filter((fight) => fight.difficulty === preferredDifficulty);
  const killsByEncounter = new Map();

  for (const fight of difficultyFights) {
    if (!fight.kill) {
      continue;
    }

    const current = killsByEncounter.get(fight.encounterID);
    if (!current || fight.reportEndTime > current.reportEndTime || fight.endTime > current.endTime) {
      killsByEncounter.set(fight.encounterID, fight);
    }
  }

  const latestKill = [...killsByEncounter.values()].sort((a, b) => {
    if (b.reportEndTime !== a.reportEndTime) {
      return b.reportEndTime - a.reportEndTime;
    }

    return b.endTime - a.endTime;
  })[0];

  const bestWipe = difficultyFights
    .filter((fight) => !fight.kill)
    .map(getFightPercent)
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b)[0];

  const raid = zoneReports[0].zone.name;
  const zoneId = zoneReports[0].zone.id;
  const total = getEncounterCount(zoneReports);
  const lastUpdated = new Date(Math.max(...zoneReports.map((report) => report.endTime))).toISOString();
  const rankingData = await graphql(token, RANKING_QUERY, {
    guildId: team.guildId,
    zoneId,
    size: total || 20,
  });

  return {
    name: team.name,
    guildId: team.guildId,
    zoneId,
    raid,
    difficulty: DIFFICULTIES.get(preferredDifficulty) || `Difficulty ${preferredDifficulty}`,
    killed: killsByEncounter.size,
    total,
    bestPercent: Number((bestWipe ?? (killsByEncounter.size === total ? 0 : 100)).toFixed(1)),
    latestKill: latestKill?.name || "Nog geen kill gevonden",
    rankings: rankingData.guildData.guild.zoneRanking.progress,
    lastUpdated,
  };
};

const sortKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === "object") {
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
  const teams = [];

  for (const team of TEAMS) {
    teams.push(await summarizeTeam(token, team));
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
