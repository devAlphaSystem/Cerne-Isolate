import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearInterval, setImmediate, setInterval } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const WORKER_DIRECTORY = new URL("./workers/", import.meta.url);
const RESULT_DIRECTORY = fileURLToPath(new URL("./results/", import.meta.url));
const DIST_ENTRY = new URL("../dist/index.js", import.meta.url);
const DIST_WORKER = new URL("../dist/worker.js", import.meta.url);

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * 1024;

/** Prazo dos casos de timeout: confortavelmente acima do startup de um filho em máquina lenta. */
const TIMEOUT_MS = 300;
/** Intervalo entre SIGTERM e SIGKILL no caso de escalada. */
const KILL_GRACE_MS = 100;
/** Espera antes de cancelar ou fechar, para que os filhos já estejam dentro do handler. */
const SETTLE_MS = 120;
/** Iterações do worker de CPU: cerca de 30 ms de trabalho por tarefa. */
const CPU_ROUNDS = 6_000_000;
/**
 * Prazo do caso inteiro. Nenhum caso saudável passa de um segundo, então este limite nunca é
 * atingido enquanto o executor assenta suas Promises. Um caso que estoura vira a linha
 * `não assentou`, com o ciclo de vida parcial no snapshot, em vez de travar a suíte.
 */
const CASE_DEADLINE_MS = 4_000;

function deterministicBytes(byteLength, seed) {
  const blockSize = Math.min(byteLength, 65536);
  const block = Buffer.allocUnsafe(blockSize);
  let state = seed >>> 0;
  for (let index = 0; index < blockSize; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 1) >>> 0;
    block[index] = state >>> 24;
  }
  if (byteLength <= blockSize) {
    return block;
  }
  const bytes = Buffer.allocUnsafe(byteLength);
  bytes.fill(block);
  return bytes;
}

const TINY_PAYLOAD = { bytes: deterministicBytes(64, 11) };
const MEDIUM_PAYLOAD = { bytes: deterministicBytes(MEBIBYTE, 22) };
const LARGE_PAYLOAD = { bytes: deterministicBytes(16 * MEBIBYTE, 33) };
const CPU_PAYLOAD = { rounds: CPU_ROUNDS };
const STRUCTURED_PAYLOAD = {
  texto: "cerne-isolate",
  numero: 42,
  decimal: -1.5,
  verdadeiro: true,
  vazio: null,
  grande: 9007199254740993n,
  data: new Date("2026-07-28T12:00:00.000Z"),
  padrao: /cerne-(\d+)/gu,
  bytes: deterministicBytes(4 * KIBIBYTE, 44),
  amostras: new Float64Array([1.5, 2.25, 3.125]),
  mapa: new Map([
    ["a", 1],
    ["b", [1, 2, 3]],
  ]),
  conjunto: new Set(["x", "y"]),
  aninhado: { nivel: { profundo: [{ folha: "fim" }] } },
};

function repeated(value, count) {
  return Array.from({ length: count }, () => value);
}

