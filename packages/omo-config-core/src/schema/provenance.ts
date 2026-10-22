import * as z from "zod"

export const OmoProvenanceSettingsSchema = z.object({
  workspaces: z.array(z.object({
    name: z.string().trim().min(1),
    git_owners: z.array(z.string().trim().min(1)).optional(),
    paths: z.array(z.string().trim().min(1)).optional(),
  }).strict()).optional(),
}).strict()

export type OmoProvenanceSettings = z.infer<typeof OmoProvenanceSettingsSchema>
