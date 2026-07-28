import { defineProcessHandler } from "../../dist/worker.js";

const SAFETY_LIMIT_MS = 30_000;

process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

/**
 * Ignora SIGTERM e prende o event loop em um laço síncrono, então nem o `disconnect` nem o
 * sinal educado conseguem encerrá-lo: só a escalada para SIGKILL. O prazo de segurança evita
 * um processo órfão caso o benchmark seja interrompido no meio do caso.
 */
defineProcessHandler(() => {
  const deadline = Date.now() + SAFETY_LIMIT_MS;
  let state = 1;
  while (Date.now() < deadline) {
    state = (Math.imul(state ^ (state >>> 13), 2246822519) + 1) >>> 0;
  }
  return { state };
});