const CASES = [
  { worker: "digest.mjs", label: "1 tarefa", scenario: () => batch("digest.mjs", {}, [TINY_PAYLOAD]) },
  { worker: "digest.mjs", label: "8 tarefas c1", scenario: () => batch("digest.mjs", { concurrency: 1 }, repeated(TINY_PAYLOAD, 8)) },
  { worker: "digest.mjs", label: "8 tarefas c2", scenario: () => batch("digest.mjs", { concurrency: 2 }, repeated(TINY_PAYLOAD, 8)) },
  { worker: "digest.mjs", label: "8 tarefas c4", scenario: () => batch("digest.mjs", { concurrency: 4 }, repeated(TINY_PAYLOAD, 8)) },
  { worker: "digest.mjs", label: "32 tarefas c4 na fila", scenario: () => batch("digest.mjs", { concurrency: 4, maxQueue: 32 }, repeated(TINY_PAYLOAD, 32)) },
  { worker: "digest.mjs", label: "payload 1 MiB", scenario: () => batch("digest.mjs", {}, [MEDIUM_PAYLOAD]) },
  { worker: "digest.mjs", label: "payload 16 MiB", scenario: () => batch("digest.mjs", {}, [LARGE_PAYLOAD]) },
  { worker: "produce.mjs", label: "resultado 16 MiB", scenario: () => batch("produce.mjs", {}, [{ byteLength: 16 * MEBIBYTE, seed: 55 }]) },
  { worker: "echo.mjs", label: "eco estruturado", scenario: () => batch("echo.mjs", {}, [STRUCTURED_PAYLOAD]) },
  { worker: "cpu.mjs", label: "4 tarefas c1", scenario: () => batch("cpu.mjs", { concurrency: 1 }, repeated(CPU_PAYLOAD, 4)) },
  { worker: "cpu.mjs", label: "4 tarefas c4", scenario: () => batch("cpu.mjs", { concurrency: 4 }, repeated(CPU_PAYLOAD, 4)) },
  { worker: "hang.mjs", label: "timeout", scenario: () => batch("hang.mjs", { timeoutMs: TIMEOUT_MS }, [TINY_PAYLOAD]) },
  { worker: "stubborn.mjs", label: "timeout até sigkill", scenario: () => batch("stubborn.mjs", { timeoutMs: TIMEOUT_MS, killGraceMs: KILL_GRACE_MS }, [TINY_PAYLOAD]) },
  { worker: "hang.mjs", label: "aborto ativo", scenario: abortActiveScenario },
  { worker: "hang.mjs", label: "aborto na fila", scenario: abortQueuedScenario },
  { worker: "hang.mjs", label: "fila cheia", scenario: queueFullScenario },
  { worker: "hang.mjs", label: "close com 4 ativos", scenario: closeWithActiveScenario },
  { worker: "boom.mjs", label: "erro do handler", scenario: () => batch("boom.mjs", {}, [TINY_PAYLOAD]) },
  { worker: "unserializable.mjs", label: "resultado inválido", scenario: () => batch("unserializable.mjs", {}, [TINY_PAYLOAD]) },
  { worker: "digest.mjs", label: "payload inválido", scenario: () => batch("digest.mjs", {}, [{ callback: () => undefined }]) },
  { worker: "crash.mjs", label: "saída no startup", scenario: () => batch("crash.mjs", {}, [TINY_PAYLOAD]) },
  { worker: "rogue.mjs", label: "protocolo inválido", scenario: () => batch("rogue.mjs", {}, [TINY_PAYLOAD]) },
  { worker: "digest.mjs", label: "executor fechado", scenario: closedExecutorScenario },
];

function parseArguments(argv) {
  const options = { save: null, compare: null, repeats: 1, filter: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--save" || flag === "--compare" || flag === "--filter") {
      if (value === undefined) {
        throw new Error(`${flag} exige um valor.`);
      }
      options[flag.slice(2)] = value;
      index += 1;
    } else if (flag === "--repeats") {
      options.repeats = Number(value);
      if (!Number.isInteger(options.repeats) || options.repeats < 1) {
        throw new Error("--repeats exige um inteiro maior que zero.");
      }
      index += 1;
    } else {
      throw new Error(`Argumento desconhecido: ${flag}`);
    }
  }
  return options;
}

