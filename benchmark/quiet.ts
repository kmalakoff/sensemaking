#!/usr/bin/env node
// Reports the load-average policy result and a bounded process CPU sample.
import { cpus, loadavg } from 'node:os';
import { describeLoad, topProcesses } from './lib/quiet-machine.ts';

const cores = cpus().length;
const [load1, load5, load15] = loadavg();
const { blocked, text } = describeLoad(load1, cores, topProcesses());
console.log(text);
console.log(`load 1/5/15 min: ${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)}`);
console.log(blocked ? 'VERDICT: load-average policy rejected; gate stage entry would wait.' : 'VERDICT: within the load-average policy limit.');
process.exit(blocked ? 1 : 0);
