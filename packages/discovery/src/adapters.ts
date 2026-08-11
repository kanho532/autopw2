import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { DiscoveryFact } from "./index.js";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): unknown };
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const CONSTRAINTS = ["minLength", "maxLength", "minimum", "maximum", "pattern", "format"] as const;

export interface StaticAdapterInput { relative: string; source: string; route: string; featureIds: string[]; }
export interface StaticAdapterResult { endpoints: DiscoveryFact[]; facts: DiscoveryFact[]; adapter: "openapi" | "json-schema" | "typescript-ast" | "none"; }

export function extractStaticEvidence(input: StaticAdapterInput): StaticAdapterResult {
  const document = parseSchemaDocument(input.relative, input.source);
  if (document && (typeof document.openapi === "string" || typeof document.swagger === "string") && isRecord(document.paths)) return extractOpenApi(input, document);
  if (document && (document.$schema || document.type === "object") && isRecord(document.properties)) return extractStandaloneSchema(input, document);
  if (/\.(?:[cm]?[jt]sx?)$/i.test(input.relative)) return extractTypeScript(input);
  return { endpoints: [], facts: [], adapter: "none" };
}

function extractOpenApi(input: StaticAdapterInput, document: Record<string, unknown>): StaticAdapterResult {
  const endpoints: DiscoveryFact[] = [];
  const facts: DiscoveryFact[] = [];
  for (const [pathTemplate, pathItemValue] of Object.entries(document.paths as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(pathItemValue)) continue;
    for (const [methodName, operationValue] of Object.entries(pathItemValue).sort(([a], [b]) => a.localeCompare(b))) {
      const method = methodName.toUpperCase();
      if (!HTTP_METHODS.has(method) || !isRecord(operationValue)) continue;
      const tags = arrayStrings(operationValue.tags);
      const featureId = tags[0] || input.featureIds[0] || featureFromPath(pathTemplate);
      const operationId = stringValue(operationValue.operationId);
      const requestSchema = resolveRequestSchema(operationValue, document);
      const responseSchemaRefs = responseSchemaReferences(operationValue);
      endpoints.push(adapterFact("endpoint", [input.relative, method, pathTemplate, operationId].join("|"), {
        method, path_template: normalizeEndpoint(pathTemplate), route: normalizeEndpoint(pathTemplate), operation: operationKind(method, pathTemplate),
        operation_id: operationId || undefined, feature_id: featureId, adapter: "openapi", request_schema_ref: requestSchemaReference(operationValue),
        response_schema_refs: responseSchemaRefs, response_statuses: responseStatuses(operationValue), identity_candidates: responseIdentityCandidates(operationValue, document), source_kind: "OPENAPI", confidence: 0.99, source_ref: { path: input.relative }
      }));
      if (requestSchema) facts.push(...schemaFacts(input.relative, requestSchema, featureId, normalizeEndpoint(pathTemplate), "OPENAPI", 0.99, document));
    }
  }
  return { endpoints, facts, adapter: "openapi" };
}

function extractStandaloneSchema(input: StaticAdapterInput, document: Record<string, unknown>): StaticAdapterResult {
  const featureId = stringValue(document.title) || input.featureIds[0] || featureFromPath(input.relative);
  const resourcePath = stringValue(document["x-autopw-resource-path"]);
  const schema = adapterFact("schema", [input.relative, featureId].join("|"), { name: featureId, feature_id: featureId, resource_path: resourcePath || undefined, source_kind: "OPENAPI", confidence: 0.98, source_ref: { path: input.relative } });
  return { endpoints: [], facts: [schema, ...schemaFacts(input.relative, document, featureId, resourcePath || input.route, "OPENAPI", 0.98, document)], adapter: "json-schema" };
}

