import { oneLine } from 'overfull';
import { run } from './main.js';
import { escapeData } from './output.js';

run(process.env, (text) => process.stdout.write(text)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`::error title=Overfull preflight::${escapeData(oneLine(msg))}\n`);
    process.exitCode = 2;
  },
);