function loadResults(label) {
  const path = join(RESULT_DIRECTORY, `${label}.json`);
  if (!existsSync(path)) {
    throw new Error(`Execução salva não encontrada: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const options = parseArguments(process.argv.slice(2));

if (!existsSync(fileURLToPath(DIST_ENTRY)) || !existsSync(fileURLToPath(DIST_WORKER))) {
  throw new Error("dist ausente. Rode `npm run build` primeiro.");
}
if (!existsSync(fileURLToPath(WORKER_DIRECTORY))) {
  throw new Error(`Workers do benchmark ausentes em ${fileURLToPath(WORKER_DIRECTORY)}.`);
}

const { createProcessExecutor } = await import(DIST_ENTRY.href);

const selected = options.filter === null ? CASES : CASES.filter((entry) => `${entry.worker} [${entry.label}]`.includes(options.filter));
if (selected.length === 0) {
  throw new Error(`Nenhum caso corresponde a "${options.filter}".`);
}

/**
 * Registra o handler de rejeição no mesmo turno em que a Promise nasce. Vários casos só coletam
 * os resultados depois de `close()`, e sem isso uma rejeição legítima viraria unhandledRejection.
 */
function settle(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

/**
 * Acumula os eventos do executor e permite esperar por uma quantidade deles, o que substitui
 * esperas por tempo fixo nos casos que precisam dos filhos já em execução.
 */
function createMonitor() {
  const events = [];
  let pending = null;
  const check = () => {
    if (pending !== null && events.filter((event) => event.type === pending.type).length >= pending.count) {
      const { resolve } = pending;
      pending = null;
      resolve();
    }
  };
  return {
    events,
    listen(event) {
      events.push(event);
      check();
    },
    wait(type, count) {
      return new Promise((resolve) => {
        pending = { type, count, resolve };
        check();
      });
    },
  };
}

const EXPIRED = Symbol("prazo do caso esgotado");

/**
 * Corre a Promise do cenário contra o prazo do caso. O timer é cancelado no fim para não
 * segurar o event loop, e a corrida já registra o handler de rejeição do cenário perdedor.
 */
async function withDeadline(pending) {
  const controller = new AbortController();
  try {
    return await Promise.race([pending, sleep(CASE_DEADLINE_MS, EXPIRED, { signal: controller.signal })]);
  } finally {
    controller.abort();
  }
}

/**
 * Cria um executor, roda o cenário e fecha tudo. O tempo do caso inclui `fork`, handshake,
 * execução, resposta e a confirmação de `close`, que é o custo real de uma tarefa isolada.
 */
async function withExecutor(worker, configuration, body) {
  const monitor = createMonitor();
  const executor = createProcessExecutor({
    worker: new URL(worker, WORKER_DIRECTORY),
    onEvent: monitor.listen,
    ...configuration,
  });
  const pending = (async () => {
    try {
      return await body(executor, monitor);
    } finally {
      await executor.close();
    }
  })();
  const results = await withDeadline(pending);
  return { results: results === EXPIRED ? null : results, events: monitor.events };
}

function batch(worker, configuration, payloads) {
  return withExecutor(worker, configuration, (executor) => Promise.all(payloads.map((payload) => settle(executor.run(payload)))));
}

function abortActiveScenario() {
  return withExecutor("hang.mjs", {}, async (executor, monitor) => {
    const controller = new AbortController();
    const pending = settle(executor.run(TINY_PAYLOAD, { signal: controller.signal }));
    await monitor.wait("start", 1);
    await sleep(SETTLE_MS);
    controller.abort();
    return Promise.all([pending]);
  });
}

function abortQueuedScenario() {
  return withExecutor("hang.mjs", { concurrency: 1 }, async (executor) => {
    const controller = new AbortController();
    const active = settle(executor.run(TINY_PAYLOAD));
    const queued = settle(executor.run(TINY_PAYLOAD, { signal: controller.signal }));
    controller.abort();
    await queued;
    await executor.close();
    return Promise.all([active, queued]);
  });
}

function queueFullScenario() {
  return withExecutor("hang.mjs", { concurrency: 1, maxQueue: 1 }, async (executor) => {
    const active = settle(executor.run(TINY_PAYLOAD));
    const queued = settle(executor.run(TINY_PAYLOAD));
    const refused = settle(executor.run(TINY_PAYLOAD));
    await refused;
    await executor.close();
    return Promise.all([active, queued, refused]);
  });
}

function closeWithActiveScenario() {
  return withExecutor("hang.mjs", { concurrency: 4 }, async (executor, monitor) => {
    const pending = repeated(TINY_PAYLOAD, 4).map((payload) => settle(executor.run(payload)));
    await monitor.wait("start", 4);
    await sleep(SETTLE_MS);
    await executor.close();
    return Promise.all(pending);
  });
}

function closedExecutorScenario() {
  return withExecutor("digest.mjs", {}, async (executor) => {
    await executor.close();
    return Promise.all([settle(executor.run(TINY_PAYLOAD))]);
  });
}

function digestOf(data) {
  return createHash("sha256").update(data).digest("hex");
}

const MAX_DEPTH = 8;

/**
 * Descreve um valor recebido pelo IPC de forma estável e legível: buffers viram digest, os tipos
 * do structured clone viram marcadores textuais e as chaves de objeto saem ordenadas.
 */
function describe(value, depth = 0) {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return "undefined";
  }
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") {
    return value;
  }
  if (type === "bigint") {
    return `bigint:${value}`;
  }
  if (type === "function" || type === "symbol") {
    return type;
  }
  if (depth >= MAX_DEPTH) {
    return "profundidade excedida";
  }
  if (value instanceof Date) {
    return `date:${value.toISOString()}`;
  }
  if (value instanceof RegExp) {
    return `regexp:${value.source}/${value.flags}`;
  }
  if (value instanceof Error) {
    return { erro: value.name, message: value.message };
  }
  if (Buffer.isBuffer(value)) {
    return { buffer: value.byteLength, sha256: digestOf(value) };
  }
  if (ArrayBuffer.isView(value)) {
    return { view: value.constructor.name, byteLength: value.byteLength, sha256: digestOf(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (value instanceof ArrayBuffer) {
    return { arrayBuffer: value.byteLength, sha256: digestOf(new Uint8Array(value)) };
  }
  if (value instanceof Map) {
    return { map: [...value.entries()].map(([key, entry]) => [describe(key, depth + 1), describe(entry, depth + 1)]) };
  }
  if (value instanceof Set) {
    return { set: [...value].map((entry) => describe(entry, depth + 1)) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => describe(entry, depth + 1));
  }
  const record = {};
  for (const key of Object.keys(value).sort()) {
    record[key] = describe(value[key], depth + 1);
  }
  return record;
}

function describeRemoteError(error, depth = 0) {
  const described = { name: error.name, message: error.message };
  if (error.code !== undefined) {
    described.code = error.code;
  }
  if (error.cause !== undefined && depth < 3) {
    described.cause = describeRemoteError(error.cause, depth + 1);
  }
  return described;
}

/**
 * Descreve um resultado assentado. O stack fica de fora: ele carrega caminhos absolutos e linhas
 * do dist, que mudam sem que o comportamento mude.
 */
function describeResult(entry) {
  if (entry.status === "fulfilled") {
    return { status: "ok", value: describe(entry.value) };
  }
  const error = entry.reason;
  if (!(error instanceof Error)) {
    return { status: "erro", nao_erro: describe(error) };
  }
  const described = { status: "erro", name: error.name, code: error.code ?? null, message: error.message };
  for (const key of ["source", "phase", "direction", "exitCode", "signal", "timeoutMs", "maxQueue"]) {
    if (error[key] !== undefined) {
      described[key] = error[key];
    }
  }
  if (error.remoteError !== undefined) {
    described.remoteError = describeRemoteError(error.remoteError);
  }
  return described;
}

/**
 * Agrupa os eventos por tarefa. A ordem entre tarefas concorrentes depende do escalonador do
 * sistema, mas a sequência dentro de uma tarefa e o conjunto por identificador não dependem.
 * Duração, PID, código de saída e sinal ficam de fora por variarem entre execuções e sistemas.
 */
function describeTasks(events) {
  const tasks = new Map();
  for (const event of events) {
    const task = tasks.get(event.taskId) ?? { taskId: event.taskId, lifecycle: [], outcome: null, termination: null, exit: null };
    task.lifecycle.push(event.type);
    if (event.type === "end") {
      task.outcome = event.outcome;
    }
    if (event.type === "close") {
      task.termination = event.termination;
      task.exit = event.exitCode === 0 && event.signal === null ? "limpo" : "encerrado";
    }
    tasks.set(event.taskId, task);
  }
  return [...tasks.values()].sort((left, right) => left.taskId - right.taskId).map((task) => ({ ...task, lifecycle: task.lifecycle.join(" ") }));
}

function snapshotOf(run) {
  return { results: run.results === null ? "não assentou" : run.results.map(describeResult), tasks: describeTasks(run.events) };
}

function summarize(snapshot) {
  const children = snapshot.tasks.filter((task) => task.lifecycle.includes("close")).length;
  const outcomes = summarizeResults(snapshot.results);
  return `${outcomes.padEnd(30)} ${String(children).padStart(2)} filho(s)`;
}

function summarizeResults(results) {
  if (results === "não assentou") {
    return `*** não assentou em ${CASE_DEADLINE_MS} ms ***`;
  }
  const counts = new Map();
  for (const result of results) {
    const key = result.status === "ok" ? "ok" : (result.code ?? "erro");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${count} ${key}`).join(" · ");
}

async function collectGarbage() {
  if (typeof globalThis.gc !== "function") {
    return;
  }
  for (let round = 0; round < 3; round += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Roda uma execução medindo tempo e pico de RSS. O pico é do processo pai: a memória dos filhos
 * é contabilizada pelo sistema operacional à parte e não aparece aqui.
 */
async function measure(work) {
  await collectGarbage();
  const baseRss = process.memoryUsage.rss();
  let peakRss = baseRss;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > peakRss) {
      peakRss = rss;
    }
  }, 10);
  sampler.unref();
  const startedAt = process.hrtime.bigint();
  try {
    const result = await work();
    return {
      result,
      ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
      peakMb: Math.max(0, peakRss - baseRss) / MEBIBYTE,
    };
  } finally {
    clearInterval(sampler);
  }
}

