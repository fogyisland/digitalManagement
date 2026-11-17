/**
 * 夹具：报错的面那条规则。
 *
 * 这条规则要是在「什么形状都放行」，那它就只是一句提醒，不是护栏。所以下面
 * 两个夹具把两个方向都钉住：
 *
 *   - `good` —— 报错都经由 `describeError` / `toError` 到达人眼前：没有问题；
 *   - `bad`  —— 后端那句话被原样端上去：正好四条问题。
 *
 * 而且夹具不只数**条数**，还逐条点名**该说的是哪一句**。只数条数的话，一条
 * 把所有问题都说成同一句话的规则也能蒙混过关——比如把「取的是后端那句英语」
 * 和「端的是错误本身」混为一谈，条数照样是四条。
 *
 * 没有 `bad` 的话，一条再也不报错的规则看起来和一条正常的规则一模一样。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findErrorSurfaceProblemsInFile } from './error-surface.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'error-surface');
const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * 一个夹具一个条目：它应该报几条问题，每一条该说的是哪句话，以及为什么。
 */
export const ERROR_SURFACE_CASES = [
  {
    name: 'good',
    expected: [],
    why: 'every error reaches the reader through describeError() or toError()',
  },
  {
    name: 'bad',
    expected: [
      // `message.error(e.message)`
      'shows the backend sentence raw',
      // `message.error(e.response?.data?.detail)`
      'shows the backend sentence raw',
      // 先存进局部变量再端上去
      'shows the backend sentence raw',
      // `` message.error(`失败：${e}`) `` —— 端的是错误本身，不是那句英语
      'shows the caught error itself',
    ],
    why: 'the backend sentence reaches the reader raw, in four different shapes',
  },
];

/**
 * 跑一遍夹具，把行为不对的那些说出来。
 *
 * @returns {string[]} one line per mismatch, empty when the rule holds
 */
export function findErrorSurfaceFixtureProblems() {
  const problems = [];
  for (const testCase of ERROR_SURFACE_CASES) {
    const file = path.join(FIXTURE_ROOT, testCase.name, 'page.tsx');
    const found = findErrorSurfaceProblemsInFile({ repoRoot: REPO_ROOT, file });

    if (found.length !== testCase.expected.length) {
      problems.push(
        `${testCase.name} — expected ${testCase.expected.length} problem(s) because ${testCase.why}, ` +
          `got ${found.length}`,
      );
      for (const line of found) problems.push(`  ${testCase.name}: ${line}`);
      continue;
    }

    // 条数对了还不够——每一条都得是**对的那一条**。
    testCase.expected.forEach((wanted, index) => {
      if (!found[index].includes(wanted)) {
        problems.push(
          `${testCase.name} — problem #${index + 1} should say "${wanted}", but it says: ${found[index]}`,
        );
      }
    });
  }
  return problems;
}
