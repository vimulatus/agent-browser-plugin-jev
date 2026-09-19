import { lookup, parsePath, type Path } from "./path.js";

/** `==` and `!=` compare with a word, a string or a number; the ordered four need numbers on both sides. */
export type Operator = "==" | "!=" | "<" | "<=" | ">" | ">=";

const ORDERED = new Set<string>(["<", "<=", ">", ">="]);
const OPERATORS = new Set<string>(["==", "!=", ...ORDERED]);

/** A parsed `when` clause: paths, a comparison against a literal, and `not`/`and`/`or`. */
export type Expression =
  | { kind: "path"; path: Path }
  | { kind: "compare"; path: Path; op: Operator; value: string | number }
  | { kind: "not"; operand: Expression }
  | { kind: "and" | "or"; left: Expression; right: Expression };

type Token =
  | { kind: "(" | ")" | Operator | "and" | "or" | "not" }
  | { kind: "path"; path: Path; text: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number };

const TOKEN = /\s*(?:(\(|\)|==|!=|<=|>=|<|>)|"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?)(?![\w.])|([A-Za-z_][\w.\[\]]*))/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) {
      if (text.slice(at).trim() === "") break;
      throw new Error(`when "${text}": unexpected "${text.slice(at).trim()}"`);
    }
    const [, symbol, doubleQuoted, singleQuoted, number, word] = match;
    if (symbol) tokens.push({ kind: symbol as "(" | ")" | Operator });
    else if (doubleQuoted !== undefined) tokens.push({ kind: "string", value: doubleQuoted });
    else if (singleQuoted !== undefined) tokens.push({ kind: "string", value: singleQuoted });
    else if (number !== undefined) tokens.push({ kind: "number", value: Number(number) });
    else if (word === "and" || word === "or" || word === "not") tokens.push({ kind: word });
    else {
      const path = parsePath(word);
      if (!path) throw new Error(`when "${text}": "${word}" is not a path`);
      tokens.push({ kind: "path", path, text: word });
    }
  }
  return tokens;
}

/** Parses a `when` clause. Precedence: `not`, then `and`, then `or`. */
export function parseWhen(text: string): Expression {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const fail = (): never => {
    const token = tokens[at];
    const where = token === undefined ? "the end" : `"${token.kind === "path" ? token.text : "value" in token ? token.value : token.kind}"`;
    throw new Error(`when "${text}": unexpected ${where}`);
  };

  function or(): Expression {
    let left = and();
    while (peek()?.kind === "or") {
      at++;
      left = { kind: "or", left, right: and() };
    }
    return left;
  }
  function and(): Expression {
    let left = not();
    while (peek()?.kind === "and") {
      at++;
      left = { kind: "and", left, right: not() };
    }
    return left;
  }
  function not(): Expression {
    if (peek()?.kind === "not") {
      at++;
      return { kind: "not", operand: not() };
    }
    return primary();
  }
  function primary(): Expression {
    const token = peek();
    if (token?.kind === "(") {
      at++;
      const inner = or();
      if (peek()?.kind !== ")") fail();
      at++;
      return inner;
    }
    if (token?.kind !== "path") return fail();
    at++;
    const op = peek();
    if (op === undefined || !isOperator(op.kind)) return { kind: "path", path: token.path };
    at++;
    const literal = peek();
    if (literal?.kind === "number") {
      at++;
      return { kind: "compare", path: token.path, op: op.kind, value: literal.value };
    }
    if (ORDERED.has(op.kind)) return fail();
    if (literal?.kind === "string") {
      at++;
      return { kind: "compare", path: token.path, op: op.kind, value: literal.value };
    }
    if (literal?.kind === "path" && literal.path.length === 1) {
      at++;
      return { kind: "compare", path: token.path, op: op.kind, value: literal.text };
    }
    return fail();
  }

  const expression = or();
  if (at < tokens.length) fail();
  return expression;
}

function isOperator(kind: Token["kind"]): kind is Operator {
  return OPERATORS.has(kind);
}

function holds(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}

export function evaluate(expression: Expression, facts: unknown): boolean {
  switch (expression.kind) {
    case "path":
      return holds(lookup(facts, expression.path));
    case "compare": {
      const value = lookup(facts, expression.path);
      if (expression.op === "==") return value === expression.value;
      if (expression.op === "!=") return value !== expression.value;
      if (typeof value !== "number" || typeof expression.value !== "number") return false;
      switch (expression.op) {
        case "<":
          return value < expression.value;
        case "<=":
          return value <= expression.value;
        case ">":
          return value > expression.value;
        default:
          return value >= expression.value;
      }
    }
    case "not":
      return !evaluate(expression.operand, facts);
    case "and":
      return evaluate(expression.left, facts) && evaluate(expression.right, facts);
    case "or":
      return evaluate(expression.left, facts) || evaluate(expression.right, facts);
  }
}

/** Every path the expression reads, left to right. */
export function pathsOf(expression: Expression): Path[] {
  switch (expression.kind) {
    case "path":
    case "compare":
      return [expression.path];
    case "not":
      return pathsOf(expression.operand);
    case "and":
    case "or":
      return [...pathsOf(expression.left), ...pathsOf(expression.right)];
  }
}
