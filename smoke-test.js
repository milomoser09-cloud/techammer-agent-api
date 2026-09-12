const { execSync } = require('child_process');
const BASE = 'http://localhost:3000';
const KEY = 'test-key-12345';
const H = `-H "content-type: application/json" -H "x-api-key: ${KEY}"`;
const curl = (m, p, body) =>
  JSON.parse(execSync(`curl -s -X ${m} ${H} ${body ? `-d '${JSON.stringify(body)}'` : ''} '${BASE}'"${p}"`).toString());

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`  PASS  ${name}`)) : (fail++, console.log(`  FAIL  ${name}`)); };

console.log('\nSmoke test\n');

const h = JSON.parse(execSync(`curl -s ${BASE}/health`).toString());
check('health responds', h.ok === true);

const unauth = execSync(`curl -s -o /dev/null -w "%{http_code}" ${BASE}/stats/transfers`).toString();
check('rejects missing api key', unauth === '401');

const t = curl('POST', '/tools/transfer', { call_id: 'c1', phone: '(305) 555-1234', reason: 'requested_human', summary: 'wants a person' });
check('transfer returns a decision', typeof t.transfer_available === 'boolean');

const q = curl('POST', '/tools/qualification', { call_id: 'c1', phone: '305-555-1234', first_name: 'Dana', last_name: 'Ruiz', email: 'd@x.com', vehicle_year: 2021, vehicle_make: 'Toyota', vehicle_model: 'RAV4', mileage: 48000, current_issue: false });
check('qualification saves', q.saved === true);

const o = curl('POST', '/tools/opt-out', { call_id: 'c2', phone: '3055559999', verbatim_request: 'take me off your list' });
check('opt-out writes', o.suppressed === true);
check('opt-out normalizes to E.164', o.phone === '+13055559999');

const s1 = curl('GET', '/suppression/3055559999');
check('suppressed number matches in any format', s1.suppressed === true);

const s2 = curl('GET', '/suppression/3055551111');
check('clean number is not suppressed', s2.suppressed === false);

const bulk = curl('POST', '/suppression/check', { phones: ['305-555-9999', '3055551111', '+13055551234'] });
check('bulk scrub finds the opt-out', bulk.suppressed_count === 1);

const audit = curl('GET', '/calls/c1');
check('audit trail returns events', audit.events.length >= 2);
check('audit trail includes qualification', audit.qualification.first_name === 'Dana');

const stats = curl('GET', '/stats/transfers');
check('stats aggregate transfers', stats.total_transfers >= 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