function extractTypeScript(input: StaticAdapterInput): StaticAdapterResult {
  const sourceFile = ts.createSourceFile(input.relative, input.source, ts.ScriptTarget.Latest, true, scriptKind(input.relative));
  const constants = stringConstants(sourceFile);
  const endpoints: DiscoveryFact[] = [];
  const seen = new Set<string>();
  const add = (method: string, endpoint: string, node: ts.Node, adapter: string, featureId = input.featureIds[0] || featureFromPath(endpoint)): void => {
    const normalized = normalizeEndpoint(endpoint);
    const key = [method, normalized, adapter, node.getStart(sourceFile)].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(adapterFact("endpoint", [input.relative, key].join("|"), {
      method, path_template: normalized, route: input.route, operation: operationKind(method, normalized), feature_id: featureId,
      adapter, source_kind: "AST", confidence: 0.92, source_ref: { path: input.relative, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 }
    }));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        const endpoint = expressionString(node.arguments[0], constants);
        if (endpoint) add(methodFromOptions(node.arguments[1], constants), endpoint, node, "fetch");
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression.getText(sourceFile);
        const member = node.expression.name.text;
        const method = member.toUpperCase();
        if (HTTP_METHODS.has(method) && isHttpReceiver(receiver)) {
          const endpoint = expressionString(node.arguments[0], constants);
          if (endpoint) add(method, endpoint, node, clientAdapter(receiver));
        } else if (member === "route" && isObjectLiteral(node.arguments[0])) {
          const object = node.arguments[0];
          const methodValue = propertyString(object, "method", constants).toUpperCase();
          const endpoint = propertyString(object, "url", constants) || propertyString(object, "path", constants);
          if (HTTP_METHODS.has(methodValue) && endpoint) add(methodValue, endpoint, node, receiver.toLowerCase().includes("fastify") ? "fastify" : "route-object");
        } else if ((member === "request" || /axios|client|http|api/i.test(receiver)) && isObjectLiteral(node.arguments[0])) {
          const object = node.arguments[0];
          const methodValue = (propertyString(object, "method", constants) || "GET").toUpperCase();
          const endpoint = propertyString(object, "url", constants) || propertyString(object, "path", constants);
          if (HTTP_METHODS.has(methodValue) && endpoint) add(methodValue, endpoint, node, "request-wrapper");
        }
      } else if (ts.isIdentifier(node.expression) && /^(?:request|apiRequest|httpRequest)$/i.test(node.expression.text) && isObjectLiteral(node.arguments[0])) {
        const object = node.arguments[0];
        const method = (propertyString(object, "method", constants) || "GET").toUpperCase();
        const endpoint = propertyString(object, "url", constants) || propertyString(object, "path", constants);
        if (HTTP_METHODS.has(method) && endpoint) add(method, endpoint, node, "request-wrapper");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  extractConditionalRoutes(sourceFile, input, add);
  extractNestControllers(sourceFile, input, add);
  extractNextRoute(sourceFile, input, add);
  for (const literal of inlineScriptLiterals(sourceFile)) {
    const nested = extractTypeScript({ ...input, relative: input.relative + "#inline-" + literal.pos + ".js", source: literal.text });
    for (const endpoint of nested.endpoints) if (!endpoints.some((item) => item.fact_id === endpoint.fact_id)) endpoints.push(endpoint);
  }
  return { endpoints, facts: [], adapter: "typescript-ast" };
}

function extractConditionalRoutes(sourceFile: ts.SourceFile, input: StaticAdapterInput, add: (method: string, endpoint: string, node: ts.Node, adapter: string, featureId?: string) => void): void {
  const guardedPaths = new Map<string, string>();
  const collectGuards = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression) && node.initializer.expression.name.text === "match") {
      const routePath = regexRoute(node.initializer.arguments[0]);
      if (routePath) guardedPaths.set(node.name.text, routePath);
    }
    ts.forEachChild(node, collectGuards);
  };
  collectGuards(sourceFile);
  const visit = (node: ts.Node, inheritedPaths: string[]): void => {
    if (ts.isIfStatement(node)) {
      const localPaths = conditionPaths(node.expression, guardedPaths);
      const paths = localPaths.length ? localPaths : inheritedPaths;
      const methods = conditionMethods(node.expression);
      for (const method of methods) for (const endpoint of paths) add(method, endpoint, node, "conditional-router", input.featureIds[0] || featureFromPath(endpoint));
      visit(node.thenStatement, paths);
      if (node.elseStatement) visit(node.elseStatement, inheritedPaths);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inheritedPaths));
  };
  visit(sourceFile, []);
}

