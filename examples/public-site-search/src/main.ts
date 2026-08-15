import { createPublicClient } from "@opap/sdk";

const form = document.querySelector<HTMLFormElement>("form[data-opap-search]");
const output = document.querySelector<HTMLElement>("[data-opap-results]");
if (form && output) form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const text = (name: string) => { const value = data.get(name); return typeof value === "string" ? value : ""; };
  void createPublicClient({ baseUrl: text("baseUrl") }).query({
    sourceId: text("sourceId"), query: text("query"),
    mode: data.get("mode") === "answer" ? "answer" : "search", maxSources: 5,
  }).then((result) => { output.textContent = JSON.stringify(result, null, 2); })
    .catch((error: unknown) => { output.textContent = error instanceof Error ? error.message : String(error); });
});
