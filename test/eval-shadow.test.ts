import { describe, expect, test } from "bun:test";
import { buildDocTopics } from "../src/eval-shadow";

const prelude = (name: string, enabled?: boolean) => ({
	name,
	documentation: `${name} docs`,
	...(enabled === undefined ? {} : { enabled: () => enabled }),
});

const session = { getEvalPreludes: () => [prelude("archive"), prelude("ratchet", false), prelude("archive")] };
const registry = { global: () => ({ get: (id: string) => (id === "main" ? { session } : undefined) }) };

class FakeEvalTool {
	constructor(readonly session: unknown) {}
	docTopics() {
		return { judge: "native judge", ratchet: "native ratchet", onSession: String(this.session === session) };
	}
}

/** Mirrors omp's `getEvalDocTopics`: static topics plus one per prelude it is given. */
const getEvalDocTopics = (options?: { preludes?: { name: string; documentation: string }[] }) => ({
	judge: "static judge",
	...Object.fromEntries((options?.preludes ?? []).map(p => [p.name, p.documentation])),
});

describe("buildDocTopics", () => {
	test("serves the native tool's topics for the calling agent's session, plus r", () => {
		const topics = buildDocTopics({ AgentRegistry: registry, EvalTool: FakeEvalTool, getEvalDocTopics }, "main", "R docs");
		expect(topics).toEqual({ judge: "native judge", ratchet: "native ratchet", onSession: "true", r: "R docs" });
	});

	test("without the native tool, builds topics from the session's enabled preludes, one per name", () => {
		const topics = buildDocTopics({ AgentRegistry: registry, getEvalDocTopics }, "main", "R docs");
		expect(topics).toEqual({ judge: "static judge", archive: "archive docs", r: "R docs" });
	});

	test("falls back to prelude-less topics when the agent has no session or no id", () => {
		const host = { AgentRegistry: registry, EvalTool: FakeEvalTool, getEvalDocTopics };
		expect(buildDocTopics(host, "unknown", "R")).toEqual({ judge: "static judge", r: "R" });
		expect(buildDocTopics(host, undefined, "R")).toEqual({ judge: "static judge", r: "R" });
	});

	test("falls back when the native tool throws, and keeps r when the host exposes nothing", () => {
		class Throwing {
			docTopics(): Record<string, string> {
				throw new Error("boom");
			}
		}
		const host = { AgentRegistry: registry, EvalTool: Throwing, getEvalDocTopics };
		expect(buildDocTopics(host, "main", "R")).toEqual({ judge: "static judge", archive: "archive docs", r: "R" });
		expect(buildDocTopics({}, "main", "R")).toEqual({ r: "R" });
	});

	test("the r topic wins over a native topic of the same name", () => {
		const topics = buildDocTopics({ getEvalDocTopics: () => ({ r: "native r" }) }, undefined, "plugin R");
		expect(topics.r).toBe("plugin R");
	});
});
