/**
 * A strict JSON parser (RFC 8259) that also records where each value starts,
 * keyed by JSON Pointer, so configuration errors can say "line 12, column 7"
 * rather than only a path. Values are identical to `JSON.parse`, except that
 * duplicate object keys are rejected instead of silently keeping the last.
 */

export interface Position {
  line: number;
  column: number;
}

export interface ParsedJson {
  value: unknown;
  /** JSON Pointer -> position of the value (or of the key, for object members). */
  positions: Map<string, Position>;
}

export class JsonSyntaxError extends Error {
  readonly position: Position;
  /** The problem without its location. */
  readonly reason: string;

  constructor(reason: string, position: Position) {
    super(
      `${reason} at line ${String(position.line)}, column ${String(position.column)}`,
    );
    this.name = "JsonSyntaxError";
    this.position = position;
    this.reason = reason;
  }
}

/** Escape one JSON Pointer reference token (RFC 6901). */
export function pointerToken(token: string | number): string {
  return String(token).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function parseJsonWithPositions(text: string): ParsedJson {
  let i = 0;
  const positions = new Map<string, Position>();
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // tolerate a BOM

  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) {
    if (src.charCodeAt(k) === 10) lineStarts.push(k + 1);
  }
  const positionAt = (index: number): Position => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: index - (lineStarts[low] as number) + 1 };
  };
  const fail = (message: string, at = i): never => {
    throw new JsonSyntaxError(message, positionAt(at));
  };
  const ws = (): void => {
    while (i < src.length) {
      const c = src.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };

  const parseString = (): string => {
    const start = i;
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= src.length) fail("Unterminated string", start);
      const c = src.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return out;
      }
      if (c < 0x20) fail("Control character in string");
      if (c === 0x5c) {
        const e = src[i + 1];
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (e !== undefined && e in simple) {
          out += simple[e] as string;
          i += 2;
        } else if (e === "u") {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid unicode escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          fail("Invalid escape");
        }
      } else {
        out += src[i] as string;
        i++;
      }
    }
  };

  const parseNumber = (): number => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (!match) return fail("Invalid number");
    i += match[0].length;
    return Number(match[0]);
  };

  const parseValue = (pointer: string, record: boolean): unknown => {
    ws();
    if (record) positions.set(pointer, positionAt(i));
    const c = src[i];
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (src[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (src[i] !== '"') fail("Expected a quoted property name");
        const keyAt = i;
        const key = parseString();
        if (Object.hasOwn(obj, key)) fail(`Duplicate key "${key}"`, keyAt);
        ws();
        if (src[i] !== ":") fail("Expected ':'");
        i++;
        const child = `${pointer}/${pointerToken(key)}`;
        positions.set(child, positionAt(keyAt));
        Object.defineProperty(obj, key, {
          value: parseValue(child, false),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "}") {
          i++;
          return obj;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (src[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(`${pointer}/${String(arr.length)}`, true));
        ws();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "]") {
          i++;
          return arr;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (c === '"') return parseString();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9"))
      return parseNumber();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (src.startsWith(word, i)) {
        i += word.length;
        return value;
      }
    }
    return fail(
      i >= src.length
        ? "Unexpected end of input"
        : `Unexpected character '${String(c)}'`,
    );
  };

  const value = parseValue("", true);
  ws();
  if (i < src.length) fail("Unexpected content after the JSON value");
  return { value, positions };
}
