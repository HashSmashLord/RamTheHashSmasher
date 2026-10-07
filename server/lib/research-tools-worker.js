// Worker-thread entry for research-tools.js runExperimentInWorker: runs one
// bounded experiment off the server's main thread and posts its real result.
import { parentPort, workerData } from 'node:worker_threads';
import { runExperiment } from './research-tools.js';

try {
  parentPort.postMessage({ ok: true, result: runExperiment(workerData.req, { timeBudgetMs: workerData.timeBudgetMs }) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
