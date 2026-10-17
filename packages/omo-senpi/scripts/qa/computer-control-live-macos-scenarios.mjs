// Scenarios for computer-control-live-macos.mjs: each drives one senpi rpc session and checks the engine audit
// and the `computer` tool results it left behind.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REASON = "QA: raise the QA target window";
export const TARGET_TITLE = `omo-control-qa-${process.pid}`;

export function jsonLines(text) {
	return text.split("\n").flatMap((line) => {
		if (!line.trim().startsWith("{")) return [];
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

function filesNamed(root, name, found = []) {
	if (!existsSync(root)) return found;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) filesNamed(path, name, found);
		else if (entry.name === name) found.push(path);
	}
	return found;
}

export const auditActions = (root) =>
	filesNamed(root, ".computer-audit.jsonl")
		.flatMap((path) => jsonLines(readFileSync(path, "utf8")))
		.map((entry) => entry.action)
		.filter((action) => typeof action === "string");

export const sessionFiles = (agentDir) => {
	const root = join(agentDir, "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true })
		.map(String)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(root, name));
};

// In file order: one entry per `computer` tool result, its text parts joined.
export const toolResults = (agentDir) =>
	sessionFiles(agentDir)
		.flatMap((path) => jsonLines(readFileSync(path, "utf8")))
		.map((entry) => entry.message ?? entry)
		.filter(
			(message) =>
				message?.role === "toolResult" && message.toolName === "computer",
		)
		.map((message) =>
			(message.content ?? []).map((part) => part?.text ?? "").join("\n"),
		);

const raiseCode = `const w = await desktop.window({ title: ${JSON.stringify(TARGET_TITLE)} }); await w.raise(); return "raised"`;
const run = (code) => ({
	type: "tool_call",
	name: "computer",
	arguments: { action: "run", code },
});
const acquire = `const state = await desktop.control.acquire({ reason: ${JSON.stringify(REASON)} });`;

function answerConfirms(session, answer) {
	const answered = new Set();
	return () => {
		for (const event of session.events) {
			if (
				event.type === "extension_ui_request" &&
				event.method === "confirm" &&
				!answered.has(event.id)
			) {
				answered.add(event.id);
				session.send({
					type: "extension_ui_response",
					id: event.id,
					confirmed: answer,
				});
			}
		}
		return false;
	};
}

export const scenarios = {
	"approved-then-ended": {
		steps: [
			run(
				`${acquire} ${raiseCode.replace('return "raised"', "return JSON.stringify({ state, raised: true })")}`,
			),
			{ type: "text", text: "done" },
			run(raiseCode),
			{ type: "text", text: "done" },
		],
		async drive(session) {
			const answer = answerConfirms(session, true);
			session.send({
				type: "prompt",
				message: "control QA: acquire and raise",
			});
			await session.until("the first agent_end", () => {
				answer();
				return session.agentEnds() >= 1;
			});
			await session.until("control.revoke after agent_end", () =>
				auditActions(session.sandbox.root).includes("control.revoke"),
			);
			session.send({ type: "prompt", message: "control QA: raise again" });
			await session.until(
				"the second agent_end",
				() => session.agentEnds() >= 2,
			);
		},
		verify: ({ audits, results }) => [
			[
				"the first run reported an active grant",
				results[0]?.includes('"active":true') === true,
			],
			[
				"the first raise was admitted",
				results[0]?.includes('"raised":true') === true,
			],
			[
				"the engine audited control.grant, then raiseWindow",
				audits.indexOf("control.grant") !== -1 &&
					audits.indexOf("raiseWindow") > audits.indexOf("control.grant"),
			],
			[
				"the end of the task revoked the grant",
				audits.includes("control.revoke"),
			],
			[
				"the raise after the task ended was refused ControlRequired",
				results[1]?.includes("ControlRequired") === true,
			],
		],
	},
	interrupted: {
		steps: [
			run(`${acquire} await wait(30000); return JSON.stringify(state)`),
			{ type: "text", text: "done" },
			run(raiseCode),
			{ type: "text", text: "done" },
		],
		async drive(session) {
			const answer = answerConfirms(session, true);
			session.send({
				type: "prompt",
				message: "control QA: acquire then wait",
			});
			await session.until("control.grant in the audit", () => {
				answer();
				return auditActions(session.sandbox.root).includes("control.grant");
			});
			session.send({ type: "abort" });
			await session.until(
				"agent_end after the abort",
				() => session.agentEnds() >= 1,
			);
			await session.until("control.revoke after the abort", () =>
				auditActions(session.sandbox.root).includes("control.revoke"),
			);
			session.send({
				type: "prompt",
				message: "control QA: raise after the interrupt",
			});
			await session.until(
				"the second agent_end",
				() => session.agentEnds() >= 2,
			);
		},
		verify: ({ audits, results }) => [
			["the engine audited control.grant", audits.includes("control.grant")],
			["the interrupt revoked the grant", audits.includes("control.revoke")],
			["no raise reached the engine", !audits.includes("raiseWindow")],
			[
				"the raise after the interrupt was refused ControlRequired",
				results.at(-1)?.includes("ControlRequired") === true,
			],
		],
	},
	declined: {
		steps: [run(`${acquire} ${raiseCode}`), { type: "text", text: "done" }],
		async drive(session) {
			const answer = answerConfirms(session, false);
			session.send({
				type: "prompt",
				message: "control QA: declined then raise",
			});
			await session.until("agent_end", () => {
				answer();
				return session.agentEnds() >= 1;
			});
		},
		verify: ({ audits, results }) => [
			["the engine never saw control.grant", !audits.includes("control.grant")],
			["no raise reached the engine", !audits.includes("raiseWindow")],
			[
				"the raise was refused ControlRequired",
				results[0]?.includes("ControlRequired") === true,
			],
		],
	},
};
