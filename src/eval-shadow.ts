/**
 * Adds `language: "r"` to omp's built-in `eval` tool.
 *
 * omp has no extension point for eval languages, but an extension may re-register a built-in
 * tool name and delegate to the original with `ctx.invokeTool`. The shadow therefore runs R
 * itself and forwards py/js cells to the native tool, so retained kernels, preludes
 * (`ratchet`, `browser`, ...), streaming and auto-background keep working. Known gap: `xd://eval/*`
 * topic docs are unreadable while shadowed (omp looks them up on the registered tool).
 *
 * Call it from `session_start`: `pi.getAllTools()` throws while extensions load, and the native
 * description/schema are copied from it because the shadow replaces them. The description is a
 * snapshot; a prelude enabled mid-session reaches the model through omp's own notice, not through
 * this text.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

interface Renderer {
	renderCall(args: unknown, options: unknown, theme: unknown): unknown;
	renderResult(result: unknown, options: unknown, theme: unknown, args?: unknown): unknown;
}

interface EvalArgs {
	language?: string;
	code: string;
	title?: string;
	timeout?: number;
	reset?: boolean;
}

export interface EvalShadowDeps {
	/** Runs one R cell; same function as the `r` tool. */
	executeR(
		params: { code: string; timeout?: number; reset?: boolean },
		signal: AbortSignal | undefined,
		onUpdate: never,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<unknown>;
	/** Text appended to the native eval description. */
	rDescription: string;
	defaultTimeoutS: number;
	/** R cell renderers, used when `args.language === "r"`. */
	renderers: Renderer;
}

/** Language tokens the native tool advertises this session, or undefined when its schema is not understood. */
function nativeLanguages(
	z: ExtensionAPI["zod"],
	parameters: unknown,
): { tokens: string[]; description?: string } | undefined {
	// omptype schemas are callable (functions with a prototype), not plain objects.
	const schema =
		(typeof parameters === "object" || typeof parameters === "function") &&
		parameters !== null &&
		"toJsonSchema" in parameters &&
		typeof parameters.toJsonSchema === "function"
			? parameters.toJsonSchema()
			: parameters;
	const Native = z.object({
		properties: z.object({
			language: z.object({
				description: z.string().optional(),
				const: z.string().optional(),
				enum: z.array(z.string()).optional(),
				anyOf: z.array(z.object({ const: z.string() })).optional(),
			}),
		}),
	});
	const parsed = Native.safeParse(schema);
	if (!parsed.success) return undefined;
	const { description, const: single, enum: values, anyOf } = parsed.data.properties.language;
	const tokens = values ?? (single !== undefined ? [single] : anyOf?.map(alternative => alternative.const)) ?? [];
	return tokens.length > 0 ? { tokens, description } : undefined;
}

/**
 * Shadow `eval` with an R-aware copy. Returns whether the shadow was installed; when it was not
 * (eval disabled, already shadowed, native renderer unavailable) the caller keeps R reachable another way.
 */
export async function shadowEval(pi: ExtensionAPI, ctx: ExtensionContext, deps: EvalShadowDeps): Promise<boolean> {
	const z = pi.zod;

	const native = pi.getAllTools().find(tool => tool.name === "eval");
	// Absent (eval disabled) or already shadowed (this extension earlier, or another one): leave it.
	if (native?.sourceInfo.source !== "builtin") return false;

	let evalRenderer: Renderer;
	try {
		// Dynamic on purpose: a host without this subpath must degrade to "no R in eval", not fail to load.
		const { evalToolRenderer } = await import("@oh-my-pi/pi-tui/tools/eval");
		// Structurally the same renderer; the host types its args more narrowly than `Renderer`.
		evalRenderer = evalToolRenderer as unknown as Renderer;
	} catch (err) {
		// Without the native renderer py/js cells would lose their cell UI; keep eval untouched.
		if (ctx.hasUI) {
			ctx.ui.notify(`omp-plugin-r: eval language "r" disabled (native eval renderer unavailable: ${err})`, "warning");
		}
		return false;
	}

	const languagesInfo = nativeLanguages(z, native.parameters);
	// Unparseable native schema: do not guess which runtimes exist; leave eval alone and use the `r` tool.
	if (!languagesInfo) return false;
	const { tokens, description: languageDescription } = languagesInfo;
	const languages = [...tokens.filter(t => t !== "r"), "r"] as [string, ...string[]];
	const isR = (args: unknown) => typeof args === "object" && args !== null && "language" in args && args.language === "r";

	pi.registerTool({
		name: "eval",
		label: "Eval",
		description: `${native.description}\n\n## R (language "r")\n${deps.rDescription}`,
		approval: "exec",
		parameters: z.object({
			language: z
				.enum(languages)
				.describe([languageDescription, '"r": R (persistent R process)'].filter(Boolean).join("; ")),
			code: z
				.string()
				.describe("Code or standalone % command; top-level await works (py/js). For r: plain R code, may span lines."),
			title: z.string().optional().describe("Short transcript label (shown for py/js cells)."),
			timeout: z
				.number()
				.min(0)
				.optional()
				.describe(`Cell deadline in seconds; 0 disables it. Default ${deps.defaultTimeoutS} for r.`),
			reset: z.boolean().optional().describe("Wipe only this language's kernel."),
		}),

		async execute(_toolCallId, params: EvalArgs, signal, onUpdate, toolCtx) {
			if (params.language === "r") {
				return deps.executeR(
					{ code: params.code, timeout: params.timeout, reset: params.reset },
					signal,
					onUpdate as never,
					toolCtx,
				) as never;
			}
			if (!toolCtx.invokeTool) throw new Error("The native eval tool is unavailable in this session.");
			// The native schema rejects unknown keys, so forward exactly its own fields.
			const { language, code, title, timeout, reset } = params;
			return toolCtx.invokeTool({
				language,
				code,
				...(title !== undefined && { title }),
				...(timeout !== undefined && { timeout }),
				...(reset !== undefined && { reset }),
			}) as never;
		},

		renderCall: (args: unknown, options: unknown, theme: unknown) =>
			(isR(args) ? deps.renderers : evalRenderer).renderCall(args, options, theme) as never,
		renderResult: (result: unknown, options: unknown, theme: unknown, args?: unknown) =>
			(isR(args) ? deps.renderers : evalRenderer).renderResult(result, options, theme, args) as never,

		// Not in the public ToolDefinition type, but forwarded by omp's tool proxy (own keys of the
		// definition). `eval` is exclusive within a session, draws call+result as one cell, and its
		// approval dialog shows the code like the native tool's does.
		...({
			concurrency: "exclusive",
			mergeCallAndResult: true,
			formatApprovalDetails: (args: unknown) => {
				if (typeof args !== "object" || args === null) return undefined;
				const language = "language" in args && typeof args.language === "string" ? args.language : "?";
				const code = "code" in args && typeof args.code === "string" ? args.code : "";
				return `Language: ${language}\nCode:\n${code.length > 2000 ? `${code.slice(0, 2000)}\n…` : code}`;
			},
		} as object),
	});
	return true;
}
