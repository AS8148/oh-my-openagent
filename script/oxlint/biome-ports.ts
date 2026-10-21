// Biome rules that oxlint 1.89.0 has no rule for, ported so replacing Biome loses no check:
// style/noEnum, suspicious/noImplicitAnyLet and correctness/noStringCaseMismatch.
type Node = { readonly type: string; readonly [key: string]: unknown };
type RuleContext = {
  readonly filename?: string;
  readonly report: (problem: { readonly node: Node; readonly message: string }) => void;
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};
const nodes = (value: unknown): readonly Node[] => (Array.isArray(value) ? value.filter(isNode) : []);

const caseOf = (node: Node | undefined): "upper" | "lower" | undefined => {
  const callee = node?.type === "CallExpression" ? child(node, "callee") : undefined;
  const property = callee?.type === "MemberExpression" ? child(callee, "property") : undefined;
  const name = property?.type === "Identifier" ? property["name"] : undefined;
  return name === "toUpperCase" ? "upper" : name === "toLowerCase" ? "lower" : undefined;
};

const mismatches = (text: unknown, expected: "upper" | "lower"): boolean =>
  typeof text === "string" && text !== (expected === "upper" ? text.toUpperCase() : text.toLowerCase());

export default {
  meta: { name: "omo" },
  rules: {
    "no-enum": {
      create: (context: RuleContext) => ({
        TSEnumDeclaration: (node: Node) =>
          context.report({
            node,
            message: "Enums are not allowed: use a union of string literals or an `as const` object (Biome noEnum).",
          }),
      }),
    },
    "no-implicit-any-let": {
      create: (context: RuleContext) => ({
        VariableDeclaration: (node: Node) => {
          // JavaScript has no type annotations, so Biome checks TypeScript files only.
          if (!/\.[cm]?tsx?$/.test(context.filename ?? "")) return;
          if (node["kind"] !== "let" || node["declare"] === true) return;
          for (const declarator of nodes(node["declarations"])) {
            const id = child(declarator, "id");
            if (child(declarator, "init") === undefined && id?.type === "Identifier" && child(id, "typeAnnotation") === undefined)
              context.report({
                node: declarator,
                message: "This let has no type and no initial value, so it is implicitly any: give it a type (Biome noImplicitAnyLet).",
              });
          }
        },
      }),
    },
    "no-string-case-mismatch": {
      create: (context: RuleContext) => ({
        BinaryExpression: (node: Node) => {
          if (!["===", "!==", "==", "!="].includes(String(node["operator"]))) return;
          const left = child(node, "left");
          const right = child(node, "right");
          for (const [call, other] of [[left, right], [right, left]] as const) {
            const expected = caseOf(call);
            if (expected !== undefined && other?.type === "Literal" && mismatches(other["value"], expected))
              context.report({
                node,
                message: `This compares a ${expected}-cased string with a literal that is not ${expected}case, so it never matches (Biome noStringCaseMismatch).`,
              });
          }
        },
      }),
    },
  },
};
