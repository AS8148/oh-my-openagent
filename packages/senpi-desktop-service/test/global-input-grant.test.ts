import { afterEach, describe, expect, it } from "vitest";
import { runComputerCode } from "../src/run/runtime";
import { DesktopService } from "../src/service/service";
import { type ConfirmControl, noTools, snapshot } from "./control-harness";
import { fakeEngineFactory, rejectionOf, type SpawnLog } from "./harness";

// Every case waits on real child-process I/O; the guard only catches a hang, it never times behavior.
const HANG_GUARD = { timeout: 30_000 };
const GLOBAL_INPUT = ["click", "moveMouse", "drag", "scroll", "typeText", "keyChord", "holdKeys", "holdMouse"];

const services: DesktopService[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
});

async function openDesktop(fullAccess: boolean): Promise<{ service: DesktopService; log: SpawnLog }> {
	const log = fakeEngineFactory({ FAKE_ENGINE_DESKTOP: "1", FAKE_ENGINE_GLOBAL_INPUT_GATE: "1" });
	const service = new DesktopService({ createChild: log.factory, fullAccess: () => fullAccess });
	services.push(service);
	await service.open({});
	return { service, log };
}

function run(service: DesktopService, code: string, confirmControl?: ConfirmControl) {
	return runComputerCode(
		{ code, snapshot: snapshot(false), timeoutMs: 15_000 },
		{ service, executeTool: noTools, ...(confirmControl === undefined ? {} : { confirmControl }) },
	);
}

const sentInput = (log: SpawnLog) => log.requests.filter((request) => GLOBAL_INPUT.includes(request.method));
const sent = (log: SpawnLog, method: string) => log.requests.filter((request) => request.method === method);

describe("global input needs the control grant outside full access (#10788)", HANG_GUARD, () => {
	it("refuses a desktop click without a grant and never writes it to the engine", async () => {
		// Given
		const { service, log } = await openDesktop(false);

		// When
		const error = await rejectionOf(run(service, `await desktop.screenshot(); await desktop.click(10, 10);`));

		// Then
		expect(error).toMatchObject({ data: { code: "ControlRequired" } });
		expect(sentInput(log)).toEqual([]);
	});

	it("refuses typing on a display target without a grant", async () => {
		// Given
		const { service, log } = await openDesktop(false);

		// When
		const error = await rejectionOf(run(service, `await (await desktop.display("1")).type("hi");`));

		// Then
		expect(error).toMatchObject({ data: { code: "ControlRequired" } });
		expect(sentInput(log)).toEqual([]);
	});

	it("still sends background input to one window without a grant", async () => {
		// Given
		const { service, log } = await openDesktop(false);

		// When
		await run(service, `const w = await desktop.window("101"); await w.screenshot(); await w.click(5, 5);`);

		// Then
		expect(sent(log, "click")).toHaveLength(1);
		expect(sent(log, "control.grant")).toEqual([]);
	});

	it("sends the desktop click once the human approved the grant", async () => {
		// Given
		const { service, log } = await openDesktop(false);

		// When
		await run(
			service,
			`await desktop.control.acquire({ reason: "click Run" }); await desktop.screenshot(); await desktop.click(10, 10);`,
			() => Promise.resolve(true),
		);

		// Then
		expect(sent(log, "click")).toHaveLength(1);
	});

	it("grants without asking in full access, headless included, and then sends the click", async () => {
		// Given: no confirm channel at all, as in a headless run
		const { service, log } = await openDesktop(true);

		// When
		await run(service, `await desktop.screenshot(); await desktop.click(10, 10);`);

		// Then
		const methods = log.requests.map((request) => request.method);
		expect(methods.indexOf("control.grant")).toBeGreaterThan(-1);
		expect(methods.indexOf("control.grant")).toBeLessThan(methods.indexOf("click"));
		expect(sent(log, "click")).toHaveLength(1);
	});

	it("in full access re-grants once after the engine dropped the grant, sending the input exactly once", async () => {
		// Given: a grant the service sent, then dropped engine-side by a stop the user resumed
		const { service, log } = await openDesktop(true);
		await run(service, `await desktop.screenshot(); await desktop.click(10, 10);`);
		await service.stop();
		await service.resume();

		// When
		await run(service, `await desktop.click(10, 10);`);

		// Then: the refused attempt plus the retry reached the engine, and only the retry was admitted
		expect(sent(log, "control.grant")).toHaveLength(2);
		expect(sent(log, "click")).toHaveLength(3);
	});

	it("never grants while the user's stop is latched", async () => {
		// Given
		const { service, log } = await openDesktop(true);
		await service.stop();

		// When
		const error = await rejectionOf(run(service, `await desktop.screenshot(); await desktop.click(10, 10);`));

		// Then
		expect(error).toMatchObject({ data: { code: "Suspended" } });
		expect(sentInput(log)).toEqual([]);
	});
});
