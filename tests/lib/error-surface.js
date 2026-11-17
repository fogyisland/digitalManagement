/**
 * 报错的「面」——后端那句话只能经由 describeError 到达人眼前。
 *
 * ## 为什么这条规则存在
 *
 * 后端说英语，前端说中文，而翻译只发生在一个地方：
 * `src/client/utils/errors.ts` 的 `describeError`（以及它的姊妹 `toError`）。
 * 页面若绕过它，把 `e.message` 或 `e.response.data.detail` 直接塞进 toast，
 * 用户就会重新看到那句
 * "A platform administrator must name the tenant to write into (X-Tenant)"。
 *
 * 这条规则盯的正是那个绕路。
 *
 * ## 这条规则怎么判
 *
 * 它读 TypeScript 的语法树（不是正则），逐个 catch 块看两件事：
 *
 *   1. 块里有没有把内容弹给人看的调用——`message.error(...)`、
 *      `message.warning(...)`、`notification.error(...)`；
 *   2. 这个调用的内容是不是**带着后端那句话**。
 *
 * 「带着」指三种形状：
 *
 *   - 直接用了被捕获的那个错误：`message.error(e)`；
 *   - 从它身上取了那句话：`e.message`、`e.response?.data?.detail`，
 *     或者从它身上取了一个装着那句话的局部变量；
 *   - 把它插进了模板：`` message.error(`失败：${e}`) ``。
 *
 * 交给翻译器的除外：`describeError(e, '保存失败')` 和 `toError(e, '保存失败')`
 * 里的 `e` 是被**消费**掉的，不是漏出去的。
 *
 * 条件的**判断部分**也不算漏出去：
 * `status === 403 ? '这句中文' : describeError(e, …)` 是在挑一句中文，
 * 不是在把英文端上来。分支本身仍然要过。
 *
 * 取 `status`（一个数字）不算取那句话，取 `detail`（后端那句英语）才算——
 * 所以「用状态码挑一句中文」和「把英文原样端上去」分得开。
 *
 * ## 为什么不用正则
 *
 * 正则分不清「`e` 被翻译器消费了」和「`e` 被原样端上去了」，也分不清
 * `e.response.status`（一个数字）和 `e.response.data.detail`（那句英语）。
 * 这两件事恰好是这条规则的全部。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

/** 会把内容弹给人看的表面——它们的名字在页面里就是 `message` / `notification`。 */
const READER_SURFACES = new Set(['message', 'notification']);

/** 这些方法名才算是「弹给人看」。 */
const READER_METHODS = new Set(['error', 'warning']);

/**
 * 会把错误变成人话的翻译器。它们**消费**错误，错误不会从它们手里漏出去。
 */
const TRANSLATORS = new Set(['describeError', 'toError']);

/**
 * 从错误身上取「一句话」的属性名。
 *
 * 取 `status`（一个数字）是安全的——`403` 不是后端那句英语；
 * 取 `message` / `detail` 才是把那句话端上去。
 */
const TEXT_PROPERTIES = new Set(['message', 'detail', 'msg', 'text', 'reason']);

/** 递归查局部变量时的深度上限——防的是循环推导，不是防深代码。 */
const MAX_DERIVATION_DEPTH = 6;

/**
 * 递归收集目录下的源文件。
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectSourceFiles(dir) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * 解析一个文件。
 *
 * @param {string} file
 * @returns {import('typescript').SourceFile}
 */
function parseFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * 一个被调用者的名字：`describeError` / `message.error` 都取最后那一段。
 *
 * @param {import('typescript').Expression} expression
 * @returns {string}
 */
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return '';
}

/**
 * 找到所有 catch 块。
 *
 * @param {import('typescript').Node} node
 * @param {import('typescript').CatchClause[]} out
 * @returns {import('typescript').CatchClause[]}
 */
function findCatchClauses(node, out = []) {
  if (ts.isCatchClause(node)) out.push(node);
  // The braces matter: an arrow that *returns* the (always truthy) array
  // stops TypeScript's `forEachChild` after the first child, and the scan
  // then sees only the head of the file.
  node.forEachChild((child) => {
    findCatchClauses(child, out);
  });
  return out;
}

/**
 * 找到所有「弹给人看」的调用。
 *
 * @param {import('typescript').Node} node
 * @param {import('typescript').CallExpression[]} out
 * @returns {import('typescript').CallExpression[]}
 */
function findReaderCalls(node, out = []) {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      READER_SURFACES.has(callee.expression.text) &&
      READER_METHODS.has(callee.name.text)
    ) {
      out.push(node);
    }
  }
  node.forEachChild((child) => {
    findReaderCalls(child, out);
  });
  return out;
}

/**
 * catch 块里声明的局部变量：名字 → 初始值。
 *
 * @param {import('typescript').CatchClause} clause
 * @returns {Map<string, import('typescript').Expression>}
 */
function collectLocals(clause) {
  const locals = new Map();
  const statements = clause.block?.statements ?? [];
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      locals.set(declaration.name.text, declaration.initializer);
    }
  }
  return locals;
}

/**
 * 这条访问链的根是不是那个被捕获的错误？
 *
 * `e.response?.data?.detail` 的根是 `e`；`e.message` 的根也是 `e`。
 *
 * @param {import('typescript').Node} node
 * @param {string} caughtName
 * @returns {boolean}
 */
function rootedAtCaughtError(node, caughtName) {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === caughtName;
}

/**
 * 这个表达式是不是**从那个错误身上取了那句话**？
 *
 * @param {import('typescript').Node} node
 * @param {string} caughtName
 * @param {Map<string, import('typescript').Expression>} locals
 * @param {number} depth
 * @returns {boolean}
 */