await batch("digest.mjs", {}, [TINY_PAYLOAD]);

const rows = [];
for (const entry of selected) {
  const name = `${entry.worker} [${entry.label}]`;
  const timings = [];
  const peaks = [];
  let snapshot = null;
  for (let attempt = 0; attempt < options.repeats; attempt += 1) {
    const measured = await measure(() => entry.scenario());
    timings.push(measured.ms);
    peaks.push(measured.peakMb);
    snapshot ??= snapshotOf(measured.result);
  }
  const bestMs = Number(Math.min(...timings).toFixed(1));
  const peakMb = Number(Math.min(...peaks).toFixed(1));
  rows.push({ case: name, bestMs, peakMb, snapshot });
  console.log(`  ${name.padEnd(40)} ${bestMs.toFixed(0).padStart(7)} ms ${peakMb.toFixed(0).padStart(5)} MB  ${summarize(snapshot)}`);
}

const totalMs = rows.reduce((sum, row) => sum + row.bestMs, 0);
const maxPeakMb = Math.max(...rows.map((row) => row.peakMb));
console.log(`\ntotal ${totalMs.toFixed(0)} ms  ·  pico máximo ${maxPeakMb.toFixed(0)} MB`);
if (typeof globalThis.gc !== "function") {
  console.log("dica: rode com `node --expose-gc bench/run.mjs` para picos de memória estáveis.");
}

