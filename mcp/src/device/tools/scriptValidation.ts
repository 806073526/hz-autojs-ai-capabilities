export interface TopLevelReturnLocation {
  line: number;
  column: number;
}

export function isNodeScriptHeader(scriptContent: string): boolean {
  let text = scriptContent;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const directive = /^\s*(["'])([^"'\r\n]*)\1\s*;/.exec(text);
  if (!directive) return false;
  // 与手机端 hasNodejsScriptHeader 保持同一口径：只认 `"nodejs";` 与 `"ui nodejs";`
  // 这两种会切换到 Node 引擎的写法；`"nodejs ui";` 等其它组合手机端仍按 Rhino 执行。
  const tagText = directive[2].trim();
  return tagText === "nodejs" || tagText === "ui nodejs";
}

/**
 * 拦截最常见的脚本编译失败：顶层 return。
 *
 * AutoJs 使用 Rhino，顶层 return 会在编译阶段报 invalid return。该错误发生在
 * 子引擎执行任何上报逻辑之前，父引擎只能看到引擎消失，最终给出泛化的 TASK_FAILED。
 * 这里做一个保守的轻量扫描，只拒绝明确处于顶层语句位置的 return；函数体、注释、
 * 字符串和正则字面量里的 return 不会被误判。
 */
export function findTopLevelReturn(scriptContent: string): TopLevelReturnLocation | undefined {
  let braceDepth = 0;
  let previousSignificant = "";
  let previousSignificantEnd = 0;
  let index = 0;

  while (index < scriptContent.length) {
    const char = scriptContent[index];
    const next = scriptContent[index + 1];

    if (isWhitespace(char)) {
      index++;
      continue;
    }

    if (char === "/" && next === "/") {
      index = skipLineComment(scriptContent, index + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(scriptContent, index + 2);
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      index = skipQuotedLiteral(scriptContent, index);
      previousSignificant = "value";
      previousSignificantEnd = index;
      continue;
    }

    if (char === "{") {
      braceDepth++;
      previousSignificant = char;
      previousSignificantEnd = index + 1;
      index++;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      previousSignificant = char;
      previousSignificantEnd = index + 1;
      index++;
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index++;
      while (index < scriptContent.length && isIdentifierPart(scriptContent[index])) {
        index++;
      }
      const word = scriptContent.slice(start, index);
      const separatedByLineBreak = scriptContent.slice(previousSignificantEnd, start).includes("\n");
      if (word === "return" && braceDepth === 0 && isReturnStatementStart(previousSignificant, separatedByLineBreak)) {
        return locationAt(scriptContent, start);
      }
      previousSignificant = word;
      previousSignificantEnd = index;
      continue;
    }

    if (isNumberStart(char)) {
      index++;
      while (index < scriptContent.length && isNumberPart(scriptContent[index])) {
        index++;
      }
      previousSignificant = "value";
      previousSignificantEnd = index;
      continue;
    }

    previousSignificant = char;
    previousSignificantEnd = index + 1;
    index++;
  }

  return undefined;
}

function isReturnStatementStart(previousSignificant: string, separatedByLineBreak: boolean): boolean {
  if (
    previousSignificant === ""
    || previousSignificant === "{"
    || previousSignificant === "}"
    || previousSignificant === ";"
    || previousSignificant === ")"
    || previousSignificant === ":"
    || previousSignificant === "value"
  ) {
    return true;
  }
  if (!separatedByLineBreak) {
    return false;
  }
  return !isContinuationToken(previousSignificant);
}

function isContinuationToken(token: string): boolean {
  return token === "="
    || token === ","
    || token === "."
    || token === "("
    || token === "["
    || token === "+"
    || token === "-"
    || token === "*"
    || token === "/"
    || token === "%"
    || token === "&"
    || token === "|"
    || token === "?"
    || token === ":"
    || token === ">"
    || token === "<"
    || token === "!"
    || token === "=>";
}

function skipLineComment(scriptContent: string, index: number): number {
  const newline = scriptContent.indexOf("\n", index);
  return newline < 0 ? scriptContent.length : newline + 1;
}

function skipBlockComment(scriptContent: string, index: number): number {
  const end = scriptContent.indexOf("*/", index);
  return end < 0 ? scriptContent.length : end + 2;
}

function skipQuotedLiteral(scriptContent: string, index: number): number {
  const quote = scriptContent[index];
  index++;
  while (index < scriptContent.length) {
    const char = scriptContent[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    index++;
  }
  return index;
}

function locationAt(scriptContent: string, index: number): TopLevelReturnLocation {
  const before = scriptContent.slice(0, index);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: index - lastNewline
  };
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function isNumberStart(char: string): boolean {
  return /[0-9]/.test(char);
}

function isNumberPart(char: string): boolean {
  return /[0-9A-Fa-fxX._]/.test(char);
}
