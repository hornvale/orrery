// Aggregate self-time by function from a V8 .cpuprofile (CDP Profiler.stop).
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const key = (n) => {
  const f = n.callFrame;
  const name = f.functionName || '(anonymous)';
  const loc = f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : '(native)';
  return `${name} @ ${loc}`;
};
// Self time: sum timeDeltas attributed to each sampled node.
const self = new Map();
let total = 0;
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i] || 0;
  total += dt;
  const n = byId.get(p.samples[i]);
  if (!n) continue;
  const k = key(n);
  self.set(k, (self.get(k) || 0) + dt);
}
// Total time (self + descendants) per function, by walking parents.
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const totalT = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i] || 0;
  const seen = new Set();
  let id = p.samples[i];
  while (id !== undefined) {
    const n = byId.get(id);
    if (!n) break;
    const k = key(n);
    if (!seen.has(k)) { totalT.set(k, (totalT.get(k) || 0) + dt); seen.add(k); }
    id = parent.get(id);
  }
}
const us = (x) => (x / 1000).toFixed(1) + 'ms';
const pctOf = (x) => ((x / total) * 100).toFixed(1) + '%';
console.log(`\n=== profile total sampled: ${us(total)} (${p.samples.length} samples) ===`);
console.log('\n--- TOP SELF TIME (where the CPU actually sat) ---');
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .forEach(([k, v]) => console.log(`${pctOf(v).padStart(6)}  ${us(v).padStart(9)}  ${k}`));
console.log('\n--- TOP TOTAL TIME (self + descendants) ---');
[...totalT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)
  .forEach(([k, v]) => console.log(`${pctOf(v).padStart(6)}  ${us(v).padStart(9)}  ${k}`));
