import { defineProcessHandler } from "../../dist/worker.js";

/**
 * Executa trabalho de CPU determinístico. Representa a carga real que justifica pagar por um
 * processo descartável e mostra quanto da tarefa é overhead do executor.
 */
defineProcessHandler(({ rounds }) => {
  let state = 0x9e3779b9;
  for (let index = 0; index < rounds; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + index) >>> 0;
  }
  return { rounds, checksum: state };
});
