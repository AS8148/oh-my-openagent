import ts from "@typescript/typescript6"
import { posix } from "node:path"

// Answers one question for telemetry-opt-out-env.scan.mjs: does this expression's value come from an
// actual CALL of an opt-out helper? Identifiers are resolved by lexical scope (locals, parameters
// through every call site of their function, imports of relative modules), so a helper named in a
// comment, imported but unused, or merely in scope elsewhere in the file never counts.

const HELPERS = new Set(["withTelemetryOptOut", "telemetryLocalSinkEnv", "isolatedChildEnv"])
const MAX_DEPTH = 8

export const unwrap = (node) => {
  let current = node
  while (current !== undefined && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current) || ts.isNonNullExpression(current))) {
    current = current.expression
  }
  return current
}

const isFunction = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)

function functionNameOf(fn) {
  if (fn.name !== undefined && ts.isIdentifier(fn.name)) return fn.name.text
  const parent = fn.parent
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined
}

function bindingIn(statements, name, scope) {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { kind: "function", node: statement }
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings
      const element = bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.find((e) => e.name.text === name) : undefined
      if (element !== undefined) return { kind: "import", node: statement, imported: (element.propertyName ?? element.name).text }
    }
    const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : []
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return { kind: "value", node: declaration, scope }
      if (ts.isObjectBindingPattern(declaration.name)) {
        const element = declaration.name.elements.find((e) => ts.isIdentifier(e.name) && e.name.text === name)
        if (element !== undefined) return { kind: "member", node: declaration, member: (element.propertyName ?? element.name).getText() }
      }
    }
  }
  return undefined
}

function parameterBinding(fn, name) {
  for (const [index, parameter] of fn.parameters.entries()) {
    if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return { kind: "param", node: fn, index }
    if (ts.isObjectBindingPattern(parameter.name)) {
      const element = parameter.name.elements.find((e) => ts.isIdentifier(e.name) && e.name.text === name)
      if (element !== undefined) return { kind: "param", node: fn, index, member: (element.propertyName ?? element.name).getText() }
    }
  }
  return undefined
}

function bindingOf(identifier) {
  const name = identifier.text
  for (let scope = identifier.parent; scope !== undefined; scope = scope.parent) {
    if (isFunction(scope)) {
      const parameter = parameterBinding(scope, name)
      if (parameter !== undefined) return parameter
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope)) {
      const found = bindingIn(scope.statements, name, scope)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function assignmentsTo(scope, name) {
  const values = []
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && node.left.text === name) values.push(node.right)
    ts.forEachChild(node, visit)
  }
  if (scope !== undefined) visit(scope)
  return values
}

const isDynamicImport = (node) => node !== undefined && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword

function callsNamed(file, name) {
  const calls = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

function returnsOf(fn) {
  if (fn.body === undefined) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  const found = []
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) found.push(node.expression)
    if (!isFunction(node)) ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn.body, visit)
  return found
}

