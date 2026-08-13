import { readFile } from "node:fs/promises";

import {
  DISCORD_APPLICATION_ID,
  discordCommandManifest,
} from "../packages/discord-connector/src/index.ts";

const variablesFile = process.argv[2] ?? ".dev.vars";

const readVariable = async (name: string): Promise<string> => {
  const contents = await readFile(variablesFile, "utf8");
  const prefix = `${name}=`;
  const line = contents
    .split(/\r?\n/u)
    .filter((candidate) => candidate.trimStart().startsWith(prefix))
    .at(-1);
  if (!line) throw new Error(`${name} is missing from ${variablesFile}`);

  let value = line.trim().slice(prefix.length).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error(`${name} is empty in ${variablesFile}`);
  return value;
};

const botToken = await readVariable("DISCORD_BOT_TOKEN");
const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`,
  {
    method: "PUT",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(discordCommandManifest),
  },
);

if (!response.ok) {
  const details = (await response.text()).slice(0, 2_000);
  throw new Error(`Discord command sync failed (${response.status}): ${details}`);
}

const commands = await response.json() as Array<{ name?: string }>;
console.log(`Synchronized ${commands.length} Discord commands: ${commands
  .map((command) => command.name ?? "unknown")
  .join(", ")}`);
