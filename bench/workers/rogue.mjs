import { setTimeout as sleep } from "node:timers/promises";

const SAFETY_LIMIT_MS = 30_000;

/**
 * Envia uma mensagem fora do protocolo versionado e continua vivo. Exercita PROCESS_PROTOCOL e o
 * encerramento de um filho que não coopera com o handshake. O prazo de segurança evita um
 * processo órfão caso o benchmark seja interrompido no meio do caso.
 */
process.send?.({ protocol: "outro-pacote", version: 99, type: "ready" });
await sleep(SAFETY_LIMIT_MS);
