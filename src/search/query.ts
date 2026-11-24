/**
 * Query language (Scryfall-style), e.g.
 *
 *   kw:ブロッカー (civ:光 or civ:水) cost<=3 pow>=2000
 *   kw:パワーアタッカー>=2000 -kw:スレイヤー
 *   set:DM26-RP1 type:クリーチャー race:ドラゴン
 *   ボルシャック            (bare words search card names)
 *
 * Grammar:
 *   query   := or
 *   or      := and ( ("or" | "|") and )*
 *   and     := unary ( ("and")? unary )*
 *   unary   := ("-" | "not") unary | "(" or ")" | term
 *   term    := [field op] value          op ∈ : = != < <= > >=
 *   value   := word | "quoted string" | /regex/
 */

export type Op = ":" | "=" | "!=" | "<" | "<=" | ">" | ">=";

export type Node =
  | { type: "and"; children: Node[] }
  | { type: "or"; children: Node[] }
  | { type: "not"; child: Node }
  | { type: "term"; field: string | null; op: Op; value: string; quoted: boolean; regex: boolean };

export class QueryError extends Error {
  constructor(
    message: string,
    public position?: number,
  ) {
    super(message);
  }
}

type Token =
  | { kind: "lparen" | "rparen" | "or" | "and" | "not"; pos: number }
  | { kind: "term"; field: string | null; op: Op; value: string; quoted: boolean; regex: boolean; pos: number };

const OPS: Op[] = ["<=", ">=", "!=", ":", "=", "<", ">"];
const FIELD_RE = /^([A-Za-z_぀-ヿ一-鿿]+)(<=|>=|!=|:|=|<|>)/;

function readValue(src: string, i: number): { value: string; quoted: boolean; regex: boolean; end: number } {
  const ch = src[i];
  if (ch === '"') {
    const close = src.indexOf('"', i + 1);
    if (close < 0) throw new QueryError('閉じていない " があります', i);
    return { value: src.slice(i + 1, close), quoted: true, regex: false, end: close + 1 };
  }
  if (ch === "/") {
    let j = i + 1;
    while (j < src.length && src[j] !== "/") j += src[j] === "\\" ? 2 : 1;
    if (j >= src.length) throw new QueryError("閉じていない正規表現 / があります", i);
    return { value: src.slice(i + 1, j), quoted: false, regex: true, end: j + 1 };
  }
  let j = i;
  while (j < src.length && !/[\s()]/.test(src[j]!)) j++;
  return { value: src.slice(i, j), quoted: false, regex: false, end: j };
}

export function tokenize(input: string): Token[] {
  const src = input.normalize("NFKC");
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", pos: i++ });
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", pos: i++ });
      continue;
    }
    if (ch === "|") {
      tokens.push({ kind: "or", pos: i++ });
      continue;
    }
    if (ch === "-" && i + 1 < src.length && !/[\s\d]/.test(src[i + 1]!)) {
      tokens.push({ kind: "not", pos: i++ });
      continue;
    }
    // keywords (only as standalone words)
    const word = src.slice(i).match(/^(or|and|not|OR|AND|NOT)(?=[\s()]|$)/);
    if (word) {
      tokens.push({ kind: word[1]!.toLowerCase() as "or" | "and" | "not", pos: i });
      i += word[1]!.length;
      continue;
    }
    const pos = i;
    const fm = src.slice(i).match(FIELD_RE);
    if (fm) {
      i += fm[0].length;
      const v = readValue(src, i);
      tokens.push({ kind: "term", field: fm[1]!.toLowerCase(), op: fm[2] as Op, value: v.value, quoted: v.quoted, regex: v.regex, pos });
      i = v.end;
      continue;
    }
    const v = readValue(src, i);
    tokens.push({ kind: "term", field: null, op: ":", value: v.value, quoted: v.quoted, regex: v.regex, pos });
    i = v.end;
  }
  return tokens;
}

export function parseQuery(input: string): Node {
  const tokens = tokenize(input);
  let k = 0;
  const peek = () => tokens[k];

  function parseOr(): Node {
    const children = [parseAnd()];
    while (peek()?.kind === "or") {
      k++;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0]! : { type: "or", children };
  }
  function parseAnd(): Node {
    const children: Node[] = [];
    for (;;) {
      const t = peek();
      if (!t || t.kind === "rparen" || t.kind === "or") break;
      if (t.kind === "and") {
        k++;
        continue;
      }
      children.push(parseUnary());
    }
    if (children.length === 0) {
      const t = peek();
      throw new QueryError(t ? "条件がありません（or や ( の前後を確認してください）" : "条件がありません", t?.pos);
    }
    return children.length === 1 ? children[0]! : { type: "and", children };
  }
  function parseUnary(): Node {
    const t = peek()!;
    if (t.kind === "not") {
      k++;
      if (!peek()) throw new QueryError("否定の対象がありません", t.pos);
      return { type: "not", child: parseUnary() };
    }
    if (t.kind === "lparen") {
      k++;
      const inner = parseOr();
      if (peek()?.kind !== "rparen") throw new QueryError("閉じていない ( があります", t.pos);
      k++;
      return inner;
    }
    if (t.kind === "term") {
      k++;
      return { type: "term", field: t.field, op: t.op, value: t.value, quoted: t.quoted, regex: t.regex };
    }
    throw new QueryError(`予期しない "${t.kind}"`, t.pos);
  }

  if (tokens.length === 0) return { type: "and", children: [] };
  const node = parseOr();
  if (k < tokens.length) throw new QueryError("余分な ) があります", tokens[k]!.pos);
  return node;
}

/** Render an AST back to a canonical query string (used in tests and to echo the parsed query). */
export function formatQuery(n: Node): string {
  switch (n.type) {
    case "and":
      return n.children.map((c) => (c.type === "or" ? `(${formatQuery(c)})` : formatQuery(c))).join(" ");
    case "or":
      return n.children.map(formatQuery).join(" or ");
    case "not":
      return `-${n.child.type === "term" ? formatQuery(n.child) : `(${formatQuery(n.child)})`}`;
    case "term": {
      const v = n.regex ? `/${n.value}/` : n.quoted || /\s/.test(n.value) ? `"${n.value}"` : n.value;
      return n.field ? `${n.field}${n.op}${v}` : v;
    }
  }
}

export { OPS };
