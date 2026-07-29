// The schedule format the backup dialog writes and the scheduler reads.
//
// Both ends of the backup settings speak cron: the picker composes an
// expression, the typed field takes one straight, and one parser decides what
// either means. So the parser is where the whole feature's idea of "every day
// at 4am" actually lives, and it gets tested on its own.
//
//   node scripts/test/cron.mjs

import { parseCron, isValidCron, nextRun, previousRun, describeCron } from '../../src/cron.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const iso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : String(d));
const next = (expr, from) => iso(nextRun(expr, from));

// --- What a field can say -----------------------------------------------------
console.log('\nparsing');
check(isValidCron('0 4 * * *'), 'every day at 04:00');
check(isValidCron('*/15 * * * *'), 'a step');
check(isValidCron('0 0,12 * * *'), 'a list');
check(isValidCron('30 9-17 * * mon-fri'), 'ranges and day names');
check(isValidCron('@daily'), 'a macro');
check(parseCron('@weekly').expr === '0 0 * * 0', '@weekly expands', parseCron('@weekly').expr);
check(!isValidCron(''), 'nothing is not a schedule');
check(!isValidCron('0 4 * *'), 'four fields is not a schedule');
check(!isValidCron('0 24 * * *'), 'hour 24 does not exist');
check(!isValidCron('61 * * * *'), 'minute 61 does not exist');
check(!isValidCron('0 4 * * xyz'), 'an unknown weekday is refused');
check(!isValidCron('0-x 4 * * *'), 'a range with junk in it is refused');
check(!isValidCron('*/0 * * * *'), 'a zero step is refused');
// Sunday is both 0 and 7 everywhere else cron is written, so it is here too.
check(nextRun('0 0 * * 7', at(2026, 7, 29)).getDay() === 0, 'weekday 7 is Sunday');

let msg = '';
try {
  parseCron('0 4 * *');
} catch (e) {
  msg = e.message;
}
check(/five fields/.test(msg), 'the error says what is wrong, in words', msg);

// --- When it next comes round -------------------------------------------------
console.log('\nnext firing');
// 29 July 2026 is a Wednesday.
check(next('0 4 * * *', at(2026, 7, 29, 3, 0)) === '2026-07-29 04:00', 'later today');
check(next('0 4 * * *', at(2026, 7, 29, 4, 0)) === '2026-07-30 04:00', 'asked *at* 04:00, the answer is tomorrow');
check(next('0 4 * * *', at(2026, 7, 29, 5, 0)) === '2026-07-30 04:00', 'already past, so tomorrow');
check(next('*/15 * * * *', at(2026, 7, 29, 9, 7)) === '2026-07-29 09:15', 'the next quarter hour');
check(next('*/15 * * * *', at(2026, 7, 29, 9, 59)) === '2026-07-29 10:00', 'and over the hour');
check(next('0 */6 * * *', at(2026, 7, 29, 7, 30)) === '2026-07-29 12:00', 'every six hours');
check(next('0 3 * * mon', at(2026, 7, 29, 12, 0)) === '2026-08-03 03:00', 'Mondays at 03:00');
check(next('0 0 1 * *', at(2026, 7, 29, 12, 0)) === '2026-08-01 00:00', 'the first of the month');
check(next('0 0 29 2 *', at(2026, 7, 29)) === '2028-02-29 00:00', 'a leap day is found two years out');
check(next('30 9-17 * * *', at(2026, 7, 29, 17, 45)) === '2026-07-30 09:30', 'past the end of the window');
// Cron's one strange rule: two narrowed day fields are an OR, not an AND.
check(next('0 0 13 * fri', at(2026, 11, 2)) === '2026-11-06 00:00', 'day-of-month and weekday are ORed (Friday comes first)');
check(next('0 0 13 * fri', at(2026, 11, 7)) === '2026-11-13 00:00', '…and the 13th counts even though it is a Friday too');
check(nextRun('0 0 30 2 *', at(2026, 7, 29)) === null, '30 February never comes');

console.log('\nprevious firing');
check(iso(previousRun('0 4 * * *', at(2026, 7, 29, 3, 0))) === '2026-07-28 04:00', 'yesterday, when today has not happened yet');
check(iso(previousRun('0 4 * * *', at(2026, 7, 29, 4, 0))) === '2026-07-29 04:00', 'this minute counts as past');
check(iso(previousRun('0 3 * * mon', at(2026, 7, 29, 12, 0))) === '2026-07-27 03:00', 'the Monday just gone');

// The clock change. In Zurich, 29 March 2026 skips 02:00 → 03:00, so a job set
// for 02:30 has no 02:30 to run at; it must still run that day, not vanish.
const tz = process.env.TZ;
process.env.TZ = 'Europe/Zurich';
const spring = nextRun('30 2 * * *', new Date(2026, 2, 28, 12, 0));
check(spring && spring.getDate() === 29 && spring.getMonth() === 2,
  'the day the clocks go forward still gets its backup', iso(spring));
if (tz === undefined) delete process.env.TZ;
else process.env.TZ = tz;

// --- Saying it in words -------------------------------------------------------
console.log('\ndescribing');
const says = (expr, want) => check(describeCron(expr) === want, `${expr} → ${want}`, describeCron(expr));
says('0 4 * * *', 'At 04:00 every day');
says('*/15 * * * *', 'Every 15 minutes');
says('0 */6 * * *', 'Every 6 hours, at :00');
says('30 * * * *', 'Every hour at :30');
says('0 3 * * 1', 'At 03:00 on Mondays');
says('0 0 1 * *', 'At 00:00 on the 1st');
says('0 0,12 * * *', 'At 00:00 and 12:00 every day');
// Two narrowed day fields read as the OR they are: Tuesdays, *and* the 3rd.
says('7 5 3 1,6 2', 'At 05:07 on Tuesdays and on the 3rd and in January and June');
// A shape it cannot phrase honestly comes back as itself. A wrong description
// is worse than none — this is the line under the field people read to check
// they typed what they meant.
says('1,2,3,4 5,6 * * *', '1,2,3,4 5,6 * * *');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
