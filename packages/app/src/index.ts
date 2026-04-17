#!/usr/bin/env node
import { runTextMode } from './text-mode.js';

runTextMode().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
