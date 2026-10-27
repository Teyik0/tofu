import crypto from "node:crypto";
import { Effect, Result } from "effect";

const msePrime =
  "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a36210000000000090563";

interface ActiveDiagnostics {
  counters: CryptoDiagnostics;
  instrumented: typeof crypto.createDiffieHellman;
  original: typeof crypto.createDiffieHellman;
  owners: number;
}

let active: ActiveDiagnostics | null = null;

function createInstrumentation(): ActiveDiagnostics {
  const original = crypto.createDiffieHellman;
  const counters: CryptoDiagnostics = {
    attempts: 0,
    failures: 0,
    maxConstructorMilliseconds: 0,
    totalConstructorMilliseconds: 0,
  };
  const instrumented = new Proxy(original, {
    apply(target, receiver, args) {
      // This is the invocation used by bittorrent-protocol 5.0.9 MSE.
      if (args[0] !== msePrime || args[1] !== "hex" || args[2] !== 2) {
        return Reflect.apply(target, receiver, args);
      }
      counters.attempts += 1;
      const started = performance.now();
      const result = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (error) => error,
            try: () => Reflect.apply(target, receiver, args),
          })
        )
      );
      const elapsed = performance.now() - started;
      counters.totalConstructorMilliseconds += elapsed;
      counters.maxConstructorMilliseconds = Math.max(counters.maxConstructorMilliseconds, elapsed);
      if (Result.isFailure(result)) {
        counters.failures += 1;
        throw result.failure;
      }
      return result.success;
    },
  });
  crypto.createDiffieHellman = instrumented;
  return { counters, instrumented, original, owners: 0 };
}

// Explicit diagnostics only: preserve Bun's validation and every fresh peer key.
export function installCryptoDiagnostics() {
  active ??= createInstrumentation();
  const installation = active;
  installation.owners += 1;
  let closed = false;
  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      installation.owners -= 1;
      if (installation.owners === 0) {
        if (crypto.createDiffieHellman === installation.instrumented) {
          crypto.createDiffieHellman = installation.original;
        }
        active = null;
      }
    },
    snapshot(): CryptoDiagnostics {
      return { ...installation.counters };
    },
  };
}

export interface CryptoDiagnostics {
  attempts: number;
  failures: number;
  maxConstructorMilliseconds: number;
  totalConstructorMilliseconds: number;
}
