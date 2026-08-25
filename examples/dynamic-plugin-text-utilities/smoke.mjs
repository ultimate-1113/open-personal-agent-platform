import { stdout } from "node:process";
import { invoke } from "./src/index.mjs";

const result = invoke({ toolId: "text.utilities.stats", input: { text: "OPAP test\n日本語" } });
const expected = { characters: 13, lines: 2, words: 3 };
if (JSON.stringify(result) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected plugin result: ${JSON.stringify(result)}`);
}
stdout.write(`${JSON.stringify(result)}\n`);