function conditionMethods(expression: ts.Expression): string[] {
  const result = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isEquality(node.operatorToken.kind)) {
      const left = propertyAccessName(node.left);
      const right = propertyAccessName(node.right);
      const literal = ts.isStringLiteralLike(node.left) ? node.left.text : ts.isStringLiteralLike(node.right) ? node.right.text : "";
      if ((left === "method" || right === "method") && HTTP_METHODS.has(literal.toUpperCase())) result.add(literal.toUpperCase());
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return [...result].sort();
}

function conditionPaths(expression: ts.Expression, guardedPaths: Map<string, string>): string[] {
  const result = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && guardedPaths.has(node.text)) result.add(guardedPaths.get(node.text) as string);
    if (ts.isBinaryExpression(node) && isEquality(node.operatorToken.kind)) {
      const left = propertyAccessName(node.left);
      const right = propertyAccessName(node.right);
      const literal = ts.isStringLiteralLike(node.left) ? node.left.text : ts.isStringLiteralLike(node.right) ? node.right.text : "";
      if ((left === "pathname" || right === "pathname") && literal.startsWith("/")) result.add(normalizeEndpoint(literal));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "startsWith" && propertyAccessName(node.expression.expression) === "pathname") {
      const prefix = expressionString(node.arguments[0]);
      if (prefix) result.add(normalizeEndpoint(prefix));
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return [...result].sort();
}

function regexRoute(node: ts.Expression | undefined): string {
  if (!node || !ts.isRegularExpressionLiteral(node)) return "";
  let value = node.text.replace(/^\//, "").replace(/\/[a-z]*$/i, "").replace(/^\^/, "").replace(/\$$/, "");
  value = value.replace(/\\\//g, "/").replace(/\(\[\^\/]\+\)/g, ":id").replace(/\(\.\+\)/g, ":id").replace(/\\([.?+*^$()[\]{}|-])/g, "$1");
  return value.startsWith("/") ? normalizeEndpoint(value) : "";
}

function extractNestControllers(sourceFile: ts.SourceFile, input: StaticAdapterInput, add: (method: string, endpoint: string, node: ts.Node, adapter: string, featureId?: string) => void): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const prefix = decoratorPath(statement, "Controller");
    if (prefix === undefined) continue;
    for (const member of statement.members) {
      for (const method of HTTP_METHODS) {
        const suffix = decoratorPath(member, titleCase(method));
        if (suffix !== undefined) add(method, joinPaths(prefix, suffix), member, "nestjs", input.featureIds[0] || featureFromPath(prefix));
      }
    }
  }
}

function extractNextRoute(sourceFile: ts.SourceFile, input: StaticAdapterInput, add: (method: string, endpoint: string, node: ts.Node, adapter: string, featureId?: string) => void): void {
  if (!/(?:^|\/)app\/.*\/route\.[cm]?[jt]sx?$/i.test(input.relative)) return;
  const routePath = nextRoutePath(input.relative);
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !hasExport(statement)) continue;
    const method = statement.name.text.toUpperCase();
    if (HTTP_METHODS.has(method)) add(method, routePath, statement, "nextjs-route", input.featureIds[0] || featureFromPath(routePath));
  }
}

