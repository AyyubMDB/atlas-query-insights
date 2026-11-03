import "dotenv/config";
import cron from "node-cron";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schedule = process.env.COLLECT_CRON || "0 */4 * * *"; // every 4 hours by default

console.log(`Atlas Query Profiler collector scheduled: "${schedule}" (cron syntax)`);
console.log("Press Ctrl+C to stop.\n");

function runOnce() {
  const child = execFile(process.execPath, [path.join(__dirname, "profiler.js")], (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) console.error("Collection run failed:", err.message);
  });
  return child;
}

// Run once immediately, then on schedule.
runOnce();
cron.schedule(schedule, runOnce);