if (options.save !== null) {
  mkdirSync(RESULT_DIRECTORY, { recursive: true });
  writeFileSync(join(RESULT_DIRECTORY, `${options.save}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`gravado em bench/results/${options.save}.json`);
}

if (options.compare !== null) {
  const baseline = new Map(loadResults(options.compare).map((row) => [row.case, row]));
  let differences = 0;
  let baselineTotal = 0;
  let baselinePeak = 0;
  console.log(`\ncomparando com ${options.compare}\n`);
  console.log(`${"caso".padEnd(40)} ${"ms antes".padStart(9)} ${"ms depois".padStart(9)} ${"Δt".padStart(6)} ${"MB antes".padStart(9)} ${"MB depois".padStart(9)} ${"Δm".padStart(6)}   saída`);
  for (const row of rows) {
    const previous = baseline.get(row.case);
    if (previous === undefined) {
      console.log(`${row.case.padEnd(40)} ${"—".padStart(9)} ${String(row.bestMs).padStart(9)} ${"—".padStart(6)} ${"—".padStart(9)} ${String(row.peakMb).padStart(9)} ${"—".padStart(6)}   caso novo`);
      continue;
    }
    baselineTotal += previous.bestMs;
    baselinePeak = Math.max(baselinePeak, previous.peakMb ?? 0);
    const identical = JSON.stringify(previous.snapshot) === JSON.stringify(row.snapshot);
    if (!identical) {
      differences += 1;
    }
    const timeDelta = `${((row.bestMs / previous.bestMs - 1) * 100).toFixed(0)}%`;
    const hasPeak = typeof previous.peakMb === "number" && previous.peakMb > 0;
    const peakBefore = hasPeak ? String(previous.peakMb) : "—";
    const peakDelta = hasPeak ? `${((row.peakMb / previous.peakMb - 1) * 100).toFixed(0)}%` : "—";
    console.log(`${row.case.padEnd(40)} ${String(previous.bestMs).padStart(9)} ${String(row.bestMs).padStart(9)} ${timeDelta.padStart(6)} ${peakBefore.padStart(9)} ${String(row.peakMb).padStart(9)} ${peakDelta.padStart(6)}   ${identical ? "idêntica" : "*** DIFERENTE ***"}`);
  }
  if (baselineTotal > 0) {
    console.log(`\ntotal ${baselineTotal.toFixed(0)} ms -> ${totalMs.toFixed(0)} ms  (${((totalMs / baselineTotal - 1) * 100).toFixed(0)}%)`);
  }
  if (baselinePeak > 0) {
    console.log(`pico máximo ${baselinePeak.toFixed(0)} MB -> ${maxPeakMb.toFixed(0)} MB  (${((maxPeakMb / baselinePeak - 1) * 100).toFixed(0)}%)`);
  }
  console.log(differences === 0 ? "todas as saídas idênticas" : `${differences} caso(s) com saída diferente`);
  if (differences > 0) {
    process.exitCode = 1;
  }
}
