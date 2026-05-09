import { readFile, writeFile } from "node:fs/promises";

const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

const TEAMS = [
  { name: "Crusaders", guildId: 744461 },
  { name: "Templars", guildId: 816789 },
];

const CONFIGURED_ZONE_ID = process.env.WCL_ZONE_ID ? Number(process.env.WCL_ZONE_ID) : null;
const RAID_SIZE = Number(process.env.WCL_RAID_SIZE || 20);
const REPORT_LIMIT = Number(process.env.WCL_REPORT_LIMIT || 10);
const FALLBACK_TOTAL = Number(process.env.WCL_BOSS_COUNT || 8);
const DIFFICULTY_NAMES = {
  1: "LFR",
  2: "Flex",
  3: "Normal",
  4: "Heroic",
  5: "Mythic",
  6: "Challenge",
};

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

const TEAM_PROGRESS_QUERY = `
  query TeamProgressFromReports($guildId: Int!, $zoneId: Int!, $limit: Int!, $size: Int!) {
    reportData {
      reports(guildID: $guildId, zoneID: $zoneId, limit: $limit) {
        data {
          code
          title
          startTime
          endTime
          fights(killType: Kills) {
            id
            encounterID
            name
            difficulty
            size
            kill
            startTime
            endTime
          }
        }
      }
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

const formatProgressText = (killed, total, difficultyName, rankings) => {
  if (Number.isFinite(killed) && Number.isFinite(total) && difficultyName) {
    return `${killed}/${total} ${difficultyName}`;
  }

  const world = rankings?.worldRank?.number ? `World #${rankings.worldRank.number}` : null;
  const region = rankings?.regionRank?.number ? `EU #${rankings.regionRank.number}` : null;

  return world || region || "Progress niet gevonden";
};

const isRaidZone = (zone) => {
  const name = zone.name || "";
  const encounterCount = zone.encounters?.length || 0;

  return encounterCount >= 6 && !/mythic\+|season|dungeon|challenge/i.test(name);
};

const difficultyValue = (difficulty) => (Number.isFinite(Number(difficulty)) ? Number(difficulty) : 0);

const readCurrentProgress = async () => {
  try {
    return JSON.parse(await readFile("progress.json", "utf8"));
  } catch {
    return null;
  }
};

const getCurrentTeam = (currentProgress, teamName, zoneId) =>
  currentProgress?.teams?.find((team) => team.name === teamName && team.zoneId === zoneId) || null;

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
    .filter(isRaidZone)
    .sort((a, b) => b.id - a.id);

  if (!raidZones.length) {
    throw new Error("Could not find an active Warcraft Logs raid zone");
  }

  return raidZones[0];
};

const summarizeReports = (reports, totalBosses) => {
  const killsByDifficulty = new Map();
  const killedBossNames = new Map();
  let latestKill = null;

  for (const report of reports) {
    for (const fight of report.fights || []) {
      if (!fight.kill || !fight.encounterID || !fight.difficulty) {
        continue;
      }

      const difficulty = difficultyValue(fight.difficulty);
      const difficultyKills = killsByDifficulty.get(difficulty) || new Set();
      difficultyKills.add(fight.encounterID);
      killsByDifficulty.set(difficulty, difficultyKills);

      const existing = killedBossNames.get(fight.encounterID);
      if (!existing || report.endTime > existing.endTime) {
        killedBossNames.set(fight.encounterID, {
          name: fight.name,
          endTime: report.endTime,
          reportCode: report.code,
        });
      }

      if (!latestKill || report.endTime > latestKill.endTime) {
        latestKill = {
          name: fight.name,
          difficulty,
          endTime: report.endTime,
          reportCode: report.code,
        };
      }
    }
  }

  const bestDifficulty = [...killsByDifficulty.keys()].sort((a, b) => b - a)[0] || null;
  const killed = bestDifficulty ? killsByDifficulty.get(bestDifficulty).size : 0;

  return {
    killed,
    total: totalBosses,
    difficulty: bestDifficulty,
    difficultyName: bestDifficulty ? DIFFICULTY_NAMES[bestDifficulty] || `Difficulty ${bestDifficulty}` : null,
    latestKill: latestKill
      ? {
          name: latestKill.name,
          difficulty: DIFFICULTY_NAMES[latestKill.difficulty] || `Difficulty ${latestKill.difficulty}`,
          reportCode: latestKill.reportCode,
          endTime: new Date(latestKill.endTime).toISOString(),
        }
      : null,
    killedBosses: [...(bestDifficulty ? killsByDifficulty.get(bestDifficulty) : [])].map((encounterId) => ({
      id: encounterId,
      name: killedBossNames.get(encounterId)?.name || `Encounter ${encounterId}`,
    })),
  };
};

