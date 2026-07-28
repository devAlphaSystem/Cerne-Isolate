import { defineProcessHandler } from "../../dist/worker.js";

/**
 * Reduz o payload a um resumo minúsculo. O handler amostra o buffer em vez de percorrê-lo
 * inteiro para que o tempo do caso fique dominado pelo IPC de ida, não pelo trabalho do worker.
 */
defineProcessHandler((payload) => {
  const { bytes } = payload;
  let checksum = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
    checksum = (checksum + bytes[offset]) >>> 0;
  }
  return { byteLength: bytes.byteLength, checksum };
});
