/**
 * 夹具：提示触发者的规则。
 *
 * 这条规则要是在「什么形状都放行」，那它就只是一句提醒，不是护栏。所以下面
 * 两个夹具把两个方向都钉住：
 *
 *   - `good` —— 提示挂在一层不禁用的 span 上，被按住的按钮在它里面：没有问题；
 *   - `bad`  —— 提示直接挂在被按住的按钮上：正好一条问题。
 *
 * 没有 `bad` 的话，一条再也不报错的规则看起来和一条正常的规则一模一样。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findHintTriggerProblems } from './hint-trigger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'hint-trigger');
/** 模块解析要锚在真的仓库根上——`antd`、`react` 都在那儿。 */
const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * 一个夹具一个条目：它应该报几条问题，以及为什么。
 */
export const HINT_TRIGGER_CASES = [
  {
    name: 'good',
    expected: 0,
    why: 'the trigger is a span that is not disabled, so the explanation survives',
  },
  {
    name: 'bad',
    expected: 1,
    why: 'the trigger is the disabled button itself, which never receives mouse events',
  },
];

/**
 * 跑一遍夹具，把行为不对的那些说出来。
 *
 * @returns {string[]} one line per mismatch, empty when the rule holds
 */
export function findHintTriggerFixtureProblems() {
  const problems = [];
  for (const testCase of HINT_TRIGGER_CASES) {
    const hintFile = path.join(FIXTURE_ROOT, testCase.name, 'hint.tsx');
    const found = findHintTriggerProblems({ repoRoot: REPO_ROOT, hintFile });
    if (found.length !== testCase.expected) {
      problems.push(
        `${testCase.name} — expected ${testCase.expected} problem(s) because ${testCase.why}, ` +
          `got ${found.length}`,
      );
      for (const line of found) problems.push(`  ${testCase.name}: ${line}`);
    }
  }
  return problems;
}