function takesTheSentence(node, caughtName, locals, depth = 0) {
  if (!node || depth > MAX_DERIVATION_DEPTH) return false;

  // `e.message` / `e.response?.data?.detail` —— 取的正好是那句话。
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    rootedAtCaughtError(node, caughtName)
  ) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : '';
    if (TEXT_PROPERTIES.has(name)) return true;
  }

  // `e.toString()` —— 把整个错误变成字符串。
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'toString' &&
    rootedAtCaughtError(node.expression, caughtName)
  ) {
    return true;
  }

  // `const detail = e.response?.data?.detail;` —— 局部变量装着那句话。
  //
  // 错误**本身**不算「那句话」——那是 `carriesTheError` 的事，措辞不一样。
  if (ts.isIdentifier(node)) {
    if (node.text === caughtName) return false;
    const local = locals.get(node.text);
    if (local) return takesTheSentence(local, caughtName, locals, depth + 1);
    return false;
  }

  // 模板：`失败：${e}` —— 错误本身被插了进去。
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.some((span) => takesTheSentence(span.expression, caughtName, locals, depth + 1));
  }

  return false;
}

/**
 * 这个表达式是不是**把那个错误原样端上来了**？
 *
 * 与 `takesTheSentence` 的区别：这里连「错误本身」也算——
 * `message.error(e)` 端上去的是 "AxiosError: Request failed with status code 400"，
 * 也是一句英语。
 *
 * @param {import('typescript').Node} node
 * @param {string} caughtName
 * @param {Map<string, import('typescript').Expression>} locals
 * @param {number} depth
 * @returns {boolean}
 */
function carriesTheError(node, caughtName, locals, depth = 0) {
  if (!node || depth > MAX_DERIVATION_DEPTH) return false;
  let found = false;

  const visit = (child) => {
    if (found || !child) return;

    // 翻译器把错误**消费**掉了——它不会从这儿漏出去。
    if (ts.isCallExpression(child)) {
      if (TRANSLATORS.has(calleeName(child.expression))) return;
      child.forEachChild(visit);
      return;
    }

    // 条件的判断部分只是在挑一句中文，不是在把英文端上去。
    if (ts.isConditionalExpression(child)) {
      visit(child.whenTrue);
      visit(child.whenFalse);
      return;
    }

    // 属性访问的 `name` 那一段不是引用（`e.message` 里的 `message` 不是值）。
    if (ts.isPropertyAccessExpression(child)) {
      visit(child.expression);
      return;
    }

    if (ts.isIdentifier(child)) {
      if (child.text === caughtName) {
        found = true;
        return;
      }
      const local = locals.get(child.text);
      if (local && carriesTheError(local, caughtName, locals, depth + 1)) {
        found = true;
      }
      return;
    }

    child.forEachChild(visit);
  };

  visit(node);
  return found;
}

/**
 * 这个调用弹出去的内容是什么？
 *
 * antd 的 `message.error({ content: '…', duration: 5 })` 里，内容在 `content` 上。
 *
 * @param {import('typescript').CallExpression} call
 * @returns {import('typescript').Expression | undefined}
 */
function readerContent(call) {
  const argument = call.arguments[0];
  if (!argument) return undefined;
  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'content'
      ) {
        return property.initializer;
      }
    }
    return undefined;
  }
  return argument;
}

/**
 * 一个文件里的问题。
 *
 * @param {{repoRoot: string, file: string}} input
 * @returns {string[]} one line per problem, empty when the file holds up
 */
export function findErrorSurfaceProblemsInFile({ repoRoot, file }) {
  const problems = [];
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  let parsed;
  try {
    parsed = parseFile(file);
  } catch (error) {
    return [`${relative} could not be parsed: ${error instanceof Error ? error.message : error}`];
  }

  for (const clause of findCatchClauses(parsed)) {
    const caught = clause.variableDeclaration?.name;
    if (!caught || !ts.isIdentifier(caught)) continue;
    const caughtName = caught.text;
    const locals = collectLocals(clause);

    for (const call of findReaderCalls(clause.block)) {
      const content = readerContent(call);
      if (!content) continue;

      const method = calleeName(call.expression);
      const surface = ts.isPropertyAccessExpression(call.expression)
        ? call.expression.expression.getText()
        : 'message';

      // 一句话从错误身上被取出来端上去——那是后端那句英语。
      if (takesTheSentence(content, caughtName, locals)) {
        problems.push(
          `${relative}:${parsed.getLineAndCharacterOfPosition(call.getStart()).line + 1} — ` +
            `${surface}.${method}() shows the backend sentence raw: the caught error reaches ` +
            'the reader without describeError(), so the English text comes back',
        );
        continue;
      }

      // 错误本身被端上去——那也是一句英语。
      if (carriesTheError(content, caughtName, locals)) {
        problems.push(
          `${relative}:${parsed.getLineAndCharacterOfPosition(call.getStart()).line + 1} — ` +
            `${surface}.${method}() shows the caught error itself: the reader gets the raw ` +
            'error text. Route it through describeError() instead',
        );
      }
    }
  }

  return problems;
}

/**
 * 整个前端里的问题。
 *
 * @param {{srcDir: string, repoRoot: string}} input
 * @returns {string[]} one line per problem, empty when everything holds up
 */
export function findErrorSurfaceProblems({ srcDir, repoRoot }) {
  const problems = [];
  for (const file of collectSourceFiles(srcDir)) {
    problems.push(...findErrorSurfaceProblemsInFile({ repoRoot, file }));
  }
  return problems;
}