function schemaFacts(relative: string, schemaInput: Record<string, unknown>, featureId: string, resourcePath: string, sourceKind: "OPENAPI", confidence: number, document: Record<string, unknown>): DiscoveryFact[] {
  const schema = resolveSchema(schemaInput, document) || schemaInput;
  if (!isRecord(schema.properties)) return [];
  const required = new Set(arrayStrings(schema.required));
  const result: DiscoveryFact[] = [];
  for (const [field, rawProperty] of Object.entries(schema.properties).sort(([a], [b]) => a.localeCompare(b))) {
    const property = isRecord(rawProperty) ? resolveSchema(rawProperty, document) || rawProperty : {};
    const common = { field, feature_id: featureId, resource_path: collectionPath(resourcePath), route: resourcePath, source_kind: sourceKind, confidence, source_ref: { path: relative } };
    result.push(adapterFact("field", [relative, resourcePath, field, "schema"].join("|"), {
      ...common,
      schema_type: stringValue(property.type) || inferSchemaType(property),
      ...(Object.hasOwn(property, "example") ? { example: property.example } : {}),
      ...(Object.hasOwn(property, "default") ? { default: property.default } : {})
    }));
    if (required.has(field)) result.push(adapterFact("validation", [relative, resourcePath, field, "required"].join("|"), { ...common, rule: "required" }));
    if (Array.isArray(property.enum)) result.push(adapterFact("validation", [relative, resourcePath, field, "enum"].join("|"), { ...common, rule: "enum", values: property.enum }));
    for (const rule of CONSTRAINTS) if (Object.hasOwn(property, rule)) result.push(adapterFact("validation", [relative, resourcePath, field, rule].join("|"), { ...common, rule, value: property[rule] }));
  }
  return result;
}

function responseIdentityCandidates(operation: Record<string, unknown>, document: Record<string, unknown>): Array<Record<string, string>> {
  const explicitPath = stringValue(operation["x-autopw-identity-path"]);
  const explicitHeader = stringValue(operation["x-autopw-identity-header"]);
  const result: Array<Record<string, string>> = [];
  if (explicitPath) result.push({ kind: "explicit", path: explicitPath.replace(/^body\./, "") });
  if (explicitHeader) result.push({ kind: "explicit", header: explicitHeader.toLowerCase() });
  if (!isRecord(operation.responses)) return result;
  for (const responseValue of Object.values(operation.responses)) {
    if (!isRecord(responseValue)) continue;
    const response = resolveSchema(responseValue, document) || responseValue;
    if (isRecord(response.headers) && Object.keys(response.headers).some((name) => name.toLowerCase() === "location")) result.push({ kind: "location_header", header: "location" });
    if (!isRecord(response.content)) continue;
    for (const media of Object.values(response.content)) {
      if (!isRecord(media) || !isRecord(media.schema)) continue;
      const schema = resolveSchema(media.schema, document) || media.schema;
      if (isRecord(schema.properties)) {
        const identity = ["id", "uuid", "key"].find((name) => Object.hasOwn(schema.properties as Record<string, unknown>, name));
        if (identity) result.push({ kind: "response_body", path: identity });
      }
    }
  }
  return [...new Map(result.map((item) => [JSON.stringify(item), item])).values()];
}

function inferSchemaType(property: Record<string, unknown>): string {
  if (Array.isArray(property.enum) && property.enum.length) return typeof property.enum[0];
  if (typeof property.minimum === "number" || typeof property.maximum === "number") return "number";
  return "string";
}

function resolveRequestSchema(operation: Record<string, unknown>, document: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(operation.requestBody)) return undefined;
  const requestBody = resolveSchema(operation.requestBody, document) || operation.requestBody;
  if (!isRecord(requestBody.content)) return undefined;
  for (const media of Object.values(requestBody.content)) if (isRecord(media) && isRecord(media.schema)) return resolveSchema(media.schema, document) || media.schema;
  return undefined;
}

