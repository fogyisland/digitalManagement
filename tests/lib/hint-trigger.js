/**
 * 提示的触发者，不能是一个被按住的按钮。
 *
 * ## 为什么这条规则存在
 *
 * 浏览器不给 `disabled` 的表单控件派发鼠标事件——鼠标停在被禁用的
 * `<button>` 上，`mouseenter` 什么也不会发生。而 antd 的 Tooltip 是把鼠标
 * 事件**直接挂在它所包裹的那个元素**上的，所以 Tooltip 包着一个禁用按钮时，
 * 提示会跟着按钮一起消失：按钮变灰了，人却不知道为什么。
 *
 * 而「为什么是灰的」恰恰是禁用按钮唯一需要说的事。
 *
 * ## 这条规则怎么判
 *
 * 它不猜源码，它**渲染**一遍：把这个组件套上一个被按住的按钮，渲染成真实
 * 的 HTML，然后看 antd 把提示挂在了谁身上——
 *
 *   - 提示必须挂在某个元素上（`aria-describedby` 落在它身上）；
 *   - 那个元素**不能**是一个被禁用的表单控件；
 *   - 那个元素必须**包着**那个被按住的按钮（提示得解释的是它）。
 *
 * `src/client/components/ui/Hint.tsx` 的做法是：提示挂在一层
 * `<span style="display:inline-block">` 上，span 不禁用，鼠标事件照常触发。
 * 规则不关心用的是 span 还是 div，只关心**触发者不是被按住的控件**。
 *
 * ## 为什么用渲染而不是正则
 *
 * 正则只能猜「源码里有没有 span」，而这条规则要说的是「浏览器到底会把
 * 提示挂在谁身上」。前者是实现的影子，后者是事实——antd 哪天改了挂载方式，
 * 影子还在，事实已经变了。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 表单控件——被禁用时浏览器不派发鼠标事件的那些。 */
const DISABLED_FORM_CONTROLS = new Set(['button', 'input', 'select', 'textarea']);

/** 探针用的提示语：非空，antd 才会把 `aria-describedby` 挂上去。 */
const PROBE_TITLE = '先在左上角选中一个租户，再写入。';

/**
 * 把一个 TSX 组件读进来。
 *
 * Node 的类型擦除不认 JSX，所以这里先用 `typescript` 转一遍。模块解析锚在
 * 仓库根上——`antd`、`react` 都在根目录的 `node_modules` 里。
 *
 * @param {string} repoRoot
 * @param {string} file the `.tsx` file
 * @returns {any} the module's default export
 */
function loadTsxComponent(repoRoot, file) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');

  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path.basename(file),
  });

  const module = { exports: {} };
  const fromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const evaluate = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  evaluate(module.exports, fromRepo, module, file, path.dirname(file));
  return module.exports.default;
}

/**
 * 渲染这个组件包着一个被按住的按钮，看看提示挂在了谁身上。
 *
 * @param {string} repoRoot
 * @param {string} file
 * @returns {{markup: string, triggers: {tag: string, attrs: string}[], hasDisabledButton: boolean}}
 */
function renderAroundDisabledButton(repoRoot, file) {
  const require = createRequire(import.meta.url);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { Button } = require('antd');

  const Component = loadTsxComponent(repoRoot, file);
  if (typeof Component !== 'function') {
    throw new Error(`${file} does not export a component`);
  }

  const markup = renderToStaticMarkup(
    React.createElement(
      Component,
      { title: PROBE_TITLE },
      React.createElement(Button, { disabled: true }, '探针按钮'),
    ),
  );

  // antd 把 `aria-describedby` 挂在提示的触发元素上——那正是浏览器会派发
  // 鼠标事件的元素，也是提示消失与否的开关。
  const triggers = [];
  const pattern = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?aria-describedby[^>]*)>/g;
  let match = pattern.exec(markup);
  while (match !== null) {
    triggers.push({ tag: match[1].toLowerCase(), attrs: match[2] });
    match = pattern.exec(markup);
  }

  return {
    markup,
    triggers,
    hasDisabledButton: /<button[^>]*\bdisabled\b/.test(markup),
  };
}

/**
 * 找出这个组件身上的问题。
 *
 * @param {{repoRoot: string, hintFile: string}} input
 * @returns {string[]} one line per problem, empty when the component holds up
 */
export function findHintTriggerProblems({ repoRoot, hintFile }) {
  const problems = [];

  let rendered;
  try {
    rendered = renderAroundDisabledButton(repoRoot, hintFile);
  } catch (error) {
    return [`${hintFile} could not be rendered: ${error instanceof Error ? error.message : error}`];
  }

  if (!rendered.hasDisabledButton) {
    problems.push(`${hintFile} — the probe did not render a disabled button, so nothing was checked`);
    return problems;
  }

  if (rendered.triggers.length === 0) {
    problems.push(
      `${hintFile} — the tooltip is attached to nothing: no element carries aria-describedby, ` +
        'so the hint never reaches the reader',
    );
    return problems;
  }

  for (const trigger of rendered.triggers) {
    const disabled = /\bdisabled\b/.test(trigger.attrs);
    if (DISABLED_FORM_CONTROLS.has(trigger.tag) && disabled) {
      problems.push(
        `${hintFile} — the tooltip is attached to a disabled <${trigger.tag}>: the browser ` +
          'sends a disabled control no mouse events, so the explanation disappears exactly ' +
          'when it is needed. Wrap the control in an element that is not disabled.',
      );
    }
  }

  return problems;
}
