import { MongoClient } from 'mongodb';

// Uses MONGO_URL when set; otherwise boots a throwaway in-memory mongod so tests run with zero setup.
export async function connect({ maxPoolSize = 100 } = {}) {
  let server;
  let url = process.env.MONGO_URL;
  if (!url) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    server = await MongoMemoryServer.create();
    url = server.getUri();
  }
  const client = await new MongoClient(url, { maxPoolSize }).connect();
  const db = client.db(process.env.MONGO_DB || 'promotions');
  return {
    db,
    close: async () => {
      await client.close();
      await server?.stop();
    },
  };
}
