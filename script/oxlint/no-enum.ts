// Biome's style/noEnum has no oxlint rule, so this ports it: a TypeScript enum (const or not) is an
// error; use a union of literals or an `as const` object instead.
type EnumNode = { readonly type: "TSEnumDeclaration"; readonly id?: { readonly name?: string } };
type RuleContext = { readonly report: (problem: { readonly node: EnumNode; readonly message: string }) => void };

export default {
  meta: { name: "omo" },
  rules: {
    "no-enum": {
      create: (context: RuleContext) => ({
        TSEnumDeclaration: (node: EnumNode) =>
          context.report({
            node,
            message: `Enum ${node.id?.name ?? ""} is not allowed: use a union of string literals or an \`as const\` object (Biome noEnum).`,
          }),
      }),
    },
  },
};
