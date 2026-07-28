import { defineProcessHandler } from "../../dist/worker.js";

const BLOCK_SIZE = 65536;

function deterministicBlock(seed) {
  const block = Buffer.allocUnsafe(BLOCK_SIZE);
  let state = seed >>> 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 1) >>> 0;
    block[index] = state >>> 24;
  }
  return block;
}

/**
 * Devolve um Buffer determinístico do tamanho pedido. O preenchimento é feito por cópia de bloco
 * para que o tempo do caso fique dominado pelo IPC de volta, não pela geração dos bytes.
 */
defineProcessHandler(({ byteLength, seed }) => {
  const bytes = Buffer.allocUnsafe(byteLength);
  bytes.fill(deterministicBlock(seed));
  return { bytes };
});
