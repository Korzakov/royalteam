import { readFile, writeFile } from "node:fs/promises";

const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

const TEAMS = [
  { name: "Crusaders", guildId: 744461 },
  { name: "Templars", guildId: 816789 },
];

const ZONE_ID = Number(process.env.WCL_ZONE_ID || 44);
const RAID_SIZE = Number(process.env.WCL_RAID_SIZE || 20);
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

const PROGRESS_QUERY = `
  query TeamProgress($guildId: Int!, $zoneId: Int!, $size: Int!) {
    worldData {
      zone(id: $zoneId) {
        id
        name
        encounters {
          id
          name
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

const formatRank = (rank) => (rank?.number ? `World #${rank.number}` : "Progress beschikbaar");

const summarizeTeam = async (token, team) => {
  const data = await graphql(token, PROGRESS_QUERY, {
    guildId: team.guildId,
    zoneId: ZONE_ID,
    size: RAID_SIZE,
  });

  const zone = data.worldData.zone;
  const rankings = data.guildData.guild.zoneRanking.progress;
  const total = zone?.encounters?.length || FALLBACK_TOTAL;

  return {
    name: team.name,
    guildId: team.guildId,
    zoneId: zone?.id || ZONE_ID,
    raid: zone?.name || "Onbekende raid",
    killed: null,
    total,
    progressText: formatRank(rankings?.worldRank),
    rankings,
    lastUpdated: new Date().toISOString(),
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
