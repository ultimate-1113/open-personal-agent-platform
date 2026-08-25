/** @typedef {{ toolId: string, input: unknown }} Invocation */

/** @param {Invocation} invocation */
export const invoke = ({ toolId, input }) => {
  if (toolId !== "text.utilities.stats") throw new Error("TOOL_NOT_FOUND");
  if (typeof input !== "object" || input === null || typeof input.text !== "string") {
    throw new Error("INVALID_INPUT");
  }
  const text = /** @type {{ text: string }} */ (input).text;
  const trimmed = text.trim();
  return {
    characters: [...text].length,
    lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
    words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
  };
};

export default { invoke };
