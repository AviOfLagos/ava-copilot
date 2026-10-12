#!/usr/bin/env node
// A git merge driver for the locale files: keys added on both sides are all kept, so streams adding
// their own strings never conflict. A key changed differently on both sides is a real conflict: the
// file keeps ours and git is told to stop. Set up by scripts/worktree-bootstrap.sh.
// Usage (from git): node scripts/json-union-merge.mjs %O %A %B
import fs from 'node:fs';

const [basePath, oursPath, theirsPath] = process.argv.slice(2);
const read = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const base = read(basePath);
const ours = read(oursPath);
const theirs = read(theirsPath);
const result = { ...ours };
const conflicts = [];
for (const [key, value] of Object.entries(theirs)) {
  if (!(key in ours)) {
    // Removed by us on purpose: keep it removed
    if (key in base && JSON.stringify(base[key]) === JSON.stringify(value)) continue;
    result[key] = value;
  } else if (
    JSON.stringify(ours[key]) !== JSON.stringify(value) &&
    JSON.stringify(base[key]) !== JSON.stringify(value)
  ) {
    if (JSON.stringify(base[key]) === JSON.stringify(ours[key])) result[key] = value;
    else conflicts.push(key);
  }
}
for (const key of Object.keys(ours)) {
  // Removed by them, unchanged by us: remove it
  if (!(key in theirs) && key in base && JSON.stringify(base[key]) === JSON.stringify(ours[key])) delete result[key];
}
fs.writeFileSync(oursPath, `${JSON.stringify(result, null, 2)}\n`);
if (conflicts.length) {
  console.error(`Locale keys changed on both sides: ${conflicts.join(', ')}`);
  process.exit(1);
}
