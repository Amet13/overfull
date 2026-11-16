#!/usr/bin/env node
import { enableCompileCache } from 'node:module';
import { processIo } from './io.js';
import { main } from './main.js';

// Keeps V8's compiled code between runs (Node's own cache directory), so later starts
// skip most of the parsing. Harmless where it cannot be written.
try {
  enableCompileCache();
} catch {
  // an older Node.js, or a read-only cache directory
}

main(process.argv.slice(2), processIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`overfull: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  },
);
