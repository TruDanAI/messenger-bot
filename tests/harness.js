// Test harness siêu nhẹ — không phụ thuộc framework ngoài.
// Cú pháp:
//   const { describe, it, expect, run } = require('./harness');
//   describe('group', () => {
//     it('case', () => expect(value).toEqual(other));
//   });
//   run();    // hoặc trả về exit code

const groups = [];
let current = null;

function describe(name, fn) {
  current = { name, cases: [] };
  groups.push(current);
  fn();
  current = null;
}

function it(name, fn) {
  if (!current) throw new Error('it() phải nằm trong describe()');
  current.cases.push({ name, fn });
}

function expect(actual) {
  return {
    toEqual(expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (!ok) throw new Error(`expected ${JSON.stringify(expected)} nhưng nhận ${JSON.stringify(actual)}`);
    },
    toBe(expected) {
      if (actual !== expected) throw new Error(`expected ${expected} (===) nhưng nhận ${actual}`);
    },
    toBeTrue() {
      if (actual !== true) throw new Error(`expected true nhưng nhận ${actual}`);
    },
    toBeFalse() {
      if (actual !== false) throw new Error(`expected false nhưng nhận ${actual}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`expected truthy nhưng nhận ${actual}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`expected falsy nhưng nhận ${actual}`);
    },
    toContain(sub) {
      if (typeof actual === 'string') {
        if (!actual.includes(sub)) throw new Error(`expected string chứa "${sub}" nhưng nhận "${actual}"`);
      } else if (Array.isArray(actual)) {
        if (!actual.includes(sub)) throw new Error(`expected array chứa ${JSON.stringify(sub)} nhưng nhận ${JSON.stringify(actual)}`);
      } else {
        throw new Error('toContain chỉ hỗ trợ string/array');
      }
    },
    toMatch(re) {
      if (!re.test(String(actual))) throw new Error(`expected "${actual}" match ${re}`);
    },
    notToBe(expected) {
      if (actual === expected) throw new Error(`expected !== ${expected} nhưng giống nhau`);
    }
  };
}

function run() {
  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const group of groups) {
    console.log(`\n  ${group.name}`);
    for (const c of group.cases) {
      try {
        c.fn();
        pass += 1;
        console.log(`    ✓ ${c.name}`);
      } catch (err) {
        fail += 1;
        failures.push({ group: group.name, case: c.name, err });
        console.log(`    ✗ ${c.name}\n        ${err.message}`);
      }
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

module.exports = { describe, it, expect, run };
