import type * as z from "zod"

/** Schema messages may embed received input, including credentials in custom refinements. */
export function configIssueSummary(issue: z.core.$ZodIssue): string {
  return issue.code === "invalid_type"
    ? `Expected ${issue.expected}`
    : issue.code === "invalid_value"
      ? "Expected a supported value"
      : "Invalid value"
}

/** Keep identifiers useful to doctor without echoing credentials embedded in URL identifiers. */
export function displayConfigIdentifier(value: string): string {
  return value.replace(/[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const url = new URL(match)
      url.username = ""
      url.password = ""
      url.search = ""
      url.hash = ""
      return url.href
    } catch {
      return "[invalid URL]"
    }
  })
}
