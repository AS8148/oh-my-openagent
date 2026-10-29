import { test } from "bun:test"
import { bounceEasing } from "./bounce-easing"
import { assertCases } from "./support/assert-cases"

test("#given overshooting curves and calm transitions #then only the overshoot reports", () => {
	assertCases(
		bounceEasing,
		[
			{ id: "flag", style: { "transition-timing-function": "cubic-bezier(.34,1.56,.64,1)" } },
			{ id: "calm", style: { "transition-timing-function": "cubic-bezier(.2,.8,.4,1)" } },
			{ id: "boundary", style: { "transition-timing-function": "cubic-bezier(.2,-.1,.4,1.1)" } },
		],
		["#flag"],
	)
})
test("#given bounce names with readable pulse and travel keyframes #then pulses pass", () => {
	assertCases(
		bounceEasing,
		[
			{ id: "flag", style: { "animation-name": "fixture-bounce" } },
			{ id: "pulse", style: { "animation-name": "bounceDelay" } },
			{ id: "unknown", style: { "animation-name": "elastic-in" } },
		],
		["#flag", "#unknown"],
		{
			cssText: [
				"@keyframes bounceDelay {from {transform:scale(0)} to {transform:scale(1)}} @keyframes fixture-bounce {from {transform:translateY(-25%)} to {transform:none}}",
			],
		},
	)
})
test("#given allowed timing functions #then unrelated overshoot remains reportable", () => {
	assertCases(
		bounceEasing,
		[
			{ id: "flag", style: { "transition-timing-function": "cubic-bezier(.2,1.4,.4,1)" } },
			{ id: "allowed", style: { "transition-timing-function": "cubic-bezier(0.34, 1.56, 0.64, 1)" } },
			{ id: "calm" },
		],
		["#flag"],
		{ config: { allowEasings: ["cubic-bezier(0.34,1.56,0.64,1)"] } },
	)
})