export function createTracer(parseFile, paths) {
  const every = (nodes, test) => nodes.length > 0 && nodes.every(test)

  const moduleAt = (file, specifier) => {
    const target = posix.normalize(posix.join(posix.dirname(file.fileName), specifier))
    return [target, target.replace(/\.js$/u, ".ts")].map(parseFile).find((f) => f !== undefined)
  }

  const imported = (binding) => {
    const resolved = moduleAt(binding.node.getSourceFile(), binding.node.moduleSpecifier.text)
    return resolved === undefined ? undefined : bindingIn(resolved.statements, binding.imported, resolved)
  }

  const dynamicMember = (binding) => {
    const init = unwrap(binding.node.initializer)
    const specifier = isDynamicImport(init) ? init.arguments[0] : undefined
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return undefined
    const resolved = moduleAt(binding.node.getSourceFile(), specifier.text)
    return resolved === undefined ? undefined : bindingIn(resolved.statements, binding.member, resolved)
  }

  const callersOf = (fn) => {
    const name = functionNameOf(fn)
    if (name === undefined) return []
    const home = fn.getSourceFile()
    const calls = [...callsNamed(home, name)]
    for (const path of paths) {
      const file = parseFile(path)
      if (file === undefined || file === home) continue
      for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement) || moduleAt(file, statement.moduleSpecifier.text) !== home) continue
        const bindings = statement.importClause?.namedBindings
        if (bindings === undefined || !ts.isNamedImports(bindings)) continue
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === name) calls.push(...callsNamed(file, element.name.text))
        }
      }
    }
    return calls
  }

  const callableReaches = (binding, member, depth) => {
    if (binding === undefined || depth > MAX_DEPTH) return false
    if (binding.kind === "import") return HELPERS.has(binding.imported) && member === undefined || callableReaches(imported(binding), member, depth + 1)
    if (binding.kind === "member" && isDynamicImport(unwrap(binding.node.initializer))) {
      return HELPERS.has(binding.member) && member === undefined || callableReaches(dynamicMember(binding), member, depth + 1)
    }
    const fn = binding.kind === "function" ? binding.node : unwrap(binding.kind === "value" ? binding.node.initializer : undefined)
    if (fn === undefined || !isFunction(fn)) return false
    return every(returnsOf(fn), (r) => member === undefined ? reaches(r, depth + 1) : memberReaches(r, member, depth + 1))
  }

  const bindingReaches = (binding, member, depth) => {
    if (binding === undefined || depth > MAX_DEPTH) return false
    if (binding.kind === "import") return bindingReaches(imported(binding), member, depth + 1)
    if (binding.kind === "value") {
      const init = binding.node.initializer
      const sources = [...(init === undefined ? [] : [init]), ...assignmentsTo(binding.scope, binding.node.name.text)]
      return every(sources, (source) => member === undefined ? reaches(source, depth + 1) : memberReaches(source, member, depth + 1))
    }
    if (binding.kind === "member") {
      const init = binding.node.initializer
      return init !== undefined && memberReaches(init, binding.member, depth + 1)
    }
    if (binding.kind === "param") {
      const path = binding.member === undefined ? member : binding.member
      return every(callersOf(binding.node), (call) => {
        const argument = call.arguments[binding.index]
        if (argument === undefined) return false
        if (binding.member !== undefined) return memberReaches(argument, binding.member, depth + 1)
        return path === undefined ? reaches(argument, depth + 1) : memberReaches(argument, path, depth + 1)
      })
    }
    return false
  }

  const memberReaches = (node, member, depth) => {
    const value = unwrap(node)
    if (value === undefined || depth > MAX_DEPTH) return false
    if (ts.isObjectLiteralExpression(value)) {
      const property = value.properties.findLast((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === member)
      if (property !== undefined) return reaches(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer, depth + 1)
      return value.properties.some((p) => ts.isSpreadAssignment(p) && memberReaches(p.expression, member, depth + 1))
    }
    if (ts.isIdentifier(value)) return bindingReaches(bindingOf(value), member, depth + 1)
    if (ts.isCallExpression(value) && ts.isIdentifier(unwrap(value.expression))) {
      return callableReaches(bindingOf(unwrap(value.expression)), member, depth + 1)
    }
    return false
  }

  const reaches = (node, depth = 0) => {
    const value = unwrap(node)
    if (value === undefined || depth > MAX_DEPTH) return false
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression)
      if (!ts.isIdentifier(callee)) return false
      const binding = bindingOf(callee)
      return binding === undefined ? false : callableReaches(binding, undefined, depth + 1)
    }
    if (ts.isIdentifier(value)) return bindingReaches(bindingOf(value), undefined, depth + 1)
    if (ts.isPropertyAccessExpression(value)) return memberReaches(value.expression, value.name.text, depth + 1)
    if (ts.isObjectLiteralExpression(value)) return value.properties.some((p) => ts.isSpreadAssignment(p) && reaches(p.expression, depth + 1))
    if (ts.isConditionalExpression(value)) return reaches(value.whenTrue, depth + 1) && reaches(value.whenFalse, depth + 1)
    if (ts.isBinaryExpression(value) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)) {
      return reaches(value.left, depth + 1) && reaches(value.right, depth + 1)
    }
    return false
  }

  return { reaches, memberReaches }
}