function responseSchemaReferences(operation: Record<string, unknown>): string[] {
  if (!isRecord(operation.responses)) return [];
  const refs = new Set<string>();
  for (const response of Object.values(operation.responses)) if (isRecord(response)) {
    const direct = schemaRefOf(response);
    if (direct) refs.add(direct);
    if (isRecord(response.content)) for (const media of Object.values(response.content)) if (isRecord(media) && isRecord(media.schema)) {
      const ref = stringValue(media.schema.$ref);
      if (ref) refs.add(ref);
    }
  }
  return [...refs].sort();
}
function requestSchemaReference(operation: Record<string, unknown>): string { if (!isRecord(operation.requestBody)) return ""; const direct = schemaRefOf(operation.requestBody); if (direct) return direct; if (isRecord(operation.requestBody.content)) for (const media of Object.values(operation.requestBody.content)) if (isRecord(media) && isRecord(media.schema) && typeof media.schema.$ref === "string") return media.schema.$ref; return ""; }
function responseStatuses(operation: Record<string, unknown>): number[] { if (!isRecord(operation.responses)) return []; return Object.keys(operation.responses).map(Number).filter((status) => Number.isInteger(status) && status >= 100 && status <= 599).sort((a, b) => a - b); }

function resolveSchema(value: Record<string, unknown>, document: Record<string, unknown>): Record<string, unknown> | undefined {
  const ref = stringValue(value.$ref);
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = document;
  for (const segment of ref.slice(2).split("/")) current = isRecord(current) ? current[segment.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
  return isRecord(current) ? current : undefined;
}

function parseSchemaDocument(relative: string, source: string): Record<string, unknown> | undefined {
  if (!/\.(?:json|ya?ml)$/i.test(relative)) return undefined;
  try { const value = /\.json$/i.test(relative) ? JSON.parse(source) : yaml.load(source); return isRecord(value) ? value : undefined; }
  catch { return undefined; }
}

function adapterFact(factType: DiscoveryFact["fact_type"], key: string, fields: Record<string, unknown>): DiscoveryFact {
  return { fact_id: "fact_" + crypto.createHash("sha256").update(factType + "|" + key).digest("hex").slice(0, 16), fact_type: factType, confidence: typeof fields.confidence === "number" ? fields.confidence : 0.9, ...fields };
}

function expressionString(node: ts.Expression | undefined, constants = new Map<string, string>()): string {
  if (!node) return "";
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text) || "";
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => (ts.isIdentifier(span.expression) && /^[A-Z][A-Z0-9_]*$/.test(span.expression.text) && constants.has(span.expression.text) ? constants.get(span.expression.text) : ":" + expressionName(span.expression)) + span.literal.text).join("");
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionString(node.left, constants);
    const right = expressionString(node.right, constants);
    if (!right && /\?q=|\?query=|\?search=/i.test(node.right.getText())) return left + "?q=:query";
    return left + (right || ":value");
  }
  return "";
}