const keepBestProgress = (nextTeam, currentTeam) => {
  if (!currentTeam || currentTeam.zoneId !== nextTeam.zoneId || !Number.isFinite(currentTeam.killed)) {
    return nextTeam;
  }

  const currentDifficulty = difficultyValue(currentTeam.difficulty);
  const nextDifficulty = difficultyValue(nextTeam.difficulty);
  const currentKilled = Number(currentTeam.killed);
  const nextKilled = Number(nextTeam.killed);

  if (currentDifficulty > nextDifficulty || (currentDifficulty === nextDifficulty && currentKilled > nextKilled)) {
    return {
      ...nextTeam,
      killed: currentKilled,
      difficulty: currentTeam.difficulty ?? nextTeam.difficulty,
      difficultyName: currentTeam.difficultyName ?? nextTeam.difficultyName,
      progressText:
        currentTeam.progressText ||
        formatProgressText(currentKilled, nextTeam.total, currentTeam.difficultyName ?? nextTeam.difficultyName, nextTeam.rankings),
      latestKill: currentTeam.latestKill ?? nextTeam.latestKill,
      killedBosses: currentTeam.killedBosses ?? nextTeam.killedBosses,
      preservedFromPrevious: true,
    };
  }

  return nextTeam;
};

const summarizeTeam = async (token, team, zone, currentProgress) => {
  const data = await graphql(token, TEAM_PROGRESS_QUERY, {
    guildId: team.guildId,
    zoneId: zone.id,
    limit: REPORT_LIMIT,
    size: RAID_SIZE,
  });

  const reports = data.reportData.reports.data || [];
  const rankings = data.guildData.guild.zoneRanking.progress;
  const total = zone.encounters?.length || FALLBACK_TOTAL;
  const reportProgress = summarizeReports(reports, total);
  const nextTeam = {
    name: team.name,
    guildId: team.guildId,
    zoneId: zone.id,
    raid: zone.name,
    killed: reportProgress.killed,
    total: reportProgress.total,
    difficulty: reportProgress.difficulty,
    difficultyName: reportProgress.difficultyName,
    progressText: formatProgressText(reportProgress.killed, reportProgress.total, reportProgress.difficultyName, rankings),
    rankings,
    latestKill: reportProgress.latestKill,
    killedBosses: reportProgress.killedBosses,
    reportsScanned: reports.length,
    lastUpdated: new Date().toISOString(),
  };

  return keepBestProgress(nextTeam, getCurrentTeam(currentProgress, team.name, zone.id));
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
  const currentProgress = await readCurrentProgress();
  const zone = await resolveZone(token);
  const teams = [];

  console.log(`Using WCL zone ${zone.id}: ${zone.name}`);

  for (const team of TEAMS) {
    teams.push(await summarizeTeam(token, team, zone, currentProgress));
  }

  const progress = {
    generatedAt: new Date().toISOString(),
    source: "warcraftlogs",
    strategy: `last-${REPORT_LIMIT}-reports`,
    teams,
  };

  const next = `${JSON.stringify(progress, null, 2)}\n`;

  try {
    const { generatedAt: _currentGeneratedAt, ...currentComparableSource } = currentProgress || {};
    const { generatedAt: _nextGeneratedAt, ...nextComparableSource } = progress;
    const currentComparable = sortKeys(currentComparableSource);
    const nextComparable = sortKeys(nextComparableSource);

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
