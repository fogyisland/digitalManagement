/**
 * Runtime contract checks — how the interface reads time.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * Every timestamp this system stores is written in UTC — every database
 * connection sets `time_zone = '+00:00'`, and the columns are `DATETIME` — and
 * it comes back over the API as the naive string `YYYY-MM-DD HH:MM:SS`. That
 * form is the one shape JavaScript cannot read on its own: V8 parses it as
 * LOCAL time, so a browser that is not on UTC reads every timestamp in the
 * interface shifted by its own offset.
 *
 * The shift is not a cosmetic detail. The node list answers "is this
 * ComfyUI alive?" with a heartbeat that was fifteen minutes old, and the
 * interface said it had been quiet for eight hours — or said the node had
 * been talking since yesterday. The database and the browser were both
 * telling the truth; they were simply reading the same sentence in different
 * timezones.
 *
 * These checks read the interface's own time helpers, because they are the
 * one place the whole front end turns a timestamp into something a person
 * reads. The assertions are written so that they fail on *any* machine: they
 * compare against the UTC instant, not against a clock reading.
 *
 * The last of them compares the interface's reader with the server's. The two
 * are copies of one rule in two languages, and the check is what keeps them
 * from drifting apart.
 */

import assert from 'node:assert/strict';
import { parseDateTime } from '../../src/server/lib/auth.js';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/**
 * The shape the database hands over: a naive UTC string.
 *
 * @param {Date} instant
 * @returns {string} `YYYY-MM-DD HH:MM:SS`
 */
function naiveUtc(instant) {
  return instant.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The instant a reader found, as text.
 *
 * @param {Date|null|undefined} value
 * @returns {string|null}
 */
function isoOf(value) {
  if (!value) return null;
  const time = value.getTime();
  return Number.isNaN(time) ? 'not a date' : value.toISOString();
}

/** @type {RuntimeCheck[]} */
export const timeChecks = [
  {
    name: 'a timestamp from the database is read as the UTC instant it is',
    async run(ctx) {
      const parsed = ctx.formatUtils.parseTimestamp('2026-11-16 04:33:42');
      assert.ok(parsed, 'the naive DATETIME form must be readable');
      assert.equal(
        parsed.toISOString(),
        '2026-11-16T04:33:42.000Z',
        'the database writes UTC; reading that form as local time shifts every timestamp ' +
          'in the interface by the machine offset',
      );
    },
  },

  {
    name: 'a timestamp that already carries its zone is left alone',
    async run(ctx) {
      const parsed = ctx.formatUtils.parseTimestamp('2026-11-16T04:33:42.000Z');
      assert.ok(parsed, 'an ISO timestamp must be readable');
      assert.equal(parsed.toISOString(), '2026-11-16T04:33:42.000Z');
    },
  },

  {
    name: 'a value that is not a timestamp reads as nothing rather than as a wrong date',
    async run(ctx) {
      assert.equal(ctx.formatUtils.parseTimestamp('not a date'), null);
      assert.equal(ctx.formatUtils.formatDate('not a date'), '');
      assert.equal(ctx.formatUtils.relativeTime('not a date'), '');
    },
  },

  {
    name: 'the interface and the server read a timestamp the same way',
    async run(ctx) {
      // Two copies of one rule — the server's `parseDateTime` and the
      // interface's `parseTimestamp`. They live in different languages and
      // different processes, so nothing keeps them in step but this check.
      // The server compares a stored expiry against the clock; the interface
      // renders a stored heartbeat against the clock. If the two disagree
      // about what a timestamp means, one of them is lying by the machine's
      // offset.
      const shapes = [
        '2026-11-16 04:33:42',
        '2026-11-16T04:33:42',
        '2026-11-16 04:33:42.123',
        '2026-11-16T04:33:42.123Z',
        '2026-11-16T04:33:42+08:00',
      ];
      for (const shape of shapes) {
        assert.equal(
          isoOf(parseDateTime(shape)),
          isoOf(ctx.formatUtils.parseTimestamp(shape)),
          `the two readers disagree about "${shape}"`,
        );
      }
    },
  },

  {
    name: 'a heartbeat from a minute ago says a minute ago',
    async run(ctx) {
      const oneMinuteAgo = naiveUtc(new Date(Date.now() - 60 * 1000));
      assert.equal(
        ctx.formatUtils.relativeTime(oneMinuteAgo),
        '1 分钟前',
        'the heartbeat of a node that just spoke must not be shifted by the machine offset',
      );
    },
  },

  {
    name: 'a heartbeat from a day ago says a day ago',
    async run(ctx) {
      const yesterday = naiveUtc(new Date(Date.now() - 24 * 60 * 60 * 1000));
      assert.equal(ctx.formatUtils.relativeTime(yesterday), '1 天前');
    },
  },

  {
    name: 'a heartbeat from the future reads as just now',
    async run(ctx) {
      // Two clocks that disagree, not a node that has not spoken yet.
      const ahead = naiveUtc(new Date(Date.now() + 5 * 60 * 1000));
      assert.equal(ctx.formatUtils.relativeTime(ahead), '0 秒前');
    },
  },
];
