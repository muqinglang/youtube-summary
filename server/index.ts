import { createApp } from './app';
import { loadConfig } from './config';
import { createMemoryStore } from './store/memory';
import { createPostgresStore } from './store/postgres';
import type { Store } from './store/types';

const config = loadConfig();
// Without DATABASE_URL everything runs in memory, which is enough to exercise the API locally
// but loses every account and every cached artifact on restart.
const store: Store = config.databaseUrl
  ? await createPostgresStore(config.databaseUrl)
  : createMemoryStore();
if (!config.databaseUrl) console.warn('DATABASE_URL 未设置：使用内存存储，重启后数据全部丢失。');

const app = createApp({ config, store });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`旁听服务端已启动：http://localhost:${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await store.close();
      process.exit(0);
    })();
  });
}
