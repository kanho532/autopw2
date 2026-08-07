const VARIABLE_PATTERN = /\$\{([^}]+)\}/g;

export interface VariableReference { expression: string; namespace: string; name: string; path: string[]; }

export function extractVariableReferences(value: unknown): VariableReference[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return [];
  const references: VariableReference[] = [];
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const expression = match[1].trim();
    const path = expression.split(".").filter(Boolean);
    if (path.length < 2) references.push({ expression, namespace: path[0] || "", name: "", path });
    else references.push({ expression, namespace: path[0], name: path[1], path: path.slice(2) });
  }
  return references;
}

export function resolveInterpolation<T>(value: T, scopes: Record<string, unknown>): T {
  if (typeof value !== "string") {
    if (Array.isArray(value)) return value.map((item) => resolveInterpolation(item, scopes)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveInterpolation(item, scopes)])) as T;
    return value;
  }
  const whole = value.match(/^\$\{([^}]+)\}$/);
  if (whole) return lookup(scopes, whole[1].trim()) as T;
  return value.replace(VARIABLE_PATTERN, (_match, expression: string) => String(lookup(scopes, expression.trim()))) as T;
}

function lookup(scopes: Record<string, unknown>, expression: string): unknown {
  const parts = expression.split(".").filter(Boolean);
  if (parts.length < 2 || parts[0] === "env") throw Object.assign(new Error("undefined or forbidden variable: " + expression), { code: "PLAN_VARIABLE_UNDEFINED" });
  let current: unknown = scopes[parts[0]];
  for (const part of parts.slice(1)) {
    if (!current || typeof current !== "object" || !(part in (current as Record<string, unknown>))) throw Object.assign(new Error("undefined variable: " + expression), { code: "PLAN_VARIABLE_UNDEFINED" });
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
