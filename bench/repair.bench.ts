import { jsonrepair } from "jsonrepair";
import { bench, describe } from "vitest";
import { repairJson } from "../src/index.js";

// Representative LLM-ish payloads.
const CLEAN = JSON.stringify({
  users: Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: `user-${i}`,
    active: i % 2 === 0,
    tags: ["a", "b", "c"],
  })),
});

const FENCED = `\`\`\`json\n${CLEAN}\n\`\`\``;

const MESSY = `Here you go:
{
  users: [
    { id: 1, name: 'Ada', active: True, }, // first user
    { id: 2, name: 'Bob', active: False, },
  ],
}`;

const TRUNCATED = CLEAN.slice(0, Math.floor(CLEAN.length * 0.7));

describe("clean JSON", () => {
  bench("llm-json-repair", () => void repairJson(CLEAN));
  bench("jsonrepair", () => void JSON.parse(jsonrepair(CLEAN)));
});

describe("fenced JSON", () => {
  bench("llm-json-repair", () => void repairJson(FENCED));
  // jsonrepair does not strip markdown fences, so this is our path only.
});

describe("messy JSON (quotes, comments, trailing commas)", () => {
  bench("llm-json-repair", () => void repairJson(MESSY));
  bench("jsonrepair", () => void JSON.parse(jsonrepair(MESSY)));
});

describe("truncated JSON", () => {
  bench("llm-json-repair", () => void repairJson(TRUNCATED));
  bench("jsonrepair", () => {
    try {
      JSON.parse(jsonrepair(TRUNCATED));
    } catch {
      // jsonrepair may reject some truncations; counted as a failed attempt.
    }
  });
});
