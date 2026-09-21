import { Type } from '@nestjs/common';
import { AppModule } from '../app.module';
import { AgentService } from '../agent/agent.service';
import { ReceiptProcessingProcessor } from './receipt-processing.processor';
import { WorkerModule } from './worker.module';

// Importing the module graph pulls in StorageService -> `minio`, whose ESM-only
// dependency jest can't parse. Nothing is instantiated here, so a stub is enough.
jest.mock('minio', () => ({ Client: class {} }));

// Guards the API/worker split: the API process (AppModule) must only enqueue,
// so the processor — and with it the Claude client — may be registered only in
// WorkerModule. Reads Nest's decorator metadata, so no Redis/Postgres needed.

type ModuleRef = Type<unknown> | { module: Type<unknown>; providers?: unknown[]; imports?: unknown[] };

function collectProviders(root: ModuleRef, seen = new Set<unknown>()): Set<unknown> {
  const providers = new Set<unknown>();
  const visit = (ref: ModuleRef) => {
    const dynamic = 'module' in ref ? ref : undefined;
    const moduleClass = dynamic ? dynamic.module : (ref as Type<unknown>);
    if (seen.has(moduleClass)) return;
    seen.add(moduleClass);

    const declared = [
      ...((Reflect.getMetadata('providers', moduleClass) as unknown[] | undefined) ?? []),
      ...(dynamic?.providers ?? []),
    ];
    // A provider can be a class or a `{ provide, useClass/useFactory }` object.
    declared.forEach((p) => providers.add(typeof p === 'function' ? p : (p as { provide: unknown }).provide));

    const imports = [
      ...((Reflect.getMetadata('imports', moduleClass) as ModuleRef[] | undefined) ?? []),
      ...((dynamic?.imports as ModuleRef[] | undefined) ?? []),
    ];
    imports.forEach(visit);
  };
  visit(root);
  return providers;
}

describe('worker/API module split', () => {
  it('does not register the receipt processor or the Claude client in the API process', () => {
    const apiProviders = collectProviders(AppModule);
    expect(apiProviders.has(ReceiptProcessingProcessor)).toBe(false);
    expect(apiProviders.has(AgentService)).toBe(false);
  });

  it('registers the receipt processor in the worker process', () => {
    const workerProviders = collectProviders(WorkerModule);
    expect(workerProviders.has(ReceiptProcessingProcessor)).toBe(true);
    expect(workerProviders.has(AgentService)).toBe(true);
  });
});
