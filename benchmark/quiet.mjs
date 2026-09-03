#!/usr/bin/env node
// Reports whether this machine is quiet enough for the gate's timed stages, and what is keeping it
// busy. Read-only and takes no arguments: run it before a release, and again after stopping things.
import { cpus, loadavg } from 'node:os';
import { describeLoad, topProcesses } from './lib/quiet-machine.mjs';

const cores = cpus().length;
const [load1, load5, load15] = loadavg();
const { blocked, text } = describeLoad(load1, cores, topProcesses());
console.log(text);
console.log(`load 1/5/15 min: ${load1.toFixed(2)} / ${load5.toFixed(2)} / ${load15.toFixed(2)}`);
console.log(blocked ? 'VERDICT: not quiet enough; the gate would wait here.' : 'VERDICT: quiet enough to start the timed stages.');
process.exit(blocked ? 1 : 0);
