import { createDelegatedClient } from "@opap/sdk";

const [baseUrl, sourceId, ...queryParts] = process.argv.slice(2);
const token = process.env["OPAP_ACCESS_TOKEN"];
if (!baseUrl || !sourceId || !queryParts.length || !token) {
  throw new Error("Usage: OPAP_ACCESS_TOKEN=... node main.js <base-url> <source-id> <query>");
}
const result = await createDelegatedClient({ baseUrl, getAccessToken: () => Promise.resolve(token) }).query({
  sourceId, query: queryParts.join(" "), mode: "search", maxSources: 5,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