function expressionName(node: ts.Expression): string { return ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : "value"; }
function methodFromOptions(node: ts.Expression | undefined, constants = new Map<string, string>()): string { return isObjectLiteral(node) ? (propertyString(node, "method", constants) || "GET").toUpperCase() : "GET"; }
function propertyString(object: ts.ObjectLiteralExpression, name: string, constants = new Map<string, string>()): string { const property = object.properties.find((item) => ts.isPropertyAssignment(item) && propertyName(item.name) === name); return property && ts.isPropertyAssignment(property) ? expressionString(property.initializer, constants) : ""; }
function propertyName(node: ts.PropertyName): string { return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : ""; }
function isObjectLiteral(node: ts.Expression | undefined): node is ts.ObjectLiteralExpression { return Boolean(node && ts.isObjectLiteralExpression(node)); }
function clientAdapter(receiver: string): string { if (/axios/i.test(receiver)) return "axios"; if (/fastify/i.test(receiver)) return "fastify"; if (/^(?:app|router|server)$/i.test(receiver)) return "server-router"; return /client|http|api|request/i.test(receiver) ? "request-wrapper" : "server-router"; }
function isHttpReceiver(receiver: string): boolean { return /(?:^|\.)(?:axios|fastify|app|router|server|client|http|api|request)$/i.test(receiver) || /axios|fastify|(?:api|http|request)Client/i.test(receiver); }
function decoratorPath(node: ts.Node, name: string): string | undefined { const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : []; for (const decorator of decorators) { const expression = decorator.expression; if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === name) return expressionString(expression.arguments[0]); if (ts.isIdentifier(expression) && expression.text === name) return ""; } return undefined; }
function titleCase(value: string): string { return value[0] + value.slice(1).toLowerCase(); }
function hasExport(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean { return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)); }
function joinPaths(prefix: string, suffix: string): string { return normalizeEndpoint("/" + [prefix, suffix].map((value) => value.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")); }
function nextRoutePath(relative: string): string { const afterApp = relative.replaceAll("\\", "/").replace(/^.*(?:^|\/)app\//, "").replace(/\/route\.[^.]+$/, ""); return normalizeEndpoint("/" + afterApp.replace(/\[\.\.\.([^\]]+)\]/g, ":$1").replace(/\[([^\]]+)\]/g, ":$1").replace(/\([^/]+\)\//g, "")); }
function schemaRefOf(value: unknown): string { if (!isRecord(value)) return ""; if (typeof value.$ref === "string") return value.$ref; return ""; }
function stringConstants(sourceFile: ts.SourceFile): Map<string, string> { const result = new Map<string, string>(); for (const statement of sourceFile.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) result.set(declaration.name.text, declaration.initializer.text); return result; }
function inlineScriptLiterals(sourceFile: ts.SourceFile): Array<{ pos: number; text: string }> { const result: Array<{ pos: number; text: string }> = []; const visit = (node: ts.Node): void => { if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteralLike(node)) && /\bfetch\s*\(/.test(node.text)) { const scripts = [...node.text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]; if (scripts.length) scripts.forEach((match, index) => result.push({ pos: node.pos + index, text: match[1] })); else result.push({ pos: node.pos, text: node.text }); } ts.forEachChild(node, visit); }; visit(sourceFile); return result; }
function propertyAccessName(node: ts.Expression): string { return ts.isPropertyAccessExpression(node) ? node.name.text : ""; }
function isEquality(kind: ts.SyntaxKind): boolean { return kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken; }
function operationKind(method: string, endpoint: string): string { if (/summary/i.test(endpoint)) return "summary"; if (/count/i.test(endpoint)) return "count"; if (/\?.*(?:q|query|search)=/i.test(endpoint)) return "search"; return ({ GET: "read", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete", OPTIONS: "cors" } as Record<string, string>)[method] || method.toLowerCase(); }
function normalizeEndpoint(endpoint: string): string { try { const url = new URL(endpoint, "http://discovery.invalid"); return ((decodeURIComponent(url.pathname).replace(/\{([^}]+)\}/g, ":$1").replace(/\/$/, "") || "/") + url.search.replace(/%20/g, " ")); } catch { return (endpoint || "/").replace(/\{([^}]+)\}/g, ":$1"); } }
function collectionPath(value: string): string { return normalizeEndpoint(value).replace(/\?.*$/, "").replace(/\/:([^/]+).*$/, "") || "/"; }
function featureFromPath(value: string): string { const segments = value.replace(/\?.*$/, "").split("/").filter(Boolean); return ([...segments].reverse().find((segment) => !segment.startsWith(":")) || path.basename(value, path.extname(value)) || "project_root").replace(/[^A-Za-z0-9_.:-]+/g, "_"); }
function scriptKind(relative: string): ts.ScriptKind { if (/\.tsx$/i.test(relative)) return ts.ScriptKind.TSX; if (/\.jsx$/i.test(relative)) return ts.ScriptKind.JSX; if (/\.[cm]?js$/i.test(relative)) return ts.ScriptKind.JS; return ts.ScriptKind.TS; }
function arrayStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
